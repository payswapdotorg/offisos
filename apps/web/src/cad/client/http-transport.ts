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

/** Export one sheet. format "sheet-ir" returns the canonical IR + hash;
 *  "pdf"/"dwg" answer the typed `docs_unsupported` failure (contract only). */
export async function docsExportSheet(sheetId: string, format: "sheet-ir" | "pdf" | "dwg"): Promise<CommandQueryResponse> {
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
