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
import type {
  IfcBcfParsedTopic,
  IfcBcfTopicRequest,
  IfcBuildRequest,
  IfcBuildResult,
  IfcIdsResult,
  IfcParseResult,
} from "./ifc.js";

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

/**
 * IFC/openBIM interoperability adapter (COMPAT-IFC-001, additive + optional).
 *
 * The IfcOpenShell toolchain behind this contract: deterministic IFC
 * generation (byte-identical for equal inputs), semantic extraction of IFC
 * files, IDS validation and BCF container contracts. All byte payloads are
 * base64 strings; all wire numbers are METRES (the IFC convention) — the
 * canonical mm domain and the unit normalization live on the caller side.
 * The concrete adapter (src/adapters/ifc) spawns the disposable Python
 * worker; the App API probes this optional capability and fails typed
 * (ifc_unavailable) when the host did not bind it.
 */
export interface IfcInteropAdapter {
  readonly adapterMark: typeof ADAPTER_BOUNDARY_MARK;
  readonly engineId: string;
  readonly engineVersion: string;
  /** Engine/toolchain availability probe (cheap ping). */
  probe(): Promise<{ available: boolean; engineVersion: string | null; message: string | null }>;
  /** Deterministically generate IFC file bytes from a build model. */
  build(request: IfcBuildRequest): Promise<IfcBuildResult>;
  /** Extract the deterministic semantic IR of an IFC file. */
  parse(ifc: string): Promise<IfcParseResult>;
  /** Validate an IFC file against an IDS specification (IfcTester). */
  validateIds(ifc: string, idsXml: string): Promise<IfcIdsResult>;
  /** Build a BCF-XML v3 .bcf container from topics. */
  buildBcf(topics: readonly IfcBcfTopicRequest[]): Promise<{ bcf: string; size: number }>;
  /** Parse a .bcf container into topics (references = IfcGuids). */
  parseBcf(bcf: string): Promise<{ readonly topics: readonly IfcBcfParsedTopic[] }>;
}

/** Composite engine/file boundary. The App API consumes this; the renderer
 *  never sees it. COMPAT-IFC-001 (additive + optional): `ifc` carries the
 *  IFC/openBIM interop adapter when the host binds it — absent on legacy
 *  bundles (the dummy bundle, older hosts); the App API probes and fails
 *  typed when absent. */
export interface EngineAdapterBundle {
  readonly geometry: GeometryEngineAdapter;
  readonly bim: BimEngineAdapter;
  readonly file: FileEngineAdapter;
  readonly ifc?: IfcInteropAdapter;
}
