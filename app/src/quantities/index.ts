/**
 * CAD-PARITY-015 (Issue #110) — the quantities workflows core (barrel).
 *
 * Engine-free, host-free (LOCK-018 — scanned by the no-forbidden-imports
 * suite like every shared core): the closed canonical rule table (rules.ts)
 * and the deterministic revision-bound takeoff engine (takeoff.ts).
 */

export * from "./rules.js";
export * from "./takeoff.js";
