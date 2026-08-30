/**
 * CAD-PARITY-009 model3d barrel (Issue #90) — the public surface of the
 * shared 3D navigation / UCS / workplane / bounded-modeling core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) — imported by BOTH
 * hosts and the App API so the 3D semantics are THE SAME everywhere
 * (LOCK-004 Web/Electron semantic parity). This module stays crypto-free
 * and serialization-free for the browser bundle (the layouts barrel
 * precedent — canonical hashing lives at the App API layer).
 */

export {
  UCS_ORTHONORMAL_TOLERANCE,
  EPS3D,
  v3,
  v3Add,
  v3Sub,
  v3Dot,
  v3Cross,
  v3Length,
  v3Scale,
  v3Normalize,
  v3Equals,
  formatVec3,
  fmtNum,
  IDENTITY_MATRIX4,
  translationMatrix,
  scaleMatrix,
  scaleMatrix3,
  rotationMatrix,
  basisMatrix,
  mulMatrix,
  transformPoint,
  transformDirection,
  invertAffine,
  isAffineMatrix,
  isFiniteVec3,
} from "./math3d.js";

export {
  EMPTY_BBOX3D,
  bbox3DIsEmpty,
  bbox3DUnion,
  bbox3DCenter,
  bbox3DDiagonal,
  cameraFrame,
  validateCamera,
  normalizeCamera,
  ORBIT_ELEVATION_CLAMP_DEG,
  orbitCamera,
  panCamera,
  zoomCamera,
  ZOOM_MIN,
  ZOOM_MAX,
  FIT_MARGIN,
  fitCameraToBBox,
  STANDARD_VIEW_NAMES,
  STANDARD_VIEW_FRAMES,
  defaultCamera,
  standardCameraFor,
  formatCamera,
  VIEW_CUBE_FACE_CENTERS,
  viewCubeCorners,
  classifyViewCubeZone,
  cameraForViewCubeZone,
  cameraViewDirection,
  type BBox3D,
  type CameraFrame,
  type StandardViewName,
  type ViewCubeZone,
} from "./camera.js";

export {
  projectPoint,
  screenRay,
  unprojectAtDepth,
  rayIntersectsBox,
  pickElements,
  projectBoxCorners,
  boxEdges,
  SUBENTITY_DECLINE_REASON,
  type ScreenViewport,
  type ProjectedPoint,
  type Ray3,
  type PickableElement,
  type PickHit,
} from "./projection.js";

export {
  UCS_WORLD_ID,
  WORLD_UCS,
  validateUcsAxes,
  validateUcsRecord,
  ucsToWorldMatrix,
  worldToUcsMatrix,
  ucsToWorld,
  worldToUcs,
  ucsDirectionToWorld,
  worldDirectionToUcs,
  snapToUcsGrid,
  snapWorldToUcsGrid,
  ucsGridSegments,
  parseTypedPoint3D,
  resolveTypedPoint3D,
  type UcsGridSegment,
  type TypedPoint3D,
} from "./ucs.js";

export {
  SECTION_PREVIEW_FORMAT,
  SECTION_PREVIEW_VERSION,
  SECTION_EXACT_DECLINE_REASON,
  validateSectionPlaneRecord,
  normalizeSectionNormal,
  intersectPlaneBox,
  buildSectionPreview,
  type SectionPreviewFacet,
  type SectionPreviewBody,
  type SectionPreviewIR,
  type SectionPreviewElement,
} from "./section.js";

export {
  SCENE3D_SVG_FORMAT,
  SCENE3D_SVG_VERSION,
  buildScene3DSVG,
  type Scene3DElement,
  type Scene3DInput,
} from "./svg3d.js";

export {
  placeBox,
  placeCylinder,
  placeExtrude,
  transformDescriptor,
  moveDescriptor,
  rotateDescriptor,
  scaleDescriptor,
} from "./solids.js";

export {
  BOOLEAN_OPS,
  BOOLEAN_OPERAND_DECLINE_REASON,
  BOOLEAN_OPERAND_COUNT,
  BOOLEAN_EMPTY_DECLINE_REASON,
  BOOLEAN_INVALID_DECLINE_REASON,
  booleanDescriptor,
  booleanFailureCode,
  booleanProvenance,
  parseBooleanOp,
  type BooleanOp,
  type BooleanOperandProvenance,
  type BooleanProvenance,
} from "./booleans.js";

export {
  SECTION_EXACT_FORMAT,
  SECTION_EXACT_VERSION,
  SECTION_EXACT_ENGINE_DECLINE_REASON,
  SECTION_ON_PLANE_TOLERANCE,
  SECTION_CHAIN_EPS,
  SECTION_MAX_POINTS,
  SectionGeometryValidationError,
  buildSectionExact,
  chainSectionPolylines,
  canonicalizeLoop,
  encodeSectionPoint,
  sectionPlaneBasis,
  sectionPlaneCoords,
  validateSectionGeometry,
  validateSectionPlaneSpec,
  type SectionExactFacet,
  type SectionExactBody,
  type SectionExactIR,
  type SectionExactElement,
} from "./section-exact.js";

export {
  MAX_TOPOLOGY_FACES,
  MAX_TOPOLOGY_EDGES,
  MAX_TOPOLOGY_VERTICES,
  DEFAULT_SUBENTITY_PICK_TOLERANCE,
  TOPOLOGY_DECLINE_REASON,
  SUBENTITY_PER_ELEMENT_DECLINE_REASON,
  TopologyValidationError,
  buildTopologyMap,
  pickSubEntity,
  rayTriangle,
  raySegmentDistance,
  rayPointDistance,
  type TopologyFace,
  type TopologyEdge,
  type TopologyVertex,
  type TopologyMap,
  type SubEntityKind,
  type SubEntityHit,
} from "./topology.js";

export {
  MESH_ENTITY_TYPE,
  MESH_QUALITY_PRESETS,
  MESH_QUALITY_PRESET_NAMES,
  MESH_ENTITY_MAX_VERTICES,
  MESH_ENTITY_MAX_TRIANGLES,
  MESH_OPERATION_DECLINE_REASON,
  buildMeshEntityProps,
  meshQualityKnobs,
  parseMeshQuality,
  validateMeshEntityProps,
  validateMeshPayload,
  type MeshEntityProps,
} from "./meshes.js";

export {
  DEFAULT_CACHE_CAPACITY,
  DEFAULT_CACHE_VERTEX_BUDGET,
  TessellationCache,
  descriptorCacheKey,
  type TessellationCacheEntry,
  type TessellationCacheStats,
} from "./cache.js";
