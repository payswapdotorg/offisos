/**
 * Reference CAD/BIM adapter bundle (RESEARCH-CAD-007 / Issue #32).
 *
 * The second, engine-free `EngineAdapterBundle` behind the frozen boundary:
 *
 *   geometry — createReferenceGeometryAdapter: the pure-TypeScript analytic
 *     engine (no FreeCAD/OCCT/IfcOpenShell anywhere in the dependency graph).
 *   bim      — ReferenceBimAdapter: deterministic pass-through of the
 *     element's recorded semantic properties (the same honest scope as the
 *     OCCT BIM adapter — IfcOpenShell extraction is a later production
 *     slice; semantics the adapter does not extract are labelled UNKNOWN
 *     downstream, never guessed — LOCK-007).
 *   file     — ReferenceFileAdapter: canonical Offisos JSON serialization
 *     (the document format is canonical, not engine property; format id
 *     "offisos-reference").
 *   ifc      — (optional, CAD-PARITY-014 / Issue #107): the IFC interop
 *     adapter when the host binds one through the bundle factory options —
 *     absent by default (legacy bundles stay shape-identical; the App API
 *     probes and fails typed ifc_unavailable).
 *
 * Hosts choose the bundle at AppApiHandler.create({ adapterBundle, ... }) —
 * the SAME single wiring point the dummy and OCCT bundles use (LOCK-003: a
 * replacement engine requires no renderer or CADDocument redesign). This
 * bundle exists to prove exactly that, end to end, with real quantities.
 */

import type {
  BimEngineAdapter,
  EngineAdapterBundle,
  FileEngineAdapter,
  GeometryEngineAdapter,
  IfcInteropAdapter,
} from "../../contracts/adapter.js";
import { ADAPTER_BOUNDARY_MARK } from "../../contracts/adapter.js";
import type { CADDocumentSnapshot, Element } from "../../contracts/caddocument.js";
import { deserialize, rootVersion, serialize } from "../../caddocument/index.js";
import { createReferenceGeometryAdapter } from "./reference-geometry-adapter.js";

export const REFERENCE_FILE_FORMAT = "offisos-reference";

const REFERENCE_NOW = () => new Date("2026-01-01T00:00:00.000Z").toISOString();

export const ReferenceBimAdapter: BimEngineAdapter = {
  adapterMark: ADAPTER_BOUNDARY_MARK,
  engineId: "reference-bim",
  engineVersion: "1.0.0",
  async extractSemantics(element: Element): Promise<Readonly<Record<string, unknown>>> {
    const sem = (element.props as Record<string, unknown>).semantics;
    return typeof sem === "object" && sem !== null ? (sem as Record<string, unknown>) : {};
  },
};

export const ReferenceFileAdapter: FileEngineAdapter = {
  adapterMark: ADAPTER_BOUNDARY_MARK,
  format: REFERENCE_FILE_FORMAT,
  async read(source: Uint8Array): Promise<CADDocumentSnapshot> {
    if (source.length === 0) {
      return {
        version: rootVersion("reference-doc", "reference-adapter", null, REFERENCE_NOW),
        format: REFERENCE_FILE_FORMAT,
        formatVersion: "1",
        sourceArtifactLineage: ["reference:empty"],
        editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
        elements: [],
      };
    }
    const text = new TextDecoder().decode(source);
    return deserialize(text);
  },
  async write(snapshot: CADDocumentSnapshot): Promise<Uint8Array> {
    return new TextEncoder().encode(serialize(snapshot));
  },
};

/** Create the reference EngineAdapterBundle (geometry engine of your choice
 *  defaults to the analytic reference engine). CAD-PARITY-014 (Issue #107,
 *  additive + optional — the createOcctAdapterBundle discipline): pass `ifc`
 *  to bind the IFC interop adapter (a disposable IfcOpenShell worker per
 *  ifc.* op, never the geometry path) alongside the reference engines —
 *  hosts opt in; without it the bundle is shape-identical to the legacy
 *  reference bundle, so every existing caller is unaffected. */
export function createReferenceAdapterBundle(
  geometry: GeometryEngineAdapter = createReferenceGeometryAdapter(),
  options: { ifc?: IfcInteropAdapter } = {},
): EngineAdapterBundle {
  return {
    geometry,
    bim: ReferenceBimAdapter,
    file: ReferenceFileAdapter,
    ...(options.ifc !== undefined ? { ifc: options.ifc } : {}),
  };
}
