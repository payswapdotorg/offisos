/**
 * OCCT CAD/BIM adapter bundle (CAD-IMPLEMENT-002 / Issue #26).
 *
 * The first REAL engine behind the frozen `EngineAdapterBundle` boundary
 * (Architecture v1.1, LOCK-003/018). The contract in
 * app/src/contracts/adapter.ts is byte-unchanged; this bundle implements it:
 *
 *   geometry — createOcctGeometryAdapter: compiles the engine-independent
 *     GeometryDescriptor to the worker recipe and runs it in the isolated
 *     OCCT subprocess (process-per-call, wall-clock timeout, typed failures
 *     per CAD-005). Deterministic meshTokens preserve Web/Electron parity.
 *   bim      — createOcctBimAdapter: documented pass-through (IfcOpenShell
 *     is a later production slice; Issue #26 non-goal).
 *   file     — OcctFileAdapter: canonical Offisos JSON (format
 *     "offisos-occt") — deterministic adapter-state serialization sufficient
 *     for the existing CADDocument save/open workflow.
 *
 * The dummy adapter (src/adapters/dummy) remains the permanent deterministic
 * test double; nothing about it changes. Hosts choose the bundle at
 * AppApiHandler.create({ adapterBundle, ... }) — the same single wiring point
 * the dummy uses (LOCK-003: a replacement engine requires no renderer or
 * CADDocument redesign).
 */

import type { EngineAdapterBundle } from "../../contracts/adapter.js";
import { createOcctBimAdapter } from "./occt-bim-adapter.js";
import { createOcctGeometryAdapter } from "./occt-geometry-adapter.js";
import type { OcctGeometryAdapterOptions } from "./occt-geometry-adapter.js";
import { OcctFileAdapter } from "./occt-file-adapter.js";

export type { OcctGeometryAdapterOptions } from "./occt-geometry-adapter.js";
export {
  compileDescriptor,
  createOcctGeometryAdapter,
} from "./occt-geometry-adapter.js";
export {
  probeOcctEngine,
  resolvePythonExecutable,
  resolveWorkerScript,
} from "./occt-process.js";
export type { EngineProbe, OcctProcessOptions } from "./occt-process.js";
export { OcctFileAdapter, OCCT_FILE_FORMAT } from "./occt-file-adapter.js";
export { createOcctBimAdapter } from "./occt-bim-adapter.js";
export type * from "./worker-protocol.js";

/** Create the real OCCT EngineAdapterBundle. */
export function createOcctAdapterBundle(options: OcctGeometryAdapterOptions = {}): EngineAdapterBundle {
  const geometry = createOcctGeometryAdapter(options);
  const bim = createOcctBimAdapter(() => geometry.engineVersion);
  return {
    geometry,
    bim,
    file: OcctFileAdapter,
  };
}
