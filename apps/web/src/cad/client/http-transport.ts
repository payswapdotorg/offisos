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
