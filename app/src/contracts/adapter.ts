/**
 * CAD/BIM engine and file adapter contracts (LOCK-003/018, §5.3, §5.5, §8).
 *
 * The CAD/BIM engine (geometry / BIM / file engines) remains behind stable
 * adapter contracts. A replacement engine must not require renderer or
 * CADDocument redesign (LOCK-003). The renderer never imports engine
 * internals; it operates on the CADDocument snapshot and on the abstract
 * adapter contract.
 *
 * The dummy adapter in `src/adapters/dummy` is the adapter-boundary test
 * double that proves this separation. Production engines (FreeCAD/OCCT/
 * IfcOpenShell) are a future work item behind this boundary and are NOT
 * imported by CAD-IMPLEMENT-001.
 */

import type { Element, CADDocumentSnapshot } from "./caddocument.js";

/** Boundary marker. Adapters declare this; the static coupling test asserts
 *  that no renderer/app-api/caddocument/contracts source imports an engine
 *  module directly. */
export const ADAPTER_BOUNDARY_MARK = "offisos:adapter-boundary:1" as const;

export interface GeometryResult {
  readonly meshToken: string;
  readonly bbox: readonly [number, number, number, number, number, number];
}

/** Geometry engine adapter (OCCT/FreeCAD behind this contract). */
export interface GeometryEngineAdapter {
  readonly adapterMark: typeof ADAPTER_BOUNDARY_MARK;
  readonly engineId: string;
  readonly engineVersion: string;
  prepareGeometry(element: Element): Promise<GeometryResult>;
}

/** BIM semantics engine adapter (IfcOpenShell/IFC behind this contract). */
export interface BimEngineAdapter {
  readonly adapterMark: typeof ADAPTER_BOUNDARY_MARK;
  readonly engineId: string;
  readonly engineVersion: string;
  extractSemantics(element: Element): Promise<Readonly<Record<string, unknown>>>;
}

/** File engine adapter (IFC/STEP/DXF/FCStd behind this contract). */
export interface FileEngineAdapter {
  readonly adapterMark: typeof ADAPTER_BOUNDARY_MARK;
  readonly format: string;
  read(source: Uint8Array): Promise<CADDocumentSnapshot>;
  write(snapshot: CADDocumentSnapshot): Promise<Uint8Array>;
}

/** Composite engine/file boundary. The App API consumes this; the renderer
 *  never sees it. */
export interface EngineAdapterBundle {
  readonly geometry: GeometryEngineAdapter;
  readonly bim: BimEngineAdapter;
  readonly file: FileEngineAdapter;
}
