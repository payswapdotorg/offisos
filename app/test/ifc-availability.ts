/**
 * Shared IFC-toolchain availability helpers for the COMPAT-IFC-001 tests.
 *
 * Mirrors engine-availability.ts (CAD-IMPLEMENT-002 precedent): real-engine
 * tests must SKIP (not fail) with an explicit recorded reason when the
 * pinned IfcOpenShell toolchain is absent — environments without it (the
 * pre-IFC regression workflows) still run the full non-IFC suite green.
 * Not a .test.ts file, so the CI glob (test/*.test.ts) ignores it.
 */

import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";

interface IfcProbe {
  available: boolean;
  engineVersion: string | null;
  message: string | null;
}

let probe: IfcProbe | null = null;

/** Probe once per test process (cached). */
export async function ifcProbe(): Promise<IfcProbe> {
  probe ??= await createIfcInteropAdapter().probe();
  return probe;
}

/** node:test skip value: false when the toolchain is available, else the reason. */
export async function ifcSkip(): Promise<string | false> {
  const p = await ifcProbe();
  return p.available
    ? false
    : `IFC toolchain not available (${p.message ?? "probe failed"}; tests requiring IfcOpenShell are skipped — install python3 + ifcopenshell==0.8.5 + IfcTester==0.8.5 to run them)`;
}
