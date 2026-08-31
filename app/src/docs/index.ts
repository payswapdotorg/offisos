/**
 * COMPAT-CAD-003: the construction-documentation pure core (Issue #41).
 *
 * Module map:
 *  - entities.ts   — documentation annotation entities (docs.dim/docs.tag/
 *                    docs.note) bound to canonical identities.
 *  - project.ts    — the deterministic projection engine (plan/elevation/
 *                    section/detail → view primitives).
 *  - regenerate.ts — regeneration reports + annotation value refreshes +
 *                    view content hashes (the determinism proof).
 *  - export.ts     — the canonical Sheet IR (the future PDF/DWG adapter
 *                    contract; writers intentionally unimplemented).
 *  - schedules.ts  — CAD-PARITY-013: the deterministic fresh schedule/index
 *                    row derivation (schedules.run — no stored rows).
 *
 * Views and sheets themselves live in the CADDocument tables
 * (caddocument/document.ts) — versioned document content through the
 * DocumentEdit command model. This module derives everything else.
 *
 * Engine-free, host-free (LOCK-018).
 */

export * from "./entities.js";
export * from "./project.js";
export * from "./regenerate.js";
export * from "./export.js";
export * from "./schedules.js";
