/**
 * CAD-PARITY-005 annotation core barrel (Issue #82).
 *
 * The annotation/text/dimension subsystem: canonical entity vocabulary +
 * measurement (types), style-driven render primitives (render), the shared
 * canvas painter (paint), associative re-measurement (assoc) and
 * primitive-based picking (pick). Engine-free, host-free, deterministic
 * (LOCK-003/018) — imported by the App API, the command registry and BOTH
 * hosts (LOCK-004 parity by construction).
 */

export * from "./types.js";
export * from "./render.js";
export * from "./assoc.js";
export * from "./pick.js";
