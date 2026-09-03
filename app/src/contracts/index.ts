/**
 * CAD-IMPLEMENT-001 shared contracts (Architecture v1.1).
 *
 * Re-exports the host, transport, command/query, CADDocument, adapter and
 * scene contracts. Everything the renderer and hosts share lives here; nothing
 * under src/contracts imports Electron, browser APIs, FreeCAD, OpenCascade or
 * IfcOpenShell (enforced by test/no-forbidden-imports.test.ts).
 */

export * from "./host.js";
export * from "./app-api.js";
export * from "./caddocument.js";
export * from "./adapter.js";
export * from "./scene.js";
// CAD-PARITY-018 (additive, Issue #118): the specialized-toolsets shared
// contracts (bounds, record payload types, derived view types — the same
// barrel discipline as the sibling contracts; no runtime dependencies).
export * from "./toolsets.js";
