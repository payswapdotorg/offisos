/**
 * CADDocument — the editor's canonical working representation (§5.4, §15,
 * data-model.md §2, LOCK-019).
 *
 * Provides document-local object identity, editor state, command/undo/redo
 * semantics, model tree, source artifact lineage, format/version metadata
 * and — since CAD-IMPLEMENT-003 — an immutable, append-only model revision
 * history (contracts/model.ts) that persists with the snapshot (save/open)
 * and replays deterministically. NOT the Construction Graph (LOCK-019):
 * CADDocument identity is editor/file identity; Construction Graph identity
 * is mapped through explicit versioned contracts/events (the graph bridge).
 *
 * Versioned document transactions (§15): each `execute` creates a child
 * version whose id is derived from the canonical content hash (deterministic,
 * reproducible). `undo` reverts to the parent version; `redo` re-applies the
 * child version. The same command sequence through any host yields the same
 * version chain, revision history and content hash (Web/Electron parity,
 * §5.5).
 *
 * Identity (§5.4 "document-local object identity"): element ids are the
 * canonical document identity — stable across revisions, save/open and
 * replay. `addElement` with a missing/empty id mints a document identity
 * (`el-000001`, monotonic, never reused); a duplicate id is rejected (an id
 * must identify ONE element for its whole lifetime). `engineId` remains a
 * provenance field only.
 */

import { createHash } from "node:crypto";
import type {
  BimSettings,
  CADDocumentSnapshot,
  DimStyleRecord,
  DocsSheetRecord,
  DocsViewRecord,
  DocumentEdit,
  DraftingSettings,
  Element,
  EditorState,
  LayerRecord,
  LayerStateRecord,
  LayoutRecord,
  LtypeRecord,
  TextStyleRecord,
  VersionMeta,
  IfcImportRecordView,
  BlockDefinitionRecord,
  XrefRecord,
  ConstraintRecord,
  ViewportRecord,
  SectionPlaneRecord,
  UcsRecord,
  // CAD-PARITY-013 (additive, Issue #104): the documentation production
  // record tables.
  NavigatorNodeRecord,
  PublisherItem,
  PublisherSetRecord,
  RevisionRecord,
  ScheduleRecord,
  // CAD-PARITY-015 (additive, Issue #110): the property-definition registry.
  PropertyDefRecord,
  TitleBlockRecord,
  // CAD-PARITY-018 (additive, Issue #118): the specialized-toolsets record
  // table.
  SpecializedRecord,
} from "../contracts/caddocument.js";
import type { ModelHistory } from "../contracts/model.js";
import { childVersion, rootVersion } from "./versioning.js";
import { canonicalStringify } from "./serialization.js";
import {
  DEFAULT_LAYER,
  applyBlockDefPatch,
  applyConstraintPatch,
  applyDimStylePatch,
  applyLayerPatch,
  applyLayoutPatch,
  applyLtypePatch,
  applySheetPatch,
  applyTextStylePatch,
  applyUcsPatch,
  applyViewPatch,
  applyViewportPatch,
  applySectionPlanePatch,
  applyXrefPatch,
  applyNavigatorNodePatch,
  applyPublisherSetPatch,
  applyRevisionPatch,
  applySchedulePatch,
  // CAD-PARITY-015 (additive, Issue #110): the property-definition registry
  // validators/derivations.
  applyPropertyDefPatch,
  applyTitleBlockPatch,
  captureLayerState,
  defaultBimSettings,
  defaultDraftingSettings,
  deriveBlockSequence,
  deriveConstraintSequence,
  deriveIfcImportSequence,
  deriveLayerSequence,
  deriveLayoutSequence,
  deriveSheetSequence,
  deriveViewSequence,
  deriveViewportSequence,
  deriveXrefSequence,
  deriveUcsSequence,
  deriveSectionPlaneSequence,
  deriveNavigatorNodeSequence,
  derivePublisherSetSequence,
  deriveRevisionSequence,
  deriveScheduleSequence,
  deriveTitleBlockSequence,
  derivePropertyDefSequence,
  elementLayerReference,
  validateBimSettings,
  validateBlockDefinitionRecord,
  validateConstraintRecord,
  validateDimStyleRecord,
  validateDocsSheetRecord,
  validateIfcImportRecord,
  validateDocsViewRecord,
  validateDraftingSettings,
  validateLayerRecord,
  validateLayerStateRecord,
  validateLayoutRecord,
  validateLtypeRecord,
  validateTextStyleRecord,
  validateUcsTableRecord,
  validateSectionPlaneTableRecord,
  validateViewportRecord,
  validateXrefRecord,
  validateNavigatorNodeRecord,
  validatePublisherSetRecord,
  validateRevisionRecord,
  validateScheduleRecord,
  validatePropertyDefRecord,
  validateTitleBlockRecord,
} from "./workspace.js";
import { assertDefinitionGraph, normalizeBlockEntities, referencedBlockIds } from "../workspace/blocks/types.js";
// CAD-PARITY-018 (additive, Issue #118): the specialized-toolsets record
// grammar — validated in ONE place by the toolsets core (the single
// record-grammar precedent: the P015 registry validators lived with the
// document; the P018 core owns its own grammar and the document calls it).
import {
  deriveSpecializedSequence,
  normalizeToolsetRecord,
  TOOLSETS_TABLE_BOUNDS,
} from "../toolsets/records.js";
import {
  appendRevision,
  canonicalHashOf,
  cloneHistory,
  createdHistory,
  deepFreeze,
  deriveElementSequence,
  historyHash,
  openedHistory,
  validateHistoryLinkage,
  validateModelHistory,
} from "./history.js";

interface UndoEntry {
  readonly forward: DocumentEdit;
  readonly inverse: DocumentEdit;
  readonly fromVersion: VersionMeta;
  readonly toVersion: VersionMeta;
}

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z").toISOString();

/** CAD-PARITY-006: the definition-graph gate over an adopted table view
 *  (the Map-backed resolver for assertDefinitionGraph). */
function assertDefinitionGraphSafe(
  id: string,
  entities: readonly Record<string, unknown>[],
  entitiesById: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): void {
  assertDefinitionGraph(id, entities, (other) => entitiesById.get(other));
}

/** CAD-PARITY-013: whole-table navigator tree consistency (open-time
 *  integrity): every non-root parentId must reference a node of the SAME
 *  kind and no node may be its own ancestor (cycle). A violating tree is
 *  corrupt, not repairable (LOCK-007). */
function assertNavigatorTreeConsistent(nodes: readonly NavigatorNodeRecord[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId);
      if (parent === undefined) {
        throw new Error(`open: navigator node '${node.id}' references unknown parent '${node.parentId}'`);
      }
      if (parent.kind !== node.kind) {
        throw new Error(
          `open: navigator node '${node.id}' (${node.kind}) references a '${parent.kind}' parent — parents must share the node kind`,
        );
      }
    }
  }
  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) {
        throw new Error(`open: navigator node '${node.id}' is its own ancestor (parent cycle)`);
      }
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

export class CADDocument {
  private version: VersionMeta;
  private readonly elements: Map<string, Element> = new Map();
  private readonly format: string;
  private readonly formatVersion: string;
  private readonly sourceArtifactLineage: string[];
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  private readonly createdBy: string;
  /** Immutable, append-only model revision history (CAD-IMPLEMENT-003). */
  private historyState: ModelHistory;
  /** Monotonic mint counter for document-issued element identities. */
  private nextElementSequence: number;
  /** COMPAT-CAD-001: the persistent drawing layer table (insertion-ordered;
   *  edited ONLY through the DocumentEdit command model). */
  private readonly layers: Map<string, LayerRecord> = new Map();
  /** COMPAT-CAD-001: monotonic mint counter for `ly-NNNNNN` identities. */
  private nextLayerSequence: number;
  /** COMPAT-CAD-001: non-versioned drafting workspace settings (grid/snap/
   *  view; persisted with the snapshot, mutated without a version bump). */
  private draftingSettingsState: DraftingSettings = defaultDraftingSettings();
  /** COMPAT-CAD-002: non-versioned BIM workspace settings (camera preset;
   *  persisted with the snapshot, mutated without a version bump). */
  private bimSettingsState: BimSettings = defaultBimSettings();
  /** COMPAT-CAD-003: the documentation view table (insertion-ordered;
   *  edited ONLY through the DocumentEdit command model — view lineage lives
   *  in the recorded applied edits, like the layer table). */
  private readonly docsViews: Map<string, DocsViewRecord> = new Map();
  /** COMPAT-CAD-003: monotonic mint counter for `vw-NNNNNN` identities. */
  private nextViewSequence: number;
  /** COMPAT-CAD-003: the documentation sheet table (insertion-ordered). */
  private readonly docsSheets: Map<string, DocsSheetRecord> = new Map();
  /** COMPAT-CAD-003: monotonic mint counter for `sh-NNNNNN` identities. */
  private nextSheetSequence: number;
  /** COMPAT-IFC-001: deterministic IFC import records (insertion-ordered,
   *  append-only through addIfcImport — one record per import command). */
  private readonly ifcImports: Map<string, IfcImportRecordView> = new Map();
  /** COMPAT-IFC-001: monotonic mint counter for `if-NNNNNN` identities. */
  private nextIfcImportSequence: number;
  /** CAD-PARITY-004: user-defined linetypes (name-keyed — the domain
   *  reference model; the built-in catalog is code-resolved). Insertion
   *  order; edited through the DocumentEdit command model. */
  private readonly ltypes: Map<string, LtypeRecord> = new Map();
  /** CAD-PARITY-004: user-defined text styles (name-keyed). */
  private readonly textStyles: Map<string, TextStyleRecord> = new Map();
  /** CAD-PARITY-004: user-defined dimension styles (name-keyed). */
  private readonly dimStyles: Map<string, DimStyleRecord> = new Map();
  /** CAD-PARITY-004: named layer states (name-keyed; addLayerState on an
   *  existing name replaces — LAYERSTATE re-save semantics). */
  private readonly layerStates: Map<string, LayerStateRecord> = new Map();
  /** CAD-PARITY-006: reusable block/component definitions (id-keyed,
   *  insertion-ordered; edited ONLY through the DocumentEdit command model
   *  — one edit = one revision = one undo entry; removal is
   *  reference-checked against instances AND other definitions' content). */
  private readonly blockDefs: Map<string, BlockDefinitionRecord> = new Map();
  /** CAD-PARITY-006: monotonic mint counter for `blk-NNNNNN` identities. */
  private nextBlockSequence: number;
  /** CAD-PARITY-006: attached external references (id-keyed,
   *  insertion-ordered; the bounded attach/reload/detach lifecycle). */
  private readonly xrefs: Map<string, XrefRecord> = new Map();
  /** CAD-PARITY-006: monotonic mint counter for `xr-NNNNNN` identities. */
  private nextXrefSequence: number;
  /** CAD-PARITY-007: the declared parametric constraint graph (id-keyed,
   *  insertion-ordered; edited ONLY through the DocumentEdit command model
   *  — one edit = one revision = one undo entry; satisfaction is COMPUTED
   *  on demand by the shared solver, never persisted stale). */
  private readonly constraints: Map<string, ConstraintRecord> = new Map();
  /** CAD-PARITY-007: monotonic mint counter for `con-NNNNNN` identities. */
  private nextConstraintSequence: number;
  /** CAD-PARITY-008: the paper-space layout table (id-keyed, insertion-
   *  ordered; edited ONLY through the DocumentEdit command model — one
   *  edit = one revision = one undo entry; model geometry is REFERENCED
   *  through viewport records, never copied). */
  private readonly layouts: Map<string, LayoutRecord> = new Map();
  /** CAD-PARITY-008: monotonic mint counter for `lo-NNNNNN` identities. */
  private nextLayoutSequence: number;
  /** CAD-PARITY-008: the rectangular layout viewport table (id-keyed,
   *  insertion-ordered; the per-layout paper composition). */
  private readonly viewports: Map<string, ViewportRecord> = new Map();
  /** CAD-PARITY-008: monotonic mint counter for `vp-NNNNNN` identities. */
  private nextViewportSequence: number;
  /** CAD-PARITY-009: the named UCS/workplane table (id-keyed, insertion-
   *  ordered; edited ONLY through the DocumentEdit command model — one
   *  edit = one revision = one undo entry). The World UCS is IMPLICIT —
   *  never a table record (addressable as "world"). */
  private readonly ucsTable: Map<string, UcsRecord> = new Map();
  /** CAD-PARITY-009: monotonic mint counter for `ucs-NNNNNN` identities. */
  private nextUcsSequence: number;
  /** CAD-PARITY-009: the section/slice plane table (id-keyed, insertion-
   *  ordered; the bounded section-preview foundation — the derived preview
   * is recomputed on demand, never stored). */
  private readonly sectionPlanes: Map<string, SectionPlaneRecord> = new Map();
  /** CAD-PARITY-009: monotonic mint counter for `sp-NNNNNN` identities. */
  private nextSectionPlaneSequence: number;
  /** CAD-PARITY-013 (Issue #104): the navigator tree (id-keyed, insertion-
   *  ordered; ONE kind-tagged tree serving the View Map folders and the
   *  Layout Book subsets; edited ONLY through the DocumentEdit command
   *  model — one edit = one revision = one undo entry). */
  private readonly navigatorNodes: Map<string, NavigatorNodeRecord> = new Map();
  /** CAD-PARITY-013: monotonic mint counter for `nav-NNNNNN` identities. */
  private nextNavigatorNodeSequence: number;
  /** CAD-PARITY-013: the reusable title-block definitions (id-keyed,
   *  insertion-ordered; names unique — the user-facing address). */
  private readonly titleBlocks: Map<string, TitleBlockRecord> = new Map();
  /** CAD-PARITY-013: monotonic mint counter for `tb-NNNNNN` identities. */
  private nextTitleBlockSequence: number;
  /** CAD-PARITY-013: the saved schedule/index definitions (id-keyed,
   *  insertion-ordered; names unique; rows are ALWAYS derived fresh,
   *  never stored — no parallel source of truth). */
  private readonly schedules: Map<string, ScheduleRecord> = new Map();
  /** CAD-PARITY-013: monotonic mint counter for `sch-NNNNNN` identities. */
  private nextScheduleSequence: number;
  /** CAD-PARITY-015 (Issue #110): the document-owned property DEFINITIONS
   *  (id-keyed, insertion-ordered; names unique; (set, key) addresses
   *  unique). Declarations only — values live on the canonical element
   *  property-set overlay, never here (no parallel source of truth). */
  private readonly propertyDefs: Map<string, PropertyDefRecord> = new Map();
  /** CAD-PARITY-015: monotonic mint counter for `prd-NNNNNN` identities. */
  private nextPropertyDefSequence: number;
  /** CAD-PARITY-018 (Issue #118): the document-owned specialized-toolsets
   *  records (id-keyed, insertion-ordered; raster sourceRefs unique among
   *  raster.source rows). Declarations/records only — every derivation is
   *  computed fresh on demand, never stored (no parallel source of
   *  truth). */
  private readonly specialized: Map<string, SpecializedRecord> = new Map();
  /** CAD-PARITY-018: monotonic mint counter for `tls-NNNNNN` identities. */
  private nextSpecializedSequence: number;
  /** CAD-PARITY-013: the document revision records (id-keyed, insertion-
   *  ordered; codes unique — the user-facing address). */
  private readonly revisions: Map<string, RevisionRecord> = new Map();
  /** CAD-PARITY-013: monotonic mint counter for `rev-NNNNNN` identities. */
  private nextRevisionSequence: number;
  /** CAD-PARITY-013: the saved publisher sets (id-keyed, insertion-ordered;
   *  names unique; publisher.run is non-versioned output automation). */
  private readonly publisherSets: Map<string, PublisherSetRecord> = new Map();
  /** CAD-PARITY-013: monotonic mint counter for `pub-NNNNNN` identities. */
  private nextPublisherSetSequence: number;
  /** Ephemeral editor selection (§5.4 editor state). Orthogonal to the
   *  versioned document content: it is NOT in the version-id derivation and
   *  NOT in the parity content hash (§5.5). Since COMPAT-CAD-001 it IS
   *  persisted with the snapshot (save/open preserves the selection); it is
   *  still cleared by undo-insensitive and re-adopted on open. */
  #selection: string[] = [];

  private constructor(
    version: VersionMeta,
    elements: Iterable<Element>,
    format: string,
    formatVersion: string,
    lineage: Iterable<string>,
    createdBy: string,
    selection: Iterable<string>,
    history: ModelHistory,
    nextElementSequence: number,
    layers: Iterable<LayerRecord>,
    nextLayerSequence: number,
    draftingSettings: DraftingSettings,
    bimSettings: BimSettings,
    docsViews: Iterable<DocsViewRecord>,
    nextViewSequence: number,
    docsSheets: Iterable<DocsSheetRecord>,
    nextSheetSequence: number,
    ifcImports: Iterable<IfcImportRecordView>,
    nextIfcImportSequence: number,
    ltypes: Iterable<LtypeRecord>,
    textStyles: Iterable<TextStyleRecord>,
    dimStyles: Iterable<DimStyleRecord>,
    layerStates: Iterable<LayerStateRecord>,
    blockDefs: Iterable<BlockDefinitionRecord>,
    nextBlockSequence: number,
    xrefs: Iterable<XrefRecord>,
    nextXrefSequence: number,
    constraints: Iterable<ConstraintRecord>,
    nextConstraintSequence: number,
    layouts: Iterable<LayoutRecord>,
    nextLayoutSequence: number,
    viewports: Iterable<ViewportRecord>,
    nextViewportSequence: number,
    ucsTable: Iterable<UcsRecord>,
    nextUcsSequence: number,
    sectionPlanes: Iterable<SectionPlaneRecord>,
    nextSectionPlaneSequence: number,
    navigatorNodes: Iterable<NavigatorNodeRecord>,
    nextNavigatorNodeSequence: number,
    titleBlocks: Iterable<TitleBlockRecord>,
    nextTitleBlockSequence: number,
    schedules: Iterable<ScheduleRecord>,
    nextScheduleSequence: number,
    propertyDefs: Iterable<PropertyDefRecord>,
    nextPropertyDefSequence: number,
    specialized: Iterable<SpecializedRecord>,
    nextSpecializedSequence: number,
    revisions: Iterable<RevisionRecord>,
    nextRevisionSequence: number,
    publisherSets: Iterable<PublisherSetRecord>,
    nextPublisherSetSequence: number,
  ) {
    this.version = version;
    for (const e of elements) this.elements.set(e.id, e);
    this.format = format;
    this.formatVersion = formatVersion;
    this.sourceArtifactLineage = [...lineage];
    this.createdBy = createdBy;
    this.#selection = [...selection];
    this.historyState = history;
    this.nextElementSequence = nextElementSequence;
    for (const l of layers) this.layers.set(l.id, l);
    this.nextLayerSequence = nextLayerSequence;
    this.draftingSettingsState = draftingSettings;
    this.bimSettingsState = bimSettings;
    for (const v of docsViews) this.docsViews.set(v.id, v);
    this.nextViewSequence = nextViewSequence;
    for (const s of docsSheets) this.docsSheets.set(s.id, s);
    this.nextSheetSequence = nextSheetSequence;
    for (const r of ifcImports) this.ifcImports.set(r.id, r);
    this.nextIfcImportSequence = nextIfcImportSequence;
    // CAD-PARITY-004: the name-keyed standards/style/state tables.
    for (const t of ltypes) this.ltypes.set(t.name, t);
    for (const s of textStyles) this.textStyles.set(s.name, s);
    for (const d of dimStyles) this.dimStyles.set(d.name, d);
    for (const st of layerStates) this.layerStates.set(st.name, st);
    // CAD-PARITY-006: the id-keyed block-definition + xref tables.
    for (const b of blockDefs) this.blockDefs.set(b.id, b);
    this.nextBlockSequence = nextBlockSequence;
    for (const x of xrefs) this.xrefs.set(x.id, x);
    this.nextXrefSequence = nextXrefSequence;
    // CAD-PARITY-007: the declared constraint table.
    for (const c of constraints) this.constraints.set(c.id, c);
    this.nextConstraintSequence = nextConstraintSequence;
    // CAD-PARITY-008: the layout + viewport tables.
    for (const l of layouts) this.layouts.set(l.id, l);
    this.nextLayoutSequence = nextLayoutSequence;
    for (const v of viewports) this.viewports.set(v.id, v);
    this.nextViewportSequence = nextViewportSequence;
    // CAD-PARITY-009: the UCS + section-plane tables.
    for (const u of ucsTable) this.ucsTable.set(u.id, u);
    this.nextUcsSequence = nextUcsSequence;
    for (const sp of sectionPlanes) this.sectionPlanes.set(sp.id, sp);
    this.nextSectionPlaneSequence = nextSectionPlaneSequence;
    // CAD-PARITY-013: the documentation production tables.
    for (const n of navigatorNodes) this.navigatorNodes.set(n.id, n);
    this.nextNavigatorNodeSequence = nextNavigatorNodeSequence;
    for (const tb of titleBlocks) this.titleBlocks.set(tb.id, tb);
    this.nextTitleBlockSequence = nextTitleBlockSequence;
    for (const s of schedules) this.schedules.set(s.id, s);
    this.nextScheduleSequence = nextScheduleSequence;
    // CAD-PARITY-015: the property-definition registry.
    for (const d of propertyDefs) this.propertyDefs.set(d.id, d);
    this.nextPropertyDefSequence = nextPropertyDefSequence;
    // CAD-PARITY-018: the specialized-toolsets record table.
    for (const rec of specialized) this.specialized.set(rec.id, rec);
    this.nextSpecializedSequence = nextSpecializedSequence;
    for (const rev of revisions) this.revisions.set(rev.id, rev);
    this.nextRevisionSequence = nextRevisionSequence;
    for (const ps of publisherSets) this.publisherSets.set(ps.id, ps);
    this.nextPublisherSetSequence = nextPublisherSetSequence;
  }

  /** Open a snapshot: load state, set version, clear undo/redo, adopt the
   *  persisted selection (COMPAT-CAD-001) — a legacy snapshot without one
   *  opens with an empty selection. Adopts the persisted model history when
   *  the snapshot carries one (validated structurally + linked to the
   *  snapshot version); otherwise seeds a fresh history whose base IS the
   *  opened state (legacy artifact). COMPAT-CAD-001: the layer table and
   *  drafting settings are adopted when present; a legacy snapshot without a
   *  layer table materializes the canonical default layer "0" (documented
   *  default for the additive feature, not a repair — element content and
   *  revision hashes are untouched). */
  static open(snapshot: CADDocumentSnapshot, createdBy: string): CADDocument {
    let history: ModelHistory;
    let nextElementSequence: number;
    if (snapshot.modelHistory !== undefined) {
      validateModelHistory(snapshot.modelHistory);
      validateHistoryLinkage(snapshot.modelHistory, snapshot.version, snapshot.format, snapshot.formatVersion);
      history = deepFreeze(cloneHistory(snapshot.modelHistory));
      nextElementSequence = history.next_element_sequence;
    } else {
      history = openedHistory(
        snapshot.version.entity_id,
        snapshot.format,
        snapshot.formatVersion,
        snapshot.version,
        snapshot.elements,
        snapshot.sourceArtifactLineage,
      );
      nextElementSequence = deriveElementSequence(snapshot.elements);
    }
    const layers = [...(snapshot.layers ?? [DEFAULT_LAYER])];
    for (const layer of layers) validateLayerRecord(layer);
    const draftingSettings = snapshot.draftingSettings !== undefined
      ? validateDraftingSettings(snapshot.draftingSettings)
      : defaultDraftingSettings();
    const bimSettings = snapshot.bimSettings !== undefined
      ? validateBimSettings(snapshot.bimSettings)
      : defaultBimSettings();
    // COMPAT-CAD-003: adopt the documentation view/sheet tables when present
    // (validated structurally, LOCK-007); a legacy snapshot opens with empty
    // tables — the additive-feature default, not a repair.
    const docsViews = [...(snapshot.docsViews ?? [])];
    for (const view of docsViews) validateDocsViewRecord(view);
    const docsSheets = [...(snapshot.docsSheets ?? [])];
    for (const sheet of docsSheets) validateDocsSheetRecord(sheet);
    // COMPAT-IFC-001: adopt the deterministic import records when present
    // (validated structurally, LOCK-007); a legacy snapshot opens with none.
    const ifcImports = [...(snapshot.ifcImports ?? [])];
    for (const record of ifcImports) validateIfcImportRecord(record);
    // CAD-PARITY-004: adopt the name-keyed standards/style/state tables when
    // present (validated structurally, LOCK-007); a legacy snapshot opens
    // with empty tables (the built-in catalog/styles are code-resolved).
    const ltypes = [...(snapshot.ltypes ?? [])];
    for (const t of ltypes) validateLtypeRecord(t);
    const textStyles = [...(snapshot.textStyles ?? [])];
    for (const s of textStyles) validateTextStyleRecord(s);
    const dimStyles = [...(snapshot.dimStyles ?? [])];
    for (const d of dimStyles) validateDimStyleRecord(d);
    const layerStates = [...(snapshot.layerStates ?? [])];
    for (const st of layerStates) validateLayerStateRecord(st);
    // CAD-PARITY-006: adopt the block-definition + xref tables when present
    // (validated structurally — including the definition GRAPH checks over
    // the adopted table and the instance-reference integrity, LOCK-007); a
    // legacy snapshot opens with empty tables (the additive-feature
    // default, not a repair).
    const rawBlockDefs = [...(snapshot.blockDefs ?? [])];
    const adoptedBlockDefs: BlockDefinitionRecord[] = [];
    const blockEntitiesById = new Map<string, readonly Record<string, unknown>[]>();
    const blockNames = new Set<string>();
    for (const b of rawBlockDefs) {
      const validated = validateBlockDefinitionRecord(b);
      if (blockNames.has(validated.name)) {
        throw new Error(`open: duplicate block definition name '${validated.name}'`);
      }
      blockNames.add(validated.name);
      adoptedBlockDefs.push(validated);
      blockEntitiesById.set(validated.id, validated.entities);
    }
    for (const b of adoptedBlockDefs) {
      assertDefinitionGraphSafe(b.id, b.entities, blockEntitiesById);
    }
    const xrefs: XrefRecord[] = [];
    const xrefNames = new Set<string>();
    for (const x of [...(snapshot.xrefs ?? [])]) {
      const validated = validateXrefRecord(x);
      if (xrefNames.has(validated.name)) {
        throw new Error(`open: duplicate external reference name '${validated.name}'`);
      }
      xrefNames.add(validated.name);
      xrefs.push(validated);
    }
    const xrefIds = new Set(xrefs.map((x) => x.id));
    // Instance-reference integrity: every block-ref/xref-ref element must
    // reference an adopted record (a dangling reference is corrupt, not
    // repairable — LOCK-007).
    for (const el of snapshot.elements) {
      const p = el.props as Record<string, unknown>;
      if (p.drafting === true && p.type === "block-ref") {
        if (typeof p.blockId !== "string" || !blockEntitiesById.has(p.blockId)) {
          throw new Error(`open: element '${el.id}' references an unknown block definition`);
        }
      }
      if (p.drafting === true && p.type === "xref-ref") {
        if (typeof p.xrefId !== "string" || !xrefIds.has(p.xrefId)) {
          throw new Error(`open: element '${el.id}' references an unknown external reference`);
        }
      }
    }
    const blockDefs = adoptedBlockDefs;
    // CAD-PARITY-007: adopt the declared constraint table when present
    // (validated structurally through the shared grammar, LOCK-007); a
    // legacy snapshot opens with an empty table (the additive-feature
    // default, not a repair). Target elements are NOT existence-checked at
    // open (the command layer severs dead constraints explicitly — the
    // CAD-PARITY-005 dead-ref precedent; diagnostics report them honestly).
    const constraints: ConstraintRecord[] = [];
    const constraintIds = new Set<string>();
    for (const c of [...(snapshot.constraints ?? [])]) {
      const validated = validateConstraintRecord(c);
      if (constraintIds.has(validated.id)) {
        throw new Error(`open: duplicate constraint id '${validated.id}'`);
      }
      constraintIds.add(validated.id);
      constraints.push(validated);
    }
    // CAD-PARITY-008: adopt the layout + viewport tables when present
    // (validated structurally through the shared paper/viewport grammar,
    // LOCK-007); a legacy snapshot opens with empty tables (the
    // additive-feature default, not a repair). Viewport references are
    // dangling-checked against the ADOPTED layout table (a viewport without
    // its layout is corrupt, not repairable — LOCK-007).
    const layouts: LayoutRecord[] = [];
    const layoutIds = new Set<string>();
    const layoutNames = new Set<string>();
    for (const l of [...(snapshot.layouts ?? [])]) {
      const validated = validateLayoutRecord(l);
      if (layoutIds.has(validated.id)) {
        throw new Error(`open: duplicate layout id '${validated.id}'`);
      }
      if (layoutNames.has(validated.name)) {
        throw new Error(`open: duplicate layout name '${validated.name}'`);
      }
      layoutIds.add(validated.id);
      layoutNames.add(validated.name);
      layouts.push(validated);
    }
    const viewports: ViewportRecord[] = [];
    const viewportIds = new Set<string>();
    for (const v of [...(snapshot.viewports ?? [])]) {
      const validated = validateViewportRecord(v);
      if (viewportIds.has(validated.id)) {
        throw new Error(`open: duplicate viewport id '${validated.id}'`);
      }
      if (!layoutIds.has(validated.layoutId)) {
        throw new Error(`open: viewport '${validated.id}' references unknown layout '${validated.layoutId}'`);
      }
      viewportIds.add(validated.id);
      viewports.push(validated);
    }
    // The active-layout editor reference must resolve when present.
    const activeLayout = snapshot.draftingSettings?.activeLayout;
    if (activeLayout !== undefined && !layoutIds.has(activeLayout)) {
      throw new Error(`open: activeLayout '${activeLayout}' does not reference an adopted layout`);
    }
    // CAD-PARITY-009: adopt the named UCS + section-plane tables when present
    // (validated structurally through the SHARED model3d grammar —
    // right-handed orthonormal axes / unit normals, LOCK-007); a legacy
    // snapshot opens with empty tables (the additive-feature default, not a
    // repair). The active-UCS editor reference is DEFENSIVELY REPAIRED to
    // the implicit World UCS when dangling (documented editor-state repair —
    // the command layer never lets a dangling id be SET; a corrupt hand-edited
    // snapshot must still open deterministically).
    const ucsRecords: UcsRecord[] = [];
    const ucsIds = new Set<string>();
    const ucsNames = new Set<string>();
    for (const u of [...(snapshot.ucs ?? [])]) {
      const validated = validateUcsTableRecord(u);
      if (ucsIds.has(validated.id)) {
        throw new Error(`open: duplicate UCS id '${validated.id}'`);
      }
      if (ucsNames.has(validated.name)) {
        throw new Error(`open: duplicate UCS name '${validated.name}'`);
      }
      ucsIds.add(validated.id);
      ucsNames.add(validated.name);
      ucsRecords.push(validated);
    }
    const sectionPlaneRecords: SectionPlaneRecord[] = [];
    const sectionPlaneIds = new Set<string>();
    const sectionPlaneNames = new Set<string>();
    for (const sp of [...(snapshot.sectionPlanes ?? [])]) {
      const validated = validateSectionPlaneTableRecord(sp);
      if (sectionPlaneIds.has(validated.id)) {
        throw new Error(`open: duplicate section plane id '${validated.id}'`);
      }
      if (sectionPlaneNames.has(validated.name)) {
        throw new Error(`open: duplicate section plane name '${validated.name}'`);
      }
      sectionPlaneIds.add(validated.id);
      sectionPlaneNames.add(validated.name);
      sectionPlaneRecords.push(validated);
    }
    let adoptedSettings = draftingSettings;
    const activeUcs = draftingSettings.activeUcs;
    if (activeUcs !== undefined && activeUcs !== "world" && !ucsIds.has(activeUcs)) {
      const repaired = { ...draftingSettings };
      delete (repaired as { activeUcs?: string }).activeUcs;
      adoptedSettings = validateDraftingSettings(repaired);
    }
    // CAD-PARITY-013 (Issue #104): adopt the documentation production tables
    // when present (validated structurally through the shared grammar,
    // LOCK-007); a legacy snapshot opens with empty tables (the
    // additive-feature default, not a repair). Self-contained integrity is
    // checked here (duplicate ids/names/codes, parent existence + same kind,
    // no cycles); the CROSS-TABLE reference pass runs below once every
    // adopted table is available.
    const navigatorNodeRecords: NavigatorNodeRecord[] = [];
    const navigatorIds = new Set<string>();
    for (const n of [...(snapshot.navigatorNodes ?? [])]) {
      const validated = validateNavigatorNodeRecord(n);
      if (navigatorIds.has(validated.id)) {
        throw new Error(`open: duplicate navigator node id '${validated.id}'`);
      }
      navigatorIds.add(validated.id);
      navigatorNodeRecords.push(validated);
    }
    assertNavigatorTreeConsistent(navigatorNodeRecords);
    const titleBlockRecords: TitleBlockRecord[] = [];
    const titleBlockIds = new Set<string>();
    const titleBlockNames = new Set<string>();
    for (const tb of [...(snapshot.titleBlocks ?? [])]) {
      const validated = validateTitleBlockRecord(tb);
      if (titleBlockIds.has(validated.id)) {
        throw new Error(`open: duplicate title block id '${validated.id}'`);
      }
      if (titleBlockNames.has(validated.name)) {
        throw new Error(`open: duplicate title block name '${validated.name}'`);
      }
      titleBlockIds.add(validated.id);
      titleBlockNames.add(validated.name);
      titleBlockRecords.push(validated);
    }
    const scheduleRecords: ScheduleRecord[] = [];
    const scheduleIds = new Set<string>();
    const scheduleNames = new Set<string>();
    for (const s of [...(snapshot.schedules ?? [])]) {
      const validated = validateScheduleRecord(s);
      if (scheduleIds.has(validated.id)) {
        throw new Error(`open: duplicate schedule id '${validated.id}'`);
      }
      if (scheduleNames.has(validated.name)) {
        throw new Error(`open: duplicate schedule name '${validated.name}'`);
      }
      scheduleIds.add(validated.id);
      scheduleNames.add(validated.name);
      scheduleRecords.push(validated);
    }
    // CAD-PARITY-015: adopt the property-definition registry when present
    // (validated structurally — unique ids, unique names, unique (set, key)
    // addresses; LOCK-007); a legacy snapshot opens with an empty registry
    // (the additive-feature default, not a repair).
    const propertyDefRecords: PropertyDefRecord[] = [];
    const propertyDefIds = new Set<string>();
    const propertyDefNames = new Set<string>();
    const propertyDefAddresses = new Set<string>();
    for (const d of [...(snapshot.propertyDefs ?? [])]) {
      const validated = validatePropertyDefRecord(d);
      if (propertyDefIds.has(validated.id)) {
        throw new Error(`open: duplicate property definition id '${validated.id}'`);
      }
      if (propertyDefNames.has(validated.name)) {
        throw new Error(`open: duplicate property definition name '${validated.name}'`);
      }
      const address = `${validated.set}.${validated.key}`;
      if (propertyDefAddresses.has(address)) {
        throw new Error(`open: duplicate property definition address '${address}' (set + key must be unique among definitions)`);
      }
      propertyDefIds.add(validated.id);
      propertyDefNames.add(validated.name);
      propertyDefAddresses.add(address);
      propertyDefRecords.push(validated);
    }
    // CAD-PARITY-018 (Issue #118): the specialized-toolsets records (the
    // single toolsets-core grammar + id/raster-sourceRef uniqueness).
    const specializedRecords: SpecializedRecord[] = [];
    const specializedIds = new Set<string>();
    const rasterSourceRefs = new Set<string>();
    for (const raw of [...(snapshot.specialized ?? [])]) {
      const validated = normalizeToolsetRecord(raw);
      if (specializedIds.has(validated.id)) {
        throw new Error(`open: duplicate specialized record id '${validated.id}'`);
      }
      if (validated.kind === "raster.source") {
        if (rasterSourceRefs.has(validated.data.sourceRef)) {
          throw new Error(
            `open: duplicate raster sourceRef '${validated.data.sourceRef}' (source references are unique among raster sources)`,
          );
        }
        rasterSourceRefs.add(validated.data.sourceRef);
      }
      specializedIds.add(validated.id);
      specializedRecords.push(validated);
    }
    const revisionRecords: RevisionRecord[] = [];
    const revisionIds = new Set<string>();
    const revisionCodes = new Set<string>();
    for (const rev of [...(snapshot.revisions ?? [])]) {
      const validated = validateRevisionRecord(rev);
      if (revisionIds.has(validated.id)) {
        throw new Error(`open: duplicate revision id '${validated.id}'`);
      }
      if (revisionCodes.has(validated.code)) {
        throw new Error(`open: duplicate revision code '${validated.code}'`);
      }
      revisionIds.add(validated.id);
      revisionCodes.add(validated.code);
      revisionRecords.push(validated);
    }
    const publisherSetRecords: PublisherSetRecord[] = [];
    const publisherSetIds = new Set<string>();
    const publisherSetNames = new Set<string>();
    for (const ps of [...(snapshot.publisherSets ?? [])]) {
      const validated = validatePublisherSetRecord(ps);
      if (publisherSetIds.has(validated.id)) {
        throw new Error(`open: duplicate publisher set id '${validated.id}'`);
      }
      if (publisherSetNames.has(validated.name)) {
        throw new Error(`open: duplicate publisher set name '${validated.name}'`);
      }
      publisherSetIds.add(validated.id);
      publisherSetNames.add(validated.name);
      publisherSetRecords.push(validated);
    }
    // The P013 cross-table reference integrity pass (every table is adopted
    // now — a dangling reference is corrupt, not repairable, LOCK-007).
    for (const view of docsViews) {
      if (view.folderId !== undefined) {
        const folder = navigatorNodeRecords.find((n) => n.id === view.folderId);
        if (folder === undefined || folder.kind !== "folder") {
          throw new Error(
            `open: view '${view.id}' folderId '${view.folderId}' does not reference a navigator folder node`,
          );
        }
      }
    }
    for (const layout of layouts) {
      if (layout.subsetId !== undefined) {
        const subset = navigatorNodeRecords.find((n) => n.id === layout.subsetId);
        if (subset === undefined || subset.kind !== "subset") {
          throw new Error(
            `open: layout '${layout.id}' subsetId '${layout.subsetId}' does not reference a navigator subset node`,
          );
        }
      }
      if (layout.masterId !== undefined) {
        const master = layouts.find((l) => l.id === layout.masterId);
        if (master === undefined) {
          throw new Error(`open: layout '${layout.id}' masterId '${layout.masterId}' does not reference an adopted layout`);
        }
        if (master.id === layout.id) {
          throw new Error(`open: layout '${layout.id}' references itself as master`);
        }
        if (master.masterId !== undefined) {
          throw new Error(
            `open: layout '${layout.id}' master '${master.id}' itself has a master — single-level masters only`,
          );
        }
      }
      if (layout.titleBlockPlacement !== undefined && !titleBlockIds.has(layout.titleBlockPlacement.titleBlockId)) {
        throw new Error(
          `open: layout '${layout.id}' titleBlockPlacement references unknown title block '${layout.titleBlockPlacement.titleBlockId}'`,
        );
      }
      if (layout.revisionIds !== undefined) {
        for (const revId of layout.revisionIds) {
          if (!revisionIds.has(revId)) {
            throw new Error(`open: layout '${layout.id}' references unknown revision '${revId}'`);
          }
        }
      }
    }
    for (const rev of revisionRecords) {
      for (const layoutId of rev.layoutIds) {
        if (!layoutIds.has(layoutId)) {
          throw new Error(`open: revision '${rev.id}' references unknown layout '${layoutId}'`);
        }
      }
    }
    for (const ps of publisherSetRecords) {
      for (const item of ps.items) {
        if (item.kind === "layout" && !layoutIds.has(item.id)) {
          throw new Error(`open: publisher set '${ps.id}' item references unknown layout '${item.id}'`);
        }
        if (item.kind === "subset") {
          const node = navigatorNodeRecords.find((n) => n.id === item.id);
          if (node === undefined || node.kind !== "subset") {
            throw new Error(
              `open: publisher set '${ps.id}' item references navigator node '${item.id}' that is not a subset`,
            );
          }
        }
      }
    }
    return new CADDocument(
      snapshot.version,
      snapshot.elements,
      snapshot.format,
      snapshot.formatVersion,
      snapshot.sourceArtifactLineage,
      createdBy,
      snapshot.selection ?? [],
      history,
      Math.max(nextElementSequence, history.next_element_sequence),
      layers,
      Math.max(deriveLayerSequence(layers), history.next_layer_sequence ?? 1),
      adoptedSettings,
      bimSettings,
      docsViews,
      Math.max(deriveViewSequence(docsViews), history.next_view_sequence ?? 1),
      docsSheets,
      Math.max(deriveSheetSequence(docsSheets), history.next_sheet_sequence ?? 1),
      ifcImports,
      Math.max(deriveIfcImportSequence(ifcImports), history.next_ifc_import_sequence ?? 1),
      ltypes,
      textStyles,
      dimStyles,
      layerStates,
      blockDefs,
      Math.max(deriveBlockSequence(blockDefs), history.next_block_sequence ?? 1),
      xrefs,
      Math.max(deriveXrefSequence(xrefs), history.next_xref_sequence ?? 1),
      constraints,
      Math.max(deriveConstraintSequence(constraints), history.next_constraint_sequence ?? 1),
      layouts,
      Math.max(deriveLayoutSequence(layouts), history.next_layout_sequence ?? 1),
      viewports,
      Math.max(deriveViewportSequence(viewports), history.next_viewport_sequence ?? 1),
      ucsRecords,
      Math.max(deriveUcsSequence(ucsRecords), history.next_ucs_sequence ?? 1),
      sectionPlaneRecords,
      Math.max(deriveSectionPlaneSequence(sectionPlaneRecords), history.next_section_plane_sequence ?? 1),
      navigatorNodeRecords,
      Math.max(deriveNavigatorNodeSequence(navigatorNodeRecords), history.next_navigator_node_sequence ?? 1),
      titleBlockRecords,
      Math.max(deriveTitleBlockSequence(titleBlockRecords), history.next_title_block_sequence ?? 1),
      scheduleRecords,
      Math.max(deriveScheduleSequence(scheduleRecords), history.next_schedule_sequence ?? 1),
      propertyDefRecords,
      Math.max(derivePropertyDefSequence(propertyDefRecords), history.next_property_def_sequence ?? 1),
      specializedRecords,
      Math.max(deriveSpecializedSequence(specializedRecords), history.next_specialized_sequence ?? 1),
      revisionRecords,
      Math.max(deriveRevisionSequence(revisionRecords), history.next_revision_sequence ?? 1),
      publisherSetRecords,
      Math.max(derivePublisherSetSequence(publisherSetRecords), history.next_publisher_set_sequence ?? 1),
    );
  }

  /** Create an empty document (root version, fresh "created" history). The
   *  drafting workspace starts with the canonical default layer "0" and the
   *  canonical default drafting settings (COMPAT-CAD-001). */
  static empty(entityId: string, format: string, formatVersion: string, createdBy: string): CADDocument {
    const root = rootVersion(entityId, createdBy, null, FIXED_NOW);
    const history = createdHistory(entityId, format, formatVersion, root);
    return new CADDocument(
      root,
      [],
      format,
      formatVersion,
      [],
      createdBy,
      [],
      history,
      1,
      [DEFAULT_LAYER],
      1,
      defaultDraftingSettings(),
      defaultBimSettings(),
      [],
      1,
      [],
      1,
      [],
      1,
      // CAD-PARITY-004: empty name-keyed tables (built-ins are code-resolved).
      [],
      [],
      [],
      [],
      // CAD-PARITY-006: empty block-definition + xref tables.
      [],
      1,
      [],
      1,
      // CAD-PARITY-007: empty constraint table.
      [],
      1,
      // CAD-PARITY-008: empty layout + viewport tables.
      [],
      1,
      [],
      1,
      // CAD-PARITY-009: empty UCS + section-plane tables (the World UCS is
      // implicit — never a table record).
      [],
      1,
      [],
      1,
      // CAD-PARITY-013: empty documentation production tables.
      [],
      1,
      [],
      1,
      [],
      1,
      // CAD-PARITY-015: empty property-definition registry.
      [],
      1,
      // CAD-PARITY-018: empty specialized-toolsets record table.
      [],
      1,
      [],
      1,
      [],
      1,
    );
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get commandDepth(): number {
    return this.undoStack.length;
  }
  /** Current ephemeral editor selection (orthogonal to the versioned snapshot). */
  get selection(): readonly string[] {
    return this.#selection;
  }
  /** COMPAT-CAD-001: the persistent drawing layer table (insertion order). */
  get layerTable(): readonly LayerRecord[] {
    return [...this.layers.values()];
  }
  /** COMPAT-IFC-001: the deterministic IFC import records (insertion order). */
  get ifcImportRecords(): readonly IfcImportRecordView[] {
    return [...this.ifcImports.values()];
  }
  /** COMPAT-CAD-001: the non-versioned drafting workspace settings. */
  get draftingSettings(): DraftingSettings {
    return this.draftingSettingsState;
  }
  /** COMPAT-CAD-002: the non-versioned BIM workspace settings. */
  get bimSettings(): BimSettings {
    return this.bimSettingsState;
  }
  /** The immutable model revision history (frozen; LOCK-005). */
  get history(): ModelHistory {
    return this.historyState;
  }
  /** Canonical hash of the model history (persistence/parity anchor). */
  getHistoryHash(): string {
    return historyHash(this.historyState);
  }

  /** Replace the editor selection. Does NOT bump the version or push undo. */
  setSelection(ids: readonly string[]): void {
    this.#selection = [...ids];
  }

  /** COMPAT-CAD-001: replace the drafting workspace settings (validated +
   *  canonicalized). Does NOT bump the version or push undo — settings are
   *  presentation/configuration state, like the selection, but persisted. */
  setDraftingSettings(settings: DraftingSettings): void {
    this.draftingSettingsState = validateDraftingSettings(settings);
  }

  /** COMPAT-CAD-002: replace the BIM workspace settings (validated +
   *  canonicalized). Same non-versioned-but-persisted contract as the
   *  drafting settings. */
  setBimSettings(settings: BimSettings): void {
    this.bimSettingsState = validateBimSettings(settings);
  }

  /** Apply an edit, bump version, push inverse onto undo stack, clear redo,
   *  append an immutable revision to the model history. Returns the computed
   *  inverse (for audit).
   *
   *  COMPAT-CAD-001: `applyEdits` batches are atomic — sub-edits are applied
   *  in order with their per-sub-edit inverses captured INTERLEAVED (a later
   *  sub-edit's inverse may depend on the state produced by an earlier
   *  sub-edit), and the recorded inverse is the reversed inverse batch. One
   *  execute = one version = one revision = one undo entry. */
  execute(edit: DocumentEdit): DocumentEdit {
    // CAD-PARITY-004: locked/frozen layer enforcement — the SINGLE semantic
    // gate for every FORWARD edit path (App API commands, entity ops, raw
    // document.applyEdit). Drafting entities on a LOCKED layer reject
    // modification/removal; new drafting entities cannot be created on a
    // FROZEN layer; moving an entity ONTO a locked/frozen layer is rejected.
    // Undo/redo bypass this gate by design (journal semantics — undoing a
    // locked-layer edit after a later lock change must never wedge the
    // journal; AutoCAD-class behavior).
    this.validateEditLocking(edit);
    const normalized = this.normalizeEdit(edit);
    const beforeElements = [...this.elements.values()];
    const inverse = this.applyWithInverse(normalized);
    const fromVersion = this.version;
    const contentHash = this.contentHashAt(fromVersion);
    this.version = childVersion(fromVersion, contentHash, this.createdBy, fromVersion.source_snapshot_id, FIXED_NOW);
    this.undoStack.push({ forward: normalized, inverse, fromVersion, toVersion: this.version });
    this.redoStack.length = 0;
    this.historyState = appendRevision({
      history: this.historyState,
      fromVersionId: fromVersion.version_id,
      toVersion: this.version,
      contentHash,
      appliedEdit: normalized,
      note: "edit",
      createdBy: this.createdBy,
      beforeElements,
      afterElements: [...this.elements.values()],
      nextElementSequence: this.nextElementSequence,
      nextLayerSequence: this.nextLayerSequence,
      nextViewSequence: this.nextViewSequence,
      nextSheetSequence: this.nextSheetSequence,
      nextIfcImportSequence: this.nextIfcImportSequence,
      nextBlockSequence: this.nextBlockSequence,
      nextXrefSequence: this.nextXrefSequence,
      nextConstraintSequence: this.nextConstraintSequence,
      nextLayoutSequence: this.nextLayoutSequence,
      nextViewportSequence: this.nextViewportSequence,
      nextUcsSequence: this.nextUcsSequence,
      nextSectionPlaneSequence: this.nextSectionPlaneSequence,
      // CAD-PARITY-013: the documentation production mint counters.
      nextNavigatorNodeSequence: this.nextNavigatorNodeSequence,
      nextTitleBlockSequence: this.nextTitleBlockSequence,
      nextScheduleSequence: this.nextScheduleSequence,
      nextPropertyDefSequence: this.nextPropertyDefSequence,
      // CAD-PARITY-018: the specialized-toolsets mint counter.
      nextSpecializedSequence: this.nextSpecializedSequence,
      nextRevisionSequence: this.nextRevisionSequence,
      nextPublisherSetSequence: this.nextPublisherSetSequence,
    });
    return inverse;
  }

  /** Apply an edit AND compute its inverse in one pass. For composite batches
   *  the sub-edit inverses are captured between applications (state-correct). */
  private applyWithInverse(edit: DocumentEdit): DocumentEdit {
    if (edit.type === "applyEdits") {
      const inverses: DocumentEdit[] = [];
      for (const sub of edit.edits) {
        inverses.push(this.applyWithInverse(sub));
      }
      inverses.reverse();
      return { type: "applyEdits", edits: inverses };
    }
    const inverse = this.computeInverse(edit);
    this.applyEdit(edit);
    return inverse;
  }

  /** Undo the last edit. Reverts content and version, records the inverse
   *  transition as a revision. Returns the undone forward edit, or null if
   *  there is nothing to undo. */
  undo(): DocumentEdit | null {
    const entry = this.undoStack.pop();
    if (entry === undefined) return null;
    const fromVersion = this.version; // the version being left
    const beforeElements = [...this.elements.values()];
    this.applyEdit(entry.inverse);
    this.version = entry.fromVersion;
    this.redoStack.push(entry);
    const contentHash = this.contentHashAt(entry.fromVersion);
    this.historyState = appendRevision({
      history: this.historyState,
      fromVersionId: fromVersion.version_id,
      toVersion: entry.fromVersion,
      contentHash,
      appliedEdit: entry.inverse,
      note: "undo",
      createdBy: this.createdBy,
      beforeElements,
      afterElements: [...this.elements.values()],
      nextElementSequence: this.nextElementSequence,
      nextLayerSequence: this.nextLayerSequence,
      nextViewSequence: this.nextViewSequence,
      nextSheetSequence: this.nextSheetSequence,
      nextBlockSequence: this.nextBlockSequence,
      nextXrefSequence: this.nextXrefSequence,
      nextConstraintSequence: this.nextConstraintSequence,
      nextLayoutSequence: this.nextLayoutSequence,
      nextViewportSequence: this.nextViewportSequence,
      nextUcsSequence: this.nextUcsSequence,
      nextSectionPlaneSequence: this.nextSectionPlaneSequence,
      // CAD-PARITY-013: the documentation production mint counters.
      nextNavigatorNodeSequence: this.nextNavigatorNodeSequence,
      nextTitleBlockSequence: this.nextTitleBlockSequence,
      nextScheduleSequence: this.nextScheduleSequence,
      nextPropertyDefSequence: this.nextPropertyDefSequence,
      // CAD-PARITY-018: the specialized-toolsets mint counter.
      nextSpecializedSequence: this.nextSpecializedSequence,
      nextRevisionSequence: this.nextRevisionSequence,
      nextPublisherSetSequence: this.nextPublisherSetSequence,
    });
    return entry.forward;
  }

  /** Redo the last undone edit. Re-applies content and version, records the
   *  transition as a revision. Returns the re-applied forward edit, or null
   *  if there is nothing to redo. */
  redo(): DocumentEdit | null {
    const entry = this.redoStack.pop();
    if (entry === undefined) return null;
    const fromVersion = this.version; // the version being left
    const beforeElements = [...this.elements.values()];
    this.applyEdit(entry.forward);
    this.version = entry.toVersion;
    this.undoStack.push(entry);
    const contentHash = this.contentHashAt(entry.toVersion);
    this.historyState = appendRevision({
      history: this.historyState,
      fromVersionId: fromVersion.version_id,
      toVersion: entry.toVersion,
      contentHash,
      appliedEdit: entry.forward,
      note: "redo",
      createdBy: this.createdBy,
      beforeElements,
      afterElements: [...this.elements.values()],
      nextElementSequence: this.nextElementSequence,
      nextLayerSequence: this.nextLayerSequence,
      nextViewSequence: this.nextViewSequence,
      nextSheetSequence: this.nextSheetSequence,
      nextBlockSequence: this.nextBlockSequence,
      nextXrefSequence: this.nextXrefSequence,
      nextConstraintSequence: this.nextConstraintSequence,
      nextLayoutSequence: this.nextLayoutSequence,
      nextViewportSequence: this.nextViewportSequence,
      nextUcsSequence: this.nextUcsSequence,
      nextSectionPlaneSequence: this.nextSectionPlaneSequence,
      // CAD-PARITY-013: the documentation production mint counters.
      nextNavigatorNodeSequence: this.nextNavigatorNodeSequence,
      nextTitleBlockSequence: this.nextTitleBlockSequence,
      nextScheduleSequence: this.nextScheduleSequence,
      nextPropertyDefSequence: this.nextPropertyDefSequence,
      // CAD-PARITY-018: the specialized-toolsets mint counter.
      nextSpecializedSequence: this.nextSpecializedSequence,
      nextRevisionSequence: this.nextRevisionSequence,
      nextPublisherSetSequence: this.nextPublisherSetSequence,
    });
    return entry.forward;
  }

  /** An immutable point-in-time snapshot (§5.4), including the immutable
   *  model revision history (persisted through save/open; CAD-IMPLEMENT-003)
   *  and — since COMPAT-CAD-001 — the layer table, the editor selection and
   *  the drafting workspace settings (all persisted through save/open). */
  snapshot(): CADDocumentSnapshot {
    const editorState: EditorState = {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      commandDepth: this.commandDepth,
    };
    return {
      version: this.version,
      format: this.format,
      formatVersion: this.formatVersion,
      sourceArtifactLineage: this.sourceArtifactLineage,
      editorState,
      elements: [...this.elements.values()],
      modelHistory: this.historyState,
      layers: [...this.layers.values()],
      selection: [...this.#selection],
      draftingSettings: this.draftingSettingsState,
      bimSettings: this.bimSettingsState,
      // COMPAT-CAD-003: documentation tables — omitted on docs-free documents
      // so legacy snapshots stay byte-identical (additive-optional contract).
      ...(this.docsViews.size > 0 ? { docsViews: [...this.docsViews.values()] } : {}),
      ...(this.docsSheets.size > 0 ? { docsSheets: [...this.docsSheets.values()] } : {}),
      // COMPAT-IFC-001: deterministic import records — omitted when none so
      // legacy snapshots stay byte-identical (additive-optional contract).
      ...(this.ifcImports.size > 0 ? { ifcImports: [...this.ifcImports.values()] } : {}),
      // CAD-PARITY-004: the name-keyed standards/style/state tables — omitted
      // while empty so legacy snapshots (and the pinned parity fixture) stay
      // byte-identical (additive-optional contract).
      ...(this.ltypes.size > 0 ? { ltypes: [...this.ltypes.values()] } : {}),
      ...(this.textStyles.size > 0 ? { textStyles: [...this.textStyles.values()] } : {}),
      ...(this.dimStyles.size > 0 ? { dimStyles: [...this.dimStyles.values()] } : {}),
      ...(this.layerStates.size > 0 ? { layerStates: [...this.layerStates.values()] } : {}),
      // CAD-PARITY-006: the block-definition + xref tables — omitted while
      // empty so legacy snapshots (and the pinned parity fixtures) stay
      // byte-identical (additive-optional contract).
      ...(this.blockDefs.size > 0 ? { blockDefs: [...this.blockDefs.values()] } : {}),
      ...(this.xrefs.size > 0 ? { xrefs: [...this.xrefs.values()] } : {}),
      // CAD-PARITY-007: the declared constraint graph — omitted while empty
      // (the same additive-optional contract; satisfaction is never stored).
      ...(this.constraints.size > 0 ? { constraints: [...this.constraints.values()] } : {}),
      // CAD-PARITY-008: the layout + viewport tables — omitted while empty
      // so legacy snapshots (and the pinned parity fixtures) stay
      // byte-identical (the additive-optional contract; the plot IR is
      // derived state, never stored).
      ...(this.layouts.size > 0 ? { layouts: [...this.layouts.values()] } : {}),
      ...(this.viewports.size > 0 ? { viewports: [...this.viewports.values()] } : {}),
      // CAD-PARITY-009: the named UCS + section-plane tables — omitted while
      // empty so legacy snapshots (and the pinned parity fixtures) stay
      // byte-identical (the additive-optional contract; the World UCS is
      // implicit, never a record; the section preview is derived, never
      // stored).
      ...(this.ucsTable.size > 0 ? { ucs: [...this.ucsTable.values()] } : {}),
      ...(this.sectionPlanes.size > 0 ? { sectionPlanes: [...this.sectionPlanes.values()] } : {}),
      // CAD-PARITY-013: the documentation production tables — omitted while
      // empty so legacy snapshots (and the pinned CAD-PARITY-002..012 parity
      // fixtures) stay byte-identical (the additive-optional contract).
      ...(this.navigatorNodes.size > 0 ? { navigatorNodes: [...this.navigatorNodes.values()] } : {}),
      ...(this.titleBlocks.size > 0 ? { titleBlocks: [...this.titleBlocks.values()] } : {}),
      ...(this.schedules.size > 0 ? { schedules: [...this.schedules.values()] } : {}),
      ...(this.propertyDefs.size > 0 ? { propertyDefs: [...this.propertyDefs.values()] } : {}),
      // CAD-PARITY-018: the specialized-toolsets record table — omitted while
      // empty so legacy snapshots (and every pinned fixture) stay
      // byte-identical (the additive-optional contract).
      ...(this.specialized.size > 0 ? { specialized: [...this.specialized.values()] } : {}),
      ...(this.revisions.size > 0 ? { revisions: [...this.revisions.values()] } : {}),
      ...(this.publisherSets.size > 0 ? { publisherSets: [...this.publisherSets.values()] } : {}),
    };
  }

  // --- Internals -----------------------------------------------------------

  /** CAD-PARITY-004: locked/frozen layer enforcement for FORWARD edits (the
   *  execute() gate — undo/redo bypass by journal semantics). The walk
   * simulates applyEdits batches in order so a batch that unlocks a layer
   * and then edits its entities is legitimate, while a batch that edits a
   * locked layer's entities is rejected deterministically.
   *  - DRAFTING entities (props.drafting === true) on a locked layer reject
   *    updateElement/setProps/removeElement;
   *  - new drafting entities cannot be ADDED to a frozen layer;
   *  - a patch/setProps that reassigns an entity ONTO a locked or frozen
   *    layer is rejected.
   *  BIM/annotation elements are not layer-managed (documented scope). */
  private validateEditLocking(edit: DocumentEdit): void {
    const frozenOverrides = new Map<string, boolean>();
    const lockedOverrides = new Map<string, boolean>();
    const layerFrozen = (id: string): boolean => {
      if (frozenOverrides.has(id)) return frozenOverrides.get(id) === true;
      return this.layers.get(id)?.frozen === true;
    };
    const layerLocked = (id: string): boolean => {
      if (lockedOverrides.has(id)) return lockedOverrides.get(id) === true;
      return this.layers.get(id)?.locked === true;
    };
    const checkTargetLayer = (target: unknown): void => {
      if (typeof target !== "string" || target.length === 0) return;
      if (layerFrozen(target)) {
        throw new Error(`layer '${target}' is frozen — entities cannot be assigned to a frozen layer`);
      }
      if (layerLocked(target)) {
        throw new Error(`layer '${target}' is locked — entities cannot be assigned to a locked layer`);
      }
    };
    const walk = (e: DocumentEdit): void => {
      switch (e.type) {
        case "applyEdits": {
          for (const sub of e.edits) walk(sub);
          return;
        }
        case "updateLayer": {
          if (e.layerId === undefined) return;
          frozenOverrides.set(e.layerId, e.patch.frozen !== undefined ? e.patch.frozen === true : layerFrozen(e.layerId));
          lockedOverrides.set(e.layerId, e.patch.locked !== undefined ? e.patch.locked === true : layerLocked(e.layerId));
          return;
        }
        case "addLayer": {
          const layer = e.layer;
          if (layer !== undefined) {
            frozenOverrides.set(layer.id, layer.frozen === true);
            lockedOverrides.set(layer.id, layer.locked === true);
          }
          return;
        }
        case "removeLayer":
          return;
        case "addElement": {
          const p = e.element?.props as Record<string, unknown> | undefined;
          if (p !== undefined && p.drafting === true && typeof p.layer === "string") {
            if (layerFrozen(p.layer)) {
              throw new Error(`layer '${p.layer}' is frozen — new entities cannot be created on a frozen layer`);
            }
          }
          return;
        }
        case "updateElement":
        case "setProps": {
          const el = this.elements.get(e.elementId);
          if (el === undefined) return;
          const p = el.props as Record<string, unknown>;
          if (p.drafting === true && typeof p.layer === "string" && layerLocked(p.layer)) {
            throw new Error(`element '${el.id}' is on locked layer '${p.layer}' — unlock the layer to modify it`);
          }
          checkTargetLayer((e.patch as Record<string, unknown> | undefined)?.layer);
          return;
        }
        case "removeElement": {
          const el = this.elements.get(e.elementId);
          if (el === undefined) return;
          const p = el.props as Record<string, unknown>;
          if (p.drafting === true && typeof p.layer === "string" && layerLocked(p.layer)) {
            throw new Error(`element '${el.id}' is on locked layer '${p.layer}' — unlock the layer to erase it`);
          }
          return;
        }
        default:
          return;
      }
    };
    walk(edit);
  }

  /** Canonical-identity normalization for incoming edits (§5.4):
   *  - addElement with a missing/non-string/empty id → the DOCUMENT mints a
   *    canonical identity (`el-NNNNNN`, monotonic, never reused);
   *  - addElement with an id that already exists → rejected (an id must
   *    identify ONE element for its whole lifetime — identity stability);
   *  - COMPAT-CAD-001: addLayer with a missing/empty id → the DOCUMENT mints
   *    `ly-NNNNNN` the same way (monotonic, never reused); applyEdits batches
   *    normalize their sub-edits recursively, in order. */
  private normalizeEdit(edit: DocumentEdit): DocumentEdit {
    if (edit.type === "applyEdits") {
      if (edit.edits.length === 0) {
        throw new Error("applyEdits requires at least one sub-edit (an empty batch is a no-op command)");
      }
      return { type: "applyEdits", edits: edit.edits.map((sub) => this.normalizeEdit(sub)) };
    }
    if (edit.type === "addLayer") {
      const layer = validateLayerRecord(edit.layer);
      if (this.layers.has(layer.id)) {
        throw new Error(
          `addLayer: layer id '${layer.id}' already exists — canonical layer identity must not be reused while the layer exists`,
        );
      }
      return edit;
    }
    // COMPAT-CAD-003: addView mints a `vw-NNNNNN` identity when missing (the
    // addElement pattern); an explicit id is validated + duplicate-checked.
    if (edit.type === "addView") {
      const raw = edit.view as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) {
        const view = validateDocsViewRecord(edit.view);
        if (this.docsViews.has(view.id)) {
          throw new Error(
            `addView: view id '${view.id}' already exists — canonical view identity must not be reused while the view exists`,
          );
        }
        return edit;
      }
      const minted = this.mintViewId();
      const view = validateDocsViewRecord({ ...edit.view, id: minted });
      return { ...edit, view } as DocumentEdit;
    }
    // COMPAT-CAD-003: addSheet mints a `sh-NNNNNN` identity when missing.
    if (edit.type === "addSheet") {
      const raw = edit.sheet as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) {
        const sheet = validateDocsSheetRecord(edit.sheet);
        if (this.docsSheets.has(sheet.id)) {
          throw new Error(
            `addSheet: sheet id '${sheet.id}' already exists — canonical sheet identity must not be reused while the sheet exists`,
          );
        }
        return edit;
      }
      const minted = this.mintSheetId();
      const sheet = validateDocsSheetRecord({ ...edit.sheet, id: minted });
      return { ...edit, sheet } as DocumentEdit;
    }
    // COMPAT-IFC-001: addIfcImport mints an `if-NNNNNN` identity when missing.
    if (edit.type === "addIfcImport") {
      const raw = edit.record as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) {
        const record = validateIfcImportRecord(edit.record);
        if (this.ifcImports.has(record.id)) {
          throw new Error(
            `addIfcImport: record id '${record.id}' already exists — canonical record identity must not be reused while the record exists`,
          );
        }
        return edit;
      }
      const minted = this.mintIfcImportId();
      const record = validateIfcImportRecord({ ...edit.record, id: minted });
      return { ...edit, record } as DocumentEdit;
    }
    // CAD-PARITY-006: addBlockDef mints a `blk-NNNNNN` identity when missing
    // (the addView pattern); an explicit id is validated + duplicate-checked
    // at apply time (validateBlockDefWrite).
    if (edit.type === "addBlockDef") {
      const raw = edit.block as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      const minted = this.mintBlockId();
      return { ...edit, block: { ...edit.block, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-006: addXref mints an `xr-NNNNNN` identity when missing.
    if (edit.type === "addXref") {
      const raw = edit.xref as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      const minted = this.mintXrefId();
      return { ...edit, xref: { ...edit.xref, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-007: addConstraint mints a `con-NNNNNN` identity when
    // missing (the addBlockDef pattern); an explicit id is validated +
    // duplicate-checked at apply time (applyAddConstraint). The mint skips
    // past explicitly-taken ids (never-reuse stays collision-free).
    if (edit.type === "addConstraint") {
      const raw = edit.constraint as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintConstraintId();
      while (this.constraints.has(minted)) minted = this.mintConstraintId();
      return { ...edit, constraint: { ...edit.constraint, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-008: addLayout mints a `lo-NNNNNN` identity when missing
    // (the addConstraint pattern — the mint skips past taken ids).
    if (edit.type === "addLayout") {
      const raw = edit.layout as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintLayoutId();
      while (this.layouts.has(minted)) minted = this.mintLayoutId();
      return { ...edit, layout: { ...edit.layout, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-008: addViewport mints a `vp-NNNNNN` identity when missing.
    if (edit.type === "addViewport") {
      const raw = edit.viewport as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintViewportId();
      while (this.viewports.has(minted)) minted = this.mintViewportId();
      return { ...edit, viewport: { ...edit.viewport, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-009: addUcs mints a `ucs-NNNNNN` identity when missing
    // (the addLayout pattern — the mint skips past taken ids).
    if (edit.type === "addUcs") {
      const raw = edit.ucs as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintUcsId();
      while (this.ucsTable.has(minted)) minted = this.mintUcsId();
      return { ...edit, ucs: { ...edit.ucs, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-009: addSectionPlane mints an `sp-NNNNNN` identity when
    // missing.
    if (edit.type === "addSectionPlane") {
      const raw = edit.sectionPlane as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintSectionPlaneId();
      while (this.sectionPlanes.has(minted)) minted = this.mintSectionPlaneId();
      return { ...edit, sectionPlane: { ...edit.sectionPlane, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-013 (Issue #104): the documentation production tables mint
    // their identities when missing (the addLayout pattern — the mint skips
    // past taken ids; explicit ids are validated + duplicate-checked at
    // apply time).
    if (edit.type === "addNavigatorNode") {
      const raw = edit.node as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintNavigatorNodeId();
      while (this.navigatorNodes.has(minted)) minted = this.mintNavigatorNodeId();
      return { ...edit, node: { ...edit.node, id: minted } } as DocumentEdit;
    }
    if (edit.type === "addTitleBlock") {
      const raw = edit.titleBlock as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintTitleBlockId();
      while (this.titleBlocks.has(minted)) minted = this.mintTitleBlockId();
      return { ...edit, titleBlock: { ...edit.titleBlock, id: minted } } as DocumentEdit;
    }
    if (edit.type === "addSchedule") {
      const raw = edit.schedule as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintScheduleId();
      while (this.schedules.has(minted)) minted = this.mintScheduleId();
      return { ...edit, schedule: { ...edit.schedule, id: minted } } as DocumentEdit;
    }
    if (edit.type === "addPropertyDef") {
      const raw = edit.propertyDef as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintPropertyDefId();
      while (this.propertyDefs.has(minted)) minted = this.mintPropertyDefId();
      return { ...edit, propertyDef: { ...edit.propertyDef, id: minted } } as DocumentEdit;
    }
    // CAD-PARITY-018 (Issue #118): the specialized-toolsets id mint (a
    // missing/empty record id mints a canonical `tls-NNNNNN` identity —
    // the same document-authority contract as every other table).
    if (edit.type === "addSpecialized") {
      const raw = edit.record as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintSpecializedId();
      while (this.specialized.has(minted)) minted = this.mintSpecializedId();
      return { ...edit, record: { ...edit.record, id: minted } } as DocumentEdit;
    }
    if (edit.type === "addRevision") {
      const raw = edit.revision as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintRevisionId();
      while (this.revisions.has(minted)) minted = this.mintRevisionId();
      return { ...edit, revision: { ...edit.revision, id: minted } } as DocumentEdit;
    }
    if (edit.type === "addPublisherSet") {
      const raw = edit.set as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return edit;
      let minted = this.mintPublisherSetId();
      while (this.publisherSets.has(minted)) minted = this.mintPublisherSetId();
      return { ...edit, set: { ...edit.set, id: minted } } as DocumentEdit;
    }
    if (edit.type !== "addElement") return edit;
    const element = edit.element;
    if (element === undefined) throw new Error("addElement requires element");
    const id = (element as { id?: unknown }).id;
    const needsMint = typeof id !== "string" || id.length === 0;
    if (!needsMint) {
      const elementId = id as string;
      if (this.elements.has(elementId)) {
        throw new Error(
          `addElement: element id '${elementId}' already exists — canonical element identity must not be reused while the element exists (remove it first)`,
        );
      }
      return edit;
    }
    const minted = `el-${String(this.nextElementSequence).padStart(6, "0")}`;
    this.nextElementSequence += 1;
    return { ...edit, element: { ...element, id: minted } } as DocumentEdit;
  }

  /** Mint a canonical layer identity (`ly-NNNNNN`, monotonic, never reused).
   *  Exposed for the drafting layer builders in the App API layer. */
  mintLayerId(): string {
    const minted = `ly-${String(this.nextLayerSequence).padStart(6, "0")}`;
    this.nextLayerSequence += 1;
    return minted;
  }

  /** COMPAT-CAD-002: mint a canonical element identity (`el-NNNNNN`, monotonic,
   *  never reused) WITHOUT adding an element — for composite builders that
   *  must wire references between batch-created copies (hosted BIM cascades)
   *  inside ONE atomic batch while identity minting stays a document
   *  authority (§5.4; mirrors mintLayerId). A minted-but-unused identity is
   *  burned, never reused. */
  mintElementId(): string {
    const minted = `el-${String(this.nextElementSequence).padStart(6, "0")}`;
    this.nextElementSequence += 1;
    return minted;
  }

  /** COMPAT-CAD-003: mint a canonical documentation view identity
   *  (`vw-NNNNNN`, monotonic, never reused) — document authority, mirrors
   *  mintLayerId/mintElementId. */
  mintViewId(): string {
    const minted = `vw-${String(this.nextViewSequence).padStart(6, "0")}`;
    this.nextViewSequence += 1;
    return minted;
  }

  /** COMPAT-CAD-003: mint a canonical documentation sheet identity
   *  (`sh-NNNNNN`, monotonic, never reused). */
  mintSheetId(): string {
    const minted = `sh-${String(this.nextSheetSequence).padStart(6, "0")}`;
    this.nextSheetSequence += 1;
    return minted;
  }

  /** COMPAT-IFC-001: mint the next `if-NNNNNN` import-record identity
   *  (document authority; monotonic, never reused). */
  mintIfcImportId(): string {
    const minted = `if-${String(this.nextIfcImportSequence).padStart(6, "0")}`;
    this.nextIfcImportSequence += 1;
    return minted;
  }

  /** COMPAT-CAD-003: the documentation view table (insertion order). */
  get viewTable(): readonly DocsViewRecord[] {
    return [...this.docsViews.values()];
  }

  /** COMPAT-CAD-003: the documentation sheet table (insertion order). */
  get sheetTable(): readonly DocsSheetRecord[] {
    return [...this.docsSheets.values()];
  }

  /** Look up a documentation view by canonical id. */
  viewById(id: string): DocsViewRecord | undefined {
    return this.docsViews.get(id);
  }

  /** Look up a documentation sheet by canonical id. */
  sheetById(id: string): DocsSheetRecord | undefined {
    return this.docsSheets.get(id);
  }

  /** Current mint counter for view identities (persisted via the history). */
  get viewSequence(): number {
    return this.nextViewSequence;
  }

  /** Current mint counter for sheet identities (persisted via the history). */
  get sheetSequence(): number {
    return this.nextSheetSequence;
  }

  private applyEdit(edit: DocumentEdit): void {
    switch (edit.type) {
      case "addElement": {
        if (edit.element === undefined) throw new Error("addElement requires element");
        this.elements.set(edit.element.id, edit.element);
        break;
      }
      case "removeElement": {
        if (edit.elementId === undefined) throw new Error("removeElement requires elementId");
        this.elements.delete(edit.elementId);
        break;
      }
      case "updateElement": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("updateElement requires elementId + patch");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`updateElement: no element '${edit.elementId}'`);
        this.elements.set(edit.elementId, { ...el, props: { ...el.props, ...edit.patch } });
        break;
      }
      case "setProps": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("setProps requires elementId + patch (full props)");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`setProps: no element '${edit.elementId}'`);
        this.elements.set(edit.elementId, { ...el, props: edit.patch });
        break;
      }
      // --- COMPAT-CAD-001 (additive): composite + layer edits ---
      case "applyEdits": {
        for (const sub of edit.edits) this.applyEdit(sub);
        break;
      }
      case "addLayer": {
        const layer = validateLayerRecord(edit.layer);
        if (this.layers.has(layer.id)) {
          throw new Error(`addLayer: layer id '${layer.id}' already exists`);
        }
        this.layers.set(layer.id, layer);
        break;
      }
      case "updateLayer": {
        if (edit.layerId === undefined || edit.patch === undefined) {
          throw new Error("updateLayer requires layerId + patch");
        }
        const current = this.layers.get(edit.layerId);
        if (current === undefined) throw new Error(`updateLayer: no layer '${edit.layerId}'`);
        this.layers.set(edit.layerId, applyLayerPatch(current, edit.patch));
        break;
      }
      case "removeLayer": {
        if (edit.layerId === undefined) throw new Error("removeLayer requires layerId");
        if (!this.layers.has(edit.layerId)) throw new Error(`removeLayer: no layer '${edit.layerId}'`);
        let references = 0;
        for (const el of this.elements.values()) {
          if (elementLayerReference(el.props) === edit.layerId) references += 1;
        }
        if (references > 0) {
          throw new Error(
            `removeLayer: layer '${edit.layerId}' is still referenced by ${references} element(s) — reassign or delete them first (no silent cascade)`,
          );
        }
        this.layers.delete(edit.layerId);
        break;
      }
      // --- COMPAT-CAD-003 (additive): documentation view/sheet edits ---
      case "addView": {
        if (edit.view === undefined) throw new Error("addView requires view");
        const view = validateDocsViewRecord(edit.view);
        if (this.docsViews.has(view.id)) throw new Error(`addView: view id '${view.id}' already exists`);
        this.validateViewReferences(view);
        this.docsViews.set(view.id, view);
        break;
      }
      case "updateView": {
        if (edit.viewId === undefined || edit.patch === undefined) {
          throw new Error("updateView requires viewId + patch");
        }
        const current = this.docsViews.get(edit.viewId);
        if (current === undefined) throw new Error(`updateView: no view '${edit.viewId}'`);
        const merged = applyViewPatch(current, edit.patch);
        this.validateViewReferences(merged);
        this.docsViews.set(edit.viewId, merged);
        break;
      }
      case "removeView": {
        if (edit.viewId === undefined) throw new Error("removeView requires viewId");
        if (!this.docsViews.has(edit.viewId)) throw new Error(`removeView: no view '${edit.viewId}'`);
        const sheetRefs = [...this.docsSheets.values()].filter((sh) =>
          sh.viewPlacements.some((p) => p.viewId === edit.viewId),
        );
        if (sheetRefs.length > 0) {
          throw new Error(
            `removeView: view '${edit.viewId}' is still placed on ${sheetRefs.length} sheet(s) (${sheetRefs.map((sh) => sh.id).join(", ")}) — remove those placements first (no silent cascade)`,
          );
        }
        let annotationRefs = 0;
        for (const el of this.elements.values()) {
          if (el.props.viewId === edit.viewId) annotationRefs += 1;
        }
        if (annotationRefs > 0) {
          throw new Error(
            `removeView: view '${edit.viewId}' is still referenced by ${annotationRefs} annotation element(s) — delete them first (no silent cascade)`,
          );
        }
        // Detail views referencing this view as their source also block removal.
        const detailRefs = [...this.docsViews.values()].filter((v) => v.sourceViewId === edit.viewId);
        if (detailRefs.length > 0) {
          throw new Error(
            `removeView: view '${edit.viewId}' is the detail source of ${detailRefs.length} detail view(s) (${detailRefs.map((v) => v.id).join(", ")}) — remove them first (no silent cascade)`,
          );
        }
        this.docsViews.delete(edit.viewId);
        break;
      }
      case "addSheet": {
        if (edit.sheet === undefined) throw new Error("addSheet requires sheet");
        const sheet = validateDocsSheetRecord(edit.sheet);
        if (this.docsSheets.has(sheet.id)) throw new Error(`addSheet: sheet id '${sheet.id}' already exists`);
        for (const placement of sheet.viewPlacements) {
          if (!this.docsViews.has(placement.viewId)) {
            throw new Error(`addSheet: placement references unknown view '${placement.viewId}'`);
          }
        }
        this.docsSheets.set(sheet.id, sheet);
        break;
      }
      case "addIfcImport": {
        if (edit.record === undefined) throw new Error("addIfcImport requires record");
        const record = validateIfcImportRecord(edit.record);
        if (this.ifcImports.has(record.id)) throw new Error(`addIfcImport: record id '${record.id}' already exists`);
        this.ifcImports.set(record.id, record);
        break;
      }
      case "removeIfcImport": {
        if (edit.recordId === undefined) throw new Error("removeIfcImport requires recordId");
        if (!this.ifcImports.has(edit.recordId)) throw new Error(`removeIfcImport: no record '${edit.recordId}'`);
        this.ifcImports.delete(edit.recordId);
        break;
      }
      case "updateSheet": {
        if (edit.sheetId === undefined || edit.patch === undefined) {
          throw new Error("updateSheet requires sheetId + patch");
        }
        const current = this.docsSheets.get(edit.sheetId);
        if (current === undefined) throw new Error(`updateSheet: no sheet '${edit.sheetId}'`);
        const merged = applySheetPatch(current, edit.patch);
        for (const placement of merged.viewPlacements) {
          if (!this.docsViews.has(placement.viewId)) {
            throw new Error(`updateSheet: placement references unknown view '${placement.viewId}'`);
          }
        }
        this.docsSheets.set(edit.sheetId, merged);
        break;
      }
      case "removeSheet": {
        if (edit.sheetId === undefined) throw new Error("removeSheet requires sheetId");
        if (!this.docsSheets.has(edit.sheetId)) throw new Error(`removeSheet: no sheet '${edit.sheetId}'`);
        this.docsSheets.delete(edit.sheetId);
        break;
      }
      // --- CAD-PARITY-004 (additive): standards/style tables + layer states ---
      case "addLtype": {
        if (edit.ltype === undefined) throw new Error("addLtype requires ltype");
        const ltype = validateLtypeRecord(edit.ltype);
        if (this.ltypes.has(ltype.name)) {
          throw new Error(`addLtype: linetype '${ltype.name}' already exists — remove it first`);
        }
        this.ltypes.set(ltype.name, ltype);
        break;
      }
      case "updateLtype": {
        if (edit.ltypeName === undefined || edit.patch === undefined) {
          throw new Error("updateLtype requires ltypeName + patch");
        }
        const current = this.ltypes.get(edit.ltypeName);
        if (current === undefined) throw new Error(`updateLtype: no linetype '${edit.ltypeName}'`);
        this.ltypes.set(edit.ltypeName, applyLtypePatch(current, edit.patch));
        break;
      }
      case "removeLtype": {
        if (edit.ltypeName === undefined) throw new Error("removeLtype requires ltypeName");
        if (!this.ltypes.has(edit.ltypeName)) throw new Error(`removeLtype: no linetype '${edit.ltypeName}'`);
        this.assertLtypeUnreferenced(edit.ltypeName);
        this.ltypes.delete(edit.ltypeName);
        break;
      }
      case "addTextStyle": {
        if (edit.style === undefined) throw new Error("addTextStyle requires style");
        const style = validateTextStyleRecord(edit.style);
        if (this.textStyles.has(style.name)) {
          throw new Error(`addTextStyle: text style '${style.name}' already exists — remove it first`);
        }
        this.textStyles.set(style.name, style);
        break;
      }
      case "updateTextStyle": {
        if (edit.styleName === undefined || edit.patch === undefined) {
          throw new Error("updateTextStyle requires styleName + patch");
        }
        const current = this.textStyles.get(edit.styleName);
        if (current === undefined) throw new Error(`updateTextStyle: no text style '${edit.styleName}'`);
        this.textStyles.set(edit.styleName, applyTextStylePatch(current, edit.patch));
        break;
      }
      case "removeTextStyle": {
        if (edit.styleName === undefined) throw new Error("removeTextStyle requires styleName");
        if (!this.textStyles.has(edit.styleName)) throw new Error(`removeTextStyle: no text style '${edit.styleName}'`);
        if (this.draftingSettingsState.textStyle === edit.styleName) {
          throw new Error(`removeTextStyle: '${edit.styleName}' is the current text style — switch to another style first`);
        }
        this.textStyles.delete(edit.styleName);
        break;
      }
      case "addDimStyle": {
        if (edit.style === undefined) throw new Error("addDimStyle requires style");
        const style = validateDimStyleRecord(edit.style);
        if (this.dimStyles.has(style.name)) {
          throw new Error(`addDimStyle: dimension style '${style.name}' already exists — remove it first`);
        }
        this.dimStyles.set(style.name, style);
        break;
      }
      case "updateDimStyle": {
        if (edit.styleName === undefined || edit.patch === undefined) {
          throw new Error("updateDimStyle requires styleName + patch");
        }
        const current = this.dimStyles.get(edit.styleName);
        if (current === undefined) throw new Error(`updateDimStyle: no dimension style '${edit.styleName}'`);
        this.dimStyles.set(edit.styleName, applyDimStylePatch(current, edit.patch));
        break;
      }
      case "removeDimStyle": {
        if (edit.styleName === undefined) throw new Error("removeDimStyle requires styleName");
        if (!this.dimStyles.has(edit.styleName)) throw new Error(`removeDimStyle: no dimension style '${edit.styleName}'`);
        if (this.draftingSettingsState.dimStyle === edit.styleName) {
          throw new Error(`removeDimStyle: '${edit.styleName}' is the current dimension style — switch to another style first`);
        }
        let refs = 0;
        for (const el of this.elements.values()) {
          if ((el.props as Record<string, unknown>).style === edit.styleName) refs += 1;
        }
        if (refs > 0) {
          throw new Error(`removeDimStyle: '${edit.styleName}' is referenced by ${refs} dimension element(s) — reassign them first (no silent cascade)`);
        }
        this.dimStyles.delete(edit.styleName);
        break;
      }
      case "addLayerState": {
        if (edit.state === undefined) throw new Error("addLayerState requires state");
        const state = validateLayerStateRecord(edit.state);
        // Same-name re-save replaces (LAYERSTATE semantics).
        this.layerStates.set(state.name, state);
        break;
      }
      case "removeLayerState": {
        if (edit.stateName === undefined) throw new Error("removeLayerState requires stateName");
        if (!this.layerStates.has(edit.stateName)) throw new Error(`removeLayerState: no layer state '${edit.stateName}'`);
        this.layerStates.delete(edit.stateName);
        break;
      }
      // --- CAD-PARITY-006 (additive): block definitions + xrefs ------------
      case "addBlockDef": {
        if (edit.block === undefined) throw new Error("addBlockDef requires block");
        const block = this.validateBlockDefWrite(edit.block, false);
        this.blockDefs.set(block.id, block);
        break;
      }
      case "updateBlockDef": {
        if (edit.blockId === undefined || edit.patch === undefined) {
          throw new Error("updateBlockDef requires blockId + patch");
        }
        const current = this.blockDefs.get(edit.blockId);
        if (current === undefined) throw new Error(`updateBlockDef: no block definition '${edit.blockId}'`);
        let patchedEntities: readonly Record<string, unknown>[] = current.entities;
        if (edit.patch.entities !== undefined) {
          try {
            patchedEntities = normalizeBlockEntities(edit.patch.entities as unknown[]);
          } catch (e) {
            throw new Error(`updateBlockDef: ${(e as Error).message}`);
          }
        }
        const merged = applyBlockDefPatch(current, edit.patch, (id) =>
          id === edit.blockId ? patchedEntities : this.blockDefs.get(id)?.entities,
        );
        this.assertBlockDefNameFree(merged.name, edit.blockId);
        this.assertBlockRefsResolve(merged.id, merged.entities);
        this.blockDefs.set(edit.blockId, merged);
        break;
      }
      case "setBlockDefRecord": {
        if (edit.blockId === undefined || edit.block === undefined) {
          throw new Error("setBlockDefRecord requires blockId + block");
        }
        const block = validateBlockDefinitionRecord(edit.block, (id) =>
          id === edit.blockId
            ? (edit.block as BlockDefinitionRecord).entities
            : this.blockDefs.get(id)?.entities,
        );
        if (block.id !== edit.blockId) throw new Error("setBlockDefRecord: block.id must equal blockId");
        if (!this.blockDefs.has(block.id)) throw new Error(`setBlockDefRecord: no block definition '${block.id}'`);
        this.assertBlockDefNameFree(block.name, block.id);
        this.assertBlockRefsResolve(block.id, block.entities);
        this.blockDefs.set(block.id, block);
        break;
      }
      case "removeBlockDef": {
        if (edit.blockId === undefined) throw new Error("removeBlockDef requires blockId");
        if (!this.blockDefs.has(edit.blockId)) throw new Error(`removeBlockDef: no block definition '${edit.blockId}'`);
        this.assertBlockDefUnreferenced(edit.blockId);
        this.blockDefs.delete(edit.blockId);
        break;
      }
      case "addXref": {
        if (edit.xref === undefined) throw new Error("addXref requires xref");
        const xref = validateXrefRecord(edit.xref);
        if (this.xrefs.has(xref.id)) {
          throw new Error(`addXref: reference id '${xref.id}' already exists — canonical reference identity must not be reused while the reference exists`);
        }
        this.assertXrefNameFree(xref.name, null);
        this.xrefs.set(xref.id, xref);
        break;
      }
      case "updateXref": {
        if (edit.xrefId === undefined || edit.patch === undefined) {
          throw new Error("updateXref requires xrefId + patch");
        }
        const current = this.xrefs.get(edit.xrefId);
        if (current === undefined) throw new Error(`updateXref: no external reference '${edit.xrefId}'`);
        const merged = applyXrefPatch(current, edit.patch);
        this.assertXrefNameFree(merged.name, edit.xrefId);
        this.xrefs.set(edit.xrefId, merged);
        break;
      }
      case "setXrefRecord": {
        if (edit.xrefId === undefined || edit.xref === undefined) {
          throw new Error("setXrefRecord requires xrefId + xref");
        }
        const xref = validateXrefRecord(edit.xref);
        if (xref.id !== edit.xrefId) throw new Error("setXrefRecord: xref.id must equal xrefId");
        if (!this.xrefs.has(xref.id)) throw new Error(`setXrefRecord: no external reference '${xref.id}'`);
        this.assertXrefNameFree(xref.name, xref.id);
        this.xrefs.set(xref.id, xref);
        break;
      }
      case "removeXref": {
        if (edit.xrefId === undefined) throw new Error("removeXref requires xrefId");
        if (!this.xrefs.has(edit.xrefId)) throw new Error(`removeXref: no external reference '${edit.xrefId}'`);
        this.assertXrefUnreferenced(edit.xrefId);
        this.xrefs.delete(edit.xrefId);
        break;
      }
      // --- CAD-PARITY-007 (additive): the parametric constraint table ----
      case "addConstraint": {
        if (edit.constraint === undefined) throw new Error("addConstraint requires constraint");
        const constraint = validateConstraintRecord(edit.constraint);
        if (this.constraints.has(constraint.id)) {
          throw new Error(
            `addConstraint: constraint id '${constraint.id}' already exists — canonical constraint identity must not be reused while the constraint exists`,
          );
        }
        this.constraints.set(constraint.id, constraint);
        break;
      }
      case "updateConstraint": {
        if (edit.constraintId === undefined || edit.patch === undefined) {
          throw new Error("updateConstraint requires constraintId + patch");
        }
        const current = this.constraints.get(edit.constraintId);
        if (current === undefined) throw new Error(`updateConstraint: no constraint '${edit.constraintId}'`);
        this.constraints.set(edit.constraintId, applyConstraintPatch(current, edit.patch));
        break;
      }
      case "setConstraintRecord": {
        if (edit.constraintId === undefined || edit.constraint === undefined) {
          throw new Error("setConstraintRecord requires constraintId + constraint");
        }
        const constraint = validateConstraintRecord(edit.constraint);
        if (constraint.id !== edit.constraintId) throw new Error("setConstraintRecord: constraint.id must equal constraintId");
        if (!this.constraints.has(constraint.id)) throw new Error(`setConstraintRecord: no constraint '${constraint.id}'`);
        this.constraints.set(constraint.id, constraint);
        break;
      }
      case "removeConstraint": {
        if (edit.constraintId === undefined) throw new Error("removeConstraint requires constraintId");
        if (!this.constraints.has(edit.constraintId)) throw new Error(`removeConstraint: no constraint '${edit.constraintId}'`);
        this.constraints.delete(edit.constraintId);
        break;
      }
      // --- CAD-PARITY-008 (additive): the layout + viewport tables -----
      case "addLayout": {
        if (edit.layout === undefined) throw new Error("addLayout requires layout");
        const layout = validateLayoutRecord(edit.layout);
        if (this.layouts.has(layout.id)) {
          throw new Error(
            `addLayout: layout id '${layout.id}' already exists — canonical layout identity must not be reused while the layout exists`,
          );
        }
        this.assertLayoutNameFree(layout.name, null);
        this.validateLayoutP013References(layout, null);
        this.layouts.set(layout.id, layout);
        break;
      }
      case "updateLayout": {
        if (edit.layoutId === undefined || edit.patch === undefined) {
          throw new Error("updateLayout requires layoutId + patch");
        }
        const current = this.layouts.get(edit.layoutId);
        if (current === undefined) throw new Error(`updateLayout: no layout '${edit.layoutId}'`);
        const merged = applyLayoutPatch(current, edit.patch);
        this.assertLayoutNameFree(merged.name, edit.layoutId);
        this.validateLayoutP013References(merged, edit.layoutId);
        this.layouts.set(edit.layoutId, merged);
        // Keep the editor reference honest: a rename never breaks the
        // activeLayout reference (it references the immutable id).
        break;
      }
      case "setLayoutRecord": {
        if (edit.layoutId === undefined || edit.layout === undefined) {
          throw new Error("setLayoutRecord requires layoutId + layout");
        }
        const layout = validateLayoutRecord(edit.layout);
        if (layout.id !== edit.layoutId) throw new Error("setLayoutRecord: layout.id must equal layoutId");
        if (!this.layouts.has(layout.id)) throw new Error(`setLayoutRecord: no layout '${layout.id}'`);
        this.assertLayoutNameFree(layout.name, layout.id);
        this.validateLayoutP013References(layout, layout.id);
        this.layouts.set(layout.id, layout);
        break;
      }
      case "removeLayout": {
        if (edit.layoutId === undefined) throw new Error("removeLayout requires layoutId");
        if (!this.layouts.has(edit.layoutId)) throw new Error(`removeLayout: no layout '${edit.layoutId}'`);
        this.assertLayoutUnreferenced(edit.layoutId);
        // NOTE: the last-layout rule is a COMMAND-layer rule (LAYOUTDELETE),
        // NOT a document-edit rule — undoing the FIRST layout creation
        // replays removeLayout on a one-layout table and must succeed
        // (journal semantics, the locked-layer-gate precedent).
        this.layouts.delete(edit.layoutId);
        break;
      }
      case "addViewport": {
        if (edit.viewport === undefined) throw new Error("addViewport requires viewport");
        const viewport = validateViewportRecord(edit.viewport);
        if (this.viewports.has(viewport.id)) {
          throw new Error(
            `addViewport: viewport id '${viewport.id}' already exists — canonical viewport identity must not be reused while the viewport exists`,
          );
        }
        if (!this.layouts.has(viewport.layoutId)) {
          throw new Error(`addViewport: viewport references unknown layout '${viewport.layoutId}'`);
        }
        this.viewports.set(viewport.id, viewport);
        break;
      }
      case "updateViewport": {
        if (edit.viewportId === undefined || edit.patch === undefined) {
          throw new Error("updateViewport requires viewportId + patch");
        }
        const current = this.viewports.get(edit.viewportId);
        if (current === undefined) throw new Error(`updateViewport: no viewport '${edit.viewportId}'`);
        this.viewports.set(edit.viewportId, applyViewportPatch(current, edit.patch));
        break;
      }
      case "setViewportRecord": {
        if (edit.viewportId === undefined || edit.viewport === undefined) {
          throw new Error("setViewportRecord requires viewportId + viewport");
        }
        const viewport = validateViewportRecord(edit.viewport);
        if (viewport.id !== edit.viewportId) throw new Error("setViewportRecord: viewport.id must equal viewportId");
        if (!this.viewports.has(viewport.id)) throw new Error(`setViewportRecord: no viewport '${viewport.id}'`);
        if (!this.layouts.has(viewport.layoutId)) {
          throw new Error(`setViewportRecord: viewport references unknown layout '${viewport.layoutId}'`);
        }
        this.viewports.set(viewport.id, viewport);
        break;
      }
      case "removeViewport": {
        if (edit.viewportId === undefined) throw new Error("removeViewport requires viewportId");
        if (!this.viewports.has(edit.viewportId)) throw new Error(`removeViewport: no viewport '${edit.viewportId}'`);
        this.viewports.delete(edit.viewportId);
        break;
      }
      // --- CAD-PARITY-009 (additive): the UCS + section-plane tables ----
      case "addUcs": {
        if (edit.ucs === undefined) throw new Error("addUcs requires ucs");
        const ucs = validateUcsTableRecord(edit.ucs);
        if (this.ucsTable.has(ucs.id)) {
          throw new Error(
            `addUcs: UCS id '${ucs.id}' already exists — canonical UCS identity must not be reused while the UCS exists`,
          );
        }
        this.assertUcsNameFree(ucs.name, null);
        this.ucsTable.set(ucs.id, ucs);
        break;
      }
      case "updateUcs": {
        if (edit.ucsId === undefined || edit.patch === undefined) {
          throw new Error("updateUcs requires ucsId + patch");
        }
        const current = this.ucsTable.get(edit.ucsId);
        if (current === undefined) throw new Error(`updateUcs: no UCS '${edit.ucsId}'`);
        const merged = applyUcsPatch(current, edit.patch);
        this.assertUcsNameFree(merged.name, edit.ucsId);
        this.ucsTable.set(edit.ucsId, merged);
        // The editor reference stays honest: activation references the
        // immutable id, so a rename never dangles it.
        break;
      }
      case "setUcsRecord": {
        if (edit.ucsId === undefined || edit.ucs === undefined) {
          throw new Error("setUcsRecord requires ucsId + ucs");
        }
        const ucs = validateUcsTableRecord(edit.ucs);
        if (ucs.id !== edit.ucsId) throw new Error("setUcsRecord: ucs.id must equal ucsId");
        if (!this.ucsTable.has(ucs.id)) throw new Error(`setUcsRecord: no UCS '${ucs.id}'`);
        this.assertUcsNameFree(ucs.name, ucs.id);
        this.ucsTable.set(ucs.id, ucs);
        break;
      }
      case "removeUcs": {
        if (edit.ucsId === undefined) throw new Error("removeUcs requires ucsId");
        if (!this.ucsTable.has(edit.ucsId)) throw new Error(`removeUcs: no UCS '${edit.ucsId}'`);
        // NOTE: removing the ACTIVE UCS is a COMMAND-layer typed decline
        // (ucs_active — activate World first), NOT a document-edit rule —
        // undoing the FIRST UCS creation replays removeUcs on the table the
        // revision recorded (journal semantics, the removeLayout precedent;
        // open() defensively repairs a dangling activeUcs to World).
        this.ucsTable.delete(edit.ucsId);
        break;
      }
      case "addSectionPlane": {
        if (edit.sectionPlane === undefined) throw new Error("addSectionPlane requires sectionPlane");
        const plane = validateSectionPlaneTableRecord(edit.sectionPlane);
        if (this.sectionPlanes.has(plane.id)) {
          throw new Error(
            `addSectionPlane: section plane id '${plane.id}' already exists — canonical section-plane identity must not be reused while the plane exists`,
          );
        }
        this.assertSectionPlaneNameFree(plane.name, null);
        this.sectionPlanes.set(plane.id, plane);
        break;
      }
      case "updateSectionPlane": {
        if (edit.sectionPlaneId === undefined || edit.patch === undefined) {
          throw new Error("updateSectionPlane requires sectionPlaneId + patch");
        }
        const current = this.sectionPlanes.get(edit.sectionPlaneId);
        if (current === undefined) throw new Error(`updateSectionPlane: no section plane '${edit.sectionPlaneId}'`);
        const merged = applySectionPlanePatch(current, edit.patch);
        this.assertSectionPlaneNameFree(merged.name, edit.sectionPlaneId);
        this.sectionPlanes.set(edit.sectionPlaneId, merged);
        break;
      }
      case "setSectionPlaneRecord": {
        if (edit.sectionPlaneId === undefined || edit.sectionPlane === undefined) {
          throw new Error("setSectionPlaneRecord requires sectionPlaneId + sectionPlane");
        }
        const plane = validateSectionPlaneTableRecord(edit.sectionPlane);
        if (plane.id !== edit.sectionPlaneId) throw new Error("setSectionPlaneRecord: sectionPlane.id must equal sectionPlaneId");
        if (!this.sectionPlanes.has(plane.id)) throw new Error(`setSectionPlaneRecord: no section plane '${plane.id}'`);
        this.assertSectionPlaneNameFree(plane.name, plane.id);
        this.sectionPlanes.set(plane.id, plane);
        break;
      }
      case "removeSectionPlane": {
        if (edit.sectionPlaneId === undefined) throw new Error("removeSectionPlane requires sectionPlaneId");
        if (!this.sectionPlanes.has(edit.sectionPlaneId)) throw new Error(`removeSectionPlane: no section plane '${edit.sectionPlaneId}'`);
        this.sectionPlanes.delete(edit.sectionPlaneId);
        break;
      }
      // --- CAD-PARITY-013 (additive, Issue #104): the documentation -----
      // --- production record tables -------------------------------------
      case "addNavigatorNode": {
        if (edit.node === undefined) throw new Error("addNavigatorNode requires node");
        const node = validateNavigatorNodeRecord(edit.node);
        if (this.navigatorNodes.has(node.id)) {
          throw new Error(
            `addNavigatorNode: node id '${node.id}' already exists — canonical navigator identity must not be reused while the node exists`,
          );
        }
        this.validateNavigatorNodeReferences(node);
        this.navigatorNodes.set(node.id, node);
        break;
      }
      case "updateNavigatorNode": {
        if (edit.nodeId === undefined || edit.patch === undefined) {
          throw new Error("updateNavigatorNode requires nodeId + patch");
        }
        const current = this.navigatorNodes.get(edit.nodeId);
        if (current === undefined) throw new Error(`updateNavigatorNode: no navigator node '${edit.nodeId}'`);
        const merged = applyNavigatorNodePatch(current, edit.patch);
        this.validateNavigatorNodeReferences(merged);
        this.assertNoNavigatorCycle(merged.id, merged.parentId);
        this.navigatorNodes.set(edit.nodeId, merged);
        break;
      }
      case "setNavigatorNodeRecord": {
        if (edit.nodeId === undefined || edit.node === undefined) {
          throw new Error("setNavigatorNodeRecord requires nodeId + node");
        }
        const node = validateNavigatorNodeRecord(edit.node);
        if (node.id !== edit.nodeId) throw new Error("setNavigatorNodeRecord: node.id must equal nodeId");
        if (!this.navigatorNodes.has(node.id)) throw new Error(`setNavigatorNodeRecord: no navigator node '${node.id}'`);
        this.validateNavigatorNodeReferences(node);
        this.assertNoNavigatorCycle(node.id, node.parentId);
        this.navigatorNodes.set(node.id, node);
        break;
      }
      case "removeNavigatorNode": {
        if (edit.nodeId === undefined) throw new Error("removeNavigatorNode requires nodeId");
        if (!this.navigatorNodes.has(edit.nodeId)) throw new Error(`removeNavigatorNode: no navigator node '${edit.nodeId}'`);
        this.assertNavigatorNodeUnreferenced(edit.nodeId);
        this.navigatorNodes.delete(edit.nodeId);
        break;
      }
      case "addTitleBlock": {
        if (edit.titleBlock === undefined) throw new Error("addTitleBlock requires titleBlock");
        const block = validateTitleBlockRecord(edit.titleBlock);
        if (this.titleBlocks.has(block.id)) {
          throw new Error(
            `addTitleBlock: title block id '${block.id}' already exists — canonical title-block identity must not be reused while the record exists`,
          );
        }
        this.assertTitleBlockNameFree(block.name, null);
        this.titleBlocks.set(block.id, block);
        break;
      }
      case "updateTitleBlock": {
        if (edit.titleBlockId === undefined || edit.patch === undefined) {
          throw new Error("updateTitleBlock requires titleBlockId + patch");
        }
        const current = this.titleBlocks.get(edit.titleBlockId);
        if (current === undefined) throw new Error(`updateTitleBlock: no title block '${edit.titleBlockId}'`);
        const merged = applyTitleBlockPatch(current, edit.patch);
        this.assertTitleBlockNameFree(merged.name, edit.titleBlockId);
        this.titleBlocks.set(edit.titleBlockId, merged);
        break;
      }
      case "setTitleBlockRecord": {
        if (edit.titleBlockId === undefined || edit.titleBlock === undefined) {
          throw new Error("setTitleBlockRecord requires titleBlockId + titleBlock");
        }
        const block = validateTitleBlockRecord(edit.titleBlock);
        if (block.id !== edit.titleBlockId) throw new Error("setTitleBlockRecord: titleBlock.id must equal titleBlockId");
        if (!this.titleBlocks.has(block.id)) throw new Error(`setTitleBlockRecord: no title block '${block.id}'`);
        this.assertTitleBlockNameFree(block.name, block.id);
        this.titleBlocks.set(block.id, block);
        break;
      }
      case "removeTitleBlock": {
        if (edit.titleBlockId === undefined) throw new Error("removeTitleBlock requires titleBlockId");
        if (!this.titleBlocks.has(edit.titleBlockId)) throw new Error(`removeTitleBlock: no title block '${edit.titleBlockId}'`);
        this.assertTitleBlockUnreferenced(edit.titleBlockId);
        this.titleBlocks.delete(edit.titleBlockId);
        break;
      }
      case "addSchedule": {
        if (edit.schedule === undefined) throw new Error("addSchedule requires schedule");
        const schedule = validateScheduleRecord(edit.schedule);
        if (this.schedules.has(schedule.id)) {
          throw new Error(
            `addSchedule: schedule id '${schedule.id}' already exists — canonical schedule identity must not be reused while the record exists`,
          );
        }
        this.assertScheduleNameFree(schedule.name, null);
        this.schedules.set(schedule.id, schedule);
        break;
      }
      case "updateSchedule": {
        if (edit.scheduleId === undefined || edit.patch === undefined) {
          throw new Error("updateSchedule requires scheduleId + patch");
        }
        const current = this.schedules.get(edit.scheduleId);
        if (current === undefined) throw new Error(`updateSchedule: no schedule '${edit.scheduleId}'`);
        const merged = applySchedulePatch(current, edit.patch);
        this.assertScheduleNameFree(merged.name, edit.scheduleId);
        this.schedules.set(edit.scheduleId, merged);
        break;
      }
      case "setScheduleRecord": {
        if (edit.scheduleId === undefined || edit.schedule === undefined) {
          throw new Error("setScheduleRecord requires scheduleId + schedule");
        }
        const schedule = validateScheduleRecord(edit.schedule);
        if (schedule.id !== edit.scheduleId) throw new Error("setScheduleRecord: schedule.id must equal scheduleId");
        if (!this.schedules.has(schedule.id)) throw new Error(`setScheduleRecord: no schedule '${schedule.id}'`);
        this.assertScheduleNameFree(schedule.name, schedule.id);
        this.schedules.set(schedule.id, schedule);
        break;
      }
      case "removeSchedule": {
        if (edit.scheduleId === undefined) throw new Error("removeSchedule requires scheduleId");
        if (!this.schedules.has(edit.scheduleId)) throw new Error(`removeSchedule: no schedule '${edit.scheduleId}'`);
        this.schedules.delete(edit.scheduleId);
        break;
      }
      // CAD-PARITY-015 (Issue #110): the property-definition registry edits.
      case "addPropertyDef": {
        if (edit.propertyDef === undefined) throw new Error("addPropertyDef requires propertyDef");
        const def = validatePropertyDefRecord(edit.propertyDef);
        if (this.propertyDefs.has(def.id)) {
          throw new Error(
            `addPropertyDef: property definition id '${def.id}' already exists — canonical property definition identity must not be reused while the record exists`,
          );
        }
        this.assertPropertyDefNameFree(def.name, null);
        this.assertPropertyDefAddressFree(def.set, def.key, null);
        this.propertyDefs.set(def.id, def);
        break;
      }
      case "updatePropertyDef": {
        if (edit.propertyDefId === undefined || edit.patch === undefined) {
          throw new Error("updatePropertyDef requires propertyDefId + patch");
        }
        const current = this.propertyDefs.get(edit.propertyDefId);
        if (current === undefined) throw new Error(`updatePropertyDef: no property definition '${edit.propertyDefId}'`);
        const merged = applyPropertyDefPatch(current, edit.patch);
        this.assertPropertyDefNameFree(merged.name, edit.propertyDefId);
        this.assertPropertyDefAddressFree(merged.set, merged.key, edit.propertyDefId);
        this.propertyDefs.set(edit.propertyDefId, merged);
        break;
      }
      case "setPropertyDefRecord": {
        if (edit.propertyDefId === undefined || edit.propertyDef === undefined) {
          throw new Error("setPropertyDefRecord requires propertyDefId + propertyDef");
        }
        const def = validatePropertyDefRecord(edit.propertyDef);
        if (def.id !== edit.propertyDefId) throw new Error("setPropertyDefRecord: propertyDef.id must equal propertyDefId");
        if (!this.propertyDefs.has(def.id)) throw new Error(`setPropertyDefRecord: no property definition '${def.id}'`);
        this.assertPropertyDefNameFree(def.name, def.id);
        this.assertPropertyDefAddressFree(def.set, def.key, def.id);
        this.propertyDefs.set(def.id, def);
        break;
      }
      case "removePropertyDef": {
        if (edit.propertyDefId === undefined) throw new Error("removePropertyDef requires propertyDefId");
        if (!this.propertyDefs.has(edit.propertyDefId)) throw new Error(`removePropertyDef: no property definition '${edit.propertyDefId}'`);
        // No gates: schedule pd:<id> columns render the deterministic missing
        // cell afterwards (rows are derived fresh — nothing is stored stale).
        this.propertyDefs.delete(edit.propertyDefId);
        break;
      }
      // CAD-PARITY-018 (Issue #118): the specialized-toolsets record table
      // (the single toolsets-core grammar; table bounds + raster sourceRef
      // uniqueness enforced here — the document is the table authority).
      case "addSpecialized": {
        if (edit.record === undefined) throw new Error("addSpecialized requires record");
        const record = normalizeToolsetRecord(edit.record);
        if (this.specialized.has(record.id)) {
          throw new Error(
            `addSpecialized: specialized record id '${record.id}' already exists — canonical specialized identity must not be reused while the record exists`,
          );
        }
        this.assertSpecializedTableBounds(record, null);
        this.specialized.set(record.id, record);
        break;
      }
      case "setSpecializedRecord": {
        if (edit.id === undefined || edit.record === undefined) {
          throw new Error("setSpecializedRecord requires id + record");
        }
        const record = normalizeToolsetRecord(edit.record);
        if (record.id !== edit.id) throw new Error("setSpecializedRecord: record.id must equal id");
        if (!this.specialized.has(record.id)) {
          throw new Error(`setSpecializedRecord: no specialized record '${record.id}'`);
        }
        this.assertSpecializedTableBounds(record, record.id);
        this.specialized.set(record.id, record);
        break;
      }
      case "removeSpecialized": {
        if (edit.id === undefined) throw new Error("removeSpecialized requires id");
        if (!this.specialized.has(edit.id)) {
          throw new Error(`removeSpecialized: no specialized record '${edit.id}'`);
        }
        this.specialized.delete(edit.id);
        break;
      }
      case "addRevision": {
        if (edit.revision === undefined) throw new Error("addRevision requires revision");
        const revision = validateRevisionRecord(edit.revision);
        if (this.revisions.has(revision.id)) {
          throw new Error(
            `addRevision: revision id '${revision.id}' already exists — canonical revision identity must not be reused while the record exists`,
          );
        }
        this.assertRevisionCodeFree(revision.code, null);
        this.assertRevisionLayoutsExist(revision.layoutIds);
        this.revisions.set(revision.id, revision);
        break;
      }
      case "updateRevision": {
        if (edit.revisionId === undefined || edit.patch === undefined) {
          throw new Error("updateRevision requires revisionId + patch");
        }
        const current = this.revisions.get(edit.revisionId);
        if (current === undefined) throw new Error(`updateRevision: no revision '${edit.revisionId}'`);
        const merged = applyRevisionPatch(current, edit.patch);
        this.assertRevisionCodeFree(merged.code, edit.revisionId);
        this.assertRevisionLayoutsExist(merged.layoutIds);
        this.revisions.set(edit.revisionId, merged);
        break;
      }
      case "setRevisionRecord": {
        if (edit.revisionId === undefined || edit.revision === undefined) {
          throw new Error("setRevisionRecord requires revisionId + revision");
        }
        const revision = validateRevisionRecord(edit.revision);
        if (revision.id !== edit.revisionId) throw new Error("setRevisionRecord: revision.id must equal revisionId");
        if (!this.revisions.has(revision.id)) throw new Error(`setRevisionRecord: no revision '${revision.id}'`);
        this.assertRevisionCodeFree(revision.code, revision.id);
        this.assertRevisionLayoutsExist(revision.layoutIds);
        this.revisions.set(revision.id, revision);
        break;
      }
      case "removeRevision": {
        if (edit.revisionId === undefined) throw new Error("removeRevision requires revisionId");
        if (!this.revisions.has(edit.revisionId)) throw new Error(`removeRevision: no revision '${edit.revisionId}'`);
        // NO document-level gates: layouts reference revisions the other
        // way — the command layer strips the reference from every
        // referencing layout in the SAME atomic batch (the explicit-cascade
        // precedent); undo restores both together.
        this.revisions.delete(edit.revisionId);
        break;
      }
      case "addPublisherSet": {
        if (edit.set === undefined) throw new Error("addPublisherSet requires set");
        const set = validatePublisherSetRecord(edit.set);
        if (this.publisherSets.has(set.id)) {
          throw new Error(
            `addPublisherSet: set id '${set.id}' already exists — canonical publisher-set identity must not be reused while the record exists`,
          );
        }
        this.assertPublisherSetNameFree(set.name, null);
        this.assertPublisherItemsResolve(set.items);
        this.assertPublisherExpansionUnique(set.items);
        this.publisherSets.set(set.id, set);
        break;
      }
      case "updatePublisherSet": {
        if (edit.setId === undefined || edit.patch === undefined) {
          throw new Error("updatePublisherSet requires setId + patch");
        }
        const current = this.publisherSets.get(edit.setId);
        if (current === undefined) throw new Error(`updatePublisherSet: no publisher set '${edit.setId}'`);
        const merged = applyPublisherSetPatch(current, edit.patch);
        this.assertPublisherSetNameFree(merged.name, edit.setId);
        this.assertPublisherItemsResolve(merged.items);
        this.assertPublisherExpansionUnique(merged.items);
        this.publisherSets.set(edit.setId, merged);
        break;
      }
      case "setPublisherSetRecord": {
        if (edit.setId === undefined || edit.set === undefined) {
          throw new Error("setPublisherSetRecord requires setId + set");
        }
        const set = validatePublisherSetRecord(edit.set);
        if (set.id !== edit.setId) throw new Error("setPublisherSetRecord: set.id must equal setId");
        if (!this.publisherSets.has(set.id)) throw new Error(`setPublisherSetRecord: no publisher set '${set.id}'`);
        this.assertPublisherSetNameFree(set.name, set.id);
        this.assertPublisherItemsResolve(set.items);
        this.assertPublisherExpansionUnique(set.items);
        this.publisherSets.set(set.id, set);
        break;
      }
      case "removePublisherSet": {
        if (edit.setId === undefined) throw new Error("removePublisherSet requires setId");
        if (!this.publisherSets.has(edit.setId)) throw new Error(`removePublisherSet: no publisher set '${edit.setId}'`);
        this.publisherSets.delete(edit.setId);
        break;
      }
      case "setViewRecord": {
        if (edit.viewId === undefined || edit.view === undefined) {
          throw new Error("setViewRecord requires viewId + view");
        }
        const view = validateDocsViewRecord(edit.view);
        if (view.id !== edit.viewId) throw new Error("setViewRecord: view.id must equal viewId");
        if (!this.docsViews.has(view.id)) throw new Error(`setViewRecord: no view '${view.id}'`);
        this.validateViewReferences(view);
        this.docsViews.set(view.id, view);
        break;
      }
      case "setSheetRecord": {
        if (edit.sheetId === undefined || edit.sheet === undefined) {
          throw new Error("setSheetRecord requires sheetId + sheet");
        }
        const sheet = validateDocsSheetRecord(edit.sheet);
        if (sheet.id !== edit.sheetId) throw new Error("setSheetRecord: sheet.id must equal sheetId");
        if (!this.docsSheets.has(sheet.id)) throw new Error(`setSheetRecord: no sheet '${sheet.id}'`);
        for (const placement of sheet.viewPlacements) {
          if (!this.docsViews.has(placement.viewId)) {
            throw new Error(`setSheetRecord: placement references unknown view '${placement.viewId}'`);
          }
        }
        this.docsSheets.set(sheet.id, sheet);
        break;
      }
      default: {
        const _exhaustive = edit satisfies never;
        throw new Error(`unreachable edit type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** COMPAT-CAD-003: state-dependent cross-reference validation for a view
   *  record (called from applyEdit where document state is available):
   *  plan/elevation/section storyId must reference an existing BIM story
   *  element; a detail's sourceViewId must reference an existing MODEL view
   *  (detail-of-detail is rejected — a detail is not a projection source). */
  private validateViewReferences(view: DocsViewRecord): void {
    if (view.storyId !== undefined) {
      const story = this.elements.get(view.storyId);
      if (story === undefined || story.props.type !== "bim.story") {
        throw new Error(`view '${view.id}': storyId '${view.storyId}' does not reference a BIM story element`);
      }
    }
    if (view.kind === "detail") {
      const source = this.docsViews.get(view.sourceViewId as string);
      if (source === undefined) {
        throw new Error(`view '${view.id}': sourceViewId '${view.sourceViewId}' does not reference an existing view`);
      }
      if (source.kind === "detail") {
        throw new Error(`view '${view.id}': detail-of-detail is not supported — source must be a plan/elevation/section view`);
      }
    }
    // CAD-PARITY-013: the navigator View Map folder reference must resolve
    // to an existing FOLDER node (the removeNavigatorNode gate keeps this
    // unreachable through the command surface — raw edits validate it here).
    if (view.folderId !== undefined) {
      const folder = this.navigatorNodes.get(view.folderId);
      if (folder === undefined || folder.kind !== "folder") {
        throw new Error(
          `view '${view.id}': folderId '${view.folderId}' does not reference a navigator folder node`,
        );
      }
    }
  }

  /** CAD-PARITY-013: cross-table reference validation for a layout record
   *  (called from applyEdit where document state is available): subsetId →
   *  an existing subset node; masterId → an existing OTHER layout that itself
   *  has no master (single-level); titleBlockPlacement → an existing title
   *  block; revisionIds → existing revisions. `selfId` excludes the layout
   *  itself from the master self-reference check (null = pure add). */
  private validateLayoutP013References(layout: LayoutRecord, selfId: string | null): void {
    if (layout.subsetId !== undefined) {
      const subset = this.navigatorNodes.get(layout.subsetId);
      if (subset === undefined || subset.kind !== "subset") {
        throw new Error(
          `layout '${layout.id}': subsetId '${layout.subsetId}' does not reference a navigator subset node`,
        );
      }
    }
    if (layout.masterId !== undefined) {
      const master = this.layouts.get(layout.masterId);
      if (master === undefined) {
        throw new Error(
          `layout '${layout.id}': masterId '${layout.masterId}' does not reference an existing layout`,
        );
      }
      if (master.id === (selfId ?? layout.id)) {
        throw new Error(`layout '${layout.id}': a layout cannot be its own master`);
      }
      if (master.masterId !== undefined) {
        throw new Error(
          `layout '${layout.id}': master '${master.id}' itself has a master — masters are single-level (a master cannot be mastered)`,
        );
      }
      // Single-level masters the OTHER way: a layout that is ALREADY the
      // master of another layout cannot itself gain a master (otherwise
      // patching only the TOP of a would-be chain A→B→C would slip a
      // two-level composition through — the open-time whole-table check
      // rejects exactly this state, so applyEdit must too).
      for (const other of this.layouts.values()) {
        if (other.id !== layout.id && other.masterId === layout.id) {
          throw new Error(
            `layout '${layout.id}' is the master of layout '${other.id}' — masters are single-level (a master cannot be mastered)`,
          );
        }
      }
    }
    if (layout.titleBlockPlacement !== undefined && !this.titleBlocks.has(layout.titleBlockPlacement.titleBlockId)) {
      throw new Error(
        `layout '${layout.id}': titleBlockPlacement references unknown title block '${layout.titleBlockPlacement.titleBlockId}'`,
      );
    }
    if (layout.revisionIds !== undefined) {
      for (const revId of layout.revisionIds) {
        if (!this.revisions.has(revId)) {
          throw new Error(`layout '${layout.id}': references unknown revision '${revId}'`);
        }
      }
    }
  }

  private computeInverse(edit: DocumentEdit): DocumentEdit {
    switch (edit.type) {
      case "addElement": {
        if (edit.element === undefined) throw new Error("addElement requires element");
        return { type: "removeElement", elementId: edit.element.id };
      }
      case "removeElement": {
        if (edit.elementId === undefined) throw new Error("removeElement requires elementId");
        const existing = this.elements.get(edit.elementId);
        if (existing === undefined) throw new Error(`removeElement: no element '${edit.elementId}'`);
        return { type: "addElement", element: existing };
      }
      case "updateElement": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("updateElement requires elementId + patch");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`updateElement: no element '${edit.elementId}'`);
        const prevProps = el.props as Record<string, unknown>;
        const prevValues: Record<string, unknown> = {};
        let addedKey = false;
        for (const k of Object.keys(edit.patch)) {
          prevValues[k] = prevProps[k];
          if (prevProps[k] === undefined) addedKey = true;
        }
        // COMPAT-CAD-002 correctness fix: when the patch ADDED a key that did
        // not exist before, an updateElement inverse cannot express the key's
        // removal (an undefined value is not representable in canonical JSON
        // and would not restore absence on replay). The exact inverse is then
        // a FULL setProps of the previous props (which drops the added key).
        // When every patched key existed before, the classic per-key
        // updateElement inverse is retained — byte-identical to every
        // recorded history (hash compatibility).
        return addedKey
          ? { type: "setProps", elementId: edit.elementId, patch: { ...prevProps } }
          : { type: "updateElement", elementId: edit.elementId, patch: prevValues };
      }
      case "setProps": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("setProps requires elementId + patch");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`setProps: no element '${edit.elementId}'`);
        return { type: "setProps", elementId: edit.elementId, patch: { ...el.props } };
      }
      // --- COMPAT-CAD-001 (additive): composite + layer edits ---
      case "applyEdits": {
        // Composite inverses are captured interleaved in applyWithInverse —
        // a bare computeInverse on a batch cannot be state-correct.
        throw new Error("computeInverse: applyEdits is handled by applyWithInverse (interleaved inverses)");
      }
      case "addLayer": {
        const layer = validateLayerRecord(edit.layer);
        return { type: "removeLayer", layerId: layer.id };
      }
      case "updateLayer": {
        if (edit.layerId === undefined || edit.patch === undefined) {
          throw new Error("updateLayer requires layerId + patch");
        }
        const current = this.layers.get(edit.layerId);
        if (current === undefined) throw new Error(`updateLayer: no layer '${edit.layerId}'`);
        const prevValues: Record<string, unknown> = {};
        for (const k of Object.keys(edit.patch)) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateLayer", layerId: edit.layerId, patch: prevValues };
      }
      case "removeLayer": {
        if (edit.layerId === undefined) throw new Error("removeLayer requires layerId");
        const existing = this.layers.get(edit.layerId);
        if (existing === undefined) throw new Error(`removeLayer: no layer '${edit.layerId}'`);
        return { type: "addLayer", layer: existing };
      }
      // --- COMPAT-CAD-003 (additive): documentation view/sheet inverses ---
      case "addView": {
        if (edit.view === undefined) throw new Error("addView requires view");
        return { type: "removeView", viewId: edit.view.id };
      }
      case "updateView": {
        if (edit.viewId === undefined || edit.patch === undefined) {
          throw new Error("updateView requires viewId + patch");
        }
        const current = this.docsViews.get(edit.viewId);
        if (current === undefined) throw new Error(`updateView: no view '${edit.viewId}'`);
        // Exact-inverse rule (COMPAT-CAD-002 updateElement lesson): a full
        // record restore is always correct, including patches that ADDED a
        // key (a partial inverse carrying undefined is not representable).
        return { type: "setViewRecord", viewId: edit.viewId, view: current };
      }
      case "setViewRecord": {
        if (edit.viewId === undefined || edit.view === undefined) {
          throw new Error("setViewRecord requires viewId + view");
        }
        const current = this.docsViews.get(edit.viewId);
        if (current === undefined) throw new Error(`setViewRecord: no view '${edit.viewId}'`);
        return { type: "setViewRecord", viewId: edit.viewId, view: current };
      }
      case "removeView": {
        if (edit.viewId === undefined) throw new Error("removeView requires viewId");
        const existing = this.docsViews.get(edit.viewId);
        if (existing === undefined) throw new Error(`removeView: no view '${edit.viewId}'`);
        return { type: "addView", view: existing };
      }
      case "addSheet": {
        if (edit.sheet === undefined) throw new Error("addSheet requires sheet");
        return { type: "removeSheet", sheetId: edit.sheet.id };
      }
      case "addIfcImport": {
        if (edit.record === undefined) throw new Error("addIfcImport requires record");
        return { type: "removeIfcImport", recordId: edit.record.id };
      }
      case "removeIfcImport": {
        if (edit.recordId === undefined) throw new Error("removeIfcImport requires recordId");
        const current = this.ifcImports.get(edit.recordId);
        if (current === undefined) throw new Error(`removeIfcImport: no record '${edit.recordId}'`);
        return { type: "addIfcImport", record: current };
      }
      case "updateSheet": {
        if (edit.sheetId === undefined || edit.patch === undefined) {
          throw new Error("updateSheet requires sheetId + patch");
        }
        const current = this.docsSheets.get(edit.sheetId);
        if (current === undefined) throw new Error(`updateSheet: no sheet '${edit.sheetId}'`);
        return { type: "setSheetRecord", sheetId: edit.sheetId, sheet: current };
      }
      case "setSheetRecord": {
        if (edit.sheetId === undefined || edit.sheet === undefined) {
          throw new Error("setSheetRecord requires sheetId + sheet");
        }
        const current = this.docsSheets.get(edit.sheetId);
        if (current === undefined) throw new Error(`setSheetRecord: no sheet '${edit.sheetId}'`);
        return { type: "setSheetRecord", sheetId: edit.sheetId, sheet: current };
      }
      case "removeSheet": {
        if (edit.sheetId === undefined) throw new Error("removeSheet requires sheetId");
        const existing = this.docsSheets.get(edit.sheetId);
        if (existing === undefined) throw new Error(`removeSheet: no sheet '${edit.sheetId}'`);
        return { type: "addSheet", sheet: existing };
      }
      // --- CAD-PARITY-004 (additive): standards/style tables + layer states ---
      case "addLtype": {
        if (edit.ltype === undefined) throw new Error("addLtype requires ltype");
        const ltype = validateLtypeRecord(edit.ltype);
        return { type: "removeLtype", ltypeName: ltype.name };
      }
      case "updateLtype": {
        if (edit.ltypeName === undefined || edit.patch === undefined) {
          throw new Error("updateLtype requires ltypeName + patch");
        }
        const current = this.ltypes.get(edit.ltypeName);
        if (current === undefined) throw new Error(`updateLtype: no linetype '${edit.ltypeName}'`);
        const prevValues: Record<string, unknown> = {};
        for (const k of Object.keys(edit.patch)) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateLtype", ltypeName: edit.ltypeName, patch: prevValues };
      }
      case "removeLtype": {
        if (edit.ltypeName === undefined) throw new Error("removeLtype requires ltypeName");
        const existing = this.ltypes.get(edit.ltypeName);
        if (existing === undefined) throw new Error(`removeLtype: no linetype '${edit.ltypeName}'`);
        return { type: "addLtype", ltype: existing };
      }
      case "addTextStyle": {
        if (edit.style === undefined) throw new Error("addTextStyle requires style");
        const style = validateTextStyleRecord(edit.style);
        return { type: "removeTextStyle", styleName: style.name };
      }
      case "updateTextStyle": {
        if (edit.styleName === undefined || edit.patch === undefined) {
          throw new Error("updateTextStyle requires styleName + patch");
        }
        const current = this.textStyles.get(edit.styleName);
        if (current === undefined) throw new Error(`updateTextStyle: no text style '${edit.styleName}'`);
        const prevValues: Record<string, unknown> = {};
        for (const k of Object.keys(edit.patch)) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateTextStyle", styleName: edit.styleName, patch: prevValues };
      }
      case "removeTextStyle": {
        if (edit.styleName === undefined) throw new Error("removeTextStyle requires styleName");
        const existing = this.textStyles.get(edit.styleName);
        if (existing === undefined) throw new Error(`removeTextStyle: no text style '${edit.styleName}'`);
        return { type: "addTextStyle", style: existing };
      }
      case "addDimStyle": {
        if (edit.style === undefined) throw new Error("addDimStyle requires style");
        const style = validateDimStyleRecord(edit.style);
        return { type: "removeDimStyle", styleName: style.name };
      }
      case "updateDimStyle": {
        if (edit.styleName === undefined || edit.patch === undefined) {
          throw new Error("updateDimStyle requires styleName + patch");
        }
        const current = this.dimStyles.get(edit.styleName);
        if (current === undefined) throw new Error(`updateDimStyle: no dimension style '${edit.styleName}'`);
        const prevValues: Record<string, unknown> = {};
        for (const k of Object.keys(edit.patch)) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateDimStyle", styleName: edit.styleName, patch: prevValues };
      }
      case "removeDimStyle": {
        if (edit.styleName === undefined) throw new Error("removeDimStyle requires styleName");
        const existing = this.dimStyles.get(edit.styleName);
        if (existing === undefined) throw new Error(`removeDimStyle: no dimension style '${edit.styleName}'`);
        return { type: "addDimStyle", style: existing };
      }
      case "addLayerState": {
        if (edit.state === undefined) throw new Error("addLayerState requires state");
        const state = validateLayerStateRecord(edit.state);
        return { type: "removeLayerState", stateName: state.name };
      }
      case "removeLayerState": {
        if (edit.stateName === undefined) throw new Error("removeLayerState requires stateName");
        const existing = this.layerStates.get(edit.stateName);
        if (existing === undefined) throw new Error(`removeLayerState: no layer state '${edit.stateName}'`);
        return { type: "addLayerState", state: existing };
      }
      // --- CAD-PARITY-006 (additive): block definitions + xrefs ------------
      case "addBlockDef": {
        if (edit.block === undefined) throw new Error("addBlockDef requires block");
        const block = validateBlockDefinitionRecord(edit.block);
        return { type: "removeBlockDef", blockId: block.id };
      }
      case "updateBlockDef": {
        if (edit.blockId === undefined || edit.patch === undefined) {
          throw new Error("updateBlockDef requires blockId + patch");
        }
        const current = this.blockDefs.get(edit.blockId);
        if (current === undefined) throw new Error(`updateBlockDef: no block definition '${edit.blockId}'`);
        // Exact inverse: a patch that ADDS a key absent from the current
        // record (e.g. description) inverts through the full-record restore
        // — the setViewRecord precedent (a prevValues patch could not
        // represent the key's absence).
        const patchKeys = Object.keys(edit.patch);
        const addsKey = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (addsKey) {
          return { type: "setBlockDefRecord", blockId: edit.blockId, block: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateBlockDef", blockId: edit.blockId, patch: prevValues };
      }
      case "setBlockDefRecord": {
        if (edit.blockId === undefined || edit.block === undefined) {
          throw new Error("setBlockDefRecord requires blockId + block");
        }
        const current = this.blockDefs.get(edit.blockId);
        if (current === undefined) throw new Error(`setBlockDefRecord: no block definition '${edit.blockId}'`);
        return { type: "setBlockDefRecord", blockId: edit.blockId, block: current };
      }
      case "removeBlockDef": {
        if (edit.blockId === undefined) throw new Error("removeBlockDef requires blockId");
        const existing = this.blockDefs.get(edit.blockId);
        if (existing === undefined) throw new Error(`removeBlockDef: no block definition '${edit.blockId}'`);
        return { type: "addBlockDef", block: existing };
      }
      case "addXref": {
        if (edit.xref === undefined) throw new Error("addXref requires xref");
        const xref = validateXrefRecord(edit.xref);
        return { type: "removeXref", xrefId: xref.id };
      }
      case "updateXref": {
        if (edit.xrefId === undefined || edit.patch === undefined) {
          throw new Error("updateXref requires xrefId + patch");
        }
        const current = this.xrefs.get(edit.xrefId);
        if (current === undefined) throw new Error(`updateXref: no external reference '${edit.xrefId}'`);
        const patchKeys = Object.keys(edit.patch);
        const addsKey = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (addsKey) {
          return { type: "setXrefRecord", xrefId: edit.xrefId, xref: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateXref", xrefId: edit.xrefId, patch: prevValues };
      }
      case "setXrefRecord": {
        if (edit.xrefId === undefined || edit.xref === undefined) {
          throw new Error("setXrefRecord requires xrefId + xref");
        }
        const current = this.xrefs.get(edit.xrefId);
        if (current === undefined) throw new Error(`setXrefRecord: no external reference '${edit.xrefId}'`);
        return { type: "setXrefRecord", xrefId: edit.xrefId, xref: current };
      }
      case "removeXref": {
        if (edit.xrefId === undefined) throw new Error("removeXref requires xrefId");
        const existing = this.xrefs.get(edit.xrefId);
        if (existing === undefined) throw new Error(`removeXref: no external reference '${edit.xrefId}'`);
        return { type: "addXref", xref: existing };
      }
      // --- CAD-PARITY-007 (additive): constraint inverses -----------------
      case "addConstraint": {
        if (edit.constraint === undefined) throw new Error("addConstraint requires constraint");
        const constraint = validateConstraintRecord(edit.constraint);
        return { type: "removeConstraint", constraintId: constraint.id };
      }
      case "updateConstraint": {
        if (edit.constraintId === undefined || edit.patch === undefined) {
          throw new Error("updateConstraint requires constraintId + patch");
        }
        const current = this.constraints.get(edit.constraintId);
        if (current === undefined) throw new Error(`updateConstraint: no constraint '${edit.constraintId}'`);
        const patchKeys = Object.keys(edit.patch);
        const addsKey = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (addsKey) {
          // The patch adds a key the stored record lacks (e.g. mode appears)
          // — the exact inverse is the full-record restore (setBlockDefRecord
          // semantics: absence of keys is representable on undo/replay).
          return { type: "setConstraintRecord", constraintId: edit.constraintId, constraint: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateConstraint", constraintId: edit.constraintId, patch: prevValues };
      }
      case "setConstraintRecord": {
        if (edit.constraintId === undefined || edit.constraint === undefined) {
          throw new Error("setConstraintRecord requires constraintId + constraint");
        }
        const current = this.constraints.get(edit.constraintId);
        if (current === undefined) throw new Error(`setConstraintRecord: no constraint '${edit.constraintId}'`);
        return { type: "setConstraintRecord", constraintId: edit.constraintId, constraint: current };
      }
      case "removeConstraint": {
        if (edit.constraintId === undefined) throw new Error("removeConstraint requires constraintId");
        const existing = this.constraints.get(edit.constraintId);
        if (existing === undefined) throw new Error(`removeConstraint: no constraint '${edit.constraintId}'`);
        return { type: "addConstraint", constraint: existing };
      }
      // --- CAD-PARITY-008 (additive): layout + viewport inverses --------
      case "addLayout": {
        if (edit.layout === undefined) throw new Error("addLayout requires layout");
        const layout = validateLayoutRecord(edit.layout);
        return { type: "removeLayout", layoutId: layout.id };
      }
      case "updateLayout": {
        if (edit.layoutId === undefined || edit.patch === undefined) {
          throw new Error("updateLayout requires layoutId + patch");
        }
        const current = this.layouts.get(edit.layoutId);
        if (current === undefined) throw new Error(`updateLayout: no layout '${edit.layoutId}'`);
        const patchKeys = Object.keys(edit.patch);
        const addsKey = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (addsKey) {
          return { type: "setLayoutRecord", layoutId: edit.layoutId, layout: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateLayout", layoutId: edit.layoutId, patch: prevValues };
      }
      case "setLayoutRecord": {
        if (edit.layoutId === undefined || edit.layout === undefined) {
          throw new Error("setLayoutRecord requires layoutId + layout");
        }
        const current = this.layouts.get(edit.layoutId);
        if (current === undefined) throw new Error(`setLayoutRecord: no layout '${edit.layoutId}'`);
        return { type: "setLayoutRecord", layoutId: edit.layoutId, layout: current };
      }
      case "removeLayout": {
        if (edit.layoutId === undefined) throw new Error("removeLayout requires layoutId");
        const existing = this.layouts.get(edit.layoutId);
        if (existing === undefined) throw new Error(`removeLayout: no layout '${edit.layoutId}'`);
        return { type: "addLayout", layout: existing };
      }
      case "addViewport": {
        if (edit.viewport === undefined) throw new Error("addViewport requires viewport");
        const viewport = validateViewportRecord(edit.viewport);
        return { type: "removeViewport", viewportId: viewport.id };
      }
      case "updateViewport": {
        if (edit.viewportId === undefined || edit.patch === undefined) {
          throw new Error("updateViewport requires viewportId + patch");
        }
        const current = this.viewports.get(edit.viewportId);
        if (current === undefined) throw new Error(`updateViewport: no viewport '${edit.viewportId}'`);
        const patchKeys = Object.keys(edit.patch);
        const addsKey = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (addsKey) {
          return { type: "setViewportRecord", viewportId: edit.viewportId, viewport: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateViewport", viewportId: edit.viewportId, patch: prevValues };
      }
      case "setViewportRecord": {
        if (edit.viewportId === undefined || edit.viewport === undefined) {
          throw new Error("setViewportRecord requires viewportId + viewport");
        }
        const current = this.viewports.get(edit.viewportId);
        if (current === undefined) throw new Error(`setViewportRecord: no viewport '${edit.viewportId}'`);
        return { type: "setViewportRecord", viewportId: edit.viewportId, viewport: current };
      }
      case "removeViewport": {
        if (edit.viewportId === undefined) throw new Error("removeViewport requires viewportId");
        const existing = this.viewports.get(edit.viewportId);
        if (existing === undefined) throw new Error(`removeViewport: no viewport '${edit.viewportId}'`);
        return { type: "addViewport", viewport: existing };
      }
      // --- CAD-PARITY-009 (additive): UCS + section-plane inverses -------
      case "addUcs": {
        if (edit.ucs === undefined) throw new Error("addUcs requires ucs");
        const ucs = validateUcsTableRecord(edit.ucs);
        return { type: "removeUcs", ucsId: ucs.id };
      }
      case "updateUcs": {
        if (edit.ucsId === undefined || edit.patch === undefined) {
          throw new Error("updateUcs requires ucsId + patch");
        }
        const current = this.ucsTable.get(edit.ucsId);
        if (current === undefined) throw new Error(`updateUcs: no UCS '${edit.ucsId}'`);
        const patchKeys = Object.keys(edit.patch);
        const addsKey = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (addsKey) {
          return { type: "setUcsRecord", ucsId: edit.ucsId, ucs: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateUcs", ucsId: edit.ucsId, patch: prevValues };
      }
      case "setUcsRecord": {
        if (edit.ucsId === undefined || edit.ucs === undefined) {
          throw new Error("setUcsRecord requires ucsId + ucs");
        }
        const current = this.ucsTable.get(edit.ucsId);
        if (current === undefined) throw new Error(`setUcsRecord: no UCS '${edit.ucsId}'`);
        return { type: "setUcsRecord", ucsId: edit.ucsId, ucs: current };
      }
      case "removeUcs": {
        if (edit.ucsId === undefined) throw new Error("removeUcs requires ucsId");
        const existing = this.ucsTable.get(edit.ucsId);
        if (existing === undefined) throw new Error(`removeUcs: no UCS '${edit.ucsId}'`);
        return { type: "addUcs", ucs: existing };
      }
      case "addSectionPlane": {
        if (edit.sectionPlane === undefined) throw new Error("addSectionPlane requires sectionPlane");
        const plane = validateSectionPlaneTableRecord(edit.sectionPlane);
        return { type: "removeSectionPlane", sectionPlaneId: plane.id };
      }
      case "updateSectionPlane": {
        if (edit.sectionPlaneId === undefined || edit.patch === undefined) {
          throw new Error("updateSectionPlane requires sectionPlaneId + patch");
        }
        const current = this.sectionPlanes.get(edit.sectionPlaneId);
        if (current === undefined) throw new Error(`updateSectionPlane: no section plane '${edit.sectionPlaneId}'`);
        const patchKeys = Object.keys(edit.patch);
        const addsKey = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (addsKey) {
          return { type: "setSectionPlaneRecord", sectionPlaneId: edit.sectionPlaneId, sectionPlane: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateSectionPlane", sectionPlaneId: edit.sectionPlaneId, patch: prevValues };
      }
      case "setSectionPlaneRecord": {
        if (edit.sectionPlaneId === undefined || edit.sectionPlane === undefined) {
          throw new Error("setSectionPlaneRecord requires sectionPlaneId + sectionPlane");
        }
        const current = this.sectionPlanes.get(edit.sectionPlaneId);
        if (current === undefined) throw new Error(`setSectionPlaneRecord: no section plane '${edit.sectionPlaneId}'`);
        return { type: "setSectionPlaneRecord", sectionPlaneId: edit.sectionPlaneId, sectionPlane: current };
      }
      case "removeSectionPlane": {
        if (edit.sectionPlaneId === undefined) throw new Error("removeSectionPlane requires sectionPlaneId");
        const existing = this.sectionPlanes.get(edit.sectionPlaneId);
        if (existing === undefined) throw new Error(`removeSectionPlane: no section plane '${edit.sectionPlaneId}'`);
        return { type: "addSectionPlane", sectionPlane: existing };
      }
      // --- CAD-PARITY-013 (additive, Issue #104): the documentation -----
      // --- production record inverses (the updateLayout pattern: a patch
      // that ADDED/REMOVED a key inverts through the full-record restore so
      // absence is exactly representable on undo/replay). ----------------
      case "addNavigatorNode": {
        if (edit.node === undefined) throw new Error("addNavigatorNode requires node");
        const node = validateNavigatorNodeRecord(edit.node);
        return { type: "removeNavigatorNode", nodeId: node.id };
      }
      case "updateNavigatorNode": {
        if (edit.nodeId === undefined || edit.patch === undefined) {
          throw new Error("updateNavigatorNode requires nodeId + patch");
        }
        const current = this.navigatorNodes.get(edit.nodeId);
        if (current === undefined) throw new Error(`updateNavigatorNode: no navigator node '${edit.nodeId}'`);
        const patchKeys = Object.keys(edit.patch);
        const changesKeySet = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (changesKeySet) {
          return { type: "setNavigatorNodeRecord", nodeId: edit.nodeId, node: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateNavigatorNode", nodeId: edit.nodeId, patch: prevValues };
      }
      case "setNavigatorNodeRecord": {
        if (edit.nodeId === undefined || edit.node === undefined) {
          throw new Error("setNavigatorNodeRecord requires nodeId + node");
        }
        const current = this.navigatorNodes.get(edit.nodeId);
        if (current === undefined) throw new Error(`setNavigatorNodeRecord: no navigator node '${edit.nodeId}'`);
        return { type: "setNavigatorNodeRecord", nodeId: edit.nodeId, node: current };
      }
      case "removeNavigatorNode": {
        if (edit.nodeId === undefined) throw new Error("removeNavigatorNode requires nodeId");
        const existing = this.navigatorNodes.get(edit.nodeId);
        if (existing === undefined) throw new Error(`removeNavigatorNode: no navigator node '${edit.nodeId}'`);
        return { type: "addNavigatorNode", node: existing };
      }
      case "addTitleBlock": {
        if (edit.titleBlock === undefined) throw new Error("addTitleBlock requires titleBlock");
        const block = validateTitleBlockRecord(edit.titleBlock);
        return { type: "removeTitleBlock", titleBlockId: block.id };
      }
      case "updateTitleBlock": {
        if (edit.titleBlockId === undefined || edit.patch === undefined) {
          throw new Error("updateTitleBlock requires titleBlockId + patch");
        }
        const current = this.titleBlocks.get(edit.titleBlockId);
        if (current === undefined) throw new Error(`updateTitleBlock: no title block '${edit.titleBlockId}'`);
        const patchKeys = Object.keys(edit.patch);
        const changesKeySet = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (changesKeySet) {
          return { type: "setTitleBlockRecord", titleBlockId: edit.titleBlockId, titleBlock: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateTitleBlock", titleBlockId: edit.titleBlockId, patch: prevValues };
      }
      case "setTitleBlockRecord": {
        if (edit.titleBlockId === undefined || edit.titleBlock === undefined) {
          throw new Error("setTitleBlockRecord requires titleBlockId + titleBlock");
        }
        const current = this.titleBlocks.get(edit.titleBlockId);
        if (current === undefined) throw new Error(`setTitleBlockRecord: no title block '${edit.titleBlockId}'`);
        return { type: "setTitleBlockRecord", titleBlockId: edit.titleBlockId, titleBlock: current };
      }
      case "removeTitleBlock": {
        if (edit.titleBlockId === undefined) throw new Error("removeTitleBlock requires titleBlockId");
        const existing = this.titleBlocks.get(edit.titleBlockId);
        if (existing === undefined) throw new Error(`removeTitleBlock: no title block '${edit.titleBlockId}'`);
        return { type: "addTitleBlock", titleBlock: existing };
      }
      case "addSchedule": {
        if (edit.schedule === undefined) throw new Error("addSchedule requires schedule");
        const schedule = validateScheduleRecord(edit.schedule);
        return { type: "removeSchedule", scheduleId: schedule.id };
      }
      case "updateSchedule": {
        if (edit.scheduleId === undefined || edit.patch === undefined) {
          throw new Error("updateSchedule requires scheduleId + patch");
        }
        const current = this.schedules.get(edit.scheduleId);
        if (current === undefined) throw new Error(`updateSchedule: no schedule '${edit.scheduleId}'`);
        const patchKeys = Object.keys(edit.patch);
        const changesKeySet = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (changesKeySet) {
          return { type: "setScheduleRecord", scheduleId: edit.scheduleId, schedule: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateSchedule", scheduleId: edit.scheduleId, patch: prevValues };
      }
      case "setScheduleRecord": {
        if (edit.scheduleId === undefined || edit.schedule === undefined) {
          throw new Error("setScheduleRecord requires scheduleId + schedule");
        }
        const current = this.schedules.get(edit.scheduleId);
        if (current === undefined) throw new Error(`setScheduleRecord: no schedule '${edit.scheduleId}'`);
        return { type: "setScheduleRecord", scheduleId: edit.scheduleId, schedule: current };
      }
      case "removeSchedule": {
        if (edit.scheduleId === undefined) throw new Error("removeSchedule requires scheduleId");
        const existing = this.schedules.get(edit.scheduleId);
        if (existing === undefined) throw new Error(`removeSchedule: no schedule '${edit.scheduleId}'`);
        return { type: "addSchedule", schedule: existing };
      }
      // CAD-PARITY-015 (Issue #110): the property-definition registry inverses.
      case "addPropertyDef": {
        if (edit.propertyDef === undefined) throw new Error("addPropertyDef requires propertyDef");
        const def = validatePropertyDefRecord(edit.propertyDef);
        return { type: "removePropertyDef", propertyDefId: def.id };
      }
      case "updatePropertyDef": {
        if (edit.propertyDefId === undefined || edit.patch === undefined) {
          throw new Error("updatePropertyDef requires propertyDefId + patch");
        }
        const current = this.propertyDefs.get(edit.propertyDefId);
        if (current === undefined) throw new Error(`updatePropertyDef: no property definition '${edit.propertyDefId}'`);
        const patchKeys = Object.keys(edit.patch);
        const changesKeySet = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (changesKeySet) {
          return { type: "setPropertyDefRecord", propertyDefId: edit.propertyDefId, propertyDef: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updatePropertyDef", propertyDefId: edit.propertyDefId, patch: prevValues };
      }
      case "setPropertyDefRecord": {
        if (edit.propertyDefId === undefined || edit.propertyDef === undefined) {
          throw new Error("setPropertyDefRecord requires propertyDefId + propertyDef");
        }
        const current = this.propertyDefs.get(edit.propertyDefId);
        if (current === undefined) throw new Error(`setPropertyDefRecord: no property definition '${edit.propertyDefId}'`);
        return { type: "setPropertyDefRecord", propertyDefId: edit.propertyDefId, propertyDef: current };
      }
      case "removePropertyDef": {
        if (edit.propertyDefId === undefined) throw new Error("removePropertyDef requires propertyDefId");
        const existing = this.propertyDefs.get(edit.propertyDefId);
        if (existing === undefined) throw new Error(`removePropertyDef: no property definition '${edit.propertyDefId}'`);
        return { type: "addPropertyDef", propertyDef: existing };
      }
      // CAD-PARITY-018 (Issue #118): the specialized-toolsets inverses (the
      // full-record restore pattern — undo of add is remove; undo of remove
      // re-adds the exact record; undo of setRecord restores the previous
      // record byte-identically).
      case "addSpecialized": {
        if (edit.record === undefined) throw new Error("addSpecialized requires record");
        const record = normalizeToolsetRecord(edit.record);
        return { type: "removeSpecialized", id: record.id };
      }
      case "setSpecializedRecord": {
        if (edit.id === undefined || edit.record === undefined) {
          throw new Error("setSpecializedRecord requires id + record");
        }
        const current = this.specialized.get(edit.id);
        if (current === undefined) throw new Error(`setSpecializedRecord: no specialized record '${edit.id}'`);
        return { type: "setSpecializedRecord", id: edit.id, record: current };
      }
      case "removeSpecialized": {
        if (edit.id === undefined) throw new Error("removeSpecialized requires id");
        const existing = this.specialized.get(edit.id);
        if (existing === undefined) throw new Error(`removeSpecialized: no specialized record '${edit.id}'`);
        return { type: "addSpecialized", record: existing };
      }
      case "addRevision": {
        if (edit.revision === undefined) throw new Error("addRevision requires revision");
        const revision = validateRevisionRecord(edit.revision);
        return { type: "removeRevision", revisionId: revision.id };
      }
      case "updateRevision": {
        if (edit.revisionId === undefined || edit.patch === undefined) {
          throw new Error("updateRevision requires revisionId + patch");
        }
        const current = this.revisions.get(edit.revisionId);
        if (current === undefined) throw new Error(`updateRevision: no revision '${edit.revisionId}'`);
        const patchKeys = Object.keys(edit.patch);
        const changesKeySet = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (changesKeySet) {
          return { type: "setRevisionRecord", revisionId: edit.revisionId, revision: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateRevision", revisionId: edit.revisionId, patch: prevValues };
      }
      case "setRevisionRecord": {
        if (edit.revisionId === undefined || edit.revision === undefined) {
          throw new Error("setRevisionRecord requires revisionId + revision");
        }
        const current = this.revisions.get(edit.revisionId);
        if (current === undefined) throw new Error(`setRevisionRecord: no revision '${edit.revisionId}'`);
        return { type: "setRevisionRecord", revisionId: edit.revisionId, revision: current };
      }
      case "removeRevision": {
        if (edit.revisionId === undefined) throw new Error("removeRevision requires revisionId");
        const existing = this.revisions.get(edit.revisionId);
        if (existing === undefined) throw new Error(`removeRevision: no revision '${edit.revisionId}'`);
        return { type: "addRevision", revision: existing };
      }
      case "addPublisherSet": {
        if (edit.set === undefined) throw new Error("addPublisherSet requires set");
        const set = validatePublisherSetRecord(edit.set);
        return { type: "removePublisherSet", setId: set.id };
      }
      case "updatePublisherSet": {
        if (edit.setId === undefined || edit.patch === undefined) {
          throw new Error("updatePublisherSet requires setId + patch");
        }
        const current = this.publisherSets.get(edit.setId);
        if (current === undefined) throw new Error(`updatePublisherSet: no publisher set '${edit.setId}'`);
        const patchKeys = Object.keys(edit.patch);
        const changesKeySet = patchKeys.some(
          (k) => !Object.prototype.hasOwnProperty.call(current as unknown as Record<string, unknown>, k),
        );
        if (changesKeySet) {
          return { type: "setPublisherSetRecord", setId: edit.setId, set: current };
        }
        const prevValues: Record<string, unknown> = {};
        for (const k of patchKeys) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updatePublisherSet", setId: edit.setId, patch: prevValues };
      }
      case "setPublisherSetRecord": {
        if (edit.setId === undefined || edit.set === undefined) {
          throw new Error("setPublisherSetRecord requires setId + set");
        }
        const current = this.publisherSets.get(edit.setId);
        if (current === undefined) throw new Error(`setPublisherSetRecord: no publisher set '${edit.setId}'`);
        return { type: "setPublisherSetRecord", setId: edit.setId, set: current };
      }
      case "removePublisherSet": {
        if (edit.setId === undefined) throw new Error("removePublisherSet requires setId");
        const existing = this.publisherSets.get(edit.setId);
        if (existing === undefined) throw new Error(`removePublisherSet: no publisher set '${edit.setId}'`);
        return { type: "addPublisherSet", set: existing };
      }
      default: {
        const _exhaustive = edit satisfies never;
        throw new Error(`unreachable edit type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Current mint counter for layer identities (persisted via the history;
   *  COMPAT-CAD-001). */
  get layerSequence(): number {
    return this.nextLayerSequence;
  }

  /** Look up a layer by canonical id. */
  layerById(id: string): LayerRecord | undefined {
    return this.layers.get(id);
  }

  // --- CAD-PARITY-004: the name-keyed standards/style/state tables ----------

  /** The user-defined linetype table (insertion order). */
  get ltypeTable(): readonly LtypeRecord[] {
    return [...this.ltypes.values()];
  }

  /** Look up a user-defined linetype by name. */
  ltypeByName(name: string): LtypeRecord | undefined {
    return this.ltypes.get(name);
  }

  /** The user-defined text-style table (insertion order). */
  get textStyleTable(): readonly TextStyleRecord[] {
    return [...this.textStyles.values()];
  }

  /** Look up a user-defined text style by name. */
  textStyleByName(name: string): TextStyleRecord | undefined {
    return this.textStyles.get(name);
  }

  /** The user-defined dimension-style table (insertion order). */
  get dimStyleTable(): readonly DimStyleRecord[] {
    return [...this.dimStyles.values()];
  }

  /** Look up a user-defined dimension style by name. */
  dimStyleByName(name: string): DimStyleRecord | undefined {
    return this.dimStyles.get(name);
  }

  /** The named layer states (insertion order). */
  get layerStateTable(): readonly LayerStateRecord[] {
    return [...this.layerStates.values()];
  }

  /** Look up a layer state by name. */
  layerStateByName(name: string): LayerStateRecord | undefined {
    return this.layerStates.get(name);
  }

  // --- CAD-PARITY-006: block definitions + external references ------------

  /** The block-definition table (insertion order). */
  get blockDefTable(): readonly BlockDefinitionRecord[] {
    return [...this.blockDefs.values()];
  }

  /** Look up a block definition by canonical id. */
  blockDefById(id: string): BlockDefinitionRecord | undefined {
    return this.blockDefs.get(id);
  }

  /** Look up a block definition by name (the user-facing address). */
  blockDefByName(name: string): BlockDefinitionRecord | undefined {
    for (const b of this.blockDefs.values()) {
      if (b.name === name) return b;
    }
    return undefined;
  }

  /** The attached external references (insertion order). */
  get xrefTable(): readonly XrefRecord[] {
    return [...this.xrefs.values()];
  }

  /** Look up an external reference by canonical id. */
  xrefById(id: string): XrefRecord | undefined {
    return this.xrefs.get(id);
  }

  /** Look up an external reference by name. */
  xrefByName(name: string): XrefRecord | undefined {
    for (const x of this.xrefs.values()) {
      if (x.name === name) return x;
    }
    return undefined;
  }

  /** CAD-PARITY-007: the declared constraint graph (insertion order). */
  get constraintTable(): readonly ConstraintRecord[] {
    return [...this.constraints.values()];
  }

  /** CAD-PARITY-007: look up one constraint record by canonical id. */
  constraintById(id: string): ConstraintRecord | undefined {
    return this.constraints.get(id);
  }

  // --- CAD-PARITY-008: the layout + viewport tables -------------------------

  /** The paper-space layout table (insertion order). */
  get layoutTable(): readonly LayoutRecord[] {
    return [...this.layouts.values()];
  }

  /** Look up one layout by canonical id. */
  layoutById(id: string): LayoutRecord | undefined {
    return this.layouts.get(id);
  }

  /** Look up one layout by its unique user-facing name. */
  layoutByName(name: string): LayoutRecord | undefined {
    for (const l of this.layouts.values()) {
      if (l.name === name) return l;
    }
    return undefined;
  }

  /** The rectangular layout viewport table (insertion order). */
  get viewportTable(): readonly ViewportRecord[] {
    return [...this.viewports.values()];
  }

  /** Look up one viewport by canonical id. */
  viewportById(id: string): ViewportRecord | undefined {
    return this.viewports.get(id);
  }

  /** The viewports of ONE layout (table order — the deterministic z-order). */
  viewportsOfLayout(layoutId: string): readonly ViewportRecord[] {
    return [...this.viewports.values()].filter((v) => v.layoutId === layoutId);
  }

  /** Current mint counter for layout identities (persisted via the history). */
  get layoutSequence(): number {
    return this.nextLayoutSequence;
  }

  /** Current mint counter for viewport identities (persisted via the history). */
  get viewportSequence(): number {
    return this.nextViewportSequence;
  }

  /** Mint a canonical block-definition identity (`blk-NNNNNN`, monotonic,
   *  never reused) — document authority, mirrors mintLayerId. */
  mintBlockId(): string {
    const minted = `blk-${String(this.nextBlockSequence).padStart(6, "0")}`;
    this.nextBlockSequence += 1;
    return minted;
  }

  /** Mint a canonical external-reference identity (`xr-NNNNNN`, monotonic,
   *  never reused). */
  mintXrefId(): string {
    const minted = `xr-${String(this.nextXrefSequence).padStart(6, "0")}`;
    this.nextXrefSequence += 1;
    return minted;
  }

  /** CAD-PARITY-007: mint a canonical constraint identity (`con-NNNNNN`,
   *  monotonic, never reused) — document authority, mirrors mintBlockId. */
  mintConstraintId(): string {
    const minted = `con-${String(this.nextConstraintSequence).padStart(6, "0")}`;
    this.nextConstraintSequence += 1;
    return minted;
  }

  /** CAD-PARITY-008: mint a canonical layout identity (`lo-NNNNNN`,
   *  monotonic, never reused) — document authority. */
  mintLayoutId(): string {
    const minted = `lo-${String(this.nextLayoutSequence).padStart(6, "0")}`;
    this.nextLayoutSequence += 1;
    return minted;
  }

  /** CAD-PARITY-008: mint a canonical viewport identity (`vp-NNNNNN`,
   *  monotonic, never reused) — document authority. */
  mintViewportId(): string {
    const minted = `vp-${String(this.nextViewportSequence).padStart(6, "0")}`;
    this.nextViewportSequence += 1;
    return minted;
  }

  /** CAD-PARITY-009: mint a canonical UCS identity (`ucs-NNNNNN`, monotonic,
   *  never reused) — document authority (mirrors mintLayoutId). */
  mintUcsId(): string {
    const minted = `ucs-${String(this.nextUcsSequence).padStart(6, "0")}`;
    this.nextUcsSequence += 1;
    return minted;
  }

  /** CAD-PARITY-009: mint a canonical section-plane identity
   *  (`sp-NNNNNN`, monotonic, never reused) — document authority. */
  mintSectionPlaneId(): string {
    const minted = `sp-${String(this.nextSectionPlaneSequence).padStart(6, "0")}`;
    this.nextSectionPlaneSequence += 1;
    return minted;
  }

  // --- CAD-PARITY-013: the documentation production mint counters --------

  /** CAD-PARITY-013: mint a canonical navigator node identity
   *  (`nav-NNNNNN`, monotonic, never reused) — document authority. */
  mintNavigatorNodeId(): string {
    const minted = `nav-${String(this.nextNavigatorNodeSequence).padStart(6, "0")}`;
    this.nextNavigatorNodeSequence += 1;
    return minted;
  }

  /** CAD-PARITY-013: mint a canonical title-block identity
   *  (`tb-NNNNNN`, monotonic, never reused) — document authority. */
  mintTitleBlockId(): string {
    const minted = `tb-${String(this.nextTitleBlockSequence).padStart(6, "0")}`;
    this.nextTitleBlockSequence += 1;
    return minted;
  }

  /** CAD-PARITY-013: mint a canonical schedule identity
   *  (`sch-NNNNNN`, monotonic, never reused) — document authority. */
  mintScheduleId(): string {
    const minted = `sch-${String(this.nextScheduleSequence).padStart(6, "0")}`;
    this.nextScheduleSequence += 1;
    return minted;
  }

  /** CAD-PARITY-013: mint a canonical revision identity
   *  (`rev-NNNNNN`, monotonic, never reused) — document authority. */
  mintRevisionId(): string {
    const minted = `rev-${String(this.nextRevisionSequence).padStart(6, "0")}`;
    this.nextRevisionSequence += 1;
    return minted;
  }

  /** CAD-PARITY-013: mint a canonical publisher-set identity
   *  (`pub-NNNNNN`, monotonic, never reused) — document authority. */
  mintPublisherSetId(): string {
    const minted = `pub-${String(this.nextPublisherSetSequence).padStart(6, "0")}`;
    this.nextPublisherSetSequence += 1;
    return minted;
  }

  // --- CAD-PARITY-013: the documentation production tables -------------------

  /** CAD-PARITY-013: the navigator tree (insertion order). */
  get navigatorNodeTable(): readonly NavigatorNodeRecord[] {
    return [...this.navigatorNodes.values()];
  }

  /** Look up a navigator node by canonical id. */
  navigatorNodeById(id: string): NavigatorNodeRecord | undefined {
    return this.navigatorNodes.get(id);
  }

  /** Current mint counter for navigator node identities (persisted via the
   *  history). */
  get navigatorNodeSequence(): number {
    return this.nextNavigatorNodeSequence;
  }

  /** The title-block table (insertion order). */
  get titleBlockTable(): readonly TitleBlockRecord[] {
    return [...this.titleBlocks.values()];
  }

  /** Look up a title block by canonical id. */
  titleBlockById(id: string): TitleBlockRecord | undefined {
    return this.titleBlocks.get(id);
  }

  /** Look up a title block by its unique user-facing name. */
  titleBlockByName(name: string): TitleBlockRecord | undefined {
    for (const tb of this.titleBlocks.values()) {
      if (tb.name === name) return tb;
    }
    return undefined;
  }

  /** Current mint counter for title-block identities. */
  get titleBlockSequence(): number {
    return this.nextTitleBlockSequence;
  }

  /** The schedule table (insertion order). */
  get scheduleTable(): readonly ScheduleRecord[] {
    return [...this.schedules.values()];
  }

  /** Look up a schedule by canonical id. */
  scheduleById(id: string): ScheduleRecord | undefined {
    return this.schedules.get(id);
  }

  /** Look up a schedule by its unique name. */
  scheduleByName(name: string): ScheduleRecord | undefined {
    for (const s of this.schedules.values()) {
      if (s.name === name) return s;
    }
    return undefined;
  }

  /** Current mint counter for schedule identities. */
  get scheduleSequence(): number {
    return this.nextScheduleSequence;
  }

  /** CAD-PARITY-015: mint a canonical property-definition identity
   *  (`prd-NNNNNN`, monotonic, never reused) — document authority. */
  mintPropertyDefId(): string {
    const minted = `prd-${String(this.nextPropertyDefSequence).padStart(6, "0")}`;
    this.nextPropertyDefSequence += 1;
    return minted;
  }

  /** CAD-PARITY-015: the property-definition registry (insertion order). */
  get propertyDefTable(): readonly PropertyDefRecord[] {
    return [...this.propertyDefs.values()];
  }

  /** CAD-PARITY-015: look up a property definition by canonical id. */
  propertyDefById(id: string): PropertyDefRecord | undefined {
    return this.propertyDefs.get(id);
  }

  /** CAD-PARITY-015: look up a property definition by its unique name. */
  propertyDefByName(name: string): PropertyDefRecord | undefined {
    for (const d of this.propertyDefs.values()) {
      if (d.name === name) return d;
    }
    return undefined;
  }

  /** CAD-PARITY-015: look up a property definition by its unique (set, key)
   *  address (the `ps:<set>.<key>` resolution grammar). */
  propertyDefByAddress(set: string, key: string): PropertyDefRecord | undefined {
    for (const d of this.propertyDefs.values()) {
      if (d.set === set && d.key === key) return d;
    }
    return undefined;
  }

  /** CAD-PARITY-015: current mint counter for property-definition identities. */
  get propertyDefSequence(): number {
    return this.nextPropertyDefSequence;
  }

  /** CAD-PARITY-018: mint a canonical specialized-record identity
   *  (`tls-NNNNNN`, monotonic, never reused) — document authority. */
  mintSpecializedId(): string {
    const minted = `tls-${String(this.nextSpecializedSequence).padStart(6, "0")}`;
    this.nextSpecializedSequence += 1;
    return minted;
  }

  /** CAD-PARITY-018: the specialized-toolsets record table (insertion
   *  order — mint order, deterministic). */
  get specializedTable(): readonly SpecializedRecord[] {
    return [...this.specialized.values()];
  }

  /** CAD-PARITY-018: look up a specialized record by canonical id. */
  specializedById(id: string): SpecializedRecord | undefined {
    return this.specialized.get(id);
  }

  /** CAD-PARITY-018: the raster sources carrying a given sourceRef (the
   *  uniqueness basis). */
  specializedRasterSourceByRef(sourceRef: string): SpecializedRecord | undefined {
    for (const rec of this.specialized.values()) {
      if (rec.kind === "raster.source" && rec.data.sourceRef === sourceRef) return rec;
    }
    return undefined;
  }

  /** CAD-PARITY-018: current mint counter for specialized identities. */
  get specializedSequence(): number {
    return this.nextSpecializedSequence;
  }

  /** CAD-PARITY-018 (Issue #118): the per-kind specialized table bounds +
   *  raster sourceRef uniqueness (typed messages; the document is the
   *  table authority — the pure toolsets-core validators have no table
   *  access, so the closed bounds are enforced here). */
  private assertSpecializedTableBounds(record: SpecializedRecord, excludeId: string | null): void {
    let count = 0;
    for (const rec of this.specialized.values()) {
      if (excludeId !== null && rec.id === excludeId) continue;
      if (rec.kind === record.kind) count += 1;
    }
    const bounds: Record<string, number> = {
      "mep.run": TOOLSETS_TABLE_BOUNDS.maxRuns,
      "mech.equipment": TOOLSETS_TABLE_BOUNDS.maxEquipment,
      "raster.source": TOOLSETS_TABLE_BOUNDS.maxRasterSources,
      "raster.reference": TOOLSETS_TABLE_BOUNDS.maxRasterReferences,
    };
    const max = bounds[record.kind] ?? 0;
    if (count + 1 > max) {
      throw new Error(
        `addSpecialized: the ${record.kind} table is full (${max} records — the closed specialized-toolsets bound)`,
      );
    }
    if (record.kind === "raster.source") {
      for (const rec of this.specialized.values()) {
        if (excludeId !== null && rec.id === excludeId) continue;
        if (rec.kind === "raster.source" && rec.data.sourceRef === record.data.sourceRef) {
          throw new Error(
            `addSpecialized: raster sourceRef '${record.data.sourceRef}' is already registered (source references are unique among raster sources)`,
          );
        }
      }
    }
  }

  /** The revision records (insertion order). */
  get revisionTable(): readonly RevisionRecord[] {
    return [...this.revisions.values()];
  }

  /** Look up a revision by canonical id. */
  revisionById(id: string): RevisionRecord | undefined {
    return this.revisions.get(id);
  }

  /** Look up a revision by its unique code. */
  revisionByCode(code: string): RevisionRecord | undefined {
    for (const rev of this.revisions.values()) {
      if (rev.code === code) return rev;
    }
    return undefined;
  }

  /** Current mint counter for revision identities. */
  get revisionSequence(): number {
    return this.nextRevisionSequence;
  }

  /** The publisher sets (insertion order). */
  get publisherSetTable(): readonly PublisherSetRecord[] {
    return [...this.publisherSets.values()];
  }

  /** Look up a publisher set by canonical id. */
  publisherSetById(id: string): PublisherSetRecord | undefined {
    return this.publisherSets.get(id);
  }

  /** Look up a publisher set by its unique name. */
  publisherSetByName(name: string): PublisherSetRecord | undefined {
    for (const ps of this.publisherSets.values()) {
      if (ps.name === name) return ps;
    }
    return undefined;
  }

  /** Current mint counter for publisher-set identities. */
  get publisherSetSequence(): number {
    return this.nextPublisherSetSequence;
  }

  /** CAD-PARITY-013: state-dependent navigator parent validation (parent
   *  must exist and share the node's kind — folders under folders, subsets
   *  under subsets). */
  private validateNavigatorNodeReferences(node: NavigatorNodeRecord): void {
    if (node.parentId !== null) {
      const parent = this.navigatorNodes.get(node.parentId);
      if (parent === undefined) {
        throw new Error(
          `navigator node '${node.id}': parentId '${node.parentId}' does not reference an existing node`,
        );
      }
      if (parent.kind !== node.kind) {
        throw new Error(
          `navigator node '${node.id}' (${node.kind}) cannot nest under a '${parent.kind}' node — parents must share the node kind`,
        );
      }
    }
  }

  /** CAD-PARITY-013: cycle gate — a node may not become its own ancestor
   *  (walk the parent chain from the NEW parent upward). */
  private assertNoNavigatorCycle(nodeId: string, parentId: string | null): void {
    const seen = new Set<string>([nodeId]);
    let current = parentId;
    while (current !== null) {
      if (seen.has(current)) {
        throw new Error(
          `navigator node '${nodeId}' would become its own ancestor (cycle through '${current}') — navigator_invalid`,
        );
      }
      seen.add(current);
      current = this.navigatorNodes.get(current)?.parentId ?? null;
    }
  }

  /** CAD-PARITY-013: reference gates for removeNavigatorNode — child nodes,
   *  view folderId references, layout subsetId references and publisher-set
   *  subset items block removal (no silent cascade). */
  private assertNavigatorNodeUnreferenced(id: string): void {
    let children = 0;
    for (const n of this.navigatorNodes.values()) {
      if (n.parentId === id) children += 1;
    }
    if (children > 0) {
      throw new Error(
        `removeNavigatorNode: '${id}' still has ${children} child node${children === 1 ? "" : "s"} — remove them first (no silent cascade)`,
      );
    }
    let viewRefs = 0;
    for (const view of this.docsViews.values()) {
      if (view.folderId === id) viewRefs += 1;
    }
    if (viewRefs > 0) {
      throw new Error(
        `removeNavigatorNode: '${id}' is the folder of ${viewRefs} view${viewRefs === 1 ? "" : "s"} — unassign them first (no silent cascade)`,
      );
    }
    let layoutRefs = 0;
    for (const layout of this.layouts.values()) {
      if (layout.subsetId === id) layoutRefs += 1;
    }
    if (layoutRefs > 0) {
      throw new Error(
        `removeNavigatorNode: '${id}' is the subset of ${layoutRefs} layout${layoutRefs === 1 ? "" : "s"} — unassign them first (no silent cascade)`,
      );
    }
    for (const ps of this.publisherSets.values()) {
      const item = ps.items.find((i) => i.kind === "subset" && i.id === id);
      if (item !== undefined) {
        throw new Error(
          `removeNavigatorNode: '${id}' is referenced by publisher set '${ps.name}' — remove the item through publisher.update first (no silent cascade)`,
        );
      }
    }
  }

  /** A title-block name must stay unique (null excludeId = pure add check). */
  private assertTitleBlockNameFree(name: string, excludeId: string | null): void {
    for (const tb of this.titleBlocks.values()) {
      if (tb.id !== excludeId && tb.name === name) {
        throw new Error(`title block name '${name}' already exists — title block names are unique`);
      }
    }
  }

  /** Reference gate for removeTitleBlock: layout titleBlockPlacement
   *  references block removal (no silent cascade). */
  private assertTitleBlockUnreferenced(id: string): void {
    const referencing = [...this.layouts.values()].filter((l) => l.titleBlockPlacement?.titleBlockId === id);
    if (referencing.length > 0) {
      throw new Error(
        `removeTitleBlock: '${id}' is placed on ${referencing.length} layout${referencing.length === 1 ? "" : "s"} (${referencing.map((l) => l.name).join(", ")}) — unplace it first (no silent cascade)`,
      );
    }
  }

  /** A schedule name must stay unique (null excludeId = pure add check). */
  private assertScheduleNameFree(name: string, excludeId: string | null): void {
    for (const s of this.schedules.values()) {
      if (s.id !== excludeId && s.name === name) {
        throw new Error(`schedule name '${name}' already exists — schedule names are unique`);
      }
    }
  }

  /** CAD-PARITY-015: a property-definition name must stay unique (null
   *  excludeId = pure add check). */
  private assertPropertyDefNameFree(name: string, excludeId: string | null): void {
    for (const d of this.propertyDefs.values()) {
      if (d.id !== excludeId && d.name === name) {
        throw new Error(`property definition name '${name}' already exists — property definition names are unique`);
      }
    }
  }

  /** CAD-PARITY-015: a property-definition (set, key) address must stay
   *  unique (null excludeId = pure add check). */
  private assertPropertyDefAddressFree(set: string, key: string, excludeId: string | null): void {
    for (const d of this.propertyDefs.values()) {
      if (d.id !== excludeId && d.set === set && d.key === key) {
        throw new Error(`property definition address '${set}.${key}' already exists — (set, key) addresses are unique among property definitions`);
      }
    }
  }

  /** A revision code must stay unique (null excludeId = pure add check). */
  private assertRevisionCodeFree(code: string, excludeId: string | null): void {
    for (const rev of this.revisions.values()) {
      if (rev.id !== excludeId && rev.code === code) {
        throw new Error(`revision code '${code}' already exists — revision codes are unique`);
      }
    }
  }

  /** Every revision layoutId must reference an existing layout. */
  private assertRevisionLayoutsExist(layoutIds: readonly string[]): void {
    for (const layoutId of layoutIds) {
      if (!this.layouts.has(layoutId)) {
        throw new Error(`revision references unknown layout '${layoutId}'`);
      }
    }
  }

  /** A publisher-set name must stay unique (null excludeId = pure add). */
  private assertPublisherSetNameFree(name: string, excludeId: string | null): void {
    for (const ps of this.publisherSets.values()) {
      if (ps.id !== excludeId && ps.name === name) {
        throw new Error(`publisher set name '${name}' already exists — publisher set names are unique`);
      }
    }
  }

  /** Every publisher item target must exist with the right kind (layout →
   *  lo-*; subset → a kind "subset" navigator node). */
  private assertPublisherItemsResolve(items: readonly PublisherItem[]): void {
    for (const item of items) {
      if (item.kind === "layout" && !this.layouts.has(item.id)) {
        throw new Error(`publisher set item references unknown layout '${item.id}'`);
      }
      if (item.kind === "subset") {
        const node = this.navigatorNodes.get(item.id);
        if (node === undefined || node.kind !== "subset") {
          throw new Error(
            `publisher set item references navigator node '${item.id}' that is not a subset (kind "subset" required)`,
          );
        }
      }
    }
  }

  /** The EXPANDED publisher layout list (subsets expanded in book order)
   *  must contain no duplicate layout — one layout cannot publish twice. */
  private assertPublisherExpansionUnique(items: readonly PublisherItem[]): void {
    const expanded: string[] = [];
    for (const item of items) {
      if (item.kind === "layout") {
        expanded.push(item.id);
      } else {
        expanded.push(...this.subsetLayoutIds(item.id));
      }
    }
    const seen = new Set<string>();
    for (const layoutId of expanded) {
      if (seen.has(layoutId)) {
        throw new Error(
          `publisher set expansion contains layout '${layoutId}' twice — a layout cannot be published twice (check overlapping subset/layout items)`,
        );
      }
      seen.add(layoutId);
    }
  }

  /** The layouts of ONE subset's SUBTREE in book order (nodes ordered by
   *  (order, id) recursively; layouts in document order within a node). */
  private subsetLayoutIds(subsetNodeId: string): readonly string[] {
    const out: string[] = [];
    const walk = (nodeId: string): void => {
      const children = [...this.navigatorNodes.values()]
        .filter((n) => n.parentId === nodeId && n.kind === "subset")
        .sort((a, b) => (a.order !== b.order ? a.order - b.order : (a.id < b.id ? -1 : 1)));
      for (const layout of this.layouts.values()) {
        if (layout.subsetId === nodeId) out.push(layout.id);
      }
      for (const child of children) walk(child.id);
    };
    walk(subsetNodeId);
    return out;
  }

  /** Validate a block-definition record for an ADD or UPDATE against the
   *  post-write table view: structural validation + the definition-graph
   *  gates (cycles/nesting), duplicate id (add) and duplicate name checks,
   *  and nested-reference resolution. */
  private validateBlockDefWrite(raw: unknown, isUpdate: boolean): BlockDefinitionRecord {
    const record = raw as BlockDefinitionRecord;
    const resolver = (id: string): readonly Record<string, unknown>[] | undefined =>
      id === record.id ? record.entities : this.blockDefs.get(id)?.entities;
    let validated: BlockDefinitionRecord;
    try {
      validated = validateBlockDefinitionRecord(raw, resolver);
    } catch (e) {
      throw new Error(isUpdate ? `updateBlockDef: ${(e as Error).message}` : `addBlockDef: ${(e as Error).message}`);
    }
    if (!isUpdate && this.blockDefs.has(validated.id)) {
      throw new Error(
        `addBlockDef: block id '${validated.id}' already exists — canonical block identity must not be reused while the definition exists`,
      );
    }
    this.assertBlockDefNameFree(validated.name, isUpdate ? validated.id : null);
    this.assertBlockRefsResolve(validated.id, validated.entities);
    return validated;
  }

  /** A definition name must stay unique (null excludeId = pure add check). */
  private assertBlockDefNameFree(name: string, excludeId: string | null): void {
    for (const b of this.blockDefs.values()) {
      if (b.id !== excludeId && b.name === name) {
        throw new Error(`block definition name '${name}' already exists — remove or rename it first`);
      }
    }
  }

  /** Every nested block-ref inside a definition's content must reference a
   *  definition of the post-write table (self included — self-reference is
   *  the cycle the graph gate rejects). */
  private assertBlockRefsResolve(id: string, entities: readonly Record<string, unknown>[]): void {
    for (const childId of referencedBlockIds(entities)) {
      if (childId !== id && !this.blockDefs.has(childId)) {
        throw new Error(`block definition references unknown definition '${childId}'`);
      }
    }
  }

  /** Reference check for removeBlockDef: instances AND other definitions'
   *  inline content block removal (no silent cascade). */
  private assertBlockDefUnreferenced(id: string): void {
    let instances = 0;
    for (const el of this.elements.values()) {
      const p = el.props as Record<string, unknown>;
      if (p.drafting === true && p.type === "block-ref" && p.blockId === id) instances += 1;
    }
    if (instances > 0) {
      throw new Error(
        `removeBlockDef: '${id}' is referenced by ${instances} block instance${instances === 1 ? "" : "s"} — erase or explode them first (no silent cascade)`,
      );
    }
    for (const b of this.blockDefs.values()) {
      if (b.id !== id && referencedBlockIds(b.entities).includes(id)) {
        throw new Error(
          `removeBlockDef: '${id}' is referenced by definition '${b.name}' — edit that definition first (no silent cascade)`,
        );
      }
    }
  }

  /** An external-reference name must stay unique (null excludeId = add). */
  private assertXrefNameFree(name: string, excludeId: string | null): void {
    for (const x of this.xrefs.values()) {
      if (x.id !== excludeId && x.name === name) {
        throw new Error(`external reference name '${name}' already exists — detach it first`);
      }
    }
  }

  /** Reference check for removeXref: instance elements referencing the
   *  record block removal — the DETACH command removes instances + record
   * as ONE atomic batch (the cascade lives at the command layer). */
  private assertXrefUnreferenced(id: string): void {
    let instances = 0;
    for (const el of this.elements.values()) {
      const p = el.props as Record<string, unknown>;
      if (p.drafting === true && p.type === "xref-ref" && p.xrefId === id) instances += 1;
    }
    if (instances > 0) {
      throw new Error(
        `removeXref: '${id}' is referenced by ${instances} reference instance${instances === 1 ? "" : "s"} — detach through the reference manager (XDETACH) instead`,
      );
    }
  }

  // --- CAD-PARITY-008: layout reference checks -------------------------------

  /** Uniqueness check for layout names (rename keeps names unique). */
  private assertLayoutNameFree(name: string, excludeId: string | null): void {
    for (const l of this.layouts.values()) {
      if (l.id !== excludeId && l.name === name) {
        throw new Error(`layout name '${name}' already exists — layout names are unique`);
      }
    }
  }

  // --- CAD-PARITY-009: the UCS + section-plane surfaces ----------------------

  /** CAD-PARITY-009: the named UCS table (insertion order; the implicit
   *  World UCS is NEVER in it — address it as "world"). */
  get ucsRecords(): readonly UcsRecord[] {
    return [...this.ucsTable.values()];
  }

  /** Look up a named UCS by canonical id. */
  ucsById(id: string): UcsRecord | undefined {
    return this.ucsTable.get(id);
  }

  /** Look up a named UCS by name (names unique among UCSs). */
  ucsByName(name: string): UcsRecord | undefined {
    for (const u of this.ucsTable.values()) {
      if (u.name === name) return u;
    }
    return undefined;
  }

  /** Current mint counter for UCS identities (persisted via the history). */
  get ucsSequence(): number {
    return this.nextUcsSequence;
  }

  /** CAD-PARITY-009: the section-plane table (insertion order). */
  get sectionPlaneRecords(): readonly SectionPlaneRecord[] {
    return [...this.sectionPlanes.values()];
  }

  /** Look up a section plane by canonical id. */
  sectionPlaneById(id: string): SectionPlaneRecord | undefined {
    return this.sectionPlanes.get(id);
  }

  /** Look up a section plane by name. */
  sectionPlaneByName(name: string): SectionPlaneRecord | undefined {
    for (const sp of this.sectionPlanes.values()) {
      if (sp.name === name) return sp;
    }
    return undefined;
  }

  /** Current mint counter for section-plane identities. */
  get sectionPlaneSequence(): number {
    return this.nextSectionPlaneSequence;
  }

  /** Uniqueness check for UCS names (rename keeps names unique; the
   *  implicit World UCS owns its reserved name by construction — table
   * records cannot take it, validateUcsTableRecord rejects it). */
  private assertUcsNameFree(name: string, excludeId: string | null): void {
    for (const u of this.ucsTable.values()) {
      if (u.id !== excludeId && u.name === name) {
        throw new Error(`UCS name '${name}' already exists — UCS names are unique`);
      }
    }
  }

  /** Uniqueness check for section-plane names. */
  private assertSectionPlaneNameFree(name: string, excludeId: string | null): void {
    for (const sp of this.sectionPlanes.values()) {
      if (sp.id !== excludeId && sp.name === name) {
        throw new Error(`section plane name '${name}' already exists — section plane names are unique`);
      }
    }
  }

  /** Reference check for removeLayout: viewport records referencing the
   *  layout block removal — the LAYOUTDELETE command removes the viewports
   *  and the record as ONE atomic batch (the xref.detach precedent — the
   *  explicit cascade lives at the command layer, never silently here). */
  private assertLayoutUnreferenced(id: string): void {
    let refs = 0;
    for (const v of this.viewports.values()) {
      if (v.layoutId === id) refs += 1;
    }
    if (refs > 0) {
      throw new Error(
        `removeLayout: '${id}' is referenced by ${refs} viewport${refs === 1 ? "" : "s"} — LAYOUTDELETE removes the layout and its viewports as one atomic command`,
      );
    }
    // CAD-PARITY-013: the documentation production references block layout
    // removal (references FROM other records gate; the layout's own subset
    // assignment does NOT — the navigator node removal is gated instead).
    for (const l of this.layouts.values()) {
      if (l.id !== id && l.masterId === id) {
        throw new Error(
          `removeLayout: '${id}' is the master of layout '${l.name}' — reassign that layout's master first (no silent cascade)`,
        );
      }
    }
    for (const rev of this.revisions.values()) {
      if (rev.layoutIds.includes(id)) {
        throw new Error(
          `removeLayout: '${id}' is referenced by revision '${rev.code}' — remove the reference through revision.update first (no silent cascade)`,
        );
      }
    }
    for (const ps of this.publisherSets.values()) {
      const item = ps.items.find((i) => i.kind === "layout" && i.id === id);
      if (item !== undefined) {
        throw new Error(
          `removeLayout: '${id}' is referenced by publisher set '${ps.name}' — remove the item through publisher.update first (no silent cascade)`,
        );
      }
    }
  }

  /** Capture the current layer table as a LayerStateRecord body (the
   *  LAYERSTATE save path; used by the App API layerState.save command). */
  captureCurrentLayerState(name: string): LayerStateRecord {
    return { name, layers: captureLayerState([...this.layers.values()]) };
  }

  /** Reference check for removeLtype: layers + entities referencing the
   *  linetype name block removal (no silent cascade — the removeLayer
   *  precedent). */
  private assertLtypeUnreferenced(name: string): void {
    for (const layer of this.layers.values()) {
      if (layer.linetype === name) {
        throw new Error(`removeLtype: linetype '${name}' is still used by layer '${layer.name}' — reassign it first (no silent cascade)`);
      }
    }
    let refs = 0;
    for (const el of this.elements.values()) {
      if ((el.props as Record<string, unknown>).linetype === name) refs += 1;
    }
    if (refs > 0) {
      throw new Error(`removeLtype: linetype '${name}' is still used by ${refs} element override(s) — reassign them first (no silent cascade)`);
    }
  }

  /** Element lookup by canonical id (drafting command support). */
  elementById(id: string): Element | undefined {
    return this.elements.get(id);
  }

  /** All elements in insertion order (drafting command support). */
  allElements(): readonly Element[] {
    return [...this.elements.values()];
  }

  /** Canonical content hash excluding the version metadata itself (so the
   *  hash is a pure function of document content, not of the version label).
   *  The model revision history is also excluded: two documents with the
   *  same content but different paths to it converge to the same content
   *  hash (§5.4/§5.5); history has its own hash (`getHistoryHash`). */
  private contentHashAt(_atVersion: VersionMeta): string {
    const content = {
      format: this.format,
      formatVersion: this.formatVersion,
      sourceArtifactLineage: this.sourceArtifactLineage,
      elements: [...this.elements.values()],
    };
    return createHash("sha256").update(canonicalStringify(content)).digest("hex");
  }

  /** Expose the canonical hash of the current snapshot (for parity tests).
   *  Excludes the model history, the ephemeral editor selection AND the
   *  ephemeral editor state (undo/redo stacks do not survive open by design)
   *  — the parity hash captures PERSISTED document content: version,
   *  format/lineage, elements, layers and drafting settings (COMPAT-CAD-001).
   *  Parity of the history/event stream is asserted separately (historyHash
   *  + bridge events hash). */
  currentContentHash(): string {
    const {
      modelHistory: _history,
      selection: _selection,
      editorState: _editorState,
      ...content
    } = this.snapshot();
    void _history;
    void _selection;
    void _editorState;
    return canonicalHashOf(content);
  }
}
