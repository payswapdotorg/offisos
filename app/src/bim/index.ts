/**
 * BIM authoring core (COMPAT-CAD-002) — barrel.
 *
 * Engine-free, host-free (LOCK-018 scanned — see
 * app/test/no-forbidden-imports.test.ts). Semantics live in elements.ts;
 * deterministic solid derivation in geometry.ts; atomic edit batches in
 * editops.ts; the App API bridge in commands.ts; semantic extraction in
 * semantics.ts; standard cameras in camera.ts.
 */
export * from "./elements.js";
export * from "./components.js";
export * from "./geometry.js";
export * from "./editops.js";
export * from "./commands.js";
export * from "./semantics.js";
export * from "./camera.js";
// CAD-PARITY-011 (additive, Issue #97): the cross-cutting semantic meta
// overlay, the vertical-relationship validators and the dedicated
// lifecycle/classification edit builders.
export * from "./meta.js";
export * from "./relationships.js";
export * from "./lifecycle.js";
