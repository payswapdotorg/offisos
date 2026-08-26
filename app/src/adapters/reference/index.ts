/**
 * Reference CAD/BIM adapter bundle — public exports
 * (RESEARCH-CAD-007 / Issue #32).
 */

export {
  createReferenceGeometryAdapter,
  evaluateDescriptorAnalytically,
  REFERENCE_ENGINE_ID,
  REFERENCE_ENGINE_VERSION,
  REFERENCE_MESH_PREFIX,
} from "./reference-geometry-adapter.js";
export {
  createReferenceAdapterBundle,
  ReferenceBimAdapter,
  ReferenceFileAdapter,
  REFERENCE_FILE_FORMAT,
} from "./reference-adapter.js";
