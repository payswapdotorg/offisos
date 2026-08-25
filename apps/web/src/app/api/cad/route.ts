/**
 * CAD/BIM App API — Web transport endpoint (CAD-IMPLEMENT-001 / Issue #24,
 * Architecture v1.1 FROZEN).
 *
 * This Next.js App Router API route IS the Web host surface for the Offisos
 * CAD workspace. The advanced contracts (CADDocument, AppApiHandler, dummy
 * adapter) are imported directly from the canonical
 * `@offisos/cad-app-shell` package source (../../app/src/*) via the tsconfig
 * `paths` alias — single source of truth (milestone-3 integration; no
 * duplicated contract copy). Web/Electron parity is proven by the Offisos
 * repo's host-parity tests; this route reproduces the same server-side
 * handler logic for the Web host.
 *
 * Construction Graph boundary (LOCK-019): CADDocument is the editor
 * representation only; the dummy adapter is the only engine — no FreeCAD/
 * OCCT/IfcOpenShell coupling (LOCK-003/018).
 *
 * Wire contract: see `@offisos/cad-app-shell/contracts/app-api`
 * (WireEnvelope v1). The POST accepts either an envelope
 * `{ api: "1", body: CommandQueryRequest }` or a bare `CommandQueryRequest`
 * (the latter is wrapped automatically for client convenience). GET returns
 * the current `document.getState` snapshot (health-check + Agent Browser
 * smoke entry point).
 */

import { AppApiHandler } from "@offisos/cad-app-shell/app-api";
import { DummyAdapterBundle } from "@offisos/cad-app-shell/adapters/dummy";
import type {
  CommandQueryRequest,
  CommandQueryResponse,
  WireEnvelope,
} from "@offisos/cad-app-shell/contracts/app-api";
import { APP_API_VERSION, err } from "@offisos/cad-app-shell/contracts/app-api";

export const runtime = "nodejs";

/**
 * Module-level singleton handler. State (the open CADDocument + undo/redo
 * stacks + ephemeral selection + idempotency cache) persists across requests
 * within the server process. This is the Web host's document session.
 */
const handler = AppApiHandler.create({
  adapterBundle: DummyAdapterBundle,
  entityId: "web-workspace",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "web-workspace",
});

/** Detect whether a parsed JSON value is a v1 WireEnvelope. */
function isWireEnvelope(value: unknown): value is WireEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "api" in value &&
    "body" in value &&
    (value as { api: unknown }).api === APP_API_VERSION
  );
}

/** Detect whether a parsed JSON value looks like a bare CommandQueryRequest. */
function isCommandQueryRequest(
  value: unknown,
): value is CommandQueryRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "command" ||
    v.type === "query"
  ) && typeof v.name === "string";
}

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json(
      err("bad_json", "request body must be valid JSON", true),
      { status: 400 },
    );
  }

  let request: CommandQueryRequest;
  if (isWireEnvelope(parsed)) {
    request = parsed.body;
  } else if (isCommandQueryRequest(parsed)) {
    // Bare request — wrap in envelope semantics implicitly.
    request = parsed;
  } else {
    return Response.json(
      err(
        "bad_request_shape",
        "expected a WireEnvelope { api: '1', body } or a bare CommandQueryRequest",
        true,
      ),
      { status: 400 },
    );
  }

  const response = await handler.handle(request);
  return Response.json(response);
}

export async function GET(): Promise<Response> {
  const response = await handler.handle({
    type: "query",
    name: "document.getState",
    payload: {},
  });
  return Response.json(response as CommandQueryResponse);
}
