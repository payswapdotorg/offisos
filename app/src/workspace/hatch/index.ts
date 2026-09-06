/**
 * COMPAT-CAD-010 (Issue #18) hatch core barrel.
 *
 * The hatch subsystem: the canonical entity vocabulary + boundary
 * resolution (types), the style-driven deterministic render primitives
 * (render), the boundary associativity cascade (cascade), the shared
 * canvas painter (paint) and primitive-based picking (pick).
 * Engine-free, host-free, deterministic (LOCK-003/018) — imported by the
 * App API, the command registry and BOTH hosts (LOCK-004 parity by
 * construction).
 */

export * from "./types.js";
export * from "./render.js";
export * from "./cascade.js";
export * from "./pick.js";
