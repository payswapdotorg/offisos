/**
 * CAD/BIM Web transport — client-side typed fetch wrappers
 * (CAD-IMPLEMENT-001 / Issue #24 + CAD-IMPLEMENT-002 / Issue #26,
 * Architecture v1.1 FROZEN).
 *
 * Browser-safe. Imports ONLY from `@offisos/cad-app-shell/contracts/*`
 * (type-only or pure runtime helpers — NO `node:crypto` dependency). The
 * client talks to the backend ONLY via `fetch("/api/cad", ...)`; the
 * AppApiHandler + the real OCCT adapter bundle live server-side in
 * `src/app/api/cad/route.ts` (CAD-IMPLEMENT-002 — the engine runs behind
 * the frozen EngineAdapterBundle boundary; the client never sees it).
 *
 * Wire contract: see `@offisos/cad-app-shell/contracts/app-api`
 * (WireEnvelope v1). CAD-IMPLEMENT-002 adds the `geometry.prepare` command
 * (additive, api-contract.md §8): the client sends an engine-independent
 * GeometryDescriptor and receives the deterministic GeometryResult plus the
 * viewport mesh data.
 */

import type {
  Command,
  CommandQueryRequest,
  CommandQueryResponse,
  Query,
  WireEnvelope,
} from "@offisos/cad-app-shell/contracts/app-api";
import { APP_API_VERSION, err } from "@offisos/cad-app-shell/contracts/app-api";
import type {
  CADDocumentSnapshot,
  DocumentEdit,
  Element,
  VersionMeta,
} from "@offisos/cad-app-shell/contracts/caddocument";
import type {
  GraphBridgeResult,
  ModelHistory,
  ModelReplayResult,
} from "@offisos/cad-app-shell/contracts/model";

/** Send a CommandQueryRequest over the Web transport. */
export async function send(
  req: CommandQueryRequest,
): Promise<CommandQueryResponse> {
  const envelope: WireEnvelope = { api: APP_API_VERSION, body: req };
  let res: Response;
  try {
    res = await fetch("/api/cad", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
  } catch (e) {
    return err(
      "transport_network",
      `network error: ${(e as Error).message}`,
      true,
    );
  }
  if (!res.ok) {
    return err(
      "transport_http_" + res.status,
      `HTTP ${res.status}`,
      false,
    );
  }
  return (await res.json()) as CommandQueryResponse;
}

/** Run a command (mutating). */
function command(
  name: Command["name"],
  payload: unknown,
  idempotencyKey?: string,
): Promise<CommandQueryResponse> {
  const cmd: Command = { type: "command", name, payload, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) };
  return send(cmd);
}

/** Run a query (non-mutating). */
function query(name: Query["name"], payload: unknown = {}): Promise<CommandQueryResponse> {
  const q: Query = { type: "query", name, payload };
  return send(q);
}

// --- Workspace-level typed wrappers ----------------------------------------

export interface CreateOptions {
  entityId?: string;
  format?: string;
  formatVersion?: string;
  createdBy?: string;
}

export async function createDoc(opts: CreateOptions = {}): Promise<CommandQueryResponse> {
  return command("document.create", opts);
}

export async function openFromBytes(bytes: number[] | Uint8Array): Promise<CommandQueryResponse> {
  return command("document.open", { source: Array.from(bytes) });
}

export async function openFromText(text: string): Promise<CommandQueryResponse> {
  return command("document.deserialize", { text });
}

export async function applyEdit(edit: DocumentEdit): Promise<CommandQueryResponse> {
  return command("document.applyEdit", { edit });
}

// --- CAD-PARITY-006: blocks/attributes/xrefs through the shared App API ---

/** One per-instance attribute value (`block.insert` / `attribute.update`). */
export interface BlockAttributeValue {
  tag: string;
  value: string;
}

/** `block.create` payload: convert the source elements into a reusable
 * definition and REMOVE them, in ONE atomic revision (undo restores both). */
export interface BlockCreatePayload {
  name: string;
  basePoint: { x: number; y: number };
  /** Element ids to convert into inline content (either this or `entities`). */
  fromElementIds?: string[];
  /** Pre-normalized inline entities (the ATTDEF command path patches the
   *  definition table directly through block.update instead). */
  entities?: unknown[];
  layer?: string;
  description?: string;
}

export async function blockCreate(payload: BlockCreatePayload): Promise<CommandQueryResponse> {
  return command("block.create", payload);
}

/** `block.insert` — place a block instance (uniform scale + rotation +
 *  attribute values validated against the definition slots). */
export async function blockInsert(payload: {
  name: string;
  x: number;
  y: number;
  scale?: number;
  rotation?: number;
  layer?: string;
  attributes?: readonly BlockAttributeValue[];
}): Promise<CommandQueryResponse> {
  return command("block.insert", payload);
}

/** `block.update` — patch a definition (name/basePoint/description/
 *  entities); instances propagate through the shared expansion. */
export async function blockUpdate(
  name: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("block.update", { name, patch });
}

/** `block.remove` — delete a definition (reference-checked: instances and
 *  other definitions' content block removal — no silent cascade). */
export async function blockRemove(name: string): Promise<CommandQueryResponse> {
  return command("block.remove", { name });
}

/** `attribute.update` — rewrite ONE per-instance attribute value (value
 *  null clears the stored value → the definition default renders). */
export async function attributeUpdate(
  id: string,
  tag: string,
  value: string | null,
): Promise<CommandQueryResponse> {
  return command("attribute.update", { id, tag, value });
}

/** `xref.attach` — attach an external reference. With `content` (an offisos
 *  snapshot object re-read by the host): loaded (inline entities + provenance
 *  hash + placement instance in ONE atomic revision). Without: unresolved
 *  (the placeholder rendering — the command line cannot read files). */
export async function xrefAttach(payload: {
  name: string;
  path: string;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  layer?: string;
  content?: unknown;
}): Promise<CommandQueryResponse> {
  return command("xref.attach", payload);
}

/** `xref.detach` — remove the record AND its instances as ONE atomic batch
 *  (the explicit detach cascade — never silent). */
export async function xrefDetach(name: string): Promise<CommandQueryResponse> {
  return command("xref.detach", { name });
}

/** `xref.reload` — re-resolve an attached reference with FRESH content (the
 *  host re-reads the external file; the References palette drives this). */
export async function xrefReload(name: string, content: unknown): Promise<CommandQueryResponse> {
  return command("xref.reload", { name, content });
}

/** `blocks.list` (query) — the definition inventory with instance counts
 *  and attribute tags (the BLOCKLIST surface). */
export async function blocksList(): Promise<CommandQueryResponse> {
  return query("blocks.list", {});
}

/** `xrefs.list` (query) — the reference inventory with statuses, instance
 *  counts and provenance hashes (the XLIST surface). */
export async function xrefsList(): Promise<CommandQueryResponse> {
  return query("xrefs.list", {});
}

// --- CAD-PARITY-007: the parametric-constraints surface (Issue #86) -------

/** `constraint.create` — declare ONE constraint and APPLY it through the
 *  deterministic solver (the closed-form adjustment + propagation + the
 *  associative-annotation cascade travel in ONE atomic revision). */
export async function constraintCreate(payload: {
  kind: string;
  targets: readonly { id: string; anchor?: string }[];
  value?: number;
  mode?: "external" | "internal";
}): Promise<CommandQueryResponse> {
  return command("constraint.create", payload);
}

/** `constraint.update` — re-declare a dimensional value (or tangency mode)
 *  and RE-SOLVE (same atomic-revision contract). */
export async function constraintUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("constraint.update", { id, patch });
}

/** `constraint.remove` — delete the declared record (geometry stays). */
export async function constraintRemove(id: string): Promise<CommandQueryResponse> {
  return command("constraint.remove", { id });
}

/** `constraint.solve` — re-run the deterministic solve over the whole
 *  declared graph (the explicit diagnostics surface). */
export async function constraintSolve(): Promise<CommandQueryResponse> {
  return command("constraint.solve", {});
}

/** `constraints.list` (query) — the declared graph inventory with the
 *  computed per-constraint statuses. */
export async function constraintsList(): Promise<CommandQueryResponse> {
  return query("constraints.list", {});
}

/** `constraints.diagnostics` (query) — the full on-demand solver report:
 *  the typed outcome, per-constraint verification, per-component DoF. */
export async function constraintsDiagnostics(): Promise<CommandQueryResponse> {
  return query("constraints.diagnostics", {});
}

// --- CAD-IMPLEMENT-002: real geometry through the shared App API ----------

/** Response value of a successful `geometry.prepare` (mirror of the wire). */
export interface PreparedGeometry {
  meshToken: string;
  bbox: readonly number[];
  mesh: { vertices: readonly number[]; indices: readonly number[] } | null;
  metadata: { volume: number; vertices: number; triangles: number } | null;
  engine: { engineId: string; engineVersion: string };
}

/**
 * Realize an engine-independent GeometryDescriptor (box / cylinder /
 * transform / fuse / cut) through the REAL geometry engine behind the
 * adapter boundary. Deterministic: identical descriptors yield identical
 * meshTokens. The result persists via applyEdit(addElement) with the
 * meshToken in props.
 */
export async function prepareGeometry(geometry: unknown): Promise<CommandQueryResponse> {
  return command("geometry.prepare", { geometry });
}

/** Extract a PreparedGeometry from an ok response (null on any mismatch). */
export function unwrapPrepared(res: CommandQueryResponse): PreparedGeometry | null {
  if (!res.ok) return null;
  const v = res.value as Partial<PreparedGeometry> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.meshToken !== "string" ||
    !Array.isArray(v.bbox) || v.bbox.length !== 6
  ) {
    return null;
  }
  return v as PreparedGeometry;
}

export async function setSelection(ids: string[]): Promise<CommandQueryResponse> {
  return command("document.setSelection", { ids });
}

export async function getSelection(): Promise<CommandQueryResponse> {
  return query("document.getSelection", {});
}

export async function undo(): Promise<CommandQueryResponse> {
  return command("document.undo", {});
}

export async function redo(): Promise<CommandQueryResponse> {
  return command("document.redo", {});
}

export async function save(): Promise<CommandQueryResponse> {
  return command("document.save", {});
}

export async function getState(): Promise<CommandQueryResponse> {
  return query("document.getState", {});
}

export async function getVersion(): Promise<CommandQueryResponse> {
  return query("document.getVersion", {});
}

export async function canUndo(): Promise<CommandQueryResponse> {
  return query("document.canUndo", {});
}

export async function canRedo(): Promise<CommandQueryResponse> {
  return query("document.canRedo", {});
}

// --- CAD-IMPLEMENT-003: model revisions + Construction Graph bridge -------

/** The immutable model revision history persisted with the document. */
export async function getHistory(): Promise<CommandQueryResponse> {
  return query("model.getHistory", {});
}

// --- RESEARCH-CAD-007: downstream impact cascade ----------------------------

/** Response value of a successful `impact.cascade` (mirror of the wire). */
export interface ImpactCascadeResult {
  entity_id: string;
  model_event_id: string;
  events_hash: string;
  from_revision: { revision_number: number; version_id: string };
  to_revision: { revision_number: number; version_id: string };
  events: { event_id: string; event_type: string; causation_id: string | null }[];
  quantities: {
    current: {
      element_id: string;
      value: number;
      method: string;
      declared_tolerance: { absolute: number; relative: number };
      uncertainty: string;
    }[];
    deltas: {
      element_id: string;
      previous: number | null;
      current: number | null;
      delta: number | null;
    }[];
    skipped: { element_id: string; reason: string; uncertainty: string }[];
  };
  estimate: {
    previous: { total: number; currency: string } | null;
    current: { total: number; currency: string; items: { element_id: string; category: string; amount: number }[] };
  };
  rfq: {
    packages: { package_id: string; category: string; scope_element_ids: string[] }[];
    impacts: { category: string; affected: boolean; delta_amount: number }[];
  };
  commercial_impact: {
    currency: string;
    total_delta: number;
    affected_package_ids: string[];
    affected_category_count: number;
  };
  engine: { engineId: string; engineVersion: string };
}

/** Run the deterministic downstream cascade for one model transition
 *  (default: the latest revision) — quantities → estimate → affected RFQ →
 *  commercial impact, caused by the model.version.created graph event. */
export async function getImpactCascade(revisionNumber?: number): Promise<CommandQueryResponse> {
  return query("impact.cascade", revisionNumber === undefined ? {} : { revision_number: revisionNumber });
}

/** Extract an ImpactCascadeResult from an ok response (null on mismatch). */
export function unwrapImpactCascade(res: CommandQueryResponse): ImpactCascadeResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ImpactCascadeResult> | null;
  if (
    typeof v !== "object" || v === null ||
    !Array.isArray(v.events) || typeof v.events_hash !== "string" ||
    typeof v.commercial_impact !== "object"
  ) {
    return null;
  }
  return v as ImpactCascadeResult;
}

/** The deterministic graph-facing event stream (Construction Graph bridge). */
export async function getGraphEvents(): Promise<CommandQueryResponse> {
  return query("model.getGraphEvents", {});
}

/** Deterministic historical replay to a revision number (0 = base). */
export async function replayModel(revisionNumber: number): Promise<CommandQueryResponse> {
  return query("model.replay", { revision_number: revisionNumber });
}

/** Extract a ModelHistory from an ok response (null on mismatch). */
export function unwrapHistory(res: CommandQueryResponse): ModelHistory | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ModelHistory> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.revisions) || typeof v.base !== "object") {
    return null;
  }
  return v as ModelHistory;
}

/** Extract the GraphBridgeResult from an ok response (null on mismatch). */
export function unwrapGraphEvents(res: CommandQueryResponse): GraphBridgeResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<GraphBridgeResult> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.events) || typeof v.events_hash !== "string") {
    return null;
  }
  return v as GraphBridgeResult;
}

/** Extract a ModelReplayResult from an ok response (null on mismatch). */
export function unwrapReplay(res: CommandQueryResponse): ModelReplayResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ModelReplayResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.content_hash !== "string" ||
    !Array.isArray(v.elements) ||
    v.verified !== true
  ) {
    return null;
  }
  return v as ModelReplayResult;
}

// --- Convenience result extractors (typed) ---------------------------------

export function unwrapSnapshot(res: CommandQueryResponse): CADDocumentSnapshot | null {
  if (!res.ok) return null;
  const value = (res as { value: unknown }).value;
  // undo/redo return { undone/redone, snapshot } — extract snapshot if present.
  if (value && typeof value === "object" && "snapshot" in value) {
    const s = (value as { snapshot: unknown }).snapshot;
    return (s ?? null) as CADDocumentSnapshot | null;
  }
  return (value ?? null) as CADDocumentSnapshot | null;
}

export function unwrapVersion(res: CommandQueryResponse): VersionMeta | null {
  if (!res.ok) return null;
  const value = (res as { value: unknown }).value;
  // getVersion returns the VersionMeta directly; getState returns the snapshot.
  if (value && typeof value === "object" && "version_id" in value) {
    return value as unknown as VersionMeta;
  }
  // fallback: snapshot.version
  if (value && typeof value === "object" && "version" in value) {
    return ((value as { version: unknown }).version ?? null) as VersionMeta | null;
  }
  return null;
}

export function unwrapSelection(res: CommandQueryResponse): string[] {
  if (!res.ok) return [];
  const value = (res as { value: unknown }).value;
  if (Array.isArray(value)) return value as string[];
  if (value && typeof value === "object" && "selection" in value) {
    const s = (value as { selection: unknown }).selection;
    if (Array.isArray(s)) return s as string[];
  }
  return [];
}

export function unwrapSaveBytes(res: CommandQueryResponse): { bytes: number[]; format: string } | null {
  if (!res.ok) return null;
  const value = (res as { value: unknown }).value;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { bytes?: unknown }).bytes) &&
    typeof (value as { format?: unknown }).format === "string"
  ) {
    return value as unknown as { bytes: number[]; format: string };
  }
  return null;
}


// --- COMPAT-CAD-001: 2D drafting through the shared App API ----------------

export interface DraftingOpResult {
  applied: boolean;
  reason?: string;
  summary?: string;
  created?: string[];
}

export async function draftingCreate(entities: unknown[]): Promise<CommandQueryResponse> {
  return command("drafting.createEntities", { entities });
}

export async function draftingOp(
  name: "drafting.move" | "drafting.copy" | "drafting.delete" | "drafting.trim" | "drafting.extend",
  payload: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command(name, payload);
}

export async function draftingAddLayer(payload: { name: string; color?: string }): Promise<CommandQueryResponse> {
  return command("drafting.addLayer", payload);
}

export async function draftingUpdateLayer(layerId: string, patch: Record<string, unknown>): Promise<CommandQueryResponse> {
  return command("drafting.updateLayer", { layerId, patch });
}

export async function draftingRemoveLayer(layerId: string): Promise<CommandQueryResponse> {
  return command("drafting.removeLayer", { layerId });
}

export async function draftingSetSettings(settings: Record<string, unknown>): Promise<CommandQueryResponse> {
  return command("drafting.setSettings", { settings });
}

export async function draftingSnap(payload: Record<string, unknown>): Promise<CommandQueryResponse> {
  return query("drafting.snap", payload);
}

/** Extract a DraftingOpResult from an ok response (defensive). */
export function unwrapDraftingOp(res: CommandQueryResponse): DraftingOpResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<DraftingOpResult> | null;
  if (typeof v !== "object" || v === null || typeof v.applied !== "boolean") return null;
  return v as DraftingOpResult;
}

// --- COMPAT-CAD-002: 3D/BIM authoring through the shared App API -----------

/** One extracted semantic record (mirror of the wire, `bim.getSemantics` /
 *  the nested records of `bim.getBuilding`). */
export interface BimSemanticRecord {
  elementId: string;
  type: string;
  semantics: Record<string, unknown>;
}

/** Response value of `bim.getBuilding` (mirror of the wire). */
export interface BimBuildingResult {
  stories: {
    story: BimSemanticRecord;
    walls: (BimSemanticRecord & { openings: (BimSemanticRecord & { fills: BimSemanticRecord[] })[] })[];
    slabs: BimSemanticRecord[];
    spaces: BimSemanticRecord[];
  }[];
  bimSettings: { units: "mm"; camera: { preset: string } };
}

/** Response value of `bim.camera` (mirror of the wire; mm world units). */
export interface BimCameraResult {
  camera: { preset: string; eye: number[]; target: number[]; up: number[] };
  bbox: number[];
}

/** Response value of `bim.buildGeometry` (mirror of the wire). */
export interface BimBuildResult {
  built: number;
  results: {
    elementId: string;
    meshToken: string;
    bbox: number[];
    engine: { engineId: string; engineVersion: string };
  }[];
  skipped: { elementId: string; reason: string }[];
}

/** Generic BIM op outcome (bim.move/copy/delete/setProperties). */
export interface BimOpResult {
  applied: boolean;
  reason?: string;
  summary?: string;
  created?: string[];
}

export async function bimCreate(entities: unknown[]): Promise<CommandQueryResponse> {
  return command("bim.createElements", { entities });
}

export async function bimOp(
  name: "bim.move" | "bim.copy" | "bim.delete",
  payload: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command(name, payload);
}

export async function bimSetProperties(
  elementId: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("bim.setProperties", { elementId, patch });
}

export async function bimSetSettings(settings: Record<string, unknown>): Promise<CommandQueryResponse> {
  return command("bim.setSettings", { settings });
}

/** Realize every solid-bearing BIM element through the REAL geometry engine
 *  behind the adapter boundary (takes seconds per element — a Python OCCT
 *  worker is spawned per element). Typed skips are itemized, never silent. */
export async function bimBuildGeometry(ids?: string[]): Promise<CommandQueryResponse> {
  return command("bim.buildGeometry", ids === undefined ? {} : { ids });
}

export async function bimGetBuilding(): Promise<CommandQueryResponse> {
  return query("bim.getBuilding", {});
}

export async function bimGetSemantics(elementId?: string): Promise<CommandQueryResponse> {
  return query("bim.getSemantics", elementId === undefined ? {} : { elementId });
}

export async function bimCamera(preset: string): Promise<CommandQueryResponse> {
  return query("bim.camera", { preset });
}

/** The component/material/coordination inventory with derived parametric
 *  state (COMPAT-BIM-003): effective parameters, effective materials,
 *  grids/reference planes and the declared unsupported set. */
export async function bimGetComponents(): Promise<CommandQueryResponse> {
  return query("bim.getComponents", {});
}

// --- CAD-PARITY-011 (Issue #97): the meta/lifecycle command surface --------

/** Set (or clear with null) the canonical classification reference. */
export async function bimSetClassification(elementId: string, classificationRef: string | null): Promise<CommandQueryResponse> {
  return command("bim.setClassification", { elementId, classificationRef });
}

/** Replace the structured property sets wholesale ([] clears). */
export async function bimSetPropertySets(elementId: string, propertySets: unknown[]): Promise<CommandQueryResponse> {
  return command("bim.setPropertySets", { elementId, propertySets });
}

/** Set the bounded renovation lifecycle status. */
export async function bimSetRenovation(elementId: string, status: string): Promise<CommandQueryResponse> {
  return command("bim.setRenovation", { elementId, status });
}

/** Set (or clear with nulls) the design-option membership pair. */
export async function bimSetOptionMembership(elementId: string, optionGroupId: string | null, option: string | null): Promise<CommandQueryResponse> {
  return command("bim.setOptionMembership", { elementId, optionGroupId, option });
}

/** Set the ACTIVE option of an option group. */
export async function bimSetActiveOption(optionGroupId: string, option: string): Promise<CommandQueryResponse> {
  return command("bim.setActiveOption", { optionGroupId, option });
}

/** The canonical classification table (the closed vocabulary). */
export async function bimGetClassification(): Promise<CommandQueryResponse> {
  return query("bim.getClassification", {});
}

/** The option-group registry with members per option + active flags. */
export async function bimGetOptions(): Promise<CommandQueryResponse> {
  return query("bim.getOptions", {});
}

/** The lifecycle (renovation + option) state of the BIM elements. */
export async function bimGetLifecycle(elementId?: string): Promise<CommandQueryResponse> {
  return query("bim.getLifecycle", elementId === undefined ? {} : { elementId });
}

/** Extract a BimOpResult from an ok response (defensive). */
export function unwrapBimOp(res: CommandQueryResponse): BimOpResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<BimOpResult> | null;
  if (typeof v !== "object" || v === null || typeof v.applied !== "boolean") return null;
  return v as BimOpResult;
}

/** Extract a BimBuildingResult from an ok response (defensive). */
export function unwrapBimBuilding(res: CommandQueryResponse): BimBuildingResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<BimBuildingResult> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.stories) || typeof v.bimSettings !== "object") {
    return null;
  }
  return v as BimBuildingResult;
}

/** Extract a BimCameraResult from an ok response (defensive). */
export function unwrapBimCamera(res: CommandQueryResponse): BimCameraResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<BimCameraResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.camera !== "object" || v.camera === null ||
    !Array.isArray(v.camera.eye) || !Array.isArray(v.camera.target) || !Array.isArray(v.camera.up) ||
    !Array.isArray(v.bbox)
  ) {
    return null;
  }
  return v as BimCameraResult;
}

/** Extract a BimBuildResult from an ok response (defensive). */
export function unwrapBimBuild(res: CommandQueryResponse): BimBuildResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<BimBuildResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.built !== "number" ||
    !Array.isArray(v.results) || !Array.isArray(v.skipped)
  ) {
    return null;
  }
  return v as BimBuildResult;
}

/** Extract the created-id list of a bim.createElements ok response. */
export function unwrapBimCreated(res: CommandQueryResponse): string[] | null {
  if (!res.ok) return null;
  const v = res.value as { created?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.created)) return null;
  return v.created as string[];
}

// --- COMPAT-CAD-003: construction documentation through the shared App API -

/** One documentation view definition (mirror of the wire, `docs.listViews` /
 *  `docs.getViewGeometry`). */
export interface DocsViewRecord {
  id: string;
  kind: "plan" | "elevation" | "section" | "detail";
  title: string;
  storyId?: string;
  direction?: "front" | "back" | "left" | "right";
  sectionAxis?: "x" | "y";
  sectionOffset?: number;
  sourceViewId?: string;
  region?: { x: number; y: number; w: number; h: number };
  detailScale?: number;
  scale?: number;
}

/** Title block fields drawn in the fixed right strip of the A1 frame. */
export interface DocsTitleBlock {
  projectName: string;
  sheetTitle: string;
  sheetNumber: string;
  author?: string;
  date?: string;
}

/** One view placement on a sheet (sheet millimetres). */
export interface DocsViewPlacement {
  viewId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One documentation sheet/layout (mirror of the wire). */
export interface DocsSheetRecord {
  id: string;
  title: string;
  titleBlock: DocsTitleBlock;
  viewPlacements: DocsViewPlacement[];
}

/** A projected drawing primitive in VIEW coordinates (mm); every primitive
 *  carries the canonical `sourceId` of the element that produced it. */
export type DocsViewPrimitive =
  | { type: "line"; from: readonly [number, number]; to: readonly [number, number]; sourceId: string }
  | { type: "polyline"; points: readonly (readonly [number, number])[]; closed: boolean; sourceId: string }
  | { type: "circle"; center: readonly [number, number]; radius: number; sourceId: string }
  | { type: "arc"; center: readonly [number, number]; radius: number; startAngle: number; endAngle: number; sourceId: string }
  | { type: "text"; at: readonly [number, number]; text: string; sourceId: string };

/** One annotation element resolved for a view (docs.dim | docs.tag | docs.note
 *  props + the element id). */
export interface DocsAnnotation {
  id: string;
  type: "docs.dim" | "docs.tag" | "docs.note";
  viewId: string;
  refIds?: readonly [string, string];
  targetId?: string;
  axis?: "x" | "y";
  mode?: "overall" | "clear";
  offset?: number;
  x?: number;
  y?: number;
  text?: string;
  /** Derived by docs.regenerate. */
  measured?: number;
  label?: string;
  dangling?: boolean;
  reason?: string;
}

/** One entry of the `docs.listViews` result. */
export interface DocsViewListEntry {
  view: DocsViewRecord;
  contentHash: string | null;
  primitiveCount: number;
  skipCount: number;
  error: string | null;
}

/** Response value of `docs.getViewGeometry` (mirror of the wire). */
export interface DocsViewGeometryResult {
  view: DocsViewRecord;
  primitives: DocsViewPrimitive[];
  skips: { elementId: string; reason: string }[];
  bbox: { uMin: number; uMax: number; vMin: number; vMax: number } | null;
  contentHash: string;
  primitiveCount: number;
  annotations: DocsAnnotation[];
}

/** One per-view row of the docs.regenerate report. */
export interface DocsViewReport {
  viewId: string;
  kind: string;
  title: string;
  contentHash: string | null;
  primitiveCount: number;
  skipCount: number;
  error: string | null;
}

/** One per-annotation row of the docs.regenerate report. */
export interface DocsAnnotationReport {
  id: string;
  type: string;
  viewId: string;
  updated: boolean;
  dangling: boolean;
  reason: string | null;
  measured: number | null;
  label: string | null;
}

/** Response value of `docs.regenerate` (mirror of the wire). */
export interface DocsRegenerateResult {
  report: { views: DocsViewReport[]; annotations: DocsAnnotationReport[] };
  applied: number;
}

/** Response value of `docs.exportSheet` (format "sheet-ir"). */
export interface DocsExportResult {
  format: "sheet-ir";
  sheetId: string;
  ir: unknown;
  canonical: string;
  hash: string;
}

export async function docsCreateViews(views: unknown[]): Promise<CommandQueryResponse> {
  return command("docs.createViews", { views });
}

export async function docsRemoveView(viewId: string): Promise<CommandQueryResponse> {
  return command("docs.removeView", { viewId });
}

export async function docsCreateSheets(sheets: unknown[]): Promise<CommandQueryResponse> {
  return command("docs.createSheets", { sheets });
}

export async function docsRemoveSheet(sheetId: string): Promise<CommandQueryResponse> {
  return command("docs.removeSheet", { sheetId });
}

export async function docsAddAnnotations(annotations: unknown[]): Promise<CommandQueryResponse> {
  return command("docs.addAnnotations", { annotations });
}

export async function docsRemoveAnnotations(ids: string[]): Promise<CommandQueryResponse> {
  return command("docs.removeAnnotations", { ids });
}

export async function docsRegenerate(): Promise<CommandQueryResponse> {
  return command("docs.regenerate", {});
}

export async function docsListViews(): Promise<CommandQueryResponse> {
  return query("docs.listViews", {});
}

export async function docsGetViewGeometry(viewId: string): Promise<CommandQueryResponse> {
  return query("docs.getViewGeometry", { viewId });
}

export async function docsListSheets(): Promise<CommandQueryResponse> {
  return query("docs.listSheets", {});
}

/** Export one sheet. "sheet-ir" returns the canonical IR + hash;
 *  "pdf"/"svg" return the deterministic writer output (CAD-PARITY-014,
 *  additive — the plot.export shapes); "dwg" stays the typed
 *  `docs_unsupported` proprietary decline (the standard error path). */
export async function docsExportSheet(sheetId: string, format: "sheet-ir" | "pdf" | "svg" | "dwg"): Promise<CommandQueryResponse> {
  return query("docs.exportSheet", { sheetId, format });
}

/** Extract the created-id list of a docs.createViews/createSheets/addAnnotations
 *  ok response. */
export function unwrapDocsCreated(res: CommandQueryResponse): string[] | null {
  if (!res.ok) return null;
  const v = res.value as { created?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.created)) return null;
  return v.created as string[];
}

/** Extract a DocsViewListEntry[] from a docs.listViews ok response. */
export function unwrapDocsListViews(res: CommandQueryResponse): DocsViewListEntry[] | null {
  if (!res.ok) return null;
  const v = res.value as { views?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.views)) return null;
  return v.views as DocsViewListEntry[];
}

/** Extract a DocsViewGeometryResult from a docs.getViewGeometry ok response. */
export function unwrapDocsViewGeometry(res: CommandQueryResponse): DocsViewGeometryResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<DocsViewGeometryResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.view !== "object" || v.view === null ||
    !Array.isArray(v.primitives) || !Array.isArray(v.skips) ||
    typeof v.contentHash !== "string" || typeof v.primitiveCount !== "number" ||
    !Array.isArray(v.annotations)
  ) {
    return null;
  }
  return v as DocsViewGeometryResult;
}

/** Extract a DocsSheetRecord[] from a docs.listSheets ok response. */
export function unwrapDocsListSheets(res: CommandQueryResponse): DocsSheetRecord[] | null {
  if (!res.ok) return null;
  const v = res.value as { sheets?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.sheets)) return null;
  return v.sheets as DocsSheetRecord[];
}

/** Extract a DocsRegenerateResult from a docs.regenerate ok response. */
export function unwrapDocsRegenerate(res: CommandQueryResponse): DocsRegenerateResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<DocsRegenerateResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.report !== "object" || v.report === null ||
    !Array.isArray(v.report.views) || !Array.isArray(v.report.annotations) ||
    typeof v.applied !== "number"
  ) {
    return null;
  }
  return v as DocsRegenerateResult;
}

/** Extract a DocsExportResult from a docs.exportSheet ok response. */
export function unwrapDocsExport(res: CommandQueryResponse): DocsExportResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<DocsExportResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.canonical !== "string" || typeof v.hash !== "string" ||
    typeof v.sheetId !== "string"
  ) {
    return null;
  }
  return v as DocsExportResult;
}

// --- COMPAT-IFC-001: IFC/openBIM interop through the shared App API ---------

/** Per-kind element counts of an `ifc.export` (mirror of the wire). */
export interface IfcExportCounts {
  stories: number;
  walls: number;
  slabs: number;
  openings: number;
  doors: number;
  windows: number;
  spaces: number;
}

/** CAD-PARITY-014 (additive): the documentation-table export counts of an
 *  `ifc.export` — present only when at least one table is non-empty (legacy
 *  exports stay shape-identical). Sheets stay out of IFC by design (the
 *  canonical Sheet IR is their carrier) and are counted as not exported. */
export interface IfcExportDocumentationCounts {
  views: number;
  layouts: number;
  navigatorNodes: number;
  titleBlocks: number;
  schedules: number;
  revisions: number;
  publisherSets: number;
  sheetsNotExported: number;
}

/** Response value of `ifc.export` (mirror of the wire). */
export interface IfcExportResult {
  /** Base64 of the deterministic IFC file bytes. */
  ifc: string;
  size: number;
  /** SHA-256 of the IFC bytes (the determinism proof). */
  sha256: string;
  schema: string;
  engineVersion: string;
  counts: IfcExportCounts;
  /** CAD-PARITY-014 (additive): the IfcGroup documentation carrier counts —
   *  absent when the model carries no documentation tables. */
  documentation?: IfcExportDocumentationCounts;
}

/** Field-level preservation classification of a reconciliation field. */
export type IfcFieldClassification = "exact" | "tolerance" | "lossy" | "unsupported";

/** One field comparison of the reconciliation report (mirror of the wire). */
export interface IfcFieldResult {
  field: string;
  classification: IfcFieldClassification;
  expected?: unknown;
  actual?: unknown;
  /** Declared tolerance for tolerance-classified numeric fields (mm). */
  tolerance?: number;
  note?: string;
}

/** Per-element reconciliation action. */
export type IfcElementAction = "created" | "reconciled" | "unchanged" | "unsupported";

/** One element row of the reconciliation report (mirror of the wire). */
export interface IfcElementReport {
  canonicalId: string | null;
  globalId: string | null;
  ifcClass: string;
  name: string;
  action: IfcElementAction;
  fields: IfcFieldResult[];
}

/** The canonical reconciliation report of `ifc.import` / `ifc.compare`. */
export interface IfcImportReport {
  source: {
    sha256: string;
    schema: string;
    lengthUnitName: string | null;
    lengthUnitPrefix: string | null;
    /** Declared factor file-length-units → canonical mm. */
    scaleToMm: number;
  };
  elements: IfcElementReport[];
  summary: {
    created: number;
    reconciled: number;
    unchanged: number;
    unsupported: number;
    exact: number;
    tolerance: number;
    lossy: number;
    unsupportedFields: number;
  };
  /** Caller-declared fallbacks actually applied (recorded, never silent). */
  declaredFallbacks: string[];
}

/** One canonical↔GlobalId provenance mapping entry of an import record. */
export interface IfcImportMappingEntry {
  canonicalId: string | null;
  globalId: string;
  ifcClass: string;
  action: IfcElementAction;
}

/** The persisted deterministic record of one IFC import (`if-NNNNNN`). */
export interface IfcImportRecord {
  id: string;
  at: string;
  sourceHash: string;
  schema: string;
  lengthUnitName: string | null;
  lengthUnitPrefix: string | null;
  scaleToMm: number;
  reportHash: string;
  summary: IfcImportReport["summary"];
  mapping: IfcImportMappingEntry[];
}

/** Response value of `ifc.import` (mirror of the wire). */
export interface IfcImportResult {
  record: IfcImportRecord;
  report: IfcImportReport;
  reportHash: string;
  created: string[];
  patched: string[];
  snapshot: unknown;
}

/** One BCF topic request of `ifc.bcfCreate` (canonical element ids). */
export interface IfcBcfTopicRequest {
  title: string;
  description: string;
  author?: string;
  type?: string;
  status?: string;
  comment?: string;
  commentAuthor?: string;
  elementIds: string[];
  /** CAD-PARITY-014 (additive): the topic's camera viewpoint (world metres;
   *  absent = the legacy origin-target camera) and the source lineage (the
   *  caller-chosen canonical model state reference). */
  viewpoint?: IfcBcfViewpoint;
  sourceRevision?: string;
}

/** A BCF 3.0 camera viewpoint of `ifc.bcfCreate` (CAD-PARITY-014, additive:
 *  world metres; the vectors are three finite numbers each). */
export interface IfcBcfViewpoint {
  cameraViewPoint: [number, number, number];
  cameraDirection: [number, number, number];
  cameraUpVector: [number, number, number];
  /** Orthogonal camera (viewToWorldScale required); absent = perspective. */
  orthogonal?: boolean;
  viewToWorldScale?: number;
}

/** Response value of `ifc.bcfCreate` (mirror of the wire). */
export interface IfcBcfCreateResult {
  /** Base64 of the .bcf container bytes. */
  bcf: string;
  size: number;
  /** Count of referenced IfcGuids (derived from the canonical ids). */
  referencedCanonicalIds: number;
}

/** Response value of `ifc.probe` (mirror of the wire). */
export interface IfcProbeResult {
  available: boolean;
  engineVersion: string | null;
  message: string | null;
}

/** Response value of `ifc.compare` (mirror of the wire). */
export interface IfcCompareResult {
  report: IfcImportReport;
  reportHash: string;
}

/** One per-entity IDS validation result bound to canonical provenance. */
export interface IfcIdsEntityResult {
  globalId: string;
  canonicalId: string | null;
  ifcClass: string | null;
  name: string | null;
  passed: boolean;
}

/** One IDS specification result of `ifc.idsValidate`. */
export interface IfcIdsSpecResult {
  name: string;
  status: "pass" | "fail";
  entities: IfcIdsEntityResult[];
}

/** Response value of `ifc.idsValidate` (mirror of the wire). */
export interface IfcIdsValidateResult {
  specs: IfcIdsSpecResult[];
  schema: string;
}

/** One comment of a parsed BCF topic. */
export interface IfcBcfParsedComment {
  author: string;
  comment: string;
  date: string;
}

/** One parsed BCF topic with references resolved back to canonical ids
 *  (null when unresolvable — never fabricated). */
export interface IfcBcfParsedTopic {
  guid: string;
  title: string;
  description: string;
  type: string;
  status: string;
  comments: IfcBcfParsedComment[];
  references: string[];
  resolvedCanonicalIds: (string | null)[];
  /** CAD-PARITY-014 (additive): the parsed camera viewpoint (null when the
   *  topic carries none) and the source lineage (null when absent). */
  viewpoint: IfcBcfParsedViewpoint | null;
  sourceRevision: string | null;
}

/** The parsed BCF camera viewpoint (viewToWorldScale null for perspective
 *  cameras). */
export interface IfcBcfParsedViewpoint {
  cameraViewPoint: [number, number, number];
  cameraDirection: [number, number, number];
  cameraUpVector: [number, number, number];
  orthogonal: boolean;
  viewToWorldScale: number | null;
}

/** Response value of `ifc.bcfParse` (mirror of the wire). */
export interface IfcBcfParseResult {
  topics: IfcBcfParsedTopic[];
}

export async function ifcExport(projectName?: string): Promise<CommandQueryResponse> {
  return command("ifc.export", projectName === undefined ? {} : { projectName });
}

/** Import + reconcile an IFC file as ONE atomic versioned command. The
 *  optional declared fallbacks (mm) are recorded in the report, never silent. */
export async function ifcImport(payload: {
  ifc: string;
  defaultStoryHeight?: number;
  defaultSpaceHeight?: number;
}): Promise<CommandQueryResponse> {
  return command("ifc.import", payload);
}

export async function ifcBcfCreate(topics: IfcBcfTopicRequest[]): Promise<CommandQueryResponse> {
  return command("ifc.bcfCreate", { topics });
}

export async function ifcProbe(): Promise<CommandQueryResponse> {
  return query("ifc.probe", {});
}

export async function ifcCompare(ifc: string): Promise<CommandQueryResponse> {
  return query("ifc.compare", { ifc });
}

/** Validate an IDS specification. `ifc` omitted → the current document's
 *  export (server-side default). */
export async function ifcIdsValidate(ids: string, ifc?: string): Promise<CommandQueryResponse> {
  return query("ifc.idsValidate", ifc === undefined ? { ids } : { ifc, ids });
}

export async function ifcBcfParse(bcf: string): Promise<CommandQueryResponse> {
  return query("ifc.bcfParse", { bcf });
}

export async function ifcListImports(): Promise<CommandQueryResponse> {
  return query("ifc.listImports", {});
}

/** Extract an IfcExportResult from an ifc.export ok response. */
export function unwrapIfcExport(res: CommandQueryResponse): IfcExportResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<IfcExportResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.ifc !== "string" || typeof v.sha256 !== "string" ||
    typeof v.size !== "number" || typeof v.schema !== "string" ||
    typeof v.counts !== "object" || v.counts === null
  ) {
    return null;
  }
  return v as IfcExportResult;
}

/** Extract an IfcImportResult from an ifc.import ok response. */
export function unwrapIfcImport(res: CommandQueryResponse): IfcImportResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<IfcImportResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.record !== "object" || v.record === null ||
    typeof v.report !== "object" || v.report === null ||
    typeof v.reportHash !== "string" ||
    !Array.isArray(v.report.elements) ||
    !Array.isArray(v.created) || !Array.isArray(v.patched)
  ) {
    return null;
  }
  return v as IfcImportResult;
}

/** Extract an IfcProbeResult from an ifc.probe ok response. */
export function unwrapIfcProbe(res: CommandQueryResponse): IfcProbeResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<IfcProbeResult> | null;
  if (typeof v !== "object" || v === null || typeof v.available !== "boolean") return null;
  return v as IfcProbeResult;
}

/** Extract an IfcCompareResult from an ifc.compare ok response. */
export function unwrapIfcCompare(res: CommandQueryResponse): IfcCompareResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<IfcCompareResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.report !== "object" || v.report === null ||
    !Array.isArray(v.report.elements) || typeof v.reportHash !== "string"
  ) {
    return null;
  }
  return v as IfcCompareResult;
}

/** Extract an IfcIdsValidateResult from an ifc.idsValidate ok response. */
export function unwrapIfcIdsValidate(res: CommandQueryResponse): IfcIdsValidateResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<IfcIdsValidateResult> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.specs)) return null;
  return v as IfcIdsValidateResult;
}

/** Extract an IfcBcfCreateResult from an ifc.bcfCreate ok response. */
export function unwrapIfcBcfCreate(res: CommandQueryResponse): IfcBcfCreateResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<IfcBcfCreateResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.bcf !== "string" || typeof v.size !== "number"
  ) {
    return null;
  }
  return v as IfcBcfCreateResult;
}

/** Extract an IfcBcfParseResult from an ifc.bcfParse ok response. */
export function unwrapIfcBcfParse(res: CommandQueryResponse): IfcBcfParseResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<IfcBcfParseResult> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.topics)) return null;
  return v as IfcBcfParseResult;
}

/** Extract an IfcImportRecord[] from an ifc.listImports ok response. */
export function unwrapIfcListImports(res: CommandQueryResponse): IfcImportRecord[] | null {
  if (!res.ok) return null;
  const v = res.value as { records?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.records)) return null;
  return v.records as IfcImportRecord[];
}

export type {
  CADDocumentSnapshot,
  DocumentEdit,
  Element,
  Command,
  CommandQueryRequest,
  CommandQueryResponse,
  Query,
  WireEnvelope,
  VersionMeta,
};

// --- CAD-PARITY-008: the layouts/plot surface (Issue #88) -----------------

/** `layout.create` — add ONE paper-space layout (canonical default page
 *  setup: A3 landscape, 10 mm margins, "fit", as-displayed plot style). */
export async function layoutCreate(name: string): Promise<CommandQueryResponse> {
  return command("layout.create", { name });
}

/** `layout.rename` — keep names unique (viewports reference the id). */
export async function layoutRename(target: { id?: string; name?: string }, newName: string): Promise<CommandQueryResponse> {
  return command("layout.rename", { ...target, newName });
}

/** `layout.clone` — deep-copy the layout AND its viewports (one revision). */
export async function layoutClone(target: { id?: string; name?: string }, newName: string): Promise<CommandQueryResponse> {
  return command("layout.clone", { ...target, newName });
}

/** `layout.remove` — the explicit cascade: viewports + record in one revision. */
export async function layoutRemove(target: { id?: string; name?: string }): Promise<CommandQueryResponse> {
  return command("layout.remove", target);
}

/** `layout.setPageSetup` — patch the embedded page setup (a no-op returns
 *  unchanged: true without a revision). */
export async function layoutSetPageSetup(target: { id?: string; name?: string }, patch: Record<string, unknown>): Promise<CommandQueryResponse> {
  return command("layout.setPageSetup", { ...target, patch });
}

/** `layout.activate` — the non-versioned active-tab editor context. */
export async function layoutActivate(target: { id?: string; name?: string }): Promise<CommandQueryResponse> {
  return command("layout.activate", target);
}

/** `layout.setSpace` — the TILEMODE-class model/paper context switch. */
export async function layoutSetSpace(space: "model" | "paper", target?: { id?: string; name?: string }): Promise<CommandQueryResponse> {
  return command("layout.setSpace", { space, ...target });
}

/** `viewport.create` — ONE rectangular viewport through the shared
 *  transform (fit = the deterministic model extents; window = an explicit
 *  model window; scale = an explicit denominator + center). */
export async function viewportCreate(payload: {
  layoutId?: string;
  layoutName?: string;
  corner1: readonly [number, number];
  corner2: readonly [number, number];
  view: { mode: "fit" } | { mode: "scale"; denominator: number; centerX: number; centerY: number } | { mode: "window"; x1: number; y1: number; x2: number; y2: number };
  rotationDeg?: number;
  locked?: boolean;
}): Promise<CommandQueryResponse> {
  return command("viewport.create", payload);
}

/** `viewport.update` — patch the view/frame/lock/layer overrides (the
 *  locked view rejects camera/scale/rotation edits — typed viewport_locked). */
export async function viewportUpdate(id: string, patch: Record<string, unknown>): Promise<CommandQueryResponse> {
  return command("viewport.update", { id, patch });
}

/** `viewport.remove` — delete the viewport record (model geometry stays). */
export async function viewportRemove(id: string): Promise<CommandQueryResponse> {
  return command("viewport.remove", { id });
}

/** `plot.export` — the NON-MUTATING deterministic export (svg | pdf |
 *  plot-ir; proprietary formats are typed declines). */
export async function plotExport(target: { id?: string; name?: string }, format: "svg" | "pdf" | "plot-ir"): Promise<CommandQueryResponse> {
  return command("plot.export", { ...target, format });
}

/** `plot.publish` — the bounded batch: every layout into ONE multi-page
 *  PDF (or an SVG set manifest). */
export async function plotPublish(format: "pdf" | "svg", layoutIds?: readonly string[]): Promise<CommandQueryResponse> {
  return command("plot.publish", { format, ...(layoutIds !== undefined ? { layoutIds } : {}) });
}

/** `layouts.list` (query) — the tables + the editor context. */
export async function layoutsList(): Promise<CommandQueryResponse> {
  return query("layouts.list", {});
}

/** `plot.preview` (query) — the canonical Plot IR + hash of ONE layout
 *  (the same representation the export writers consume). */
export async function plotPreview(target: { id?: string; name?: string }): Promise<CommandQueryResponse> {
  return query("plot.preview", target);
}

// --- CAD-PARITY-012 (Issue #102): materials, components & coordination ------

/** One `materials.list` row (the bim.material parity fields — absent
 *  optional fields are OMITTED entirely by the server, the canonical form). */
export interface MaterialListRow {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  /** [r, g, b] integers 0..255 (the bim color convention). */
  readonly color?: readonly number[];
  readonly lineweight?: number;
  readonly density?: number;
  readonly description?: string;
}

/** One `components.list` row — the block-system component inventory with the
 *  materialId default and the instance scan (id-sorted). */
export interface ComponentListRow {
  readonly id: string;
  readonly name: string;
  readonly materialId: string | null;
  readonly instanceCount: number;
  readonly instanceIds: readonly string[];
}

/** One `grids.list` row — the bim.grid entities with the DERIVED Excel-style
 *  labels (A, B, C… / 1, 2, 3… minted from the sorted order, never stored). */
export interface GridListRow {
  readonly id: string;
  readonly name: string;
  readonly storyId: string | null;
  readonly uLines: readonly number[];
  readonly vLines: readonly number[];
  readonly uLabels: readonly string[];
  readonly vLabels: readonly string[];
}

/** One `materials.bom` row (the deterministic quantity takeoff over the
 *  concrete 2D view; the unassigned row is LAST with materialId null). */
export interface BomListRow {
  readonly materialId: string | null;
  readonly name: string;
  readonly count: number;
  readonly length: number;
  readonly area: number;
}

/** Response value of `materials.bom` (mirror of the wire). */
export interface BomListResult {
  readonly unit: string;
  readonly rows: readonly BomListRow[];
}

/** One intersection point of a clash pair. */
export interface ClashListPoint {
  readonly x: number;
  readonly y: number;
}

/** One `coordination.clash` pair (a/b are element ids — block INSTANCE ids
 *  for instance hits; deterministic (a, b) ordering). */
export interface ClashListPair {
  readonly a: string;
  readonly b: string;
  readonly points: readonly ClashListPoint[];
}

/** Response value of `coordination.clash` (mirror of the wire; `checked` =
 *  participants, `excluded` = the typed exclusions). */
export interface ClashListResult {
  readonly pairs: readonly ClashListPair[];
  readonly checked: number;
  readonly excluded: number;
}

/** Generic P012 op outcome (material.create/update/remove/assign,
 *  grid.create/update, revcloud.create — the runBimLifecycleEdit shape). */
export interface P012OpResult {
  applied: boolean;
  reason?: string;
  summary?: string;
  created?: string[];
}

/** `material.create` — ONE atomic revision through the bim createElement
 *  path (typed material_exists / material_invalid failures; absent color
 *  resolves to the deterministic category default server-side). */
export async function materialCreate(payload: {
  name: string;
  category: string;
  color?: readonly number[];
  lineweight?: number;
  density?: number;
  description?: string;
}): Promise<CommandQueryResponse> {
  return command("material.create", payload);
}

/** `material.update` — patch a material through a FULL-RECORD setProps
 *  rewrite (null in the patch CLEARS an optional field; the undo inverse
 *  restores the previous record byte-identically). */
export async function materialUpdate(
  elementId: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("material.update", { elementId, patch });
}

/** `material.remove` — REFERENCE-CHECKED removal (material_in_use while any
 *  element assignment or block-definition default references it). */
export async function materialRemove(elementId: string): Promise<CommandQueryResponse> {
  return command("material.remove", { elementId });
}

/** `material.assign` — assign (or unassign with null) a material to a batch
 *  of elements in ONE versioned batch (full-record setProps rewrites). */
export async function materialAssign(
  ids: readonly string[],
  materialId: string | null,
): Promise<CommandQueryResponse> {
  return command("material.assign", { ids: [...ids], materialId });
}

/** `grid.create` — the full strictly-ascending u/v-set grammar → ONE bim
 *  createElement revision (grid_bad_payload / grid_invalid). */
export async function gridCreate(payload: {
  name?: string;
  storyId?: string;
  uLines: readonly number[];
  vLines: readonly number[];
}): Promise<CommandQueryResponse> {
  return command("grid.create", payload);
}

/** `grid.update` — patch a bim.grid (name / whole-array uLines / vLines
 *  replacements; full re-validation). */
export async function gridUpdate(
  elementId: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("grid.update", { elementId, patch });
}

/** `revcloud.create` — persist the closed scalloped revision-cloud polyline
 *  with the bounded marker "revcloud" as ONE atomic revision. */
export async function revcloudCreate(payload: {
  cornerA: { x: number; y: number };
  cornerB: { x: number; y: number };
  layer?: string;
}): Promise<CommandQueryResponse> {
  return command("revcloud.create", payload);
}

/** `components.list` (query) — the component inventory (id-sorted). */
export async function componentsList(): Promise<CommandQueryResponse> {
  return query("components.list", {});
}

/** `materials.list` (query) — the material table with the parity fields. */
export async function materialsList(): Promise<CommandQueryResponse> {
  return query("materials.list", {});
}

/** `materials.bom` (query) — the deterministic quantity takeoff. */
export async function materialsBom(): Promise<CommandQueryResponse> {
  return query("materials.bom", {});
}

/** `grids.list` (query) — the bim.grid entities with derived labels. */
export async function gridsList(): Promise<CommandQueryResponse> {
  return query("grids.list", {});
}

/** `coordination.clash` (query) — the deterministic pairwise clash result. */
export async function coordinationClash(): Promise<CommandQueryResponse> {
  return query("coordination.clash", {});
}

/** Extract a P012OpResult from an ok response (defensive, null on
 *  mismatch — the unwrapBimOp precedent). */
export function unwrapP012Op(res: CommandQueryResponse): P012OpResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<P012OpResult> | null;
  if (typeof v !== "object" || v === null || typeof v.applied !== "boolean") return null;
  return v as P012OpResult;
}

/** Extract a MaterialListRow[] from a materials.list ok response (null on
 *  any shape mismatch). */
export function unwrapMaterialsList(res: CommandQueryResponse): MaterialListRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { materials?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.materials)) return null;
  return v.materials as MaterialListRow[];
}

/** Extract a ComponentListRow[] from a components.list ok response. */
export function unwrapComponentsList(res: CommandQueryResponse): ComponentListRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { components?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.components)) return null;
  return v.components as ComponentListRow[];
}

/** Extract a GridListRow[] from a grids.list ok response. */
export function unwrapGridsList(res: CommandQueryResponse): GridListRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { grids?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.grids)) return null;
  return v.grids as GridListRow[];
}

/** Extract a BomListResult from a materials.bom ok response. */
export function unwrapMaterialsBom(res: CommandQueryResponse): BomListResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<BomListResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.unit !== "string" || !Array.isArray(v.rows)
  ) {
    return null;
  }
  return v as BomListResult;
}

/** Extract a ClashListResult from a coordination.clash ok response. */
export function unwrapCoordinationClash(res: CommandQueryResponse): ClashListResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ClashListResult> | null;
  if (
    typeof v !== "object" || v === null ||
    !Array.isArray(v.pairs) ||
    typeof v.checked !== "number" || typeof v.excluded !== "number"
  ) {
    return null;
  }
  return v as ClashListResult;
}

// --- CAD-PARITY-013 (Issue #104): documentation-production surface ----------
//
// Mirror interfaces for the P013 ok-value shapes (defensive optional fields
// exactly where the server records carry them; the canonical-minimal form
// omits absent optionals entirely — the P012 MaterialListRow precedent).

/** A navigator tree node (`nav-NNNNNN`): ONE kind-tagged tree serving both
 *  documentation maps — `folder` nodes form the View Map, `subset` nodes
 *  form the Layout Book. */
export interface NavigatorNodeRecord {
  readonly id: string;
  readonly kind: "folder" | "subset";
  readonly name: string;
  readonly parentId: string | null;
  readonly order: number;
  /** Subset-only: the sheet-number prefix (e.g. "A"). */
  readonly prefix?: string;
  /** Subset-only: the sheet-numbering mode. */
  readonly numbering?: "none" | "custom";
  /** Subset-only: required iff numbering === "custom" (e.g. "01"). */
  readonly customNumber?: string;
}

/** One title-block row field binding (`layoutName`/`sheetNumber`/`revisions`
 *  resolve derived per layout; `text` carries a literal value). */
export interface TitleBlockRow {
  readonly label: string;
  readonly field: "layoutName" | "sheetNumber" | "revisions" | "text";
  readonly value?: string;
}

/** A reusable title-block definition (`tb-NNNNNN`; the name is the unique
 *  user address). */
export interface TitleBlockRecord {
  readonly id: string;
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly rowHeightMm: number;
  readonly rows: readonly TitleBlockRow[];
}

/** The schedule source vocabulary (the canonical document state one
 *  schedule indexes). */
export type ScheduleSource = "elements" | "components" | "materials" | "views" | "layouts" | "sheets";

/** One schedule column (a closed per-source key vocabulary + user label). */
export interface ScheduleColumn {
  readonly key: string;
  readonly label: string;
  /** CAD-PARITY-015 (Issue #110): the calculated-field formula (calc:
   *  columns only) + the deterministic presentation format. */
  readonly formula?: ScheduleFormulaWire;
  readonly format?: ScheduleColumnFormatWire;
}

/** The bounded calculated-field formula ({op, left, right}). */
export interface ScheduleFormulaWire {
  readonly op: "add" | "sub" | "mul" | "div";
  readonly left: { readonly column: string } | { readonly value: number };
  readonly right: { readonly column: string } | { readonly value: number };
}

/** The deterministic column presentation (unit suffix + alignment). */
export interface ScheduleColumnFormatWire {
  readonly unit?: string;
  readonly align?: "left" | "right";
}

/** A saved schedule/index definition (`sch-NNNNNN`; rows are computed fresh
 *  by schedules.run and NEVER stored). */
export interface ScheduleRecord {
  readonly id: string;
  readonly name: string;
  readonly source: ScheduleSource;
  readonly filter?: { readonly type?: string; readonly storyId?: string };
  readonly columns: readonly ScheduleColumn[];
}

/** A document revision record (`rev-NNNNNN`; the code is unique). */
export interface RevisionRecord {
  readonly id: string;
  readonly code: string;
  readonly description: string;
  readonly issued: boolean;
  readonly createdAt: string;
  readonly layoutIds: readonly string[];
}

/** One publisher set entry: a layout (lo-*) or a Layout Book subset (a
 *  nav-* subset node) exported in one format. */
export interface PublisherItem {
  readonly kind: "layout" | "subset";
  readonly id: string;
  readonly format: "pdf" | "svg" | "plot-ir";
}

/** A saved publisher set (`pub-NNNNNN`; the name is unique). */
export interface PublisherSetRecord {
  readonly id: string;
  readonly name: string;
  readonly items: readonly PublisherItem[];
}

/** One `schedules.list` row (the inventory projection, NOT the full record —
 *  columnCount is the derived count). */
export interface SchedulesListRow {
  readonly id: string;
  readonly name: string;
  readonly source: ScheduleSource;
  readonly columnCount: number;
}

/** One navigator.tree View Map row (a saved view with its fresh content
 *  hash — `scale`/`contentHash` are absent when unset/unprojectable). */
export interface NavigatorViewRow {
  readonly viewId: string;
  readonly kind: string;
  readonly title: string;
  readonly scale?: number;
  readonly contentHash?: string;
}

/** One View Map tree branch (a folder node with its filed views and child
 *  folders — children by (order, id), views in document order). */
export interface NavigatorViewBranch {
  readonly node: NavigatorNodeRecord;
  readonly views: readonly NavigatorViewRow[];
  readonly children: readonly NavigatorViewBranch[];
}

/** One navigator.tree Layout Book row (a layout with its DERIVED sheet
 *  number and revision-code join — `masterId`/`titleBlockId` absent when
 *  unset). */
export interface NavigatorLayoutRow {
  readonly layoutId: string;
  readonly name: string;
  readonly sheetNumber: string;
  readonly masterId?: string;
  readonly titleBlockId?: string;
  readonly revisionCodes: readonly string[];
}

/** One Layout Book tree branch (a subset node with its filed layouts and
 *  child subsets). */
export interface NavigatorBookBranch {
  readonly node: NavigatorNodeRecord;
  readonly layouts: readonly NavigatorLayoutRow[];
  readonly children: readonly NavigatorBookBranch[];
}

/** Response value of `navigator.tree` — the full navigator projection: the
 *  project map (stories + element counts), the View Map folder tree, the
 *  Layout Book subset tree (derived sheet numbers) and the publisher-set
 *  registry. Root-level views/layouts sit in the map roots' arrays. */
export interface NavigatorTree {
  readonly projectMap: {
    readonly stories: readonly {
      readonly id: string;
      readonly name: string;
      readonly level: number;
      readonly height: number;
      readonly elementCount: number;
    }[];
  };
  readonly viewMap: {
    readonly views: readonly NavigatorViewRow[];
    readonly children: readonly NavigatorViewBranch[];
  };
  readonly layoutBook: {
    readonly layouts: readonly NavigatorLayoutRow[];
    readonly children: readonly NavigatorBookBranch[];
  };
  readonly publisherSets: readonly { readonly id: string; readonly name: string; readonly itemCount: number }[];
}

/** Response value of `schedules.run` — the FRESH deterministic row
 *  derivation over the CURRENT canonical state (every cell a string; the
 *  sha256 over the canonical rows serialization). CAD-PARITY-015 (Issue
 *  #110): the structured group segments + grand totals are present ONLY
 *  when the schedule declares grouping (the P013 shape is unchanged
 *  otherwise). */
export interface ScheduleRunResult {
  readonly schedule: ScheduleRecord;
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly sha256: string;
  readonly groups?: readonly ScheduleGroupRow[];
  readonly totals?: readonly (number | null)[];
}

/** Response value of `revisions.list` (the revision table, document order). */
export interface RevisionsListResult {
  readonly revisions: readonly RevisionRecord[];
}

/** Response value of `publisher.list` (the publisher-set table, document
 *  order — the FULL records incl. items). */
export interface PublisherListResult {
  readonly publisherSets: readonly PublisherSetRecord[];
}

/** Response value of `publisher.run` (NON-VERSIONED output automation): the
 *  deterministic per-page artifacts (sha256 over each page's serialized
 *  output — the svg string or the canonical IR JSON) + the multi-page PDF
 *  of the pdf-format pages (absent when the set has no pdf pages). */
export interface PublisherRunResult {
  readonly set: { readonly id: string; readonly name: string };
  readonly pages: readonly {
    readonly layoutId: string;
    readonly layoutName: string;
    readonly format: "pdf" | "svg" | "plot-ir";
    readonly revisions: readonly string[];
    readonly sha256: string;
  }[];
  readonly pdfSha256?: string;
  readonly pdfSize?: number;
}

/** Response value of `docs.exchangeReport` — the typed IFC/documentation
 *  exchange classification report (the ifc/report.ts classification
 *  vocabulary over the documentation concepts + the current table counts). */
export interface DocsExchangeReport {
  readonly contract: string;
  readonly classifications: readonly {
    readonly concept: string;
    readonly classification: string;
    readonly note: string;
  }[];
  readonly counts: {
    readonly views: number;
    readonly sheets: number;
    readonly layouts: number;
    readonly titleBlocks: number;
    readonly schedules: number;
    readonly revisions: number;
    readonly publisherSets: number;
    readonly navigatorNodes: number;
  };
}

/** Generic P013 op outcome (navigator.createFolder/createSubset/removeNode,
 *  titleblock.create/update/remove, schedule.create/update/remove,
 *  revision.add/update/remove, publisher.create/update/remove, layout.update —
 *  exactly ONE of the record keys per command, `removed` for the removals,
 *  `detachedLayouts` for the revision.remove explicit cascade). The ok value
 *  of every VERSIONED P013 command also carries the post-edit `snapshot`
 *  (typed `unknown` here — the shell re-reads state through getState). */
export interface P013OpResult {
  readonly node?: NavigatorNodeRecord;
  readonly titleBlock?: TitleBlockRecord;
  readonly schedule?: ScheduleRecord;
  readonly revision?: RevisionRecord;
  readonly publisherSet?: PublisherSetRecord;
  readonly removed?: string;
  readonly detachedLayouts?: readonly string[];
  readonly layoutId?: string;
  readonly layout?: unknown;
  readonly snapshot?: unknown;
}

/** `navigator.createFolder` — add ONE View Map folder (strict payload:
 *  subset-only fields are rejected, never repaired). */
export async function navigatorCreateFolder(payload: {
  name: string;
  parentId?: string;
}): Promise<CommandQueryResponse> {
  return command("navigator.createFolder", payload);
}

/** `navigator.createSubset` — add ONE Layout Book subset (optional parent
 *  subset, prefix, numbering none|custom with the counter start). */
export async function navigatorCreateSubset(payload: {
  name: string;
  parentId?: string;
  prefix?: string;
  numbering?: "none" | "custom";
  customNumber?: string;
}): Promise<CommandQueryResponse> {
  return command("navigator.createSubset", payload);
}

/** `navigator.removeNode` — gated removal (children, view folderId refs,
 *  layout subsetId refs, publisher subset items — navigator_in_use). */
export async function navigatorRemoveNode(id: string): Promise<CommandQueryResponse> {
  return command("navigator.removeNode", { id });
}

/** `titleblock.create` — add ONE reusable title-block definition (the row
 *  field grammar; the name is unique). */
export async function titleblockCreate(payload: {
  name: string;
  widthMm: number;
  heightMm: number;
  rowHeightMm: number;
  rows: readonly TitleBlockRow[];
}): Promise<CommandQueryResponse> {
  return command("titleblock.create", payload);
}

/** `titleblock.update` — whitelisted patch (name kept unique). */
export async function titleblockUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("titleblock.update", { id, patch });
}

/** `titleblock.remove` — gated (layout placements reference it). */
export async function titleblockRemove(id: string): Promise<CommandQueryResponse> {
  return command("titleblock.remove", { id });
}

/** `schedule.create` — add ONE schedule/index definition (the closed
 *  per-source column vocabulary; rows are always derived fresh). */
export async function scheduleCreate(payload: {
  name: string;
  source: ScheduleSource;
  filter?: { type?: string; storyId?: string };
  columns: readonly ScheduleColumn[];
  /** CAD-PARITY-015 (Issue #110): the optional engine powers (all
   *  opt-in — a bare payload is the P013 shape). */
  sort?: readonly { key: string; direction: "asc" | "desc" }[];
  grouping?: readonly string[];
  conditions?: readonly { set: string; key: string; op: "eq" | "ne" | "gt" | "lt" | "contains"; value: string | number | boolean }[];
}): Promise<CommandQueryResponse> {
  return command("schedule.create", payload);
}

/** `schedule.update` — whitelisted patch (name/source/filter/columns). */
export async function scheduleUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("schedule.update", { id, patch });
}

/** `schedule.remove` — no gates (nothing references a schedule). */
export async function scheduleRemove(id: string): Promise<CommandQueryResponse> {
  return command("schedule.remove", { id });
}

/** `revision.add` — add ONE document revision record (unique code, fixed
 *  deterministic timestamp; layoutIds must all exist). */
export async function revisionAdd(payload: {
  code: string;
  description?: string;
  issued?: boolean;
  layoutIds?: readonly string[];
}): Promise<CommandQueryResponse> {
  return command("revision.add", payload);
}

/** `revision.update` — whitelisted patch (code kept unique; id/createdAt
 *  immutable). */
export async function revisionUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("revision.update", { id, patch });
}

/** `revision.remove` — strips the reference from every referencing layout in
 *  the SAME atomic batch (detachedLayouts lists them). */
export async function revisionRemove(id: string): Promise<CommandQueryResponse> {
  return command("revision.remove", { id });
}

/** `publisher.create` — add ONE saved publisher set (targets validated; the
 *  expanded layout list must contain no duplicate). */
export async function publisherCreate(payload: {
  name: string;
  items: readonly PublisherItem[];
}): Promise<CommandQueryResponse> {
  return command("publisher.create", payload);
}

/** `publisher.update` — whitelisted patch (name/items). */
export async function publisherUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("publisher.update", { id, patch });
}

/** `publisher.remove` — no gates (publisher.run is non-versioned output
 *  automation; nothing stored references a set). */
export async function publisherRemove(id: string): Promise<CommandQueryResponse> {
  return command("publisher.remove", { id });
}

/** `publisher.run` — NON-VERSIONED output automation (the plot.publish
 *  precedent — NO snapshot in the ok value): expand the items, build the
 *  Plot IRs + the multi-page PDF, report the deterministic artifacts. */
export async function publisherRun(id: string): Promise<CommandQueryResponse> {
  return command("publisher.run", { id });
}

/** `layout.update` — the P013 generic layout patch command (subsetId /
 *  masterId / titleBlockPlacement / revisionIds — null unassigns; the
 *  layout resolves by id, by name, or falls back to the active layout). */
export async function layoutUpdate(payload: {
  id?: string;
  name?: string;
  patch: Record<string, unknown>;
}): Promise<CommandQueryResponse> {
  return command("layout.update", payload);
}

/** `docs.updateView` {folderId} — the thin P013 View-Map assignment wrapper
 *  over the existing docs.updateView patch surface (null unassigns — the
 *  view files back at the map root). */
export async function docsUpdateViewFolder(
  viewId: string,
  folderId: string | null,
): Promise<CommandQueryResponse> {
  return command("docs.updateView", { viewId, patch: { folderId } });
}

/** `navigator.tree` (query) — the full navigator projection (project map,
 *  View Map tree, Layout Book tree with derived sheet numbers, publisher
 *  set registry). */
export async function navigatorTree(): Promise<CommandQueryResponse> {
  return query("navigator.tree", {});
}

/** `schedules.list` (query) — the schedule inventory. */
export async function schedulesList(): Promise<CommandQueryResponse> {
  return query("schedules.list", {});
}

/** `schedules.run` (query) — the FRESH deterministic rows + sha256. */
export async function schedulesRun(id: string): Promise<CommandQueryResponse> {
  return query("schedules.run", { id });
}

/** `revisions.list` (query) — the revision table. */
export async function revisionsList(): Promise<CommandQueryResponse> {
  return query("revisions.list", {});
}

/** `publisher.list` (query) — the publisher-set table (full records). */
export async function publisherList(): Promise<CommandQueryResponse> {
  return query("publisher.list", {});
}

/** `docs.exchangeReport` (query) — the typed IFC/documentation exchange
 *  classification report. */
export async function docsExchangeReport(): Promise<CommandQueryResponse> {
  return query("docs.exchangeReport", {});
}

/** Extract a P013OpResult from an ok response (defensive, null on mismatch —
 *  the unwrapP012Op precedent: at least ONE identifying key must be
 *  present, else the shape is not a P013 op outcome). */
export function unwrapP013Op(res: CommandQueryResponse): P013OpResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<P013OpResult> | null;
  if (typeof v !== "object" || v === null) return null;
  if (
    v.node === undefined && v.titleBlock === undefined && v.schedule === undefined &&
    v.revision === undefined && v.publisherSet === undefined && v.removed === undefined &&
    v.layoutId === undefined
  ) {
    return null;
  }
  return v as P013OpResult;
}

/** Extract a NavigatorTree from a navigator.tree ok response (null on any
 *  shape mismatch — the panel keeps its loading fallback). */
export function unwrapNavigatorTree(res: CommandQueryResponse): NavigatorTree | null {
  if (!res.ok) return null;
  const v = res.value as Partial<NavigatorTree> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.projectMap !== "object" || v.projectMap === null || !Array.isArray(v.projectMap.stories) ||
    typeof v.viewMap !== "object" || v.viewMap === null || !Array.isArray(v.viewMap.views) || !Array.isArray(v.viewMap.children) ||
    typeof v.layoutBook !== "object" || v.layoutBook === null || !Array.isArray(v.layoutBook.layouts) || !Array.isArray(v.layoutBook.children) ||
    !Array.isArray(v.publisherSets)
  ) {
    return null;
  }
  return v as NavigatorTree;
}

/** Extract the SchedulesListRow[] from a schedules.list ok response. */
export function unwrapSchedulesList(res: CommandQueryResponse): SchedulesListRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { schedules?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.schedules)) return null;
  return v.schedules as SchedulesListRow[];
}

/** Extract a ScheduleRunResult from a schedules.run ok response. */
export function unwrapScheduleRun(res: CommandQueryResponse): ScheduleRunResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ScheduleRunResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.schedule !== "object" || v.schedule === null ||
    !Array.isArray(v.rows) ||
    typeof v.rowCount !== "number" ||
    typeof v.sha256 !== "string"
  ) {
    return null;
  }
  return v as ScheduleRunResult;
}

/** Extract the RevisionRecord[] from a revisions.list ok response. */
export function unwrapRevisionsList(res: CommandQueryResponse): RevisionRecord[] | null {
  if (!res.ok) return null;
  const v = res.value as Partial<RevisionsListResult> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.revisions)) return null;
  return v.revisions as RevisionRecord[];
}

/** Extract the PublisherSetRecord[] from a publisher.list ok response. */
export function unwrapPublisherList(res: CommandQueryResponse): PublisherSetRecord[] | null {
  if (!res.ok) return null;
  const v = res.value as Partial<PublisherListResult> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.publisherSets)) return null;
  return v.publisherSets as PublisherSetRecord[];
}

/** Extract a PublisherRunResult from a publisher.run ok response (the
 *  NON-VERSIONED run outcome — set + pages, optional pdf artifacts). */
export function unwrapPublisherRun(res: CommandQueryResponse): PublisherRunResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<PublisherRunResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.set !== "object" || v.set === null ||
    typeof v.set.id !== "string" || typeof v.set.name !== "string" ||
    !Array.isArray(v.pages)
  ) {
    return null;
  }
  return v as PublisherRunResult;
}

// --- CAD-PARITY-014 (Issue #107): file interoperability surface --------------
//
// Browser-safe mirror interfaces for the P014 ok-value shapes + the typed
// wrappers (one command/query function + one null-on-mismatch unwrap per
// surface — the P012/P013 discipline). `dxf.import` is the ONE versioned
// command of the slice (ONE atomic revision, the ifc.import pattern incl.
// the post-edit snapshot); `dxf.export` and the interop.* surfaces are
// NON-VERSIONED queries (the plot.export precedent — nothing is written).

/** Response value of `dxf.export` (mirror of the wire; NON-VERSIONED — the
 *  plot.export precedent): the bounded deterministic DXF R2000 ASCII text
 *  of the current drafting surface. */
export interface DxfExportResult {
  readonly format: "dxf";
  /** Base64 of the DXF text bytes. */
  readonly bytesBase64: string;
  readonly size: number;
  /** SHA-256 of the DXF bytes (the determinism proof). */
  readonly sha256: string;
  readonly counts: {
    readonly exported: number;
    readonly skipped: number;
    /** Exported entities per DXF entity type (LINE/CIRCLE/…/TEXT). */
    readonly byKind: Readonly<Record<string, number>>;
  };
  /** The sorted distinct skipped element kinds (counted, never silent). */
  readonly skippedKinds: readonly string[];
}

/** One unsupported-construct count of a DXF import report (LOCK-007). */
export interface DxfUnsupportedCount {
  readonly type: string;
  readonly count: number;
}

/** The canonical import report of `dxf.import` (the ifc.import report
 *  discipline: per-entity classification rows + the canonical reportHash). */
export interface DxfImportReport {
  readonly sourceSha256: string;
  /** The declared DXF unit + its factor to canonical mm. */
  readonly unit: string;
  readonly scaleToMm: number;
  readonly counts: {
    readonly elements: number;
    readonly layers: number;
    readonly ltypes: number;
    readonly unsupported: number;
  };
  readonly rows: readonly IfcElementReport[];
  readonly unsupported: readonly DxfUnsupportedCount[];
}

/** Response value of `dxf.import` (ONE atomic versioned command — the
 *  ifc.import pattern incl. the post-edit snapshot). */
export interface DxfImportResult {
  readonly report: DxfImportReport;
  readonly reportHash: string;
  /** Element drafts + created layers count. */
  readonly created: number;
  readonly snapshot: unknown;
}

/** One `interop.exchangeReport` classification row (the ifc/report.ts
 *  vocabulary over the exchange concepts). */
export interface InteropExchangeEntry {
  readonly concept: string;
  readonly classification: string;
  readonly note: string;
}

/** Response value of `interop.exchangeReport` — the P014 authoritative
 *  exchange classification (the successor surface; the P013
 *  docs.exchangeReport stays the frozen slice record) + the CURRENT
 *  document table counts. */
export interface InteropExchangeReport {
  readonly contract: string;
  readonly classifications: readonly InteropExchangeEntry[];
  readonly counts: {
    readonly elements: number;
    readonly layers: number;
    readonly views: number;
    readonly sheets: number;
    readonly layouts: number;
    readonly titleBlocks: number;
    readonly schedules: number;
    readonly revisions: number;
    readonly publisherSets: number;
    readonly navigatorNodes: number;
  };
}

/** One `interop.archivalList` registry row (the legal compatibility
 *  surface). */
export interface InteropArchivalRow {
  readonly format: string;
  readonly legal: "open-standard" | "published-spec" | "proprietary-declined";
  /** The app-api surface that produces (or declines) the format. */
  readonly carrier: string;
  readonly determinism: { readonly sha256Available: boolean };
  readonly bounded: string;
}

/** Response value of `interop.archivalList` (mirror of the wire). */
export interface InteropArchivalListResult {
  readonly contract: string;
  readonly rows: readonly InteropArchivalRow[];
}

/** The documentation dimension of the ifc round-trip report (mirror — the
 *  IfcGroup documentation carrier records + their summary). */
export interface IfcRoundtripDocumentation {
  readonly records: readonly IfcElementReport[];
  readonly summary: IfcImportReport["summary"];
}

/** Response value of `interop.roundtripReport` — the "dxf" arm (the pure
 *  export → parse → DRY-map loop; nothing is written). */
export interface DxfRoundtripResult {
  readonly format: "dxf";
  readonly sourceSha256: string;
  readonly report: {
    readonly source: {
      readonly sha256: string;
      readonly unit: string;
      readonly scaleToMm: number;
      readonly exported: number;
      readonly skipped: number;
    };
    readonly elements: readonly IfcElementReport[];
    readonly layers: { readonly matched: number; readonly created: number; readonly lossy: number };
    readonly unsupported: readonly DxfUnsupportedCount[];
    readonly summary: IfcImportReport["summary"];
  };
  readonly reportHash: string;
}

/** Response value of `interop.roundtripReport` — the "ifc" arm (export →
 *  parse → the DRY element + documentation reconciliation through the IFC
 *  adapter; typed ifc_unavailable without one). */
export interface IfcRoundtripResult {
  readonly format: "ifc";
  readonly sourceSha256: string;
  readonly elements: IfcImportReport;
  /** Present when the exported file carries the documentation carrier. */
  readonly documentation?: IfcRoundtripDocumentation;
  readonly reportHash: string;
}

/** Response value of `interop.roundtripReport` (either arm, identified by
 *  the format discriminant). */
export type InteropRoundtripReportResult = DxfRoundtripResult | IfcRoundtripResult;

/** Response value of `docs.exportSheet` — the P014 writer arms (pdf →
 *  bytesBase64/size/sha256/irHash, svg → text/size/sha256/irHash — the
 *  EXACT plot.export shapes; "dwg" declines typed through the standard
 *  error path). The legacy "sheet-ir" arm is mirrored by DocsExportResult. */
export interface DocsExportSheetResult {
  readonly format: "pdf" | "svg";
  readonly sheetId: string;
  /** pdf: base64 of the deterministic PDF bytes. */
  readonly bytesBase64?: string;
  /** svg: the deterministic SVG text. */
  readonly text?: string;
  readonly size: number;
  readonly sha256: string;
  /** The Sheet IR hash the writers are bound to (the unchanged IR proof). */
  readonly irHash: string;
}

/** `dxf.import` — parse the bounded DXF and apply ONE atomic edit batch
 *  (ltypes + layers + elements; ids minted by the document authority). The
 *  DWG binary magic is the typed proprietary decline (dwg_unsupported);
 *  units outside the declared set fail dxf_unsupported (no guessing). */
export async function dxfImport(payload: { dxf: string }): Promise<CommandQueryResponse> {
  return command("dxf.import", payload);
}

/** `dxf.export` (query) — the bounded deterministic DXF R2000 ASCII text
 *  of the current drafting surface (identical state → identical bytes). */
export async function dxfExport(): Promise<CommandQueryResponse> {
  return query("dxf.export", {});
}

/** `interop.exchangeReport` (query) — the authoritative exchange
 *  classification + the current document counts. */
export async function interopExchangeReport(): Promise<CommandQueryResponse> {
  return query("interop.exchangeReport", {});
}

/** `interop.archivalList` (query) — the archival format registry (the
 *  legal compatibility surface: static, deterministic). */
export async function interopArchivalList(): Promise<CommandQueryResponse> {
  return query("interop.archivalList", {});
}

/** `interop.roundtripReport` (query, NON-VERSIONED — the DRY verification
 *  loops never mutate). */
export async function interopRoundtripReport(format: "ifc" | "dxf"): Promise<CommandQueryResponse> {
  return query("interop.roundtripReport", { format });
}

/** Extract a DxfExportResult from a dxf.export ok response. */
export function unwrapDxfExport(res: CommandQueryResponse): DxfExportResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<DxfExportResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.bytesBase64 !== "string" || typeof v.sha256 !== "string" ||
    typeof v.size !== "number" ||
    typeof v.counts !== "object" || v.counts === null ||
    !Array.isArray(v.skippedKinds)
  ) {
    return null;
  }
  return v as DxfExportResult;
}

/** Extract a DxfImportResult from a dxf.import ok response. */
export function unwrapDxfImport(res: CommandQueryResponse): DxfImportResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<DxfImportResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.report !== "object" || v.report === null ||
    typeof v.reportHash !== "string" ||
    typeof v.created !== "number"
  ) {
    return null;
  }
  return v as DxfImportResult;
}

/** Extract an InteropExchangeReport from an interop.exchangeReport ok
 *  response. */
export function unwrapInteropExchangeReport(res: CommandQueryResponse): InteropExchangeReport | null {
  if (!res.ok) return null;
  const v = res.value as Partial<InteropExchangeReport> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.contract !== "string" ||
    !Array.isArray(v.classifications) ||
    typeof v.counts !== "object" || v.counts === null
  ) {
    return null;
  }
  return v as InteropExchangeReport;
}

/** Extract an InteropArchivalListResult from an interop.archivalList ok
 *  response. */
export function unwrapInteropArchivalList(res: CommandQueryResponse): InteropArchivalListResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<InteropArchivalListResult> | null;
  if (typeof v !== "object" || v === null || typeof v.contract !== "string" || !Array.isArray(v.rows)) {
    return null;
  }
  return v as InteropArchivalListResult;
}

/** Extract an InteropRoundtripReportResult from an interop.roundtripReport
 *  ok response (either arm — identified by the format discriminant). */
export function unwrapInteropRoundtripReport(res: CommandQueryResponse): InteropRoundtripReportResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<InteropRoundtripReportResult> | null;
  if (
    typeof v !== "object" || v === null ||
    (v.format !== "ifc" && v.format !== "dxf") ||
    typeof v.sourceSha256 !== "string" || typeof v.reportHash !== "string"
  ) {
    return null;
  }
  return v as InteropRoundtripReportResult;
}

/** Extract a DocsExportSheetResult from a docs.exportSheet pdf/svg ok
 *  response ("dwg" declines typed through the standard error path; the
 *  sheet-ir arm is unwrapped by unwrapDocsExport). */
export function unwrapDocsExportSheet(res: CommandQueryResponse): DocsExportSheetResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<DocsExportSheetResult> | null;
  if (
    typeof v !== "object" || v === null ||
    (v.format !== "pdf" && v.format !== "svg") ||
    typeof v.sheetId !== "string" ||
    typeof v.size !== "number" || typeof v.sha256 !== "string" ||
    typeof v.irHash !== "string"
  ) {
    return null;
  }
  return v as DocsExportSheetResult;
}

// --- CAD-PARITY-015 (additive, Issue #110): the property-definition registry
// --- + the quantity-workflow surfaces (the P013/P014 wrapper pattern). -------

/** One group segment of a grouped `schedules.run` (present only when the
 *  schedule declares grouping — the P013 response shape is unchanged
 *  otherwise). */
export interface ScheduleGroupRow {
  readonly key: readonly string[];
  readonly rowCount: number;
  readonly firstRowIndex: number;
  readonly subtotals: readonly (number | null)[];
}

/** A saved property definition (`prd-NNNNNN`) — the full record. */
export interface PropertyDefRecord {
  readonly id: string;
  readonly name: string;
  readonly set: string;
  readonly key: string;
  readonly type: "text" | "number" | "boolean";
  readonly unit?: string;
  readonly appliesTo?: readonly string[];
}

/** One `properties.list` row (the registry + the LIVE lineage statistics —
 *  values counted from the canonical element property-set overlay only). */
export interface PropertyDefRow extends PropertyDefRecord {
  readonly elementsWithValue: number;
  readonly typeMatches: number;
  readonly typeMismatches: number;
}

/** Response value of `properties.list`. */
export interface PropertiesListResult {
  readonly contract: string;
  readonly valueSource: string;
  readonly propertyDefs: readonly PropertyDefRow[];
}

/** One measured element row of `quantities.run` (null measures are
 *  absent-rendered "-" at the surface). */
export interface QuantityReportRow {
  readonly elementId: string;
  readonly type: string;
  readonly name: string;
  readonly story: string;
  readonly material: string;
  readonly length: number | null;
  readonly area: number | null;
  readonly volume: number | null;
}

/** One group segment of a grouped `quantities.run`. */
export interface QuantityGroupRow {
  readonly key: readonly string[];
  readonly rowCount: number;
  readonly count: number;
  readonly length: number | null;
  readonly area: number | null;
  readonly volume: number | null;
  readonly mass: number | null;
}

/** The grand totals of a grouped `quantities.run`. */
export interface QuantityTotalsRow {
  readonly count: number;
  readonly length: number | null;
  readonly area: number | null;
  readonly volume: number | null;
}

/** One material BOM row (the `materials` source — the effective-material
 *  aggregation; mass = density kg/m³ × volume m³, null when no density). */
export interface MaterialBomRow {
  readonly materialId: string;
  readonly materialName: string;
  readonly category: string;
  readonly count: number;
  readonly volume: number | null;
  readonly mass: number | null;
}

/** An element outside the closed quantity rule table (honest skip). */
export interface SkippedElementRow {
  readonly elementId: string;
  readonly type: string;
  readonly reason: string;
}

/** The RevisionRef binding of a `quantities.run` (the model head the report
 *  was computed over — the same deterministic binding as the graph bridge). */
export interface QuantityRevisionRef {
  readonly revision_id: string;
  readonly revision_number: number;
  readonly version_id: string;
  readonly version_number: number;
  readonly parent_version_id: string | null;
  readonly content_hash: string;
}

/** Response value of `quantities.run` — the FRESH deterministic,
 *  revision-bound takeoff (never stored). */
export interface QuantityReport {
  readonly contract: string;
  readonly source: string;
  readonly groupBy: string;
  readonly revision: QuantityRevisionRef;
  readonly rows: readonly QuantityReportRow[];
  readonly groups: readonly QuantityGroupRow[];
  readonly totals: QuantityTotalsRow | null;
  readonly bom: readonly MaterialBomRow[];
  readonly skipped: readonly SkippedElementRow[];
  readonly reportSha256: string;
}

/** Response value of `quantities.rules` — the closed canonical rule table
 *  + the live per-type element counts (the typed unsupported surface). */
export interface QuantityRulesReport {
  readonly contract: string;
  readonly units: Record<string, string>;
  readonly measures: readonly string[];
  readonly sources: readonly string[];
  readonly groupings: readonly string[];
  readonly rules: readonly {
    readonly type: string;
    readonly length: string | null;
    readonly area: string | null;
    readonly volume: string | null;
    readonly formula: { readonly length?: string; readonly area?: string; readonly volume?: string };
  }[];
  readonly liveCounts: readonly { readonly type: string; readonly count: number }[];
}

/** `property.create` (command) — add ONE property definition. */
export async function propertyDefCreate(input: {
  name: string;
  set: string;
  key: string;
  type: "text" | "number" | "boolean";
  unit?: string;
  appliesTo?: readonly string[];
}): Promise<CommandQueryResponse> {
  return command("property.create", input);
}

/** `property.update` (command) — whitelisted patch (null unit/appliesTo
 *  removes the field). */
export async function propertyDefUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("property.update", { id, patch });
}

/** `property.remove` (command) — no gates (pd: columns render the
 *  deterministic missing cell afterwards). */
export async function propertyDefRemove(id: string): Promise<CommandQueryResponse> {
  return command("property.remove", { id });
}

/** `properties.list` (query) — the registry + live lineage statistics. */
export async function propertiesList(): Promise<CommandQueryResponse> {
  return query("properties.list", {});
}

/** `quantities.run` (query) — the deterministic revision-bound takeoff. */
export async function quantitiesRun(input: {
  source: "elements" | "components" | "materials";
  groupBy?: "none" | "type" | "story" | "material";
  filter?: { type?: string; storyId?: string };
}): Promise<CommandQueryResponse> {
  return query("quantities.run", input);
}

/** `quantities.rules` (query) — the closed canonical rule table. */
export async function quantitiesRules(): Promise<CommandQueryResponse> {
  return query("quantities.rules", {});
}

/** Extract the PropertyDefRow[] from a properties.list ok response. */
export function unwrapPropertiesList(res: CommandQueryResponse): PropertyDefRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { propertyDefs?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.propertyDefs)) return null;
  return v.propertyDefs as PropertyDefRow[];
}

/** Extract a QuantityReport from a quantities.run ok response. */
export function unwrapQuantityReport(res: CommandQueryResponse): QuantityReport | null {
  if (!res.ok) return null;
  const v = res.value as Partial<QuantityReport> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.contract !== "string" ||
    typeof v.source !== "string" ||
    typeof v.reportSha256 !== "string" ||
    typeof v.revision !== "object" || v.revision === null
  ) {
    return null;
  }
  return v as QuantityReport;
}

/** Extract a QuantityRulesReport from a quantities.rules ok response. */
export function unwrapQuantityRules(res: CommandQueryResponse): QuantityRulesReport | null {
  if (!res.ok) return null;
  const v = res.value as Partial<QuantityRulesReport> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.contract !== "string" ||
    !Array.isArray(v.rules) || !Array.isArray(v.liveCounts)
  ) {
    return null;
  }
  return v as QuantityRulesReport;
}

// ---------------------------------------------------------------------------
// CAD-PARITY-016 (additive, Issue #112): the collaboration/recovery/scale
// transport mirrors — the typed client surface of the Collab workbench.
// The CADDocument stays the canonical system of record; the collab/
// recovery/job stores are session-side support mechanisms (LOCK-019).
// ---------------------------------------------------------------------------

/** `recovery.checkpoint` (command) — capture a durable versioned checkpoint
 *  of the current canonical revision (manual cause). */
export async function recoveryCheckpoint(): Promise<CommandQueryResponse> {
  return command("recovery.checkpoint", {});
}

/** `recovery.restore` (command) — deterministic crash/session recovery
 *  (checkpointId omitted = the latest valid; corrupt candidates are skipped
 *  typed, never silently repaired). */
export async function recoveryRestore(checkpointId?: string): Promise<CommandQueryResponse> {
  return command("recovery.restore", checkpointId !== undefined ? { checkpointId } : {});
}

/** `recovery.autosave` (command) — force an autosave-cause checkpoint. */
export async function recoveryAutosave(): Promise<CommandQueryResponse> {
  return command("recovery.autosave", {});
}

/** `recovery.list` (query) — the retained checkpoint inventory + policy. */
export async function recoveryList(): Promise<CommandQueryResponse> {
  return query("recovery.list", {});
}

/** `collab.join` (command) — register a project-scoped member. */
export async function collabJoin(userId: string, role: "viewer" | "commenter" | "editor"): Promise<CommandQueryResponse> {
  return command("collab.join", { userId, role });
}

/** `collab.presence` (command) — the member heartbeat. */
export async function collabPresence(userId: string): Promise<CommandQueryResponse> {
  return command("collab.presence", { userId });
}

/** `collab.comment` (command) — add a comment linked to a canonical target. */
export async function collabComment(input: {
  userId: string;
  body: string;
  target?: { kind: "document" | "element" | "revision"; id?: string; revisionRef?: string };
}): Promise<CommandQueryResponse> {
  return command("collab.comment", input);
}

/** `collab.resolveComment` (command) — mark a comment resolved. */
export async function collabResolveComment(commentId: string, userId: string): Promise<CommandQueryResponse> {
  return command("collab.resolveComment", { commentId, userId });
}

/** `collab.commit` (command) — the versioned transactional change. */
export async function collabCommit(input: {
  userId: string;
  baseVersion: number;
  edits: readonly {
    type: "addElement" | "removeElement" | "updateElement" | "setProps";
    elementId?: string;
    element?: Record<string, unknown>;
    patch?: Record<string, unknown>;
  }[];
}): Promise<CommandQueryResponse> {
  return command("collab.commit", input);
}

/** `collab.merge` (command) — resolve an open conflict (rebase|discard). */
export async function collabMerge(
  transactionId: string,
  userId: string,
  strategy: "rebase" | "discard",
): Promise<CommandQueryResponse> {
  return command("collab.merge", { transactionId, userId, strategy });
}

/** `collab.state` (query) — the member roster with computed presence. */
export async function collabState(): Promise<CommandQueryResponse> {
  return query("collab.state", {});
}

/** `collab.comments` (query) — the comment list. */
export async function collabComments(): Promise<CommandQueryResponse> {
  return query("collab.comments", {});
}

/** `collab.activity` (query) — the bounded activity stream. */
export async function collabActivity(): Promise<CommandQueryResponse> {
  return query("collab.activity", {});
}

/** `collab.transactions` (query) — the transaction/conflict/merge lineage. */
export async function collabTransactions(): Promise<CommandQueryResponse> {
  return query("collab.transactions", {});
}

/** `jobs.create` (command) — queue a durable regeneration job. */
export async function jobsCreate(
  kind: "docs.regenerate" | "quantity.recalculate" | "model.stream.warm",
  params?: Record<string, unknown>,
): Promise<CommandQueryResponse> {
  return command("jobs.create", { kind, ...(params !== undefined ? { params } : {}) });
}

/** `jobs.tick` (command) — advance ONE deterministic step. */
export async function jobsTick(jobId: string): Promise<CommandQueryResponse> {
  return command("jobs.tick", { jobId });
}

/** `jobs.list` (query) — the durable job states. */
export async function jobsList(): Promise<CommandQueryResponse> {
  return query("jobs.list", {});
}

/** `jobs.get` (query) — one durable job state. */
export async function jobsGet(jobId: string): Promise<CommandQueryResponse> {
  return query("jobs.get", { jobId });
}

/** `model.stream` (query) — one canonical id-sorted element page. */
export async function modelStream(pageIndex: number, pageSize?: number): Promise<CommandQueryResponse> {
  return query("model.stream", { pageIndex, ...(pageSize !== undefined ? { pageSize } : {}) });
}

/** `model.streamStats` (query) — the bounded stream cache counters. */
export async function modelStreamStats(): Promise<CommandQueryResponse> {
  return query("model.streamStats", {});
}

/** `xrefs.status` (query) — the fresh external-reference outcomes. */
export async function xrefsStatus(): Promise<CommandQueryResponse> {
  return query("xrefs.status", {});
}

/** `xrefs.probe` (query) — the client-side source-hash probe (stale). */
export async function xrefsProbe(name: string, sourceHash: string): Promise<CommandQueryResponse> {
  return query("xrefs.probe", { name, sourceHash });
}

/** `perf.budgets` (query) — the observable budgets + deterministic counters. */
export async function perfBudgets(): Promise<CommandQueryResponse> {
  return query("perf.budgets", {});
}

// --- The P016 view types the workbench renders --------------------------------

export interface CheckpointRow {
  readonly id: string;
  readonly seq: number;
  readonly cause: "manual" | "autosave" | "pre-restore";
  readonly entityId: string;
  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  readonly contentHash: string;
  readonly modelRevisionNumber: number;
  readonly modelRevisionId: string;
  readonly elementCount: number;
  readonly at: number;
}

export interface RecoveryListView {
  readonly checkpoints: readonly CheckpointRow[];
  readonly policy: { readonly autosaveEvery: number; readonly keep: number };
  readonly counters: {
    readonly commands: number;
    readonly mutationsSinceAutosave: number;
    readonly autosaves: number;
    readonly restores: number;
    readonly retained: number;
  };
}

export interface CollabMemberRow {
  readonly userId: string;
  readonly role: "viewer" | "commenter" | "editor";
  readonly joinedAt: number;
  readonly lastSeenAt: number | null;
  readonly active: boolean;
  readonly lastSeenVersion: number | null;
}

export interface CollabStateView {
  readonly members: readonly CollabMemberRow[];
  readonly presenceTtl: number;
  readonly sessionClock: number;
  readonly commands: number;
  readonly documentVersion: number;
}

export interface CommentRow {
  readonly id: string;
  readonly userId: string;
  readonly body: string;
  readonly target: { readonly kind: string; readonly id?: string; readonly revisionRef?: string };
  readonly resolved: boolean;
  readonly resolvedBy: string | null;
  readonly createdAt: number;
  readonly documentVersion: number;
}

export interface ActivityRow {
  readonly seq: number;
  readonly at: number;
  readonly actor: string;
  readonly kind: string;
  readonly detail: string;
}

export interface TransactionRow {
  readonly id: string;
  readonly author: string;
  readonly baseVersion: number;
  readonly touchedElementIds: readonly string[];
  readonly editCount: number;
  readonly status: "applied" | "conflict" | "merged" | "discarded";
  readonly recordedAt: number;
  readonly resultingVersion: number | null;
  readonly conflict: {
    readonly transactionId: string;
    readonly baseVersion: number;
    readonly currentVersion: number;
    readonly interveningTransactions: readonly string[];
    readonly overlappingElementIds: readonly string[];
    readonly status: "open" | "resolved";
  } | null;
  readonly merge: {
    readonly mergeId: string;
    readonly transactionId: string;
    readonly strategy: "rebase" | "discard";
    readonly parents: readonly number[];
    readonly resultingVersion: number | null;
    readonly at: number;
    readonly rebasedEditCount: number;
  } | null;
}

export interface JobRow {
  readonly id: string;
  readonly kind: "docs.regenerate" | "quantity.recalculate" | "model.stream.warm";
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly step: number;
  readonly totalSteps: number;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  readonly result: { readonly kind: string; readonly summary: Record<string, unknown> } | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly persistHint: string;
}

export interface StreamPageRow {
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly totalElements: number;
  readonly totalPages: number;
  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  readonly contentHash: string;
  readonly elements: readonly { readonly id: string; readonly kind: string }[];
  readonly cacheHit: boolean;
}

export interface StreamStatsRow {
  readonly entries: number;
  readonly maxEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly staleEvictions: number;
  readonly authoritative: false;
  readonly bounded: true;
}

export interface XrefStatusRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly recordStatus: "loaded" | "unresolved";
  readonly sourceHash: string | null;
  readonly entityCount: number;
  readonly instances: number;
  readonly outcome: "available" | "unavailable" | "stale" | "unsupported";
  readonly detail: string;
  readonly revisionBinding: { readonly documentVersionNumber: number; readonly contentHash: string };
}

export interface BudgetsView {
  readonly revision: {
    readonly documentVersionId: string;
    readonly documentVersionNumber: number;
    readonly contentHash: string;
    readonly modelRevisionNumber: number;
    readonly modelRevisionId: string;
    readonly elementCount: number;
  };
  readonly budgets: readonly { readonly workflow: string; readonly thresholdMs: number; readonly unit: string; readonly measuredBy: string }[];
  readonly counters: Record<string, number>;
}

// --- The unwraps --------------------------------------------------------------

export function unwrapRecoveryList(res: CommandQueryResponse): RecoveryListView | null {
  if (!res.ok) return null;
  const v = res.value as RecoveryListView | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.checkpoints)) return null;
  return v;
}

export function unwrapCollabState(res: CommandQueryResponse): CollabStateView | null {
  if (!res.ok) return null;
  const v = res.value as CollabStateView | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.members)) return null;
  return v;
}

export function unwrapCollabComments(res: CommandQueryResponse): CommentRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { comments?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.comments)) return null;
  return v.comments as CommentRow[];
}

export function unwrapCollabActivity(res: CommandQueryResponse): ActivityRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { activity?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.activity)) return null;
  return v.activity as ActivityRow[];
}

export function unwrapCollabTransactions(res: CommandQueryResponse): TransactionRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { transactions?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.transactions)) return null;
  return v.transactions as TransactionRow[];
}

export function unwrapJobsList(res: CommandQueryResponse): JobRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { jobs?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.jobs)) return null;
  return v.jobs as JobRow[];
}

export function unwrapJob(res: CommandQueryResponse): JobRow | null {
  if (!res.ok) return null;
  const v = res.value as { job?: unknown } | null;
  if (typeof v !== "object" || v === null || typeof v.job !== "object") return null;
  return v.job as JobRow;
}

export function unwrapStreamPage(res: CommandQueryResponse): StreamPageRow | null {
  if (!res.ok) return null;
  const v = res.value as { page?: unknown } | null;
  if (typeof v !== "object" || v === null || typeof v.page !== "object") return null;
  return v.page as StreamPageRow;
}

export function unwrapStreamStats(res: CommandQueryResponse): StreamStatsRow | null {
  if (!res.ok) return null;
  const v = res.value as { stats?: unknown } | null;
  if (typeof v !== "object" || v === null || typeof v.stats !== "object") return null;
  return v.stats as StreamStatsRow;
}

export function unwrapXrefsStatus(res: CommandQueryResponse): XrefStatusRow[] | null {
  if (!res.ok) return null;
  const v = res.value as { xrefs?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.xrefs)) return null;
  return v.xrefs as XrefStatusRow[];
}

export function unwrapPerfBudgets(res: CommandQueryResponse): BudgetsView | null {
  if (!res.ok) return null;
  const v = res.value as BudgetsView | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.budgets)) return null;
  return v;
}
