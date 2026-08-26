/**
 * CAD/BIM Web transport — client-side typed fetch wrappers
 * (CAD-IMPLEMENT-001 / Issue #24, Architecture v1.1 FROZEN).
 *
 * Browser-safe. Imports ONLY from `@offisos/cad-app-shell/contracts/*`
 * (type-only or pure runtime helpers — NO `node:crypto` dependency). The
 * client talks to the backend ONLY via `fetch("/api/cad", ...)`; the
 * AppApiHandler + dummy adapter live server-side in
 * `src/app/api/cad/route.ts`.
 *
 * Wire contract: see `@offisos/cad-app-shell/contracts/app-api`
 * (WireEnvelope v1).
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
