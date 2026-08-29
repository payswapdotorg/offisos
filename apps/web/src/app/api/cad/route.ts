/**
 * CAD/BIM App API — Web transport endpoint (CAD-IMPLEMENT-001 / Issue #24,
 * CAD-IMPLEMENT-002 / Issue #26; Architecture v1.1 FROZEN).
 *
 * This Next.js App Router API route IS the Web host surface for the Offisos
 * CAD workspace. The advanced contracts (CADDocument, AppApiHandler, the
 * adapters) are imported directly from the canonical
 * `@offisos/cad-app-shell` package source (../../app/src/*) via the tsconfig
 * `paths` alias — single source of truth (milestone-3 integration; no
 * duplicated contract copy). Web/Electron parity is proven by the Offisos
 * repo's host-parity tests; this route reproduces the same server-side
 * handler logic for the Web host.
 *
 * CAD-IMPLEMENT-002: the workspace surface is connected to the REAL geometry
 * engine (OCCT 7.8.1.1 via the isolated Python worker — the same kernel
 * FreeCAD builds on) through the same App API. The adapter bundle swap is
 * the ONLY wiring change (LOCK-003: a replacement engine requires no
 * renderer or CADDocument redesign). The engine subprocess is spawned lazily
 * per geometry.prepare call (process-per-call isolation, wall-clock timeout,
 * typed failures — CAD-005); commands that never prepare geometry (the
 * CAD-IMPLEMENT-001 flow) run engine-free. The dummy adapter remains the
 * permanent test double in the app/ suite.
 *
 * Construction Graph boundary (LOCK-019): CADDocument is the editor
 * representation only. Engine isolation (LOCK-003/018): the engine lives
 * strictly behind the EngineAdapterBundle boundary.
 *
 * Wire contract: see `@offisos/cad-app-shell/contracts/app-api`
 * (WireEnvelope v1). The POST accepts either an envelope
 * `{ api: "1", body: CommandQueryRequest }` or a bare `CommandQueryRequest`
 * (the latter is wrapped automatically for client convenience). GET returns
 * the current `document.getState` snapshot (health-check + Agent Browser
 * smoke entry point).
 */

import { AppApiHandler } from "@offisos/cad-app-shell/app-api";
import { createOcctAdapterBundle, probeOcctEngine } from "@offisos/cad-app-shell/adapters/occt";
import { createReferenceAdapterBundle } from "@offisos/cad-app-shell/adapters/reference";
import { createIfcInteropAdapter } from "@offisos/cad-app-shell/adapters/ifc";
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
 * within the server process. This is the Web host's document session. The
 * OCCT adapter bundle spawns a disposable Python worker per geometry.prepare
 * call (lazy — no engine process until geometry is actually requested).
 *
 * CAD-PARITY-009 (Issue #90): the geometry adapter selection follows the
 * documented ENGINE-AVAILABILITY pattern at the wiring point (LOCK-003 — the
 * boundary is the only thing that changes):
 *  - OFFISOS_GEOMETRY_ENGINE=reference → the in-process reference adapter
 *    (the deterministic analytic engine — serverless-safe; the parity
 *    fixture basis the smokes pin);
 *  - OFFISOS_GEOMETRY_ENGINE=occt → the OCCT subprocess bundle (fails loud
 *    on engine_unavailable — explicit, never silent);
 *  - unset → auto: probe the OCCT engine once; fall back to the reference
 *    adapter when it is unavailable (a serverless deployment without the
 *    Python subprocess keeps the full 3D workflow — every element's
 *    geometryEngine provenance records the engine that actually realized
 *    it, so the fallback is honest, never silent).
 */
const ENGINE_MODE = process.env.OFFISOS_GEOMETRY_ENGINE ?? "auto";

async function createHandler(): Promise<AppApiHandler> {
  let bundle;
  if (ENGINE_MODE === "reference") {
    bundle = createReferenceAdapterBundle();
  } else if (ENGINE_MODE === "occt") {
    bundle = createOcctAdapterBundle({ ifc: createIfcInteropAdapter() });
  } else {
    const probe = await probeOcctEngine({ timeoutMs: 15_000 });
    bundle = probe.available
      ? createOcctAdapterBundle({ ifc: createIfcInteropAdapter() })
      : createReferenceAdapterBundle();
  }
  return AppApiHandler.create({
    // COMPAT-IFC-001: the IFC interop adapter (IfcOpenShell 0.8.5 worker)
    // is bound alongside the OCCT engines — ifc.* becomes available.
    adapterBundle: bundle,
    entityId: "web-workspace",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "web-workspace",
  });
}

const handlerPromise: Promise<AppApiHandler> = createHandler();

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

  const handler = await handlerPromise;
  const response = await handler.handle(request);
  return Response.json(response);
}

export async function GET(): Promise<Response> {
  const handler = await handlerPromise;
  const response = await handler.handle({
    type: "query",
    name: "document.getState",
    payload: {},
  });
  return Response.json(response as CommandQueryResponse);
}
