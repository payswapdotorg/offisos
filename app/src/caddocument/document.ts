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
  DocsSheetRecord,
  IfcImportRecordView,
  DocsViewRecord,
  DocumentEdit,
  DraftingSettings,
  Element,
  EditorState,
  LayerRecord,
  VersionMeta,
} from "../contracts/caddocument.js";
import type { ModelHistory } from "../contracts/model.js";
import { childVersion, rootVersion } from "./versioning.js";
import { canonicalStringify } from "./serialization.js";
import {
  DEFAULT_LAYER,
  applyLayerPatch,
  applySheetPatch,
  applyViewPatch,
  defaultBimSettings,
  defaultDraftingSettings,
  deriveLayerSequence,
  deriveSheetSequence,
  deriveViewSequence,
  elementLayerReference,
  validateBimSettings,
  validateDocsSheetRecord,
  validateIfcImportRecord,
  deriveIfcImportSequence,
  validateDocsViewRecord,
  validateDraftingSettings,
  validateLayerRecord,
} from "./workspace.js";
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
      draftingSettings,
      bimSettings,
      docsViews,
      Math.max(deriveViewSequence(docsViews), history.next_view_sequence ?? 1),
      docsSheets,
      Math.max(deriveSheetSequence(docsSheets), history.next_sheet_sequence ?? 1),
      ifcImports,
      Math.max(deriveIfcImportSequence(ifcImports), history.next_ifc_import_sequence ?? 1),
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
    };
  }

  // --- Internals -----------------------------------------------------------

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
