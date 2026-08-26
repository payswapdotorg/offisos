/**
 * Dummy CAD/BIM adapter bundle (LOCK-003/018, §5.3, §5.5).
 *
 * In-memory test double for the geometry, BIM and file engine adapters. Proves
 * the adapter boundary: the renderer + CADDocument + App API operate entirely
 * against the abstract `EngineAdapterBundle` contract with no FreeCAD/OCCT/
 * IfcOpenShell anywhere in the dependency graph of CAD-IMPLEMENT-001.
 *
 * Production engines are a future work item behind this boundary; they will
 * implement the same `EngineAdapterBundle` interface without renderer or
 * CADDocument changes (LOCK-003).
 */

import type {
  BimEngineAdapter,
  EngineAdapterBundle,
  FileEngineAdapter,
  GeometryEngineAdapter,
  GeometryResult,
} from "../../contracts/adapter.js";
import { ADAPTER_BOUNDARY_MARK } from "../../contracts/adapter.js";
import type { CADDocumentSnapshot, Element } from "../../contracts/caddocument.js";
import { deserialize, rootVersion, serialize } from "../../caddocument/index.js";

const DUMMY_NOW = () => new Date("2026-01-01T00:00:00.000Z").toISOString();

function isSixNumbers(value: unknown): value is readonly [number, number, number, number, number, number] {
  return Array.isArray(value) && value.length === 6 && value.every((n) => typeof n === "number");
}

export const DummyGeometryAdapter: GeometryEngineAdapter = {
  adapterMark: ADAPTER_BOUNDARY_MARK,
  engineId: "dummy-geometry",
  engineVersion: "0.1.0",
  async prepareGeometry(element: Element): Promise<GeometryResult> {
    const props = element.props as Record<string, unknown>;
    const bbox = isSixNumbers(props.bbox)
      ? (props.bbox as readonly [number, number, number, number, number, number])
      : ([0, 0, 0, 1, 1, 1] as const);
    return { meshToken: `dummy-mesh:${element.id}`, bbox };
  },
};

export const DummyBimAdapter: BimEngineAdapter = {
  adapterMark: ADAPTER_BOUNDARY_MARK,
  engineId: "dummy-bim",
  engineVersion: "0.1.0",
  async extractSemantics(element: Element): Promise<Readonly<Record<string, unknown>>> {
    const props = element.props as Record<string, unknown>;
    const sem = props.semantics;
    return typeof sem === "object" && sem !== null ? (sem as Record<string, unknown>) : {};
  },
};

export const DummyFileAdapter: FileEngineAdapter = {
  adapterMark: ADAPTER_BOUNDARY_MARK,
  format: "offisos-dummy",
  async read(source: Uint8Array): Promise<CADDocumentSnapshot> {
    if (source.length === 0) {
      return {
        version: rootVersion("dummy-doc", "dummy-adapter", null, DUMMY_NOW),
        format: "offisos-dummy",
        formatVersion: "1",
        sourceArtifactLineage: ["dummy:empty"],
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

export const DummyAdapterBundle: EngineAdapterBundle = {
  geometry: DummyGeometryAdapter,
  bim: DummyBimAdapter,
  file: DummyFileAdapter,
};
