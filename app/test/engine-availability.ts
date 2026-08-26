/**
 * Shared engine-availability helpers for the CAD-IMPLEMENT-002 tests.
 *
 * Real-engine tests must SKIP (not fail) with an explicit recorded reason
 * when the pinned toolchain is absent (Issue #26 acceptance criteria:
 * environments without the engine still run the full non-engine suite).
 * Not a .test.ts file, so the CI glob (test/*.test.ts) ignores it.
 */

import { probeOcctEngine } from "../src/adapters/occt/index.js";
import type { EngineProbe } from "../src/adapters/occt/index.js";
import { spawn } from "node:child_process";

let probe: EngineProbe | null = null;

/** Probe once per test process (cached). */
export async function engineProbe(): Promise<EngineProbe> {
  probe ??= await probeOcctEngine({ timeoutMs: 20_000 });
  return probe;
}

/** node:test skip value: false when the engine is available, else the reason. */
export async function engineSkip(): Promise<string | false> {
  const p = await engineProbe();
  return p.available ? false : `OCCT engine not available (${p.message ?? "probe failed"}; tests requiring the engine are skipped — install python3 + cadquery-ocp to run them)`;
}

/** Whether a plain python3 executable exists (needed for process-boundary
 *  tests that do NOT require OCP). */
export function pythonAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", "print(1)"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
