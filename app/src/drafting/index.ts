/**
 * Drafting core (COMPAT-CAD-001) — public surface.
 *
 * Pure, engine-free 2D drafting: precision policy, analytic geometry kernel,
 * canonical entities, deterministic snapping and atomic edit operations.
 * Consumed by the App API (the only place drafting commands enter the
 * document command model). LOCK-018: no engine/host/browser imports.
 */

export * from "./precision.js";
export * from "./geom2d.js";
export * from "./entities.js";
export * from "./snap.js";
export * from "./editops.js";
