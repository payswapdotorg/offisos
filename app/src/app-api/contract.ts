/**
 * CAD/BIM App API handler v1 (§5.3, §5.5, api-contract.md).
 *
 * Sits below the hosts and above the CAD/BIM engine. Receives a
 * CommandQueryRequest through any Transport, validates the payload against
 * the wire schema, dispatches commands to the CADDocument (and engine adapters
 * when the command requires them), and returns a CommandQueryResponse.
 *
 * The same handler logic is exercised through both the Web Host and the
 * Electron Host (§5.5). The handler holds a CADDocument (editor's working
 * representation, §5.4) and an EngineAdapterBundle (LOCK-003/018). The renderer
 * never sees the adapter bundle — only the App API does.
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  Command,
  CommandQueryRequest,
  CommandQueryResponse,
  Query,
} from "../contracts/app-api.js";
import type { EngineAdapterBundle } from "../contracts/adapter.js";
import type { CADDocumentSnapshot, DocumentEdit, Element, VersionMeta } from "../contracts/caddocument.js";
import { CADDocument } from "../caddocument/index.js";
import { deserialize, serialize } from "../caddocument/index.js";
import { err, ok } from "../contracts/app-api.js";
import type { ErrResult } from "../contracts/app-api.js";
import {
  isAdapterFailure,
  isGeometryMetadataProvider,
  isMeshProvider,
} from "../contracts/geometry.js";
import type { GeometryPrepareResult } from "../contracts/geometry.js";
import { IdempotencyCache } from "./idempotency.js";
import { bridgeModelHistory } from "../graph/index.js";
import { verifiedReplay } from "../caddocument/history.js";
import { runImpactCascade } from "../impact/index.js";
import type { ModelReplayResult } from "../contracts/model.js";
import {
  buildDraftingCreate,
  copyEntities,
  deleteEntities,
  extendEntity,
  moveEntities,
  trimEntity,
} from "../drafting/commands.js";
import { resolveSnap } from "../drafting/snap.js";
// CAD-PARITY-003 (additive): the shared 2D entity operations + precision
// engine (workspace core — engine-free, LOCK-018 scanned).
import { createEntities, modifyEntities, EntityOpError } from "../workspace/entity-ops.js";
import {
  pickAt as precisionPickAt,
  resolveSnap as precisionResolveSnap,
  selectWindow as precisionSelectWindow,
  toEntities as toPrecisionEntities,
  type OsnapMode,
  type PrecisionSettings,
} from "../workspace/precision-2d.js";
import { canonicalSnapKinds, validateDraftingSettings, validateBimSettings } from "../caddocument/workspace.js";
import {
  ISOLATE_LAYER_STATE_NAME,
  layerStateRestoreEdits,
} from "../caddocument/workspace.js";
import {
  layerStandardById,
  LAYER_STANDARDS,
  BUILT_IN_LTYPE_NAMES,
  STANDARD_DEFAULT_LINEWEIGHT,
  STANDARD_LINEWEIGHTS,
} from "../workspace/standards/index.js";
// CAD-PARITY-005 (additive): the annotation core (engine-free — the
// canonical annotation vocabulary, style resolution, associative cascade).
import {
  AnnotationError,
  annotationFromElement,
  annotationRefIds,
  annotationToProps,
  circleGeomOf,
  elementToAnnotation,
  makeDimAngular,
  makeDimDiameter,
  makeDimLinear,
  makeDimRadius,
  makeLeader,
  makeMLeader,
  makeMText,
  makeText,
  resolveAnchor,
  type Annotation,
} from "../workspace/annotation/index.js";
import {
  annotationViewsOf,
  annotationsReferencing,
  remeasureCascade,
} from "../workspace/annotation/assoc.js";
import { resolveTextStyle, resolveDimStyle } from "../workspace/standards/index.js";
import type { DimStyleRecord, LayerRecord, LtypeRecord, TextStyleRecord } from "../contracts/caddocument.js";
// CAD-PARITY-006 (additive): the blocks core (engine-free — the canonical
// blocks/attributes/xrefs vocabulary, expansion + explode materialization).
import {
  attdefTagsOf,
  blockRefFromElement,
  blockRefToProps,
  BlockError,
  makeBlockRef,
  normalizeBlockEntities,
} from "../workspace/blocks/index.js";
import { geomFromElement } from "../workspace/geometry/bridge.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import type { BlockDefinitionRecord, BlockEntityRecord, XrefRecord, ConstraintRecord } from "../contracts/caddocument.js";
// CAD-PARITY-007 (additive): the parametric-constraints core (engine-free —
// the declared graph grammar, the deterministic propagation solver, the
// constraint-aware editing cascades and the shared glyph painter).
import {
  ConstraintError,
  applyEditsInMemory as constraintsApplyEditsInMemory,
  collectEditedIds as constraintsCollectEditedIds,
  collectRemovedIds,
  CONSTRAINT_LABEL,
  diagnoseConstraints,
  makeConstraint,
  severanceFor,
  solveConstraints,
  solveGeometryEdits,
  validateConstraintTargets,
} from "../workspace/constraints/index.js";
import { applyConstraintPatch } from "../caddocument/workspace.js";
// CAD-PARITY-008 (additive): the shared layouts/plot core (engine-free — the
// paper/page-setup grammar, the deterministic model↔paper transform, the
// canonical Plot IR, the SVG writer and the minimal deterministic PDF
// writer). The SAME modules both hosts' paper canvases consume (LOCK-004).
import {
  DEFAULT_PAGE_SETUP,
  buildPlotIR,
  fitViewToRect,
  modelExtentsOf,
  plotIRToPDF,
  plotIRToSVG,
  plotIRsToPDF,
  validatePageSetup,
  viewportRect,
  windowViewToRect,
} from "../workspace/layouts/index.js";
import type { LayoutRecord, PageSetup, ViewportRecord } from "../contracts/caddocument.js";
import type { PlotIRInput } from "../workspace/layouts/index.js";
// CAD-PARITY-012 (additive, Issue #102): the shared materials +
// coordination cores (engine-free — the deterministic quantity takeoff, the
// pairwise clash kernel view, the revision-cloud scallop geometry and the
// DERIVED grid labels).
import {
  billOfMaterials,
  categoryDefaultColor,
  DEFAULT_LINEWEIGHT,
  materialIdOf,
  validateMaterialFields,
} from "../workspace/materials.js";
import {
  detectClashes,
  gridULabels,
  gridVLabels,
  isDegenerateRect,
  revisionCloudGeom,
} from "../workspace/coordination.js";
// CAD-PARITY-009 (additive): the shared 3D navigation/UCS/workplane/
// bounded-modeling core (engine-free — the deterministic camera, the
// projection/picking math, the UCS transforms, the section-preview
// foundation, the canonical scene SVG writer, the solid descriptor
// builders). The SAME modules both hosts' 3D viewports consume (LOCK-004;
// no host-local navigation math anywhere).
import {
  SUBENTITY_DECLINE_REASON,
  SECTION_EXACT_DECLINE_REASON,
  buildSectionPreview,
  defaultCamera,
  fitCameraToBBox,
  formatCamera,
  isFiniteVec3,
  normalizeCamera,
  normalizeSectionNormal,
  pickElements,
  placeBox,
  placeCylinder,
  placeExtrude,
  moveDescriptor,
  rotateDescriptor,
  scaleDescriptor,
  screenRay,
  standardCameraFor,
  validateCamera,
  type BBox3D,
  type StandardViewName,
} from "../workspace/model3d/index.js";
import { ucsDirectionToWorld, WORLD_UCS } from "../workspace/model3d/index.js";
// CAD-PARITY-010 (additive, Issue #93): the boolean/surface/section/
// topology/cache core (engine-free — the same modules both hosts consume).
import {
  BOOLEAN_OPERAND_DECLINE_REASON,
  BOOLEAN_EMPTY_DECLINE_REASON,
  SUBENTITY_PER_ELEMENT_DECLINE_REASON,
  TOPOLOGY_DECLINE_REASON,
  SECTION_EXACT_ENGINE_DECLINE_REASON,
  MESH_OPERATION_DECLINE_REASON,
  SectionGeometryValidationError,
  TopologyValidationError,
  booleanDescriptor,
  booleanFailureCode,
  booleanProvenance,
  parseBooleanOp,
  buildSectionExact,
  validateSectionGeometry,
  buildTopologyMap,
  pickSubEntity,
  buildMeshEntityProps,
  meshQualityKnobs,
  parseMeshQuality,
  TessellationCache,
  type SubEntityKind,
  type TopologyMap,
} from "../workspace/model3d/index.js";
import {
  isQualityMeshProvider,
  isSectionProvider,
  isTopologyProvider,
} from "../contracts/geometry.js";
import type { MeshQualityPreset, SectionGeometry } from "../contracts/geometry.js";
import type { Camera3DState, SectionPlaneRecord, UcsRecord } from "../contracts/caddocument.js";
import type { GeometryDescriptor, Vec3 } from "../contracts/geometry.js";
// (isMeshProvider is already imported from ../contracts/geometry.js above.)
// COMPAT-CAD-002: the pure BIM authoring core (LOCK-018 scanned).
import {
  buildBimCreate,
  bimEntityToElement,
  bimGeometryContext,
  bimModelBBox,
  bimSolidDescriptor,
  copyBimElements,
  deleteBimElements,
  elementToBimEntityOrNull,
  makeMaterial,
  extractElementSemanticsSafe,
  moveBimElements,
  setBimProperties,
  standardCamera,
} from "../bim/index.js";
// COMPAT-BIM-003: the pure component/material/coordination core.
import {
  effectiveBox,
  effectiveMaterialId,
  effectiveParameters,
  type ComponentDefEntity,
  type GridEntity,
  type MaterialEntity,
  type ReferencePlaneEntity,
} from "../bim/index.js";
// CAD-PARITY-011 (Issue #97): the meta/lifecycle edit builders, the
// classification table and the effective renovation state.
import {
  setBimActiveOption,
  setBimClassification,
  setBimOptionMembership,
  setBimPropertySets,
  setBimRenovation,
  BIM_CLASSIFICATION_TABLE,
  BIM_CLASSIFICATION_CODES,
  effectiveRenovationStatus,
  type BimElementMeta,
} from "../bim/index.js";
// COMPAT-IFC-001: the pure IFC/openBIM core + the optional interop adapter
// capability (LOCK-018 — the engine stays behind the adapter boundary).
import {
  buildIfcExportRequest,
  ifcGuidFor,
  importEntitiesToElements,
  ifcReportHash,
  reconcileIfcImport,
  type IfcImportReport,
} from "../ifc/index.js";
// CAD-PARITY-014 (additive, Issue #107): the documentation exchange carrier
// (the IfcGroup mapping + the reconcile/classification side).
import {
  buildIfcDocumentationExport,
  reconcileIfcDocumentation,
  type IfcDocsMint,
  type IfcDocsTargetState,
} from "../ifc/index.js";
// CAD-PARITY-014 (additive, Issue #107): the bounded interoperability shared
// core (pure, engine-free, LOCK-018 — the dxf writer/reader/import mapping,
// the Sheet-IR→Plot-IR bridge, the exchange report, the archival registry
// and the dxf round-trip verification loop).
import {
  archivalList,
  buildInteropExchangeReport,
  dxfRoundtripReport,
  looksLikeDwg,
  readDxf,
  sheetIRToPlotIR,
  writeDxf,
  mapDxfImport,
  dxfUnitFactor,
  DxfError,
  type DxfWriteInput,
} from "../interop/index.js";
import { isIfcInteropProvider } from "../contracts/adapter.js";
import type { IfcInteropAdapter } from "../contracts/adapter.js";
import type { IfcBcfViewpoint } from "../contracts/ifc.js";
// COMPAT-CAD-003: the pure construction-documentation core (LOCK-018 scanned).
import {
  annotationElement,
  buildSheetIR,
  isDocsExportFormat,
  isDocsAnnotationType,
  makeDocsDim,
  makeDocsNote,
  makeDocsTag,
  projectAllViews,
  regenerateDocumentation,
  viewContentHash,
} from "../docs/index.js";
import type { DocsSheetRecord, DocsViewRecord } from "../contracts/caddocument.js";
import { validateDocsSheetRecord, validateDocsViewRecord } from "../caddocument/workspace.js";
// CAD-PARITY-013: the shared record grammars, imported for PRE-MINT draft
// validation (a failing create command never burns a canonical id — the
// host-parity determinism contract; the record re-validates at execute with
// the minted id through the SAME grammar).
import {
  validateNavigatorNodeRecord,
  validatePublisherSetRecord,
  validateRevisionRecord,
  validateScheduleRecord,
  validateTitleBlockRecord,
  // CAD-PARITY-015 (additive, Issue #110): the property-definition registry
  // validator.
  validatePropertyDefRecord,
} from "../caddocument/workspace.js";
// CAD-PARITY-013 (additive, Issue #104): the documentation production core —
// the fresh schedule row derivation (docs/schedules.ts) + the Layout Book
// ordering / sheet-numbering / revision-code derivations shared by the
// navigator tree, the publisher expansion and the title-block rendering
// (layouts/book.ts — pure, engine-free, the SAME modules both hosts
// consume, LOCK-004).
import { runSchedule } from "../docs/index.js";
import type { ScheduleRunContext } from "../docs/index.js";
// CAD-PARITY-015 (additive, Issue #110): the quantities workflows core —
// the closed canonical rule table + the deterministic revision-bound
// takeoff engine (pure, engine-free, the SAME modules both hosts consume,
// LOCK-004/018) — and the meta overlay reader for the property lineage
// statistics.
import {
  parseQuantityTakeoffInput,
  runQuantityTakeoff,
  QUANTITY_MEASURE_UNITS,
  QUANTITY_RULE_TABLE,
  QUANTITY_SOURCES,
  QUANTITY_GROUPINGS,
} from "../quantities/index.js";
import { bimMetaOfProps } from "../bim/meta.js";
import { revisionCodesOf, sheetNumberOf, subsetLayouts } from "../workspace/layouts/index.js";
import type {
  NavigatorNodeRecord,
  PublisherItem,
  PublisherSetRecord,
  RevisionRecord,
  ScheduleRecord,
  TitleBlockRecord,
  // CAD-PARITY-015 (additive, Issue #110): the property-definition registry
  // record.
  PropertyDefRecord,
} from "../contracts/caddocument.js";
import type { IfcFieldClassification } from "../ifc/report.js";
// CAD-PARITY-016 (additive, Issue #112): the collaboration/recovery/scale
// cores — the durable versioned recovery checkpoints + the deterministic
// crash/session recovery (recovery), the project-scoped members/presence/
// comments/activity + the versioned transactions with explicit conflict
// and merge/resolution lineage (collab), the durable stepwise
// background-regeneration job engine (jobs) and the bounded large-model
// stream cache with explicit non-authority (modelstream). All engine-free
// shared core (LOCK-018); the stores are SESSION-side support mechanisms —
// the CADDocument remains the single canonical system of record (LOCK-019).
import { CheckpointStore, checkpointIdOf, headRevisionIdOf } from "../recovery/index.js";
import { CollabStore, CollabError } from "../collab/index.js";
import { JobStore, JobError } from "../jobs/index.js";
import {
  ModelStreamCache,
  StreamError,
  STREAM_PAGE_SIZE_DEFAULT,
  STREAM_PAGE_SIZE_MAX,
  STREAM_PAGE_SIZE_MIN,
} from "../modelstream/index.js";
import {
  PRESENCE_TTL,
  type CheckpointView,
  type CollabMemberView,
  type CommentTarget,
  type JobKind,
  type PerfBudgetsView,
  type RecoveryReport,
  type SessionClock,
  type XrefOutcome,
  type XrefStatusView,
} from "../contracts/collab.js";

export interface AppApiHandlerOptions {
  readonly adapterBundle: EngineAdapterBundle;
  readonly entityId: string;
  readonly format: string;
  readonly formatVersion: string;
  readonly createdBy: string;
}

/** CAD-PARITY-016 (Issue #112): the lowercase path extension of an
 *  external-reference path ("" when none) — the deterministic basis of the
 *  unsupported-format outcome. */
function pathExtensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export class AppApiHandler {
  private doc: CADDocument;
  private readonly adapters: EngineAdapterBundle;
  private readonly options: AppApiHandlerOptions;
  private readonly idempotency: IdempotencyCache = new IdempotencyCache();
  /** CAD-PARITY-010: the bounded revision-tied tessellation cache (LOD mesh
   *  delivery — keys are canonical descriptor encodings + quality presets,
   *  so a modeling edit that changes an element's geometry naturally
   *  invalidates its entries; dual budgets; exact counters for the
   *  performance-budget evidence). */
  private readonly tessellationCache = new TessellationCache();
  // --- CAD-PARITY-016 (additive, Issue #112): the session-side
  // collaboration/recovery/scale state. The virtual session clock advances
  // one tick per DISPATCHED command (queries are free — the P016
  // determinism convention: every session record is a pure function of the
  // command sequence, so all outputs are fixture-pinnable across hosts and
  // the wire). The stores are support mechanisms; the CADDocument above
  // remains the single canonical system of record (LOCK-019). ---
  private sessionClock: SessionClock = 0;
  private commandCount = 0;
  /** Bumped whenever the session's DOCUMENT is replaced (create/open/
   *  deserialize/restore) — a document swap is not a modeling mutation, so
   *  the autosave version-compare must not tick for it. */
  private docEpoch = 0;
  private mutationsSinceAutosave = 0;
  private autosaveCount = 0;
  private restoreCount = 0;
  private checkpoints = new CheckpointStore();
  private collab = new CollabStore();
  private jobs = new JobStore();
  private stream = new ModelStreamCache();

  private constructor(options: AppApiHandlerOptions, doc: CADDocument, adapters: EngineAdapterBundle) {
    this.options = options;
    this.doc = doc;
    this.adapters = adapters;
  }

  /** Create a handler with an empty document (root version). */
  static create(options: AppApiHandlerOptions): AppApiHandler {
    const doc = CADDocument.empty(options.entityId, options.format, options.formatVersion, options.createdBy);
    return new AppApiHandler(options, doc, options.adapterBundle);
  }

  /** The handler's document (CAD-PARITY-011: host/test read access to the
   *  immutable history for graph bridging — the document stays the single
   *  authority; this exposes reading, never mutation). */
  get document(): CADDocument {
    return this.doc;
  }

  /** Process a command/query request. Idempotent for commands with a key. */
  async handle(request: CommandQueryRequest): Promise<CommandQueryResponse> {
    if (request.type === "command" && request.idempotencyKey !== undefined) {
      const cached = this.idempotency.get(request.idempotencyKey);
      if (cached !== undefined) return cached;
    }
    // CAD-PARITY-016 (Issue #112): the virtual session clock — one tick per
    // DISPATCHED command (idempotent replays return the cached response and
    // do NOT tick; queries are free). The command's session records carry
    // this clock value, so every P016 output is a pure function of the
    // command sequence.
    let versionBefore = 0;
    let epochBefore = 0;
    if (request.type === "command") {
      this.commandCount += 1;
      this.sessionClock += 1;
      versionBefore = this.doc.snapshot().version.version_number;
      epochBefore = this.docEpoch;
    }
    const response =
      request.type === "command" ? await this.handleCommand(request) : await this.handleQuery(request);
    if (request.type === "command") {
      // CAD-PARITY-016: the bounded autosave policy — a durable versioned
      // checkpoint is minted automatically every N document-mutating
      // commands (transparent: the command's response is untouched, so
      // every pre-P016 surface stays byte-identical). A document SWAP
      // (create/open/deserialize/restore — the epoch guard) is not a
      // modeling mutation and never ticks the policy.
      if (
        response.ok &&
        this.docEpoch === epochBefore &&
        this.doc.snapshot().version.version_number !== versionBefore
      ) {
        this.maybeAutosave();
      }
      if (request.idempotencyKey !== undefined) {
        this.idempotency.set(request.idempotencyKey, response);
      }
    }
    return response;
  }

  /** CAD-PARITY-016: the bounded autosave tick (called after a successful
   *  version-changing command; deterministic — a pure function of the
   *  command sequence). */
  private maybeAutosave(): void {
    this.mutationsSinceAutosave += 1;
    if (this.mutationsSinceAutosave >= this.checkpoints.recoveryPolicy.autosaveEvery) {
      this.mutationsSinceAutosave = 0;
      this.autosaveCount += 1;
      this.mintCheckpoint("autosave");
    }
  }

  /** CAD-PARITY-016: reset the session-side collaboration/recovery/scale
   *  state when a NEW document becomes the session's document (create/open/
   *  deserialize) — the collab members, comments, presence, activity,
   *  transactions, checkpoints, jobs and stream cache belong to the
   *  document session, never to the host process. This keeps every smoke
   *  and CI run deterministic regardless of prior requests. */
  private resetP016Session(): void {
    this.docEpoch += 1;
    this.sessionClock = 0;
    this.commandCount = 0;
    this.mutationsSinceAutosave = 0;
    this.autosaveCount = 0;
    this.restoreCount = 0;
    this.checkpoints = new CheckpointStore();
    this.collab = new CollabStore();
    this.jobs = new JobStore();
    this.stream = new ModelStreamCache();
  }

  /** CAD-PARITY-016: the shared checkpoint mint (store + activity entry). */
  private mintCheckpoint(cause: "manual" | "autosave" | "pre-restore"): CheckpointView {
    const view = this.checkpoints.create(this.doc, cause, this.sessionClock, checkpointIdOf);
    this.collab.noteSystemEvent(
      "checkpoint.saved",
      `checkpoint ${view.id} saved (${cause}, v${view.documentVersionNumber}, sha ${view.contentHash.slice(0, 12)}…, ${view.elementCount} element(s))`,
      this.sessionClock,
    );
    return view;
  }

  /** Current document content hash (for parity assertions across hosts). */
  currentContentHash(): string {
    return this.doc.currentContentHash();
  }

  // --- Commands -----------------------------------------------------------

  private async handleCommand(command: Command): Promise<CommandQueryResponse> {
    switch (command.name) {
      case "document.create":
        return this.cmdCreate(command.payload);
      case "document.open":
        return this.cmdOpen(command.payload);
      case "document.applyEdit":
        return this.cmdApplyEdit(command.payload);
      case "document.setSelection":
        return this.cmdSetSelection(command.payload);
      case "document.undo":
        return this.cmdUndo();
      case "document.redo":
        return this.cmdRedo();
      case "document.serialize":
        return this.cmdSerialize();
      case "document.deserialize":
        return this.cmdDeserialize(command.payload);
      case "document.save":
        return this.cmdSave();
      case "geometry.prepare":
        return this.cmdPrepareGeometry(command.payload);
      // --- CAD-PARITY-003 (additive): canonical 2D entity commands ---
      case "entity.create":
        return this.cmdEntityCreate(command.payload);
      case "entity.modify":
        return this.cmdEntityModify(command.payload);
      // --- COMPAT-CAD-001 (additive): 2D drafting commands ---
      case "drafting.createEntities":
        return this.cmdDraftingCreate(command.payload);
      case "drafting.move":
        return this.cmdDraftingTransform(command.payload, "move");
      case "drafting.copy":
        return this.cmdDraftingTransform(command.payload, "copy");
      case "drafting.delete":
        return this.cmdDraftingDelete(command.payload);
      case "drafting.trim":
        return this.cmdDraftingTrimExtend(command.payload, "trim");
      case "drafting.extend":
        return this.cmdDraftingTrimExtend(command.payload, "extend");
      case "drafting.setSettings":
        return this.cmdDraftingSetSettings(command.payload);
      case "drafting.addLayer":
        return this.cmdDraftingLayer(command.payload, "add");
      case "drafting.updateLayer":
        return this.cmdDraftingLayer(command.payload, "update");
      case "drafting.removeLayer":
        return this.cmdDraftingLayer(command.payload, "remove");
      // --- CAD-PARITY-004 (additive): layers, properties, styles, states ---
      case "entity.setDisplay":
        return this.cmdEntitySetDisplay(command.payload);
      case "layer.setActive":
        return this.cmdLayerSetActive(command.payload);
      case "layer.applyStandard":
        return this.cmdLayerApplyStandard(command.payload);
      case "layer.isolate":
        return this.cmdLayerIsolate(command.payload);
      case "layer.unisolate":
        return this.cmdLayerUnisolate(command.payload);
      case "layerState.save":
        return this.cmdLayerStateSave(command.payload);
      case "layerState.restore":
        return this.cmdLayerStateRestore(command.payload);
      case "layerState.remove":
        return this.cmdLayerStateRemove(command.payload);
      case "ltype.create":
        return this.cmdLtypeCreate(command.payload);
      case "ltype.update":
        return this.cmdLtypeUpdate(command.payload);
      case "ltype.remove":
        return this.cmdLtypeRemove(command.payload);
      case "textStyle.create":
        return this.cmdTextStyleCreate(command.payload);
      case "textStyle.update":
        return this.cmdTextStyleUpdate(command.payload);
      case "textStyle.remove":
        return this.cmdTextStyleRemove(command.payload);
      case "dimStyle.create":
        return this.cmdDimStyleCreate(command.payload);
      case "dimStyle.update":
        return this.cmdDimStyleUpdate(command.payload);
      case "dimStyle.remove":
        return this.cmdDimStyleRemove(command.payload);
      // --- CAD-PARITY-005 (additive): annotation/text/dimension commands ---
      case "annotation.create":
        return this.cmdAnnotationCreate(command.payload);
      case "annotation.update":
        return this.cmdAnnotationUpdate(command.payload);
      case "annotation.remeasure":
        return this.cmdAnnotationRemeasure(command.payload);
      // --- CAD-PARITY-006 (additive): blocks/attributes/xrefs commands ----
      case "block.create":
        return this.cmdBlockCreate(command.payload);
      case "block.insert":
        return this.cmdBlockInsert(command.payload);
      case "block.update":
        return this.cmdBlockUpdate(command.payload);
      case "block.remove":
        return this.cmdBlockRemove(command.payload);
      case "attribute.update":
        return this.cmdAttributeUpdate(command.payload);
      case "xref.attach":
        return this.cmdXrefAttach(command.payload);
      case "xref.detach":
        return this.cmdXrefDetach(command.payload);
      case "xref.reload":
        return this.cmdXrefReload(command.payload);
      // --- CAD-PARITY-007 (additive): parametric constraints commands ----
      case "constraint.create":
        return this.cmdConstraintCreate(command.payload);
      case "constraint.update":
        return this.cmdConstraintUpdate(command.payload);
      case "constraint.remove":
        return this.cmdConstraintRemove(command.payload);
      case "constraint.solve":
        return this.cmdConstraintSolve(command.payload);
      // --- CAD-PARITY-008 (additive): layouts, viewports, plot commands ----
      case "layout.create":
        return this.cmdLayoutCreate(command.payload);
      case "layout.rename":
        return this.cmdLayoutRename(command.payload);
      case "layout.clone":
        return this.cmdLayoutClone(command.payload);
      case "layout.remove":
        return this.cmdLayoutRemove(command.payload);
      case "layout.setPageSetup":
        return this.cmdLayoutSetPageSetup(command.payload);
      case "layout.activate":
        return this.cmdLayoutActivate(command.payload);
      case "layout.setSpace":
        return this.cmdLayoutSetSpace(command.payload);
      case "viewport.create":
        return this.cmdViewportCreate(command.payload);
      case "viewport.update":
        return this.cmdViewportUpdate(command.payload);
      case "viewport.remove":
        return this.cmdViewportRemove(command.payload);
      case "plot.export":
        return this.cmdPlotExport(command.payload);
      case "plot.publish":
        return this.cmdPlotPublish(command.payload);
      // --- CAD-PARITY-009 (additive): 3D navigation, UCS/workplanes and
      // bounded 3D modeling ---
      case "ucs.define":
        return this.cmdUcsDefine(command.payload);
      case "ucs.update":
        return this.cmdUcsUpdate(command.payload);
      case "ucs.remove":
        return this.cmdUcsRemove(command.payload);
      case "ucs.activate":
        return this.cmdUcsActivate(command.payload);
      case "view3d.set":
        return this.cmdView3dSet(command.payload);
      case "view3d.fit":
        return this.cmdView3dFit(command.payload);
      case "view3d.standard":
        return this.cmdView3dStandard(command.payload);
      case "model3d.box":
        return await this.cmdModel3dBox(command.payload);
      case "model3d.cylinder":
        return await this.cmdModel3dCylinder(command.payload);
      case "model3d.extrude":
        return await this.cmdModel3dExtrude(command.payload);
      case "model3d.move":
        return await this.cmdModel3dTransform(command.payload, "move");
      case "model3d.rotate":
        return await this.cmdModel3dTransform(command.payload, "rotate");
      case "model3d.scale":
        return await this.cmdModel3dTransform(command.payload, "scale");
      case "sectionplane.create":
        return this.cmdSectionPlaneCreate(command.payload);
      case "sectionplane.update":
        return this.cmdSectionPlaneUpdate(command.payload);
      case "sectionplane.remove":
        return this.cmdSectionPlaneRemove(command.payload);
      // --- CAD-PARITY-010 (additive, Issue #93): boolean solids and bounded
      // mesh entities ---
      case "model3d.boolean":
        return await this.cmdModel3dBoolean(command.payload);
      case "model3d.tessellate":
        return await this.cmdModel3dTessellate(command.payload);
      // --- CAD-PARITY-012 (additive, Issue #102): components, materials and
      // coordination commands (one payload = ONE DocumentEdit = one version
      // = one undo entry; typed failure codes) ---
      case "material.create":
        return this.cmdMaterialCreate(command.payload);
      case "material.update":
        return this.cmdMaterialUpdate(command.payload);
      case "material.remove":
        return this.cmdMaterialRemove(command.payload);
      case "material.assign":
        return this.cmdMaterialAssign(command.payload);
      case "grid.create":
        return this.cmdGridCreate(command.payload);
      case "grid.update":
        return this.cmdGridUpdate(command.payload);
      case "revcloud.create":
        return this.cmdRevcloudCreate(command.payload);
      // --- CAD-PARITY-013 (additive, Issue #104): the documentation
      // production commands — the navigator (View Map folders + Layout Book
      // subsets), title blocks, schedules, revisions, publisher sets and
      // the generic layout.update patch. One payload = ONE DocumentEdit =
      // one version = one undo entry; publisher.run is NON-VERSIONED output
      // automation (the plot.publish precedent). ---
      case "navigator.createFolder":
        return this.cmdNavigatorCreateFolder(command.payload);
      case "navigator.createSubset":
        return this.cmdNavigatorCreateSubset(command.payload);
      case "navigator.removeNode":
        return this.cmdNavigatorRemoveNode(command.payload);
      case "titleblock.create":
        return this.cmdTitleBlockCreate(command.payload);
      case "titleblock.update":
        return this.cmdTitleBlockUpdate(command.payload);
      case "titleblock.remove":
        return this.cmdTitleBlockRemove(command.payload);
      case "schedule.create":
        return this.cmdScheduleCreate(command.payload);
      case "schedule.update":
        return this.cmdScheduleUpdate(command.payload);
      case "schedule.remove":
        return this.cmdScheduleRemove(command.payload);
      // --- CAD-PARITY-015 (additive, Issue #110): the property-definition
      // registry command surface. ---
      case "property.create":
        return this.cmdPropertyDefCreate(command.payload);
      case "property.update":
        return this.cmdPropertyDefUpdate(command.payload);
      case "property.remove":
        return this.cmdPropertyDefRemove(command.payload);
      case "revision.add":
        return this.cmdRevisionAdd(command.payload);
      case "revision.update":
        return this.cmdRevisionUpdate(command.payload);
      case "revision.remove":
        return this.cmdRevisionRemove(command.payload);
      case "publisher.create":
        return this.cmdPublisherCreate(command.payload);
      case "publisher.update":
        return this.cmdPublisherUpdate(command.payload);
      case "publisher.remove":
        return this.cmdPublisherRemove(command.payload);
      case "publisher.run":
        return this.cmdPublisherRun(command.payload);
      case "layout.update":
        return this.cmdLayoutUpdate(command.payload);
      // --- COMPAT-CAD-002 (additive): 3D/BIM authoring commands ---
      case "bim.createElements":
        return this.cmdBimCreate(command.payload);
      case "bim.move":
        return this.cmdBimTransform(command.payload, "move");
      case "bim.copy":
        return this.cmdBimTransform(command.payload, "copy");
      case "bim.delete":
        return this.cmdBimDelete(command.payload);
      case "bim.setProperties":
        return this.cmdBimSetProperties(command.payload);
      case "bim.setSettings":
        return this.cmdBimSetSettings(command.payload);
      case "bim.buildGeometry":
        return await this.cmdBimBuildGeometry(command.payload);
      // --- CAD-PARITY-011 (additive, Issue #97): the meta/lifecycle command
      // surface (classification, property sets, renovation, options). ---
      case "bim.setClassification":
        return this.cmdBimSetClassification(command.payload);
      case "bim.setPropertySets":
        return this.cmdBimSetPropertySets(command.payload);
      case "bim.setRenovation":
        return this.cmdBimSetRenovation(command.payload);
      case "bim.setOptionMembership":
        return this.cmdBimSetOptionMembership(command.payload);
      case "bim.setActiveOption":
        return this.cmdBimSetActiveOption(command.payload);
      // --- COMPAT-CAD-003 (additive): documentation commands ---
      case "docs.createViews":
        return this.cmdDocsCreateViews(command.payload);
      case "docs.updateView":
        return this.cmdDocsUpdateView(command.payload);
      case "docs.removeView":
        return this.cmdDocsRemoveView(command.payload);
      case "docs.createSheets":
        return this.cmdDocsCreateSheets(command.payload);
      case "docs.updateSheet":
        return this.cmdDocsUpdateSheet(command.payload);
      case "docs.removeSheet":
        return this.cmdDocsRemoveSheet(command.payload);
      case "docs.addAnnotations":
        return this.cmdDocsAddAnnotations(command.payload);
      case "docs.removeAnnotations":
        return this.cmdDocsRemoveAnnotations(command.payload);
      case "docs.regenerate":
        return this.cmdDocsRegenerate();
      case "ifc.export":
        return this.cmdIfcExport(command.payload);
      case "ifc.import":
        return this.cmdIfcImport(command.payload);
      case "ifc.bcfCreate":
        return this.cmdIfcBcfCreate(command.payload);
      // --- CAD-PARITY-014 (additive, Issue #107): file interoperability ---
      case "dxf.import":
        return this.cmdDxfImport(command.payload);
      // --- CAD-PARITY-016 (additive, Issue #112): the collaboration/
      // recovery/scale command surface. ---
      case "recovery.checkpoint":
        return this.cmdRecoveryCheckpoint();
      case "recovery.restore":
        return this.cmdRecoveryRestore(command.payload);
      case "recovery.autosave":
        return this.cmdRecoveryAutosave();
      case "collab.join":
        return this.cmdCollabJoin(command.payload);
      case "collab.presence":
        return this.cmdCollabPresence(command.payload);
      case "collab.comment":
        return this.cmdCollabComment(command.payload);
      case "collab.resolveComment":
        return this.cmdCollabResolveComment(command.payload);
      case "collab.commit":
        return this.cmdCollabCommit(command.payload);
      case "collab.merge":
        return this.cmdCollabMerge(command.payload);
      case "jobs.create":
        return this.cmdJobsCreate(command.payload);
      case "jobs.tick":
        return this.cmdJobsTick(command.payload);
      default: {
        const _exhaustive: never = command.name;
        return err("unknown_command", `unknown command: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private async cmdCreate(payload: unknown): Promise<CommandQueryResponse> {
    const p = (payload ?? {}) as {
      entityId?: string;
      format?: string;
      formatVersion?: string;
      createdBy?: string;
    } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "create payload must be an object", true);
    }
    const entityId = typeof p.entityId === "string" && p.entityId.length > 0 ? p.entityId : randomUUID();
    const format = typeof p.format === "string" ? p.format : this.options.format;
    const formatVersion = typeof p.formatVersion === "string" ? p.formatVersion : this.options.formatVersion;
    const createdBy = typeof p.createdBy === "string" ? p.createdBy : this.options.createdBy;
    this.doc = CADDocument.empty(entityId, format, formatVersion, createdBy);
    this.resetP016Session();
    return ok(this.doc.snapshot());
  }

  private async cmdOpen(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { snapshot?: CADDocumentSnapshot; source?: number[] | Uint8Array } | null;
    if (p === null || typeof p !== "object") return err("bad_payload", "open payload must be an object", true);
    let snapshot: CADDocumentSnapshot;
    if (p.snapshot !== undefined) {
      snapshot = p.snapshot;
    } else if (p.source !== undefined) {
      try {
        // The wire contract is JSON; a Uint8Array source survives the wire as a
        // plain number[]. Normalize back to Uint8Array for the file adapter.
        const source =
          p.source instanceof Uint8Array ? p.source : new Uint8Array(p.source);
        snapshot = await this.adapters.file.read(source);
      } catch (e) {
        return err("file_read_failed", `file adapter read failed: ${(e as Error).message}`, false);
      }
    } else {
      return err("bad_payload", "open requires snapshot or source", true);
    }
    try {
      // CAD-IMPLEMENT-003: open now adopts/validates the persisted model
      // revision history carried by the snapshot (LOCK-007: malformed
      // history is rejected, never guessed or silently repaired).
      this.doc = CADDocument.open(snapshot, this.options.createdBy);
      this.resetP016Session();
    } catch (e) {
      return err("open_failed", `open rejected the snapshot: ${(e as Error).message}`, false);
    }
    return ok(this.doc.snapshot());
  }

  private async cmdApplyEdit(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { edit?: DocumentEdit } | null;
    if (p === null || typeof p !== "object" || p.edit === undefined) {
      return err("bad_payload", "applyEdit requires edit", true);
    }
    try {
      this.doc.execute(p.edit);
    } catch (e) {
      return err("edit_failed", (e as Error).message, false);
    }
    return ok(this.doc.snapshot());
  }

  private async cmdUndo(): Promise<CommandQueryResponse> {
    const undone = this.doc.undo();
    if (undone === null) return err("nothing_to_undo", "undo stack is empty", false);
    return ok({ undone, snapshot: this.doc.snapshot() });
  }

  private async cmdRedo(): Promise<CommandQueryResponse> {
    const redone = this.doc.redo();
    if (redone === null) return err("nothing_to_redo", "redo stack is empty", false);
    return ok({ redone, snapshot: this.doc.snapshot() });
  }

  private async cmdSerialize(): Promise<CommandQueryResponse> {
    return ok(serialize(this.doc.snapshot()));
  }

  private async cmdDeserialize(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { text?: string } | null;
    if (p === null || typeof p !== "object" || typeof p.text !== "string") {
      return err("bad_payload", "deserialize requires text", true);
    }
    try {
      const snapshot = deserialize(p.text);
      this.doc = CADDocument.open(snapshot, this.options.createdBy);
      this.resetP016Session();
    } catch (e) {
      return err("deserialize_failed", (e as Error).message, false);
    }
    return ok(this.doc.snapshot());
  }

  private async cmdSetSelection(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids)) {
      return err("bad_payload", "setSelection requires ids array", true);
    }
    const ids = p.ids as unknown[];
    if (!ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "setSelection ids must all be strings", true);
    }
    this.doc.setSelection(ids as string[]);
    return ok({ selection: [...this.doc.selection] });
  }

  private async cmdSave(): Promise<CommandQueryResponse> {
    try {
      const bytes = await this.adapters.file.write(this.doc.snapshot());
      // The wire contract is JSON; Uint8Array survives the wire as a plain
      // number[]. Return both forms for caller convenience.
      return ok({ bytes: Array.from(bytes), format: this.doc.snapshot().format });
    } catch (e) {
      return err("file_write_failed", `file adapter write failed: ${(e as Error).message}`, false);
    }
  }

  /**
   * geometry.prepare (CAD-IMPLEMENT-002, additive): realize an
   * engine-independent GeometryDescriptor through the geometry engine
   * adapter (LOCK-003/018 — the only place the App API touches the engine).
   * Non-mutating: callers persist the result via applyEdit(addElement).
   *
   * Typed failure mapping (CAD-005 §5): an AdapterFailure thrown by the
   * adapter becomes the wire ErrResult verbatim (engine_timeout /
   * engine_malformed_input / engine_error / engine_unavailable). The
   * adapter's result is structurally validated before it is returned
   * (never trust engine output blindly). Viewport mesh data and
   * selection/query metadata are attached when the concrete adapter
   * implements the optional structural capabilities (MeshProvider /
   * GeometryMetadataProvider) — the dummy adapter implements neither.
   */
  private async cmdPrepareGeometry(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { geometry?: unknown } | null;
    if (p === null || typeof p !== "object" || p.geometry === undefined) {
      return err("bad_payload", "geometry.prepare requires geometry", true);
    }
    // The contract method takes an Element; the descriptor is its props.
    const element: Element = {
      id: "geometry:prepare",
      kind: "geometry",
      engineId: null,
      props: p.geometry as Record<string, unknown>,
    };
    let result: { meshToken: string; bbox: readonly [number, number, number, number, number, number] };
    try {
      result = await this.adapters.geometry.prepareGeometry(element);
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("engine_error", `geometry adapter failed: ${(e as Error).message}`, false);
    }
    // Structural validation of the adapter's result (CAD-005 §5).
    if (
      typeof result !== "object" || result === null ||
      typeof result.meshToken !== "string" || result.meshToken.length === 0 ||
      !Array.isArray(result.bbox) || result.bbox.length !== 6 ||
      !result.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("engine_error", "geometry adapter returned an invalid GeometryResult", false);
    }

    // Optional capabilities (structural — the protected core never imports
    // a concrete adapter; LOCK-018 stays intact).
    let mesh: GeometryPrepareResult["mesh"] = null;
    if (isMeshProvider(this.adapters.geometry)) {
      try {
        mesh = await this.adapters.geometry.describeMesh(result.meshToken);
      } catch {
        mesh = null;
      }
    }
    let metadata: GeometryPrepareResult["metadata"] = null;
    if (isGeometryMetadataProvider(this.adapters.geometry)) {
      try {
        metadata = await this.adapters.geometry.describeGeometryMetadata(result.meshToken);
      } catch {
        metadata = null;
      }
    }

    const value: GeometryPrepareResult = {
      meshToken: result.meshToken,
      bbox: result.bbox,
      mesh,
      metadata,
      engine: {
        engineId: this.adapters.geometry.engineId,
        engineVersion: this.adapters.geometry.engineVersion,
      },
    };
    return ok(value);
  }

  // --- Queries ------------------------------------------------------------

  private async handleQuery(query: Query): Promise<CommandQueryResponse> {
    switch (query.name) {
      case "document.getState":
        return ok(this.doc.snapshot());
      case "document.getVersion":
        return ok(this.doc.snapshot().version as VersionMeta);
      case "document.canUndo":
        return ok(this.doc.canUndo);
      case "document.canRedo":
        return ok(this.doc.canRedo);
      case "document.getSelection":
        return ok([...this.doc.selection]);
      // --- CAD-IMPLEMENT-003 (additive): model revisions + Graph bridge ---
      case "model.getHistory":
        return ok(this.doc.history);
      case "model.getGraphEvents": {
        try {
          return ok(bridgeModelHistory(this.doc.history));
        } catch (e) {
          return err("graph_bridge_failed", `graph bridge failed: ${(e as Error).message}`, false);
        }
      }
      case "model.replay": {
        const p = query.payload as { revision_number?: unknown } | null;
        if (
          p === null || typeof p !== "object" ||
          typeof p.revision_number !== "number" || !Number.isInteger(p.revision_number) || p.revision_number < 0
        ) {
          return err("bad_payload", "model.replay requires a non-negative integer revision_number", true);
        }
        const k = p.revision_number;
        const history = this.doc.history;
        if (k > history.revisions.length) {
          return err(
            "bad_payload",
            `model.replay revision_number ${k} out of range 0..${history.revisions.length}`,
            true,
          );
        }
        try {
          const replayed = verifiedReplay(history, k);
          const targetRevision = k === 0 ? undefined : history.revisions[k - 1];
          const result: ModelReplayResult = {
            revision_number: k,
            revision_id:
              k === 0
                ? `${history.entity_id}#r0(${replayed.content_hash.slice(0, 12)})`
                : (targetRevision as { revision_id: string }).revision_id,
            elements: replayed.elements,
            content_hash: replayed.content_hash,
            verified: replayed.verified,
          };
          if (!result.verified) {
            return err(
              "replay_failed",
              `replay to revision ${k} does not match the recorded content hash (history integrity violation)`,
              false,
            );
          }
          return ok(result);
        } catch (e) {
          return err("replay_failed", `replay failed: ${(e as Error).message}`, false);
        }
      }
      case "impact.cascade":
        return await this.qImpactCascade(query.payload);
      case "drafting.snap":
        return this.qDraftingSnap(query.payload);
      // --- CAD-PARITY-003 (additive): precision queries (the SAME shared
      // modules the host renderers run — parity by construction) ---
      case "precision.snap":
        return this.qPrecisionSnap(query.payload);
      case "precision.pick":
        return this.qPrecisionPick(query.payload);
      case "precision.window":
        return this.qPrecisionWindow(query.payload);
      // --- COMPAT-CAD-002 (additive): BIM queries ---
      case "bim.getBuilding":
        return this.qBimGetBuilding();
      // --- CAD-PARITY-011 (additive, Issue #97): classification/options/
      // lifecycle queries. ---
      case "bim.getClassification":
        return this.qBimGetClassification();
      case "bim.getOptions":
        return this.qBimGetOptions();
      case "bim.getLifecycle":
        return this.qBimGetLifecycle(query.payload);
      // --- COMPAT-BIM-003 (additive): component/material/coordination ---
      case "bim.getComponents":
        return this.qBimGetComponents();
      case "bim.getSemantics":
        return this.qBimGetSemantics(query.payload);
      case "bim.camera":
        return this.qBimCamera(query.payload);
      // --- COMPAT-CAD-003 (additive): documentation queries ---
      case "docs.listViews":
        return this.qDocsListViews();
      case "docs.getViewGeometry":
        return this.qDocsGetViewGeometry(query.payload);
      case "docs.listSheets":
        return this.qDocsListSheets();
      case "docs.exportSheet":
        return this.qDocsExportSheet(query.payload);
      case "ifc.probe":
        return this.qIfcProbe();
      case "ifc.compare":
        return this.qIfcCompare(query.payload);
      case "ifc.idsValidate":
        return this.qIfcIdsValidate(query.payload);
      case "ifc.bcfParse":
        return this.qIfcBcfParse(query.payload);
      case "ifc.listImports":
        return this.qIfcListImports();
      // CAD-PARITY-006 (additive): the blocks/xrefs inventory queries.
      case "blocks.list":
        return this.qBlocksList();
      case "xrefs.list":
        return this.qXrefsList();
      // CAD-PARITY-007 (additive): the constraint graph inventory + the
      // on-demand solver diagnostics (non-mutating, computed fresh).
      case "constraints.list":
        return this.qConstraintsList();
      case "constraints.diagnostics":
        return this.qConstraintsDiagnostics();
      // --- CAD-PARITY-008 (additive): the layout/plot queries --------------
      case "layouts.list":
        return this.qLayoutsList();
      case "plot.preview":
        return this.qPlotPreview(query.payload);
      // --- CAD-PARITY-009 (additive): the 3D navigation/UCS/modeling
      // queries (non-mutating, computed fresh every call) ---
      case "ucs.list":
        return this.qUcsList();
      case "view3d.state":
        return this.qView3dState();
      case "model3d.pick":
        if (typeof (query.payload as { elementId?: unknown } | null)?.elementId === "string" &&
            ((query.payload as { subEntity?: unknown; subEntityKind?: unknown } | null)?.subEntity === true ||
             typeof (query.payload as { subEntityKind?: unknown } | null)?.subEntityKind === "string")) {
          return await this.qModel3dPickSubEntityAsync(query.payload as Record<string, unknown>, (query.payload as { elementId: string }).elementId);
        }
        return this.qModel3dPick(query.payload);
      case "model3d.sectionPreview":
        return this.qModel3dSectionPreview(query.payload);
      case "model3d.mesh":
        return await this.qModel3dMesh(query.payload);
      // --- CAD-PARITY-010 (additive, Issue #93): the exact-section,
      // topology and cache-evidence queries ---
      case "model3d.section":
        return await this.qModel3dSection(query.payload);
      case "model3d.topology":
        return await this.qModel3dTopology(query.payload);
      case "model3d.cacheStats":
        return this.qModel3dCacheStats();
      // --- CAD-PARITY-012 (additive, Issue #102): the components/materials/
      // coordination read surfaces (non-mutating, computed fresh every
      // call, never persisted stale) ---
      case "components.list":
        return this.qComponentsList();
      case "materials.list":
        return this.qMaterialsList();
      case "materials.bom":
        return this.qMaterialsBom();
      case "grids.list":
        return this.qGridsList();
      case "coordination.clash":
        return this.qCoordinationClash();
      // --- CAD-PARITY-013 (additive, Issue #104): the documentation
      // production read surfaces (non-mutating, computed fresh every call,
      // never persisted stale — navigator.tree, schedules.list/run,
      // revisions.list, publisher.list, docs.exchangeReport). ---
      case "navigator.tree":
        return this.qNavigatorTree();
      case "schedules.list":
        return this.qSchedulesList();
      case "schedules.run":
        return this.qSchedulesRun(query.payload);
      // --- CAD-PARITY-015 (additive, Issue #110): the properties/quantities
      // query surfaces (computed fresh, never persisted). ---
      case "properties.list":
        return this.qPropertiesList();
      case "quantities.run":
        return this.qQuantitiesRun(query.payload);
      case "quantities.rules":
        return this.qQuantitiesRules();
      case "revisions.list":
        return this.qRevisionsList();
      case "publisher.list":
        return this.qPublisherList();
      case "docs.exchangeReport":
        return this.qDocsExchangeReport();
      // --- CAD-PARITY-014 (additive, Issue #107): the file-interoperability
      // read surfaces (non-mutating, computed fresh every call). ---
      case "dxf.export":
        return this.qDxfExport();
      case "interop.exchangeReport":
        return this.qInteropExchangeReport();
      case "interop.archivalList":
        return this.qInteropArchivalList();
      case "interop.roundtripReport":
        return await this.qInteropRoundtripReport(query.payload);
      // --- CAD-PARITY-016 (additive, Issue #112): the collaboration/
      // recovery/scale query surfaces (non-mutating, computed fresh every
      // call, never persisted stale). ---
      case "recovery.list":
        return this.qRecoveryList();
      case "collab.state":
        return this.qCollabState();
      case "collab.comments":
        return this.qCollabComments();
      case "collab.activity":
        return this.qCollabActivity();
      case "collab.transactions":
        return this.qCollabTransactions();
      case "jobs.list":
        return this.qJobsList();
      case "jobs.get":
        return this.qJobsGet(query.payload);
      case "model.stream":
        return this.qModelStream(query.payload);
      case "model.streamStats":
        return this.qModelStreamStats();
      case "xrefs.status":
        return this.qXrefsStatus();
      case "xrefs.probe":
        return this.qXrefsProbe(query.payload);
      case "perf.budgets":
        return this.qPerfBudgets();
      default: {
        const _exhaustive: never = query.name;
        return err("unknown_query", `unknown query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * impact.cascade (RESEARCH-CAD-007, additive): run the deterministic
   * downstream chain for one model transition (default: the latest
   * revision) — quantity.recalculate.requested → quantity.changed →
   * estimate.recalculated → rfq.scope.impact.detected + the aggregate
   * commercial impact — caused by the corresponding model.version.created
   * graph event. Quantities are computed THROUGH the bound geometry engine
   * adapter (LOCK-003/018 — the only engine touchpoint); engine ids are
   * provenance only. Non-mutating, deterministic (fixed timestamps,
   * canonical ordering, canonical-hash event ids).
   */
  private async qImpactCascade(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { revision_number?: unknown } | null;
    const history = this.doc.history;
    if (history.revisions.length === 0) {
      return err("bad_payload", "impact.cascade requires at least one recorded revision", true);
    }
    let k = history.revisions.length;
    if (p !== null && typeof p === "object" && p.revision_number !== undefined) {
      if (typeof p.revision_number !== "number" || !Number.isInteger(p.revision_number)) {
        return err("bad_payload", "impact.cascade revision_number must be an integer", true);
      }
      k = p.revision_number;
    }
    if (k < 1 || k > history.revisions.length) {
      return err(
        "bad_payload",
        `impact.cascade revision_number ${k} out of range 1..${history.revisions.length}`,
        true,
      );
    }
    try {
      const cascade = await runImpactCascade({ history, revision: k, bundle: this.adapters });
      return ok(cascade);
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("impact_failed", `impact cascade failed: ${(e as Error).message}`, false);
    }
  }

  // --- COMPAT-CAD-001 (additive): 2D drafting commands -----------------------

  /** drafting.createEntities — validate + apply ONE atomic create batch
   *  (one versioned command, one revision, one undo entry). Entity ids are
   *  minted by the document; the response reports the created ids. */
  private cmdDraftingCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { entities?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.entities)) {
      return err("bad_payload", "drafting.createEntities requires an entities array", true);
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = buildDraftingCreate(
        this.doc.allElements(),
        (id) => this.doc.layerById(id) !== undefined,
        p.entities,
      );
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({ created, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.move / drafting.copy — translate / duplicate the selection. */
  private cmdDraftingTransform(payload: unknown, op: "move" | "copy"): CommandQueryResponse {
    const p = payload as { ids?: unknown; dx?: unknown; dy?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", `drafting.${op} requires an ids string array`, true);
    }
    if (typeof p.dx !== "number" || !Number.isFinite(p.dx) || typeof p.dy !== "number" || !Number.isFinite(p.dy)) {
      return err("bad_payload", `drafting.${op} requires finite dx/dy`, true);
    }
    try {
      const outcome = op === "move"
        ? moveEntities(this.doc.allElements(), p.ids as string[], p.dx, p.dy)
        : copyEntities(this.doc.allElements(), p.ids as string[], p.dx, p.dy);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      const before = new Set(this.doc.allElements().map((el) => el.id));
      this.doc.execute(outcome.edit);
      const created = op === "copy"
        ? this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id)
        : [];
      return ok({ applied: true, summary: outcome.summary, created, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.delete — remove the selection atomically. */
  private cmdDraftingDelete(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "drafting.delete requires an ids string array", true);
    }
    try {
      const outcome = deleteEntities(p.ids as string[]);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      // CAD-PARITY-005: the associative cascade — annotations referencing
      // DELETED targets disassociate (typed notes; their last known values
      // survive) inside the SAME atomic revision.
      // CAD-PARITY-007: constraints referencing deleted targets SEVER
      // (removeConstraint edits + typed notes — the dead-ref precedent).
      const elements = this.doc.allElements();
      const deleted = new Set(p.ids as string[]);
      const annotations = annotationViewsOf(elements).filter(({ annotation }) => {
        for (const refId of annotationRefIds(annotation)) {
          if (deleted.has(refId)) return true;
        }
        return false;
      });
      const constraints = this.doc.constraintTable;
      const severance = constraints.length > 0 ? severanceFor(constraints, deleted) : { edits: [], severed: [], notes: [] };
      let edit: DocumentEdit = outcome.edit;
      let summary = outcome.summary;
      const extraEdits: DocumentEdit[] = [];
      if (annotations.length > 0) {
        const worldAfter = elements.filter((el) => !deleted.has(el.id));
        const cascade = remeasureCascade(annotations, worldAfter);
        if (cascade.edits.length > 0) {
          extraEdits.push(...cascade.edits);
          summary = `${summary}; ${cascade.edits.length} annotation${cascade.edits.length === 1 ? "" : "s"} disassociated`;
        }
      }
      if (severance.edits.length > 0) {
        extraEdits.push(...severance.edits);
        summary = `${summary}; ${severance.severed.length} constraint${severance.severed.length === 1 ? "" : "s"} severed`;
      }
      if (extraEdits.length > 0) {
        const edits = edit.type === "applyEdits" ? [...edit.edits, ...extraEdits] : [edit, ...extraEdits];
        edit = { type: "applyEdits", edits };
      }
      this.doc.execute(edit);
      return ok({ applied: true, summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.trim / drafting.extend — geometry edits on line targets. */
  private cmdDraftingTrimExtend(payload: unknown, op: "trim" | "extend"): CommandQueryResponse {
    const p = payload as { targetId?: unknown; pick?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.targetId !== "string") {
      return err("bad_payload", `drafting.${op} requires a targetId string`, true);
    }
    if (!Array.isArray(p.pick) || p.pick.length !== 2 || !p.pick.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return err("bad_payload", `drafting.${op} requires pick: [x, y] finite numbers`, true);
    }
    try {
      const outcome = op === "trim"
        ? trimEntity(this.doc.allElements(), p.targetId, [p.pick[0] as number, p.pick[1] as number])
        : extendEntity(this.doc.allElements(), p.targetId, [p.pick[0] as number, p.pick[1] as number]);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("supported set")) {
        return err("drafting_unsupported", message, false);
      }
      return err("drafting_invalid", message, false);
    }
  }

  /** drafting.setSettings — replace the non-versioned drafting settings. */
  private cmdDraftingSetSettings(payload: unknown): CommandQueryResponse {
    const p = payload as { settings?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.settings !== "object" || p.settings === null) {
      return err("bad_payload", "drafting.setSettings requires a settings object", true);
    }
    try {
      const cur = this.doc.draftingSettings;
      const incoming = p.settings as Record<string, unknown>;
      // One-level deep merge: partial grid/snap/view patches keep the
      // unmentioned sibling fields.
      const merged = {
        ...cur,
        ...incoming,
        grid: { ...cur.grid, ...((incoming.grid as object) ?? {}) },
        snap: { ...cur.snap, ...((incoming.snap as object) ?? {}) },
        view: { ...cur.view, ...((incoming.view as object) ?? {}) },
        // CAD-PARITY-004: the standards object merges one level deep so
        // LTSCALE patches keep the defaultLineweight (and vice versa).
        standards: { ...(cur.standards ?? {}), ...((incoming.standards as object) ?? {}) },
      };
      if (incoming.standards === undefined && cur.standards === undefined) delete (merged as Record<string, unknown>).standards;
      const settings = validateDraftingSettings(merged);
      // CAD-PARITY-004 cross-reference validation (document state lives here):
      // - activeLayer must reference an existing, non-frozen layer;
      // - textStyle/dimStyle must reference an existing style (built-ins
      //   "Standard" included).
      if (settings.activeLayer !== undefined) {
        const layer = this.doc.layerById(settings.activeLayer);
        if (layer === undefined) {
          return err("drafting_invalid", `drafting.setSettings: activeLayer '${settings.activeLayer}' does not exist`, false);
        }
        if (layer.frozen === true) {
          return err("drafting_invalid", `drafting.setSettings: layer '${layer.name}' is frozen — a frozen layer cannot be active`, false);
        }
      }
      if (settings.textStyle !== undefined && settings.textStyle !== "Standard" && this.doc.textStyleByName(settings.textStyle) === undefined) {
        return err("drafting_invalid", `drafting.setSettings: textStyle '${settings.textStyle}' does not exist`, false);
      }
      if (settings.dimStyle !== undefined && settings.dimStyle !== "Standard" && this.doc.dimStyleByName(settings.dimStyle) === undefined) {
        return err("drafting_invalid", `drafting.setSettings: dimStyle '${settings.dimStyle}' does not exist`, false);
      }
      this.doc.setDraftingSettings(settings);
      return ok({ settings: this.doc.draftingSettings, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.addLayer / updateLayer / removeLayer — semantic layer edits
   *  through the document command model (ids minted by the document). */
  private cmdDraftingLayer(payload: unknown, op: "add" | "update" | "remove"): CommandQueryResponse {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", `drafting.${op}Layer requires an object payload`, true);
    }
    try {
      if (op === "add") {
        if (typeof p.name !== "string" || p.name.length === 0) {
          return err("bad_payload", "drafting.addLayer requires a non-empty name", true);
        }
        const layer: LayerRecord = {
          id: this.doc.mintLayerId(),
          name: p.name,
          color: typeof p.color === "string" ? p.color : "#111827",
          visible: typeof p.visible === "boolean" ? p.visible : true,
          // CAD-PARITY-004 extended fields (validated by the document's
          // validateLayerRecord through execute; linetype names + lineweight
          // standard-set membership checked here where the tables live).
          ...(typeof p.frozen === "boolean" ? { frozen: p.frozen } : {}),
          ...(typeof p.locked === "boolean" ? { locked: p.locked } : {}),
          ...(typeof p.linetype === "string" ? { linetype: p.linetype } : {}),
          ...(typeof p.lineweight === "number" ? { lineweight: p.lineweight } : {}),
          ...(typeof p.transparency === "number" ? { transparency: p.transparency } : {}),
          ...(typeof p.plot === "boolean" ? { plot: p.plot } : {}),
          ...(typeof p.description === "string" ? { description: p.description } : {}),
        };
        if (layer.linetype !== undefined && !this.ltypeResolves(layer.linetype)) {
          return err("drafting_invalid", `drafting.addLayer: unknown linetype '${layer.linetype}'`, false);
        }
        this.doc.execute({ type: "addLayer", layer });
        // CAD-PARITY-004: -LAYER Make — create AND switch the active layer in
        // one command (a frozen layer cannot be created frozen-active; the
        // fresh layer is never frozen).
        if (p.makeActive === true) {
          this.doc.setDraftingSettings({ ...this.doc.draftingSettings, activeLayer: layer.id });
        }
        return ok({ layerId: layer.id, active: p.makeActive === true, snapshot: this.doc.snapshot() });
      }
      if (op === "update") {
        if (typeof p.layerId !== "string" || typeof p.patch !== "object" || p.patch === null) {
          return err("bad_payload", "drafting.updateLayer requires layerId + patch", true);
        }
        const patch = p.patch as Record<string, unknown>;
        // CAD-PARITY-004 operational rules that need document state:
        // - a patch that sets linetype must reference a resolvable linetype;
        // - the ACTIVE layer cannot be frozen (you cannot draw on a frozen
        //   layer — the layer must be switched or thawed first).
        if (typeof patch.linetype === "string" && !this.ltypeResolves(patch.linetype)) {
          return err("drafting_invalid", `drafting.updateLayer: unknown linetype '${patch.linetype}'`, false);
        }
        if (patch.frozen === true) {
          const active = this.doc.draftingSettings.activeLayer ?? "0";
          if (p.layerId === active) {
            return err("drafting_invalid", "the active layer cannot be frozen — switch the active layer or thaw it first", false);
          }
        }
        this.doc.execute({ type: "updateLayer", layerId: p.layerId, patch });
        return ok({ snapshot: this.doc.snapshot() });
      }
      if (typeof p.layerId !== "string") {
        return err("bad_payload", "drafting.removeLayer requires layerId", true);
      }
      this.doc.execute({ type: "removeLayer", layerId: p.layerId });
      return ok({ snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-004 (additive): layers, properties, styles, states ------

  /** Does a linetype name resolve (built-in catalog or user table)? The
   *  single resolution predicate shared by every layer/entity write path. */
  private ltypeResolves(name: string): boolean {
    if (name === "Continuous") return true;
    if (BUILT_IN_LTYPE_NAMES.includes(name)) return true;
    return this.doc.ltypeByName(name) !== undefined;
  }

  /** entity.setDisplay — ONE atomic display/layer patch over a batch of
   *  entities (CHPROP / MATCHPROP / the Properties palette write path).
   *  Validation + edit construction live in the shared entity-ops core; the
   *  document's execute() gate enforces locked-layer rejection. */
  private cmdEntitySetDisplay(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "entity.setDisplay requires an ids string array + patch", true);
    }
    if (typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "entity.setDisplay requires a patch object", true);
    }
    try {
      const outcome = modifyEntities(this.doc.allElements(), {
        op: "setDisplay",
        ids: p.ids as string[],
        patch: p.patch as Record<string, unknown>,
        layerExists: (id) => this.doc.layerById(id) !== undefined,
        ltypeResolves: (name) => this.ltypeResolves(name),
      });
      if (outcome.edit === null) {
        return ok({ applied: false, reason: outcome.summary, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, modified: outcome.modifiedCount, snapshot: this.doc.snapshot() });
    } catch (e) {
      if (e instanceof EntityOpError) return err(e.code, e.message, false);
      return err("entity_invalid", (e as Error).message, false);
    }
  }

  /** layer.setActive — switch the active layer (persisted editor state; a
   *  frozen layer cannot be active). */
  private cmdLayerSetActive(payload: unknown): CommandQueryResponse {
    const p = payload as { layerId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.layerId !== "string") {
      return err("bad_payload", "layer.setActive requires a layerId string", true);
    }
    const layer = this.doc.layerById(p.layerId);
    if (layer === undefined) {
      return err("bad_layer", `layer.setActive: no layer '${p.layerId}'`, false);
    }
    if (layer.frozen === true) {
      return err("bad_layer", `layer.setActive: layer '${layer.name}' is frozen — thaw it before drawing on it`, false);
    }
    try {
      this.doc.setDraftingSettings({ ...this.doc.draftingSettings, activeLayer: p.layerId });
      return ok({ activeLayer: p.layerId, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** layer.applyStandard — apply a named layer standard (architectural /
   *  mechanical) to the document: every standard layer that does not already
   *  exist (by name) is created with its standard color/linetype/lineweight
   *  in ONE atomic versioned batch; existing layers are reported as skipped
   *  (never silently overwritten). */
  private cmdLayerApplyStandard(payload: unknown): CommandQueryResponse {
    const p = payload as { standard?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.standard !== "string") {
      return err("bad_payload", "layer.applyStandard requires a standard id ('architectural' | 'mechanical')", true);
    }
    const standard = layerStandardById(p.standard);
    if (standard === null) {
      return err("bad_payload", `layer.applyStandard: unknown standard '${p.standard}' (available: ${LAYER_STANDARDS.map((s) => s.id).join(", ")})`, true);
    }
    try {
      const existingNames = new Set(this.doc.layerTable.map((l) => l.name));
      const edits: DocumentEdit[] = [];
      const createdNames: string[] = [];
      const skippedNames: string[] = [];
      for (const def of standard.layers) {
        if (existingNames.has(def.name)) {
          skippedNames.push(def.name);
          continue;
        }
        const layer: LayerRecord = {
          id: this.doc.mintLayerId(),
          name: def.name,
          color: def.color,
          visible: true,
          ...(def.linetype !== "Continuous" ? { linetype: def.linetype } : {}),
          ...(def.lineweight !== STANDARD_DEFAULT_LINEWEIGHT ? { lineweight: def.lineweight } : {}),
          ...(def.description.length > 0 ? { description: def.description } : {}),
        };
        edits.push({ type: "addLayer", layer });
        createdNames.push(def.name);
      }
      if (edits.length > 0) {
        this.doc.execute({ type: "applyEdits", edits });
      }
      return ok({
        standard: standard.id,
        created: createdNames,
        skipped: skippedNames,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** layer.isolate — keep only the given layers (ids) visible; every other
   *  layer is switched off in ONE atomic versioned batch. The previous layer
   *  table state is saved as the reserved *ISOLATE* layer state so
   *  layer.unisolate can restore it exactly (undoable independently). */
  private cmdLayerIsolate(payload: unknown): CommandQueryResponse {
    const p = payload as { layerIds?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.layerIds) || !p.layerIds.every((x) => typeof x === "string")) {
      return err("bad_payload", "layer.isolate requires a layerIds string array", true);
    }
    const keep = new Set(p.layerIds as string[]);
    try {
      const edits: DocumentEdit[] = [];
      // Save the pre-isolation state first (replaces any stale isolation).
      edits.push({ type: "addLayerState", state: this.doc.captureCurrentLayerState(ISOLATE_LAYER_STATE_NAME) });
      for (const layer of this.doc.layerTable) {
        if (keep.has(layer.id) || !layer.visible) continue;
        edits.push({ type: "updateLayer", layerId: layer.id, patch: { visible: false } });
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ isolated: [...keep], snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** layer.unisolate — restore the layer table state saved by layer.isolate
   *  (and remove the reserved state). Without a stored isolation state the
   *  command is a typed no-op failure (honest surface). */
  private cmdLayerUnisolate(payload: unknown): CommandQueryResponse {
    void payload;
    const saved = this.doc.layerStateByName(ISOLATE_LAYER_STATE_NAME);
    if (saved === undefined) {
      return err("bad_state", "layer.unisolate: no isolation is active (run LAYISO first)", false);
    }
    try {
      const edits: DocumentEdit[] = [...layerStateRestoreEdits(saved, this.doc.layerTable)];
      edits.push({ type: "removeLayerState", stateName: ISOLATE_LAYER_STATE_NAME });
      if (edits.length > 0) {
        this.doc.execute({ type: "applyEdits", edits });
      }
      return ok({ restored: true, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** layerState.save — capture the current layer table under a name
   *  (re-save replaces; the reserved *ISOLATE* name is rejected here — it
   *  belongs to the isolation machinery). */
  private cmdLayerStateSave(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0) {
      return err("bad_payload", "layerState.save requires a non-empty name", true);
    }
    const name = p.name.trim();
    if (name === ISOLATE_LAYER_STATE_NAME) {
      return err("bad_payload", `layerState.save: '${ISOLATE_LAYER_STATE_NAME}' is reserved for LAYISO/LAYUNISO`, true);
    }
    try {
      const state = this.doc.captureCurrentLayerState(name);
      this.doc.execute({ type: "addLayerState", state });
      return ok({ name, layers: state.layers.length, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** layerState.restore — replay a saved layer state as ONE atomic
   *  versioned batch (undoable; layers removed since the save are skipped
   *  honestly and reported). */
  private cmdLayerStateRestore(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string") {
      return err("bad_payload", "layerState.restore requires a name string", true);
    }
    const state = this.doc.layerStateByName(p.name);
    if (state === undefined) {
      return err("bad_state", `layerState.restore: no layer state '${p.name}'`, false);
    }
    try {
      const edits = layerStateRestoreEdits(state, this.doc.layerTable);
      const restored = edits.length;
      if (edits.length === 0) {
        return ok({ restored: 0, skipped: state.layers.length, snapshot: this.doc.snapshot() });
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ restored, skipped: state.layers.length - restored, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** layerState.remove — delete a saved layer state. */
  private cmdLayerStateRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string") {
      return err("bad_payload", "layerState.remove requires a name string", true);
    }
    if (this.doc.layerStateByName(p.name) === undefined) {
      return err("bad_state", `layerState.remove: no layer state '${p.name}'`, false);
    }
    try {
      this.doc.execute({ type: "removeLayerState", stateName: p.name });
      return ok({ removed: p.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** ltype.create — a user-defined linetype (dash/gap pattern in mm). */
  private cmdLtypeCreate(payload: unknown): CommandQueryResponse {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.length === 0) {
      return err("bad_payload", "ltype.create requires a non-empty name", true);
    }
    try {
      const record: LtypeRecord = {
        name: p.name,
        description: typeof p.description === "string" ? p.description : "",
        pattern: Array.isArray(p.pattern) ? (p.pattern as number[]) : [],
      };
      this.doc.execute({ type: "addLtype", ltype: record });
      return ok({ name: record.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** ltype.update — patch a user-defined linetype (name immutable). */
  private cmdLtypeUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "ltype.update requires name + patch", true);
    }
    try {
      this.doc.execute({ type: "updateLtype", ltypeName: p.name, patch: p.patch as Record<string, unknown> });
      return ok({ snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** ltype.remove — delete a user-defined linetype (reference-checked:
   *  layers/entities using it block removal — no silent cascade). */
  private cmdLtypeRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string") {
      return err("bad_payload", "ltype.remove requires a name string", true);
    }
    try {
      this.doc.execute({ type: "removeLtype", ltypeName: p.name });
      return ok({ removed: p.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** textStyle.create — a user-defined text style. */
  private cmdTextStyleCreate(payload: unknown): CommandQueryResponse {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.length === 0) {
      return err("bad_payload", "textStyle.create requires a non-empty name", true);
    }
    try {
      const record: TextStyleRecord = {
        name: p.name,
        font: p.font === "mono" || p.font === "serif" ? p.font : "sans",
        height: typeof p.height === "number" ? p.height : 0,
        widthFactor: typeof p.widthFactor === "number" ? p.widthFactor : 1,
        obliqueAngle: typeof p.obliqueAngle === "number" ? p.obliqueAngle : 0,
      };
      this.doc.execute({ type: "addTextStyle", style: record });
      return ok({ name: record.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** textStyle.update — patch a user-defined text style (name immutable). */
  private cmdTextStyleUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "textStyle.update requires name + patch", true);
    }
    try {
      this.doc.execute({ type: "updateTextStyle", styleName: p.name, patch: p.patch as Record<string, unknown> });
      return ok({ snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** textStyle.remove — delete a user-defined text style (the current style
   *  blocks removal). */
  private cmdTextStyleRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string") {
      return err("bad_payload", "textStyle.remove requires a name string", true);
    }
    try {
      this.doc.execute({ type: "removeTextStyle", styleName: p.name });
      return ok({ removed: p.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** dimStyle.create — a user-defined dimension style. */
  private cmdDimStyleCreate(payload: unknown): CommandQueryResponse {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.length === 0) {
      return err("bad_payload", "dimStyle.create requires a non-empty name", true);
    }
    try {
      const record: DimStyleRecord = {
        name: p.name,
        textHeight: typeof p.textHeight === "number" ? p.textHeight : 2.5,
        arrowSize: typeof p.arrowSize === "number" ? p.arrowSize : 2.5,
        scale: typeof p.scale === "number" ? p.scale : 1,
        precision: typeof p.precision === "number" ? p.precision : 0,
      };
      // CAD-PARITY-005 (additive + optional): the rendered arrowhead kind
      // and the measurement unit suffix.
      const withOptional: DimStyleRecord = {
        ...record,
        ...(p.arrowStyle === "closed" || p.arrowStyle === "tick" || p.arrowStyle === "none" ? { arrowStyle: p.arrowStyle } : {}),
        ...(typeof p.unitSuffix === "string" && p.unitSuffix.length > 0 && p.unitSuffix.length <= 16 ? { unitSuffix: p.unitSuffix } : {}),
      };
      this.doc.execute({ type: "addDimStyle", style: withOptional });
      return ok({ name: withOptional.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** dimStyle.update — patch a user-defined dimension style (name immutable). */
  private cmdDimStyleUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "dimStyle.update requires name + patch", true);
    }
    try {
      this.doc.execute({ type: "updateDimStyle", styleName: p.name, patch: p.patch as Record<string, unknown> });
      return ok({ snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** dimStyle.remove — delete a user-defined dimension style (the current
   *  style + referencing dims block removal). */
  private cmdDimStyleRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string") {
      return err("bad_payload", "dimStyle.remove requires a name string", true);
    }
    try {
      this.doc.execute({ type: "removeDimStyle", styleName: p.name });
      return ok({ removed: p.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  // ---------------------------------------------------------------------
  // CAD-PARITY-006: blocks, attributes & external-reference commands.
  // ---------------------------------------------------------------------

  /** The fixed deterministic timestamp for record provenance (mirrors the
   *  document FIXED_NOW convention). */
  private static readonly BLOCKS_NOW = "2026-01-01T00:00:00.000Z";

  /** Resolve a block definition by name OR canonical id (typed failure). */
  private resolveBlockDef(p: { name?: unknown; blockId?: unknown }): BlockDefinitionRecord {
    if (typeof p.blockId === "string" && p.blockId.length > 0) {
      const def = this.doc.blockDefById(p.blockId);
      if (def === undefined) throw new BlockError(`no block definition '${p.blockId}'`, "bad_id");
      return def;
    }
    if (typeof p.name === "string" && p.name.length > 0) {
      const def = this.doc.blockDefByName(p.name);
      if (def === undefined) throw new BlockError(`no block definition '${p.name}'`, "bad_id");
      return def;
    }
    throw new BlockError("block name or blockId is required", "bad_input");
  }

  /** Resolve an external reference by name OR id (typed failure). */
  private resolveXref(p: { name?: unknown; xrefId?: unknown }): XrefRecord {
    if (typeof p.xrefId === "string" && p.xrefId.length > 0) {
      const rec = this.doc.xrefById(p.xrefId);
      if (rec === undefined) throw new BlockError(`no external reference '${p.xrefId}'`, "bad_id");
      return rec;
    }
    if (typeof p.name === "string" && p.name.length > 0) {
      const rec = this.doc.xrefByName(p.name);
      if (rec === undefined) throw new BlockError(`no external reference '${p.name}'`, "bad_id");
      return rec;
    }
    throw new BlockError("reference name or xrefId is required", "bad_input");
  }

  /** Convert ONE document element into canonical inline block content
   *  (the BLOCK conversion + the xref content resolver share this). Returns
   *  null when the element is outside the convertible vocabulary — the
   *  caller reports the skip honestly. */
  private elementToBlockEntity(el: Element): Record<string, unknown> | null {
    const props = el.props as Record<string, unknown>;
    if (props.drafting === true) {
      if (props.type === "block-ref") {
        // A nested reference: keep the placement + attribute values, drop
        // the element identity (the definition reference stays canonical).
        const ref = blockRefFromElement(el);
        if (ref === null) return null;
        const out: Record<string, unknown> = {
          type: "block-ref",
          layer: ref.layer,
          blockId: ref.blockId,
          x: ref.x,
          y: ref.y,
          scale: ref.scale,
          rotation: ref.rotation,
        };
        if (ref.attributes !== undefined) out.attributes = ref.attributes.map((a) => ({ tag: a.tag, value: a.value }));
        return out;
      }
      if (props.type === "text") {
        const text = annotationFromElement(el);
        if (text !== null && text.type === "text") {
          const out: Record<string, unknown> = {
            type: "text",
            layer: text.layer,
            x: text.x,
            y: text.y,
            height: text.height,
            rotation: text.rotation,
            value: text.value,
          };
          if (text.style !== undefined) out.style = text.style;
          if (text.hAlign !== undefined) out.hAlign = text.hAlign;
          if (text.vAlign !== undefined) out.vAlign = text.vAlign;
          return out;
        }
        return null;
      }
      // Drafting geometry (BOTH storage conventions — the canonical view;
      // rectangles materialize as the closed polyline they are).
      const geom = geomFromElement(el);
      if (geom === null) return null;
      const layer = typeof props.layer === "string" && props.layer.length > 0 ? props.layer : "0";
      const out: Record<string, unknown> = { ...(geom as unknown as Record<string, unknown>), layer };
      for (const key of ["color", "linetype", "lineweight", "transparency"] as const) {
        if (props[key] !== undefined) out[key] = props[key];
      }
      return out;
    }
    // Canonical annotation text elements.
    if (el.kind === "annotation" && props.annotation === true && props.type === "text") {
      const text = annotationFromElement(el);
      if (text !== null && text.type === "text") {
        const out: Record<string, unknown> = {
          type: "text",
          layer: text.layer,
          x: text.x,
          y: text.y,
          height: text.height,
          rotation: text.rotation,
          value: text.value,
        };
        if (text.style !== undefined) out.style = text.style;
        if (text.hAlign !== undefined) out.hAlign = text.hAlign;
        if (text.vAlign !== undefined) out.vAlign = text.vAlign;
        return out;
      }
    }
    return null;
  }

  /** block.create — convert the source elements into a reusable definition
   *  and REMOVE them, all in ONE atomic revision (undo restores both). */
  private cmdBlockCreate(payload: unknown): CommandQueryResponse {
    const p = payload as {
      name?: unknown;
      basePoint?: unknown;
      fromElementIds?: unknown;
      entities?: unknown;
      description?: unknown;
    } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.length === 0) {
      return err("bad_payload", "block.create requires a non-empty name", true);
    }
    const bp = p.basePoint as { x?: unknown; y?: unknown } | undefined;
    if (
      typeof bp !== "object" || bp === null ||
      typeof bp.x !== "number" || !Number.isFinite(bp.x) ||
      typeof bp.y !== "number" || !Number.isFinite(bp.y)
    ) {
      return err("bad_payload", "block.create requires basePoint {x, y}", true);
    }
    try {
      let entities: Record<string, unknown>[];
      let sourceIds: string[] = [];
      if (Array.isArray(p.entities)) {
        entities = normalizeBlockEntities(p.entities);
      } else if (Array.isArray(p.fromElementIds) && p.fromElementIds.length > 0) {
        const converted: Record<string, unknown>[] = [];
        for (const id of p.fromElementIds) {
          if (typeof id !== "string") {
            throw new BlockError("fromElementIds must be element id strings", "bad_input");
          }
          const el = this.doc.elementById(id);
          if (el === undefined) {
            throw new BlockError(`source element '${id}' does not exist`, "bad_id");
          }
          const inline = this.elementToBlockEntity(el);
          if (inline === null) {
            throw new BlockError(
              `source element '${id}' is not convertible block content (2D geometry, text or block instances; dimensions/leaders/BIM are excluded)`,
              "bad_entity",
            );
          }
          converted.push(inline);
        }
        entities = converted;
        sourceIds = p.fromElementIds as string[];
      } else {
        return err("bad_payload", "block.create requires fromElementIds (or an entities array)", true);
      }
      const record: BlockDefinitionRecord = {
        id: "",
        name: p.name,
        basePoint: { x: bp.x, y: bp.y },
        entities,
        createdAt: AppApiHandler.BLOCKS_NOW,
        ...(typeof p.description === "string" && p.description.length > 0 ? { description: p.description } : {}),
      };
      const edits: DocumentEdit[] = [{ type: "addBlockDef", block: record }];
      for (const id of sourceIds) edits.push({ type: "removeElement", elementId: id });
      this.doc.execute({ type: "applyEdits", edits });
      const created = this.doc.blockDefByName(p.name);
      return ok({
        blockId: created?.id ?? null,
        name: p.name,
        entityCount: entities.length,
        removedSources: sourceIds.length,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("block_invalid", (e as Error).message, false);
    }
  }

  /** block.insert — place a block instance (uniform scale + rotation +
   *  attribute values validated against the definition slots). */
  private cmdBlockInsert(payload: unknown): CommandQueryResponse {
    const p = payload as {
      name?: unknown;
      blockId?: unknown;
      x?: unknown;
      y?: unknown;
      scale?: unknown;
      rotation?: unknown;
      layer?: unknown;
      attributes?: unknown;
    } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "block.insert requires a payload object", true);
    }
    if (typeof p.x !== "number" || !Number.isFinite(p.x) || typeof p.y !== "number" || !Number.isFinite(p.y)) {
      return err("bad_payload", "block.insert requires x/y finite numbers", true);
    }
    // LOCK-007: a supplied scale must be a positive finite number — never
    // silently coerced (non-uniform/negative scales are unsupported).
    if (p.scale !== undefined && !(typeof p.scale === "number" && Number.isFinite(p.scale) && p.scale > 0)) {
      return err("bad_payload", "block.insert scale must be a positive finite number (non-uniform scaling is unsupported)", true);
    }
    if (p.rotation !== undefined && !(typeof p.rotation === "number" && Number.isFinite(p.rotation))) {
      return err("bad_payload", "block.insert rotation must be a finite number", true);
    }
    try {
      const def = this.resolveBlockDef(p);
      const scale = typeof p.scale === "number" && p.scale > 0 ? p.scale : 1;
      const rotation = typeof p.rotation === "number" && Number.isFinite(p.rotation) ? p.rotation : 0;
      const layer = typeof p.layer === "string" && p.layer.length > 0 ? p.layer : "0";
      if (!this.doc.layerTable.some((l) => l.id === layer)) {
        throw new BlockError(`layer '${layer}' does not exist`, "bad_layer");
      }
      const slots = attdefTagsOf(def.entities);
      const attributes: { tag: string; value: string }[] = [];
      if (Array.isArray(p.attributes)) {
        const seen = new Set<string>();
        for (const raw of p.attributes) {
          if (typeof raw !== "object" || raw === null) {
            throw new BlockError("attributes entries must be {tag, value}", "bad_input");
          }
          const a = raw as Record<string, unknown>;
          const tag = typeof a.tag === "string" ? a.tag.toUpperCase() : "";
          if (tag.length === 0) throw new BlockError("attribute tag must be a non-empty string", "bad_input");
          if (seen.has(tag)) throw new BlockError(`attribute tag '${tag}' is duplicated`, "bad_input");
          seen.add(tag);
          if (!slots.includes(tag)) {
            throw new BlockError(
              `attribute tag '${tag}' is not a slot of block '${def.name}'${slots.length > 0 ? ` — slots: ${slots.join(", ")}` : " (the definition has no attribute definitions)"}`,
              "bad_attribute",
            );
          }
          if (typeof a.value !== "string") throw new BlockError(`attribute '${tag}' value must be a string`, "bad_input");
          if (a.value.length > 0) attributes.push({ tag, value: a.value });
        }
      }
      const elementId = this.doc.mintElementId();
      const ref = makeBlockRef({
        layer,
        blockId: def.id,
        x: p.x,
        y: p.y,
        scale,
        rotation,
        ...(attributes.length > 0 ? { attributes } : {}),
      });
      this.doc.execute({
        type: "addElement",
        element: { id: elementId, kind: "geometry", engineId: null, props: blockRefToProps(ref) },
      });
      return ok({
        elementId,
        blockId: def.id,
        name: def.name,
        attributes: attributes.length,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("block_invalid", (e as Error).message, false);
    }
  }

  /** block.update — patch a definition (name/basePoint/description/
   *  entities/materialId); instances propagate through the shared expansion.
   *  CAD-PARITY-012: materialId must reference an EXISTING bim.material
   *  element or be null (clear) — validated here, where the element world is
   *  visible (typed failure, never a silent dangling reference). */
  private cmdBlockUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; blockId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "block.update requires name|blockId + patch", true);
    }
    const patch = p.patch as Record<string, unknown>;
    if (patch.materialId !== undefined && patch.materialId !== null) {
      if (typeof patch.materialId !== "string" || patch.materialId.length === 0) {
        return err("bad_payload", "block.update materialId must be a material element id or null (clear)", true);
      }
      const mat = this.doc.elementById(patch.materialId);
      if (mat === undefined || (mat.props as Record<string, unknown>).type !== "bim.material") {
        return err(
          "material_not_found",
          `material '${patch.materialId}' does not exist — block definitions may reference bim.material elements only`,
          false,
        );
      }
    }
    try {
      const def = this.resolveBlockDef(p);
      this.doc.execute({ type: "updateBlockDef", blockId: def.id, patch });
      return ok({ blockId: def.id, snapshot: this.doc.snapshot() });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("block_invalid", (e as Error).message, false);
    }
  }

  /** block.remove — delete a definition (reference-checked: instances and
   *  other definitions' content block removal — no silent cascade). */
  private cmdBlockRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; blockId?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "block.remove requires name or blockId", true);
    }
    try {
      const def = this.resolveBlockDef(p);
      this.doc.execute({ type: "removeBlockDef", blockId: def.id });
      return ok({ removed: def.id, name: def.name, snapshot: this.doc.snapshot() });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("block_invalid", (e as Error).message, false);
    }
  }

  /** attribute.update — rewrite ONE per-instance attribute value (value
   *  null/empty clears the stored value → the definition default renders). */
  private cmdAttributeUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; tag?: unknown; value?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      typeof p.id !== "string" || p.id.length === 0 ||
      typeof p.tag !== "string" || p.tag.length === 0
    ) {
      return err("bad_payload", "attribute.update requires id + tag (value: string | null)", true);
    }
    try {
      const el = this.doc.elementById(p.id);
      if (el === undefined) throw new BlockError(`element '${p.id}' does not exist`, "bad_id");
      const ref = blockRefFromElement(el);
      if (ref === null) throw new BlockError(`element '${p.id}' is not a block instance`, "bad_entity");
      const def = this.doc.blockDefById(ref.blockId);
      if (def === undefined) throw new BlockError(`block definition '${ref.blockId}' no longer exists`, "bad_id");
      const tag = p.tag.toUpperCase();
      const slots = attdefTagsOf(def.entities);
      if (!slots.includes(tag)) {
        throw new BlockError(
          `attribute tag '${tag}' is not a slot of block '${def.name}'${slots.length > 0 ? ` — slots: ${slots.join(", ")}` : " (the definition has no attribute definitions)"}`,
          "bad_attribute",
        );
      }
      const clear = p.value === null || p.value === undefined || (typeof p.value === "string" && p.value.length === 0);
      if (!clear && typeof p.value !== "string") {
        throw new BlockError("attribute value must be a string (or null to clear)", "bad_input");
      }
      const kept = (ref.attributes ?? []).filter((a) => a.tag !== tag);
      const nextAttributes = clear ? kept : [...kept, { tag, value: p.value as string }];
      // Strip-then-reattach: the spread of `ref` would otherwise carry the
      // OLD attributes array when the new one is empty (an emptied value
      // list must leave NO key — the canonical-minimal record form).
      const { attributes: _stale, ...rest } = ref;
      void _stale;
      const props: Record<string, unknown> = blockRefToProps(
        nextAttributes.length > 0 ? { ...rest, attributes: nextAttributes } : rest,
      );
      // Full-record setProps: a cleared value must REMOVE the key (the
      // updateElement merge could not represent absence).
      this.doc.execute({ type: "setProps", elementId: el.id, patch: props });
      return ok({ id: el.id, tag, value: clear ? null : (p.value as string), snapshot: this.doc.snapshot() });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("block_invalid", (e as Error).message, false);
    }
  }

  /** Resolve external content into inline entities + the provenance hash.
   *  CAD-PARITY-006 bounded slice: the payload carries the external snapshot
   *  object (the ifc.import payload precedent — hosts with file dialogs
   *  supply it; geometry + text convert, other elements are SKIPPED and
   *  reported honestly). */
  private resolveXrefContent(content: unknown): { entities: Record<string, unknown>[]; skipped: number; sourceHash: string } {
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      throw new BlockError("content must be the external document snapshot object", "bad_input");
    }
    const snapshot = content as { elements?: unknown };
    if (!Array.isArray(snapshot.elements)) {
      throw new BlockError("content.elements must be an array (an offisos snapshot)", "bad_input");
    }
    const entities: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const raw of snapshot.elements) {
      if (typeof raw !== "object" || raw === null) {
        skipped++;
        continue;
      }
      const inline = this.elementToBlockEntity(raw as Element);
      if (inline === null) {
        skipped++;
        continue;
      }
      entities.push(inline);
    }
    const sourceHash = createHash("sha256").update(canonicalStringify(content)).digest("hex");
    return { entities, skipped, sourceHash };
  }

  /** xref.attach — attach an external reference. With content: loaded
   *  (inline entities + provenance hash + placement instance in ONE atomic
   *  revision). Without: unresolved (the placeholder rendering — the command
   *  line cannot read files; the References palette supplies content). */
  private cmdXrefAttach(payload: unknown): CommandQueryResponse {
    const p = payload as {
      name?: unknown;
      path?: unknown;
      x?: unknown;
      y?: unknown;
      scale?: unknown;
      rotation?: unknown;
      layer?: unknown;
      content?: unknown;
    } | null;
    if (
      p === null || typeof p !== "object" ||
      typeof p.name !== "string" || p.name.length === 0 ||
      typeof p.path !== "string" || p.path.length === 0
    ) {
      return err("bad_payload", "xref.attach requires a non-empty name + path", true);
    }
    try {
      let entities: Record<string, unknown>[] = [];
      let skipped = 0;
      let sourceHash: string | null = null;
      if (p.content !== undefined && p.content !== null) {
        const resolved = this.resolveXrefContent(p.content);
        entities = resolved.entities;
        skipped = resolved.skipped;
        sourceHash = resolved.sourceHash;
      }
      // Mint the record identity UP FRONT so the instance element inside
      // the SAME atomic batch references the final id (one revision; a
      // failed execute burns the minted id — never reused, the mint
      // contract).
      const xrefId = this.doc.mintXrefId();
      const record: XrefRecord = {
        id: xrefId,
        name: p.name,
        path: p.path,
        status: sourceHash !== null ? "loaded" : "unresolved",
        sourceHash,
        attachedAt: AppApiHandler.BLOCKS_NOW,
        entities,
      };
      const edits: DocumentEdit[] = [{ type: "addXref", xref: record }];
      let elementId: string | null = null;
      if (typeof p.x === "number" && Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y)) {
        if (p.scale !== undefined && !(typeof p.scale === "number" && Number.isFinite(p.scale) && p.scale > 0)) {
          throw new BlockError("scale must be a positive finite number (non-uniform scaling is unsupported)", "bad_input");
        }
        if (p.rotation !== undefined && !(typeof p.rotation === "number" && Number.isFinite(p.rotation))) {
          throw new BlockError("rotation must be a finite number", "bad_input");
        }
        const scale = typeof p.scale === "number" ? p.scale : 1;
        const rotation = typeof p.rotation === "number" ? p.rotation : 0;
        const layer = typeof p.layer === "string" && p.layer.length > 0 ? p.layer : "0";
        if (!this.doc.layerTable.some((l) => l.id === layer)) {
          throw new BlockError(`layer '${layer}' does not exist`, "bad_layer");
        }
        elementId = this.doc.mintElementId();
        edits.push({
          type: "addElement",
          element: {
            id: elementId,
            kind: "geometry",
            engineId: null,
            props: { drafting: true, type: "xref-ref", layer, xrefId, x: p.x, y: p.y, scale, rotation },
          },
        });
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({
        xrefId,
        name: record.name,
        status: record.status,
        sourceHash: record.sourceHash,
        resolved: entities.length,
        skipped,
        elementId,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("xref_invalid", (e as Error).message, false);
    }
  }

  /** xref.detach — remove the record AND its instances as ONE atomic batch
   *  (the explicit detach cascade — the removeXref edit alone is
   *  reference-checked, so the cascade is always explicit). */
  private cmdXrefDetach(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; xrefId?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "xref.detach requires name or xrefId", true);
    }
    try {
      const record = this.resolveXref(p);
      const instanceIds = this.doc
        .allElements()
        .filter((el) => {
          const props = el.props as Record<string, unknown>;
          return props.drafting === true && props.type === "xref-ref" && props.xrefId === record.id;
        })
        .map((el) => el.id);
      const edits: DocumentEdit[] = instanceIds.map((id) => ({ type: "removeElement", elementId: id }) as DocumentEdit);
      edits.push({ type: "removeXref", xrefId: record.id });
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ detached: record.name, removedInstances: instanceIds.length, snapshot: this.doc.snapshot() });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("xref_invalid", (e as Error).message, false);
    }
  }

  /** xref.reload — re-resolve an attached reference with FRESH content
   *  (required in the payload: the host re-reads the external file — the
   *  command line cannot; the References palette drives this path). */
  private cmdXrefReload(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; xrefId?: unknown; content?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "xref.reload requires name|xrefId + content (the re-read snapshot)", true);
    }
    if (p.content === undefined || p.content === null) {
      return err(
        "bad_payload",
        "xref.reload requires the external content (re-read through the References palette — the command line cannot read files)",
        true,
      );
    }
    try {
      const record = this.resolveXref(p);
      const resolved = this.resolveXrefContent(p.content);
      this.doc.execute({
        type: "updateXref",
        xrefId: record.id,
        patch: { status: "loaded", sourceHash: resolved.sourceHash, entities: resolved.entities },
      });
      return ok({
        xrefId: record.id,
        name: record.name,
        status: "loaded",
        sourceHash: resolved.sourceHash,
        resolved: resolved.entities.length,
        skipped: resolved.skipped,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof BlockError) return err(e.code, e.message, false);
      return err("xref_invalid", (e as Error).message, false);
    }
  }

  /** blocks.list (query) — the definition inventory with instance counts
   *  and attribute tags (the BLOCKLIST surface). */
  private qBlocksList(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const out = this.doc.blockDefTable.map((def) => {
      let instances = 0;
      for (const el of elements) {
        const props = el.props as Record<string, unknown>;
        if (props.drafting === true && props.type === "block-ref" && props.blockId === def.id) instances++;
      }
      return {
        id: def.id,
        name: def.name,
        entityCount: def.entities.length,
        instances,
        attributeTags: attdefTagsOf(def.entities),
        ...(def.description !== undefined ? { description: def.description } : {}),
      };
    });
    return ok({ blocks: out });
  }

  /** xrefs.list (query) — the reference inventory with statuses, instance
   *  counts and provenance hashes (the XLIST / status-diagnostics surface). */
  private qXrefsList(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const out = this.doc.xrefTable.map((rec) => {
      let instances = 0;
      for (const el of elements) {
        const props = el.props as Record<string, unknown>;
        if (props.drafting === true && props.type === "xref-ref" && props.xrefId === rec.id) instances++;
      }
      return {
        id: rec.id,
        name: rec.name,
        path: rec.path,
        status: rec.status,
        sourceHash: rec.sourceHash,
        entityCount: rec.entities.length,
        instances,
      };
    });
    return ok({ xrefs: out });
  }

  // --- CAD-PARITY-007 (additive): parametric constraints -------------------

  /** The fixed deterministic constraint provenance timestamp (the
   *  BLOCKS_NOW convention). */
  private static readonly CONSTRAINTS_NOW = "2026-01-01T00:00:00.000Z";

  /** constraint.create — declare ONE constraint and APPLY it through the
   *  shared deterministic solver: the closed-form geometry adjustment +
   *  propagation patches + the associative-annotation cascade travel as
   *  element edits in the SAME atomic revision (one undo entry). The
   *  structural over-constraint gate rejects a create whose component DoF
   *  drops below zero (the AutoCAD-class redundant-constraint rejection —
   *  typed, naming the conflict). */
  private cmdConstraintCreate(payload: unknown): CommandQueryResponse {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "constraint.create requires a payload object", true);
    }
    try {
      // Mint the canonical identity UP FRONT (the solve needs the id for
      // deterministic ordering; a minted-but-unused identity is burned,
      // never reused — the mintElementId precedent).
      const id = this.doc.mintConstraintId();
      const record = makeConstraint({
        ...(p as Record<string, unknown>),
        id,
        createdAt: AppApiHandler.CONSTRAINTS_NOW,
      });
      const elementById = (elementId: string) => this.doc.elementById(elementId);
      validateConstraintTargets(record, elementById);
      const existing = this.doc.constraintTable;
      // The structural over-constraint gate: the hypothetical post-create
      // graph must not push any component's declared DoF below zero.
      const graph = [...existing, record];
      const preflight = diagnoseConstraints(this.doc.allElements(), graph);
      const targetIds = new Set(record.targets.map((t) => t.id));
      const conflicts = preflight.dof.filter(
        (c) => c.dof < 0 && c.entities.some((id) => targetIds.has(id)),
      );
      if (conflicts.length > 0) {
        const c = conflicts[0]!;
        return err(
          "over_constrained",
          `constraint '${record.kind}' over-constrains the component of '${c.entities[0]}' (declared DoF ${c.dof}) — remove a constraint first (the redundant set: ${c.constraints.join(", ")})`,
          false,
        );
      }
      // The deterministic apply: seed the targets' component from the new
      // constraint and propagate.
      const result = solveConstraints(this.doc.allElements(), graph, {
        seedIds: [...targetIds],
      });
      const edits: DocumentEdit[] = [
        { type: "addConstraint", constraint: record },
        ...solveGeometryEdits(this.doc.allElements(), result),
      ];
      // The associative-annotation cascade (dimensions re-measure against
      // the constraint-settled world — CAD-PARITY-005 composition).
      const batch: DocumentEdit = { type: "applyEdits", edits };
      const changedIds = new Set<string>();
      constraintsCollectEditedIds(batch, changedIds);
      if (changedIds.size > 0) {
        const annotations = annotationViewsOf(this.doc.allElements());
        const dependent = annotationsReferencing(annotations, changedIds);
        if (dependent.length > 0) {
          const worldAfter = constraintsApplyEditsInMemory(this.doc.allElements(), batch);
          const cascade = remeasureCascade(dependent, worldAfter);
          if (cascade.edits.length > 0) edits.push(...cascade.edits);
        }
      }
      const finalBatch: DocumentEdit = edits.length === 1 ? edits[0]! : { type: "applyEdits", edits };
      this.doc.execute(finalBatch);
      const adjusted = result.geometry.size;
      return ok({
        constraintId: id,
        kind: record.kind,
        outcome: result.outcome,
        dof: result.dof,
        summary:
          `${CONSTRAINT_LABEL[record.kind]} constraint ${id} applied — solve outcome: ${result.outcome}` +
          (adjusted > 0 ? ` (${adjusted} ${adjusted === 1 ? "entity" : "entities"} adjusted)` : ""),
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof ConstraintError) return err(e.code, e.message, false);
      return err("constraint_invalid", (e as Error).message, false);
    }
  }

  /** constraint.update — re-declare a dimensional value (or tangency mode)
   *  and RE-SOLVE: the propagation patches + the annotation cascade travel
   *  in the SAME atomic revision. */
  private cmdConstraintUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "constraint.update requires an id string", true);
    }
    if (typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "constraint.update requires a patch object", true);
    }
    try {
      const current = this.doc.constraintById(p.id);
      if (current === undefined) {
        return err("bad_id", `constraint '${p.id}' does not exist`, false);
      }
      const updated = applyConstraintPatch(current, p.patch as Record<string, unknown>);
      const graph = this.doc.constraintTable.map((c) => (c.id === p.id ? updated : c));
      const seedIds = updated.targets.map((t) => t.id);
      const result = solveConstraints(this.doc.allElements(), graph, { seedIds });
      const edits: DocumentEdit[] = [
        { type: "updateConstraint", constraintId: p.id, patch: p.patch as Record<string, unknown> },
        ...solveGeometryEdits(this.doc.allElements(), result),
      ];
      const batch: DocumentEdit = { type: "applyEdits", edits };
      const changedIds = new Set<string>();
      constraintsCollectEditedIds(batch, changedIds);
      if (changedIds.size > 0) {
        const annotations = annotationViewsOf(this.doc.allElements());
        const dependent = annotationsReferencing(annotations, changedIds);
        if (dependent.length > 0) {
          const worldAfter = constraintsApplyEditsInMemory(this.doc.allElements(), batch);
          const cascade = remeasureCascade(dependent, worldAfter);
          if (cascade.edits.length > 0) edits.push(...cascade.edits);
        }
      }
      const finalBatch: DocumentEdit = edits.length === 1 ? edits[0]! : { type: "applyEdits", edits };
      this.doc.execute(finalBatch);
      const adjusted = result.geometry.size;
      return ok({
        constraintId: p.id,
        kind: updated.kind,
        value: updated.value ?? null,
        outcome: result.outcome,
        dof: result.dof,
        summary:
          `constraint '${p.id}' updated — solve outcome: ${result.outcome}` +
          (adjusted > 0 ? ` (${adjusted} ${adjusted === 1 ? "entity" : "entities"} adjusted)` : ""),
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof ConstraintError) return err(e.code, e.message, false);
      return err("constraint_invalid", (e as Error).message, false);
    }
  }

  /** constraint.remove — delete the declared record (the geometry stays at
   *  its current solved state; no re-solve is triggered — AutoCAD-class
   *  behavior). */
  private cmdConstraintRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "constraint.remove requires an id string", true);
    }
    if (this.doc.constraintById(p.id) === undefined) {
      return err("bad_id", `constraint '${p.id}' does not exist`, false);
    }
    this.doc.execute({ type: "removeConstraint", constraintId: p.id });
    return ok({
      constraintId: p.id,
      removed: true,
      snapshot: this.doc.snapshot(),
    });
  }

  /** constraint.solve — re-run the deterministic solve over the WHOLE
   *  declared graph (the explicit diagnostics surface; geometry patches +
   *  the annotation cascade in ONE atomic revision when anything moves). */
  private cmdConstraintSolve(payload: unknown): CommandQueryResponse {
    void payload;
    const constraints = this.doc.constraintTable;
    if (constraints.length === 0) {
      return ok({
        outcome: "solved",
        statuses: [],
        dof: [],
        summary: "no constraints declared (the graph is empty)",
        snapshot: this.doc.snapshot(),
      });
    }
    try {
      const result = solveConstraints(this.doc.allElements(), constraints, {});
      const edits: DocumentEdit[] = [...solveGeometryEdits(this.doc.allElements(), result)];
      if (edits.length > 0) {
        const batch: DocumentEdit = { type: "applyEdits", edits };
        const changedIds = new Set<string>();
        constraintsCollectEditedIds(batch, changedIds);
        if (changedIds.size > 0) {
          const annotations = annotationViewsOf(this.doc.allElements());
          const dependent = annotationsReferencing(annotations, changedIds);
          if (dependent.length > 0) {
            const worldAfter = constraintsApplyEditsInMemory(this.doc.allElements(), batch);
            const cascade = remeasureCascade(dependent, worldAfter);
            if (cascade.edits.length > 0) edits.push(...cascade.edits);
          }
        }
        this.doc.execute({ type: "applyEdits", edits });
      }
      const violated = result.statuses.filter((s) => !s.satisfied).length;
      return ok({
        outcome: result.outcome,
        statuses: result.statuses,
        dof: result.dof,
        summary:
          `constraint solve: ${result.outcome} — ${result.statuses.length - violated}/${result.statuses.length} satisfied` +
          (result.geometry.size > 0
            ? `, ${result.geometry.size} ${result.geometry.size === 1 ? "entity" : "entities"} adjusted`
            : ""),
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("constraint_invalid", (e as Error).message, false);
    }
  }

  /** constraints.list (query) — the declared graph inventory with the
   *  computed per-constraint status (diagnose — never persisted stale). */
  private qConstraintsList(): CommandQueryResponse {
    const constraints = this.doc.constraintTable;
    const diagnostics = diagnoseConstraints(this.doc.allElements(), constraints);
    const statusById = new Map(diagnostics.statuses.map((s) => [s.id, s]));
    const out = constraints.map((c) => {
      const status = statusById.get(c.id);
      return {
        id: c.id,
        kind: c.kind,
        label: CONSTRAINT_LABEL[c.kind],
        targets: c.targets,
        ...(c.value !== undefined ? { value: c.value } : {}),
        ...(c.mode !== undefined ? { mode: c.mode } : {}),
        satisfied: status?.satisfied ?? false,
        note: status?.note ?? null,
      };
    });
    return ok({ constraints: out, outcome: diagnostics.outcome, dof: diagnostics.dof });
  }

  /** constraints.diagnostics (query) — the full on-demand solver report:
   *  the typed outcome, the per-constraint verification statuses and the
   *  per-component degrees-of-freedom accounting (verify-only — no
   *  propagation, no mutation). */
  private qConstraintsDiagnostics(): CommandQueryResponse {
    const constraints = this.doc.constraintTable;
    if (constraints.length === 0) {
      return ok({ outcome: "solved", statuses: [], dof: [], notes: [] });
    }
    const result = diagnoseConstraints(this.doc.allElements(), constraints);
    return ok(result);
  }

  // --- CAD-PARITY-008 (additive): layouts, viewports, plot --------------------

  private static readonly LAYOUTS_NOW = "2026-01-01T00:00:00.000Z";

  /** Resolve a layout reference (id wins; name is the user-facing address;
   *  when NEITHER is given, the ACTIVE layout — the default target of every
   *  layout/plot command). Typed bad_id error when nothing resolves. */
  private resolveLayoutRef(p: { id?: unknown; name?: unknown }): LayoutRecord | ErrResult {
    const layouts = this.doc.layoutTable;
    if (typeof p.id === "string" && p.id.length > 0) {
      const layout = this.doc.layoutById(p.id);
      if (layout === undefined) return err("bad_id", `layout '${p.id}' does not exist`, false);
      return layout;
    }
    if (typeof p.name === "string" && p.name.length > 0) {
      const layout = this.doc.layoutByName(p.name);
      if (layout === undefined) return err("bad_id", `layout '${p.name}' does not exist`, false);
      return layout;
    }
    const activeId = this.doc.draftingSettings.activeLayout;
    const active = activeId !== undefined ? this.doc.layoutById(activeId) : undefined;
    const layout = active ?? layouts[0];
    if (layout === undefined) {
      return err("bad_id", "no layout exists yet — create one with layout.create (LAYOUTNEW)", false);
    }
    return layout;
  }

  /** The Plot IR input assembled from the CURRENT document state (the SAME
   *  pure inputs both hosts pass — parity by construction). CAD-PARITY-013
   *  (Issue #104): the layout table + the title-block/navigator/revision
   *  tables flow in as additive inputs (master composition, placed
   *  title-block rendering, subset sheet numbering); layouts WITHOUT P013
   *  fields never read them, so their IR stays byte-identical. */
  private plotIRInputOf(layout: LayoutRecord): PlotIRInput {
    const settings = this.doc.draftingSettings;
    const titleBlocks = this.doc.titleBlockTable;
    const navigatorNodes = this.doc.navigatorNodeTable;
    const revisions = this.doc.revisionTable;
    return {
      layout,
      viewports: this.doc.viewportsOfLayout(layout.id),
      elements: this.doc.allElements(),
      layers: this.doc.layerTable,
      ltypes: this.doc.ltypeTable,
      textStyles: this.doc.textStyleTable,
      dimStyles: this.doc.dimStyleTable,
      ...(settings.standards !== undefined ? { standards: settings.standards } : {}),
      // CAD-PARITY-013: the full layout table (master resolution + the
      // "L"-numbering derivation) + the title-block/navigator/revision
      // tables (placement rendering; omitted-when-empty).
      layouts: this.doc.layoutTable,
      ...(titleBlocks.length > 0 ? { titleBlocks } : {}),
      ...(navigatorNodes.length > 0 ? { navigatorNodes } : {}),
      ...(revisions.length > 0 ? { revisions } : {}),
    };
  }

  /** layout.create — add ONE paper-space layout with the canonical default
   *  page setup (A3 landscape, 10 mm margins, "fit", as-displayed plot
   *  style, borders plotted). One revision = one undo entry. */
  private cmdLayoutCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0 || p.name.length > 255) {
      return err("bad_payload", "layout.create requires a name (non-empty string, max 255 chars)", true);
    }
    const name = p.name.trim();
    if (this.doc.layoutByName(name) !== undefined) {
      return err("layout_invalid", `layout name '${name}' already exists — layout names are unique`, false);
    }
    try {
      const layout: LayoutRecord = {
        id: this.doc.mintLayoutId(),
        name,
        pageSetup: DEFAULT_PAGE_SETUP,
        createdAt: AppApiHandler.LAYOUTS_NOW,
      };
      this.doc.execute({ type: "addLayout", layout });
      return ok({ layoutId: layout.id, name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  /** layout.rename — keep names unique (viewports reference the immutable
   *  id, so a rename is reference-safe by construction). */
  private cmdLayoutRename(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; newName?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.newName !== "string" || p.newName.trim().length === 0 || p.newName.length > 255) {
      return err("bad_payload", "layout.rename requires newName (non-empty string, max 255 chars)", true);
    }
    const resolved = this.resolveLayoutRef(p);
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const layout = resolved as LayoutRecord;
    const newName = (p.newName as string).trim();
    try {
      this.doc.execute({ type: "updateLayout", layoutId: layout.id, patch: { name: newName } });
      return ok({ layoutId: layout.id, name: newName, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  /** layout.clone — deep-copy the layout AND its viewports with fresh
   *  document-minted identities as ONE atomic revision (one undo entry). */
  private cmdLayoutClone(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; newName?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.newName !== "string" || p.newName.trim().length === 0 || p.newName.length > 255) {
      return err("bad_payload", "layout.clone requires newName (non-empty string, max 255 chars)", true);
    }
    const resolved = this.resolveLayoutRef(p);
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const source = resolved as LayoutRecord;
    const newName = (p.newName as string).trim();
    if (this.doc.layoutByName(newName) !== undefined) {
      return err("layout_invalid", `layout name '${newName}' already exists — layout names are unique`, false);
    }
    try {
      const clone: LayoutRecord = {
        id: this.doc.mintLayoutId(),
        name: newName,
        pageSetup: source.pageSetup,
        createdAt: AppApiHandler.LAYOUTS_NOW,
      };
      const sourceViewports = this.doc.viewportsOfLayout(source.id);
      const edits: DocumentEdit[] = [{ type: "addLayout", layout: clone }];
      const viewportIds: string[] = [];
      for (const vp of sourceViewports) {
        const vpId = this.doc.mintViewportId();
        viewportIds.push(vpId);
        edits.push({ type: "addViewport", viewport: { ...vp, id: vpId, layoutId: clone.id } });
      }
      this.doc.execute(edits.length === 1 ? edits[0]! : { type: "applyEdits", edits });
      return ok({
        layoutId: clone.id,
        name: newName,
        clonedViewports: viewportIds.length,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  /** layout.remove — the EXPLICIT cascade: the layout's viewports and the
   *  record leave as ONE atomic revision (the xref.detach precedent). The
   *  last remaining layout is rejected (the last-tab rule); a removed
   *  ACTIVE layout hands activation to the first remaining layout. */
  private cmdLayoutRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown } | null;
    const resolved = this.resolveLayoutRef(p ?? {});
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const layout = resolved as LayoutRecord;
    // The last-layout rule is a COMMAND rule (the AutoCAD last-tab rule):
    // a document that has layouts keeps at least one. (The raw document
    // edit does NOT enforce it — undo of the first layout creation must
    // replay cleanly, journal semantics.)
    if (this.doc.layoutTable.length <= 1) {
      return err("layout_last", `layout '${layout.name}' is the last remaining layout — a document that has layouts keeps at least one (the last-tab rule)`, false);
    }
    try {
      const viewports = this.doc.viewportsOfLayout(layout.id);
      const edits: DocumentEdit[] = viewports.map((v) => ({ type: "removeViewport", viewportId: v.id }) as DocumentEdit);
      edits.push({ type: "removeLayout", layoutId: layout.id });
      this.doc.execute({ type: "applyEdits", edits });
      // Hand the active-layout reference to the first remaining layout when
      // the removed one was active (non-versioned editor state).
      const settings = this.doc.draftingSettings;
      if (settings.activeLayout === layout.id) {
        const next = this.doc.layoutTable[0];
        this.doc.setDraftingSettings({
          ...settings,
          ...(next !== undefined ? { activeLayout: next.id } : {}),
          ...(next === undefined ? { space: "model" as const } : {}),
        });
      }
      return ok({ removed: layout.id, removedViewports: viewports.length, snapshot: this.doc.snapshot() });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("last remaining layout")) {
        return err("layout_last", message, false);
      }
      return err("layout_invalid", message, false);
    }
  }

  /** layout.setPageSetup — patch the embedded page setup (the merged setup
   *  re-validates as a whole through the shared grammar; a detected no-op
   *  returns unchanged WITHOUT a revision — honest idempotence). */
  private cmdLayoutSetPageSetup(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "layout.setPageSetup requires a patch object", true);
    }
    const resolved = this.resolveLayoutRef(p);
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const layout = resolved as LayoutRecord;
    const patch = p.patch as Record<string, unknown>;
    try {
      const merged = validatePageSetup({ ...layout.pageSetup, ...patch });
      const before = canonicalStringify(layout.pageSetup);
      const after = canonicalStringify(merged);
      if (before === after) {
        return ok({ layoutId: layout.id, unchanged: true, snapshot: this.doc.snapshot() });
      }
      this.doc.execute({ type: "updateLayout", layoutId: layout.id, patch: { pageSetup: merged } });
      return ok({ layoutId: layout.id, pageSetup: merged, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  /** layout.activate — the NON-VERSIONED editor context (the active tab +
   *  the paper space switch; the activeLayer precedent — persisted through
   *  save/open, no undo entry). */
  private cmdLayoutActivate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "layout.activate requires a layout id or name", true);
    }
    const resolved = this.resolveLayoutRef(p);
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const layout = resolved as LayoutRecord;
    this.doc.setDraftingSettings({ ...this.doc.draftingSettings, activeLayout: layout.id, space: "paper" });
    return ok({ activeLayoutId: layout.id, space: "paper", snapshot: this.doc.snapshot() });
  }

  /** layout.setSpace — the TILEMODE-class model/paper context switch
   *  (non-versioned editor state; MSPACE/PSPACE/TILEMODE all land here). */
  private cmdLayoutSetSpace(payload: unknown): CommandQueryResponse {
    const p = payload as { space?: unknown; id?: unknown; name?: unknown } | null;
    if (p === null || typeof p !== "object" || (p.space !== "model" && p.space !== "paper")) {
      return err("bad_payload", "layout.setSpace requires space: \"model\" | \"paper\"", true);
    }
    const space = p.space as "model" | "paper";
    let activeLayoutId = this.doc.draftingSettings.activeLayout ?? null;
    if (space === "paper") {
      const resolved = this.resolveLayoutRef(p);
      if ("ok" in resolved && resolved.ok === false) return resolved;
      activeLayoutId = (resolved as LayoutRecord).id;
    }
    this.doc.setDraftingSettings({ ...this.doc.draftingSettings, ...(activeLayoutId !== null ? { activeLayout: activeLayoutId } : {}), space });
    return ok({ space, activeLayoutId, snapshot: this.doc.snapshot() });
  }

  /** viewport.create — ONE rectangular layout viewport through the SHARED
   *  transform: fit (the deterministic model extents), window (an explicit
   *  model window) or scale (an explicit denominator + camera center). One
   *  revision = one undo entry; the document mints the `vp-NNNNNN` id. */
  private cmdViewportCreate(payload: unknown): CommandQueryResponse {
    const p = payload as {
      layoutId?: unknown;
      layoutName?: unknown;
      corner1?: unknown;
      corner2?: unknown;
      view?: unknown;
      rotationDeg?: unknown;
      locked?: unknown;
    } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "viewport.create requires a payload object", true);
    }
    // Resolve the target layout (layoutId > layoutName > active).
    let layout: LayoutRecord | undefined;
    if (typeof p.layoutId === "string" && p.layoutId.length > 0) {
      layout = this.doc.layoutById(p.layoutId);
      if (layout === undefined) return err("bad_id", `layout '${p.layoutId}' does not exist`, false);
    } else if (typeof p.layoutName === "string" && p.layoutName.length > 0) {
      layout = this.doc.layoutByName(p.layoutName);
      if (layout === undefined) return err("bad_id", `layout '${p.layoutName}' does not exist`, false);
    } else {
      const resolved = this.resolveLayoutRef({});
      if ("ok" in resolved && resolved.ok === false) return resolved;
      layout = resolved as LayoutRecord;
    }
    const corner = (v: unknown, which: string): [number, number] | null => {
      if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
      void which;
      return [v[0] as number, v[1] as number];
    };
    const c1 = corner(p.corner1, "1");
    const c2 = corner(p.corner2, "2");
    const v = p.view as { mode?: unknown; denominator?: unknown; centerX?: unknown; centerY?: unknown; x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown } | null;
    if (c1 === null || c2 === null || v === null || typeof v !== "object" || (v.mode !== "fit" && v.mode !== "scale" && v.mode !== "window")) {
      return err("bad_payload", "viewport.create requires corner1, corner2 and view {mode: fit|scale|window}", true);
    }
    try {
      const rect = viewportRect({
        id: "pending",
        layoutId: layout.id,
        corner1: c1,
        corner2: c2,
        camera: { centerX: 0, centerY: 0 },
        scaleDenominator: 1,
        rotationDeg: 0,
      });
      let camera: { centerX: number; centerY: number };
      let scaleDenominator: number;
      if (v.mode === "fit") {
        const fitted = fitViewToRect(modelExtentsOf(this.doc.allElements()), rect);
        camera = { centerX: fitted.centerX, centerY: fitted.centerY };
        scaleDenominator = fitted.scaleDenominator;
      } else if (v.mode === "window") {
        if (
          typeof v.x1 !== "number" || typeof v.y1 !== "number" || typeof v.x2 !== "number" || typeof v.y2 !== "number" ||
          !Number.isFinite(v.x1) || !Number.isFinite(v.y1) || !Number.isFinite(v.x2) || !Number.isFinite(v.y2)
        ) {
          return err("bad_payload", "viewport.create view window requires x1/y1/x2/y2 finite numbers", true);
        }
        const win = windowViewToRect(
          { x1: Math.min(v.x1, v.x2), y1: Math.min(v.y1, v.y2), x2: Math.max(v.x1, v.x2), y2: Math.max(v.y1, v.y2) },
          rect,
        );
        camera = { centerX: win.centerX, centerY: win.centerY };
        scaleDenominator = win.scaleDenominator;
      } else {
        if (typeof v.denominator !== "number" || !Number.isFinite(v.denominator) || v.denominator <= 0) {
          return err("bad_payload", "viewport.create view scale requires a positive denominator", true);
        }
        if (typeof v.centerX !== "number" || typeof v.centerY !== "number" || !Number.isFinite(v.centerX) || !Number.isFinite(v.centerY)) {
          return err("bad_payload", "viewport.create view scale requires centerX/centerY finite numbers", true);
        }
        camera = { centerX: v.centerX, centerY: v.centerY };
        scaleDenominator = v.denominator;
      }
      const rotationDeg = typeof p.rotationDeg === "number" && Number.isFinite(p.rotationDeg) ? p.rotationDeg : 0;
      const viewport: ViewportRecord = {
        id: this.doc.mintViewportId(),
        layoutId: layout.id,
        corner1: c1,
        corner2: c2,
        camera,
        scaleDenominator,
        rotationDeg,
        ...(p.locked === true ? { locked: true } : {}),
      };
      this.doc.execute({ type: "addViewport", viewport });
      return ok({
        viewportId: viewport.id,
        layoutId: layout.id,
        scaleDenominator,
        camera,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  /** viewport.update — patch scale/rotation/lock/camera/frame/layer
   *  overrides. A LOCKED view rejects camera/scale/rotation edits with the
   *  typed viewport_locked error (the frame still moves — the AutoCAD
   *  display-lock semantics); layer override ids must reference existing
   *  layers (state check). */
  private cmdViewportUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "viewport.update requires an id string", true);
    }
    if (typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "viewport.update requires a patch object", true);
    }
    const current = this.doc.viewportById(p.id);
    if (current === undefined) {
      return err("bad_id", `viewport '${p.id}' does not exist`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    // The display-lock gate: camera/scale/rotation are frozen while locked.
    if (current.locked === true) {
      const lockedKeys = ["camera", "scaleDenominator", "rotationDeg"].filter((k) => patch[k] !== undefined);
      if (lockedKeys.length > 0) {
        return err(
          "viewport_locked",
          `viewport '${p.id}' is locked — the view (camera/scale/rotation) is frozen; unlock it first (the frame still moves)`,
          false,
        );
      }
    }
    // Layer override ids must reference existing layers (state check).
    if (patch.layerOverrides !== undefined) {
      if (!Array.isArray(patch.layerOverrides)) {
        return err("bad_payload", "viewport.update layerOverrides must be an array", true);
      }
      for (const raw of patch.layerOverrides) {
        const o = raw as { layerId?: unknown };
        if (typeof o !== "object" || o === null || typeof o.layerId !== "string" || this.doc.layerById(o.layerId) === undefined) {
          return err("layout_invalid", `viewport.update: layer override references unknown layer '${String(o?.layerId)}'`, false);
        }
      }
    }
    try {
      this.doc.execute({ type: "updateViewport", viewportId: p.id, patch });
      const updated = this.doc.viewportById(p.id)!;
      return ok({ viewportId: p.id, viewport: updated, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  /** viewport.remove — delete the viewport record (model geometry is
   *  untouched — viewports reference, never own). */
  private cmdViewportRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "viewport.remove requires an id string", true);
    }
    if (this.doc.viewportById(p.id) === undefined) {
      return err("bad_id", `viewport '${p.id}' does not exist`, false);
    }
    try {
      this.doc.execute({ type: "removeViewport", viewportId: p.id });
      return ok({ removed: p.id, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  /** plot.export — the NON-MUTATING deterministic export of ONE layout:
   *  "svg" (the standalone deterministic SVG), "pdf" (the minimal
   *  deterministic PDF writer) or "plot-ir" (the canonical IR JSON). A
   *  CTB/STB plot style declines with a typed plot_unsupported (the named
   *  reference persists; applying proprietary plot styles is out of the
   *  bounded slice). */
  private cmdPlotExport(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; format?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "plot.export requires a payload object", true);
    }
    if (p.format !== "svg" && p.format !== "pdf" && p.format !== "plot-ir") {
      return err(
        "plot_unsupported",
        `plot format '${String(p.format)}' is not supported — this slice plots svg, pdf and plot-ir (proprietary DWG plotting internals and device-specific drivers are explicit non-goals, Issue #88)`,
        false,
      );
    }
    const resolved = this.resolveLayoutRef(p);
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const layout = resolved as LayoutRecord;
    if (layout.pageSetup.plotStyleKind !== "none") {
      return err(
        "plot_unsupported",
        `layout '${layout.name}' references the ${layout.pageSetup.plotStyleKind.toUpperCase()} plot style table '${layout.pageSetup.plotStyleTable}' — proprietary CTB/STB plot style application is a typed limitation of this slice; set plotStyleKind "none" to plot as displayed`,
        false,
      );
    }
    try {
      const ir = buildPlotIR(this.plotIRInputOf(layout));
      const hash = createHash("sha256").update(canonicalStringify(ir)).digest("hex");
      if (p.format === "plot-ir") {
        const canonical = canonicalStringify(ir);
        return ok({
          format: "plot-ir",
          layoutId: layout.id,
          layoutName: layout.name,
          ir,
          hash,
          size: canonical.length,
          sha256: createHash("sha256").update(canonical).digest("hex"),
        });
      }
      if (p.format === "svg") {
        const svg = plotIRToSVG(ir);
        return ok({
          format: "svg",
          layoutId: layout.id,
          layoutName: layout.name,
          text: svg,
          size: svg.length,
          sha256: createHash("sha256").update(svg).digest("hex"),
          irHash: hash,
        });
      }
      const pdf = plotIRToPDF(ir);
      return ok({
        format: "pdf",
        layoutId: layout.id,
        layoutName: layout.name,
        bytesBase64: Buffer.from(pdf).toString("base64"),
        size: pdf.length,
        sha256: createHash("sha256").update(pdf).digest("hex"),
        irHash: hash,
      });
    } catch (e) {
      return err("plot_invalid", (e as Error).message, false);
    }
  }

  /** plot.publish — the bounded PUBLISH batch: EVERY layout (or the explicit
   *  id subset) exported as ONE deterministic artifact — a multi-page PDF or
   *  an SVG set (a canonical JSON manifest). Non-mutating; layout table
   *  order. */
  private cmdPlotPublish(payload: unknown): CommandQueryResponse {
    const p = payload as { format?: unknown; layoutIds?: unknown } | null;
    if (p === null || typeof p !== "object" || (p.format !== "pdf" && p.format !== "svg")) {
      return err("bad_payload", "plot.publish requires format: \"pdf\" | \"svg\"", true);
    }
    const layouts = this.doc.layoutTable;
    if (layouts.length === 0) {
      return err("bad_id", "no layouts exist to publish — create one with layout.create (LAYOUTNEW)", false);
    }
    const subset = Array.isArray(p.layoutIds) && p.layoutIds.every((x) => typeof x === "string")
      ? layouts.filter((l) => (p.layoutIds as string[]).includes(l.id))
      : layouts;
    if (subset.length === 0) {
      return err("bad_id", "plot.publish: none of the given layoutIds exist", false);
    }
    for (const layout of subset) {
      if (layout.pageSetup.plotStyleKind !== "none") {
        return err(
          "plot_unsupported",
          `layout '${layout.name}' references the ${layout.pageSetup.plotStyleKind.toUpperCase()} plot style table '${layout.pageSetup.plotStyleTable}' — proprietary CTB/STB plot style application is a typed limitation of this slice`,
          false,
        );
      }
    }
    try {
      const irs = subset.map((layout) => buildPlotIR(this.plotIRInputOf(layout)));
      if (p.format === "pdf") {
        const pdf = plotIRsToPDF(irs);
        return ok({
          format: "pdf",
          pages: irs.map((ir, i) => ({ layoutId: subset[i]!.id, layoutName: subset[i]!.name, primitiveCount: ir.primitiveCount })),
          pageCount: irs.length,
          bytesBase64: Buffer.from(pdf).toString("base64"),
          size: pdf.length,
          sha256: createHash("sha256").update(pdf).digest("hex"),
        });
      }
      const entries = irs.map((ir, i) => ({
        layoutId: subset[i]!.id,
        layoutName: subset[i]!.name,
        svg: plotIRToSVG(ir),
      }));
      const manifest = canonicalStringify({
        format: "offisos-plot-svg-set",
        formatVersion: "1",
        sheets: entries.map((e) => ({ layoutId: e.layoutId, layoutName: e.layoutName, svg: e.svg })),
      });
      return ok({
        format: "svg",
        pages: entries.map((e, i) => ({ layoutId: e.layoutId, layoutName: e.layoutName, primitiveCount: irs[i]!.primitiveCount })),
        pageCount: entries.length,
        text: manifest,
        size: manifest.length,
        sha256: createHash("sha256").update(manifest).digest("hex"),
      });
    } catch (e) {
      return err("plot_invalid", (e as Error).message, false);
    }
  }

  /** layouts.list (query) — the layout/viewport tables + the non-versioned
   *  editor context (activeLayout/space). */
  private qLayoutsList(): CommandQueryResponse {
    const settings = this.doc.draftingSettings;
    return ok({
      layouts: this.doc.layoutTable,
      viewports: this.doc.viewportTable,
      activeLayoutId: settings.activeLayout ?? this.doc.layoutTable[0]?.id ?? null,
      space: settings.space ?? "model",
    });
  }

  /** plot.preview (query) — the canonical Plot IR + its hash for ONE layout
   *  (the SAME representation the export writers and both hosts' paper
   *  canvases consume — the preview IS the plot, LOCK-004). */
  private qPlotPreview(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown } | null;
    const resolved = this.resolveLayoutRef(p ?? {});
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const layout = resolved as LayoutRecord;
    try {
      const ir = buildPlotIR(this.plotIRInputOf(layout));
      const hash = createHash("sha256").update(canonicalStringify(ir)).digest("hex");
      return ok({ layoutId: layout.id, layoutName: layout.name, ir, hash });
    } catch (e) {
      return err("plot_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-009: 3D navigation, UCS/workplanes, bounded modeling -----

  private static readonly MODEL3D_NOW = "2026-01-01T00:00:00.000Z";

  /** Resolve a UCS reference payload: id "world" (or the name "World")
   *  resolves the IMPLICIT World UCS; an id/name resolves the table;
   *  absent → the ACTIVE UCS (non-versioned editor state). */
  private resolveUcsRef(p: { id?: unknown; name?: unknown }): UcsRecord | ErrResult {
    if (typeof p.id === "string" && p.id.length > 0) {
      if (p.id === "world") return WORLD_UCS;
      const ucs = this.doc.ucsById(p.id);
      if (ucs === undefined) return err("bad_id", `UCS '${p.id}' does not exist`, false);
      return ucs;
    }
    if (typeof p.name === "string" && p.name.length > 0) {
      if (p.name.trim().toLowerCase() === "world") return WORLD_UCS;
      const ucs = this.doc.ucsByName(p.name);
      if (ucs === undefined) return err("bad_id", `UCS '${p.name}' does not exist`, false);
      return ucs;
    }
    return this.activeUcs();
  }

  /** The ACTIVE UCS (non-versioned editor state — World when unset or,
   *  after the documented open-time defensive repair, dangling). */
  private activeUcs(): UcsRecord {
    const id = this.doc.draftingSettings.activeUcs;
    if (id === undefined || id === "world") return WORLD_UCS;
    return this.doc.ucsById(id) ?? WORLD_UCS;
  }

  /** The persisted 3D camera (or the deterministic default — the shared
   *  camera module's isometric view of the unit box). */
  private view3dCamera(): Camera3DState {
    return this.doc.draftingSettings.view3d ?? defaultCamera();
  }

  /** The deterministic model extents: the union hull of every element's
   *  persisted engine-produced extent (props.meshBBox — BIM solids AND
   *  model3d solids; elements without realized geometry contribute
   *  nothing). Empty when no element has realized geometry. */
  private model3dExtents(): BBox3D {
    let box: BBox3D | null = null;
    for (const el of this.doc.allElements()) {
      const b = el.props.meshBBox;
      if (
        !Array.isArray(b) || b.length !== 6 ||
        !b.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        continue;
      }
      const candidate: BBox3D = {
        minX: b[0] as number, minY: b[1] as number, minZ: b[2] as number,
        maxX: b[3] as number, maxY: b[4] as number, maxZ: b[5] as number,
      };
      box = box === null ? candidate : {
        minX: Math.min(box.minX, candidate.minX),
        minY: Math.min(box.minY, candidate.minY),
        minZ: Math.min(box.minZ, candidate.minZ),
        maxX: Math.max(box.maxX, candidate.maxX),
        maxY: Math.max(box.maxY, candidate.maxY),
        maxZ: Math.max(box.maxZ, candidate.maxZ),
      };
    }
    return box ?? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  }

  /** The pickable-element surface: every element with a persisted extent. */
  private model3dPickables(): { id: string; bbox: BBox3D }[] {
    const out: { id: string; bbox: BBox3D }[] = [];
    for (const el of this.doc.allElements()) {
      const b = el.props.meshBBox;
      if (
        !Array.isArray(b) || b.length !== 6 ||
        !b.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        continue;
      }
      out.push({
        id: el.id,
        bbox: {
          minX: b[0] as number, minY: b[1] as number, minZ: b[2] as number,
          maxX: b[3] as number, maxY: b[4] as number, maxZ: b[5] as number,
        },
      });
    }
    return out;
  }

  /** ucs.define — create a named UCS/workplane (one atomic revision; the
   *  document mints the `ucs-NNNNNN` id; the axis triple is validated as a
   *  whole through the SHARED grammar — degenerate/non-orthonormal triples
   *  are typed declines, never silently normalized). zAxis may be omitted —
   *  the exact right-handed derivation x×y is applied EXPLICITLY. */
  private cmdUcsDefine(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; origin?: unknown; xAxis?: unknown; yAxis?: unknown; zAxis?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "ucs.define requires a payload object", true);
    }
    if (typeof p.name !== "string" || p.name.trim().length === 0 || p.name.length > 255) {
      return err("bad_payload", "ucs.define requires a name (non-empty string, max 255 chars)", true);
    }
    const name = p.name.trim();
    if (name.toLowerCase() === "world") {
      return err("ucs_invalid", "the name 'World' is reserved for the implicit World UCS", false);
    }
    if (this.doc.ucsByName(name) !== undefined) {
      return err("ucs_invalid", `UCS name '${name}' already exists — UCS names are unique`, false);
    }
    if (!isFiniteVec3(p.origin) || !isFiniteVec3(p.xAxis) || !isFiniteVec3(p.yAxis)) {
      return err("bad_payload", "ucs.define requires origin/xAxis/yAxis as finite 3-vectors", true);
    }
    const x = p.xAxis as Vec3;
    const y = p.yAxis as Vec3;
    let z: Vec3;
    if (p.zAxis !== undefined) {
      if (!isFiniteVec3(p.zAxis)) {
        return err("bad_payload", "ucs.define zAxis must be a finite 3-vector when present", true);
      }
      z = p.zAxis as Vec3;
    } else {
      // The exact right-handed completion (x × y) — explicit derivation,
      // never a silent normalization of the given axes.
      z = [
        x[1]! * y[2]! - x[2]! * y[1]!,
        x[2]! * y[0]! - x[0]! * y[2]!,
        x[0]! * y[1]! - x[1]! * y[0]!,
      ];
    }
    try {
      const ucs: UcsRecord = {
        id: this.doc.mintUcsId(),
        name,
        origin: [...(p.origin as Vec3)],
        xAxis: [...x],
        yAxis: [...y],
        zAxis: [...z],
        createdAt: AppApiHandler.MODEL3D_NOW,
      };
      this.doc.execute({ type: "addUcs", ucs });
      return ok({ ucsId: ucs.id, name, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("ucs_invalid", (e as Error).message, false);
    }
  }

  /** ucs.update — patch name/origin/axes (id/name ref; the merged record
   *  re-validates as a whole through the shared grammar). */
  private cmdUcsUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "ucs.update requires a payload object with a patch", true);
    }
    if (typeof p.id === "string" && p.id.length > 0) {
      if (this.doc.ucsById(p.id) === undefined) return err("bad_id", `UCS '${p.id}' does not exist`, false);
    } else if (typeof p.name === "string" && p.name.length > 0) {
      const ucs = this.doc.ucsByName(p.name);
      if (ucs === undefined) return err("bad_id", `UCS '${p.name}' does not exist`, false);
      p.id = ucs.id;
    } else {
      return err("bad_payload", "ucs.update requires an id or name", true);
    }
    try {
      this.doc.execute({ type: "updateUcs", ucsId: p.id as string, patch: p.patch as Readonly<Record<string, unknown>> });
      return ok({ ucsId: p.id as string, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("ucs_invalid", (e as Error).message, false);
    }
  }

  /** ucs.remove — remove a named UCS. Removing the ACTIVE UCS is a typed
   *  ucs_active decline (activate World first); the implicit World UCS is
   *  never removable. */
  private cmdUcsRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "ucs.remove requires an id or name", true);
    }
    let ucs: UcsRecord | undefined;
    if (typeof p.id === "string" && p.id.length > 0) {
      ucs = this.doc.ucsById(p.id);
      if (ucs === undefined) return err("bad_id", `UCS '${p.id}' does not exist`, false);
    } else if (typeof p.name === "string" && p.name.length > 0) {
      ucs = this.doc.ucsByName(p.name);
      if (ucs === undefined) return err("bad_id", `UCS '${p.name}' does not exist`, false);
    } else {
      return err("bad_payload", "ucs.remove requires an id or name", true);
    }
    if (ucs.id === "world") {
      return err("ucs_invalid", "the World UCS is implicit — never removable", false);
    }
    const active = this.doc.draftingSettings.activeUcs;
    if (active === ucs.id) {
      return err("ucs_active", `UCS '${ucs.name}' is the ACTIVE UCS — activate World first (ucs.activate {id: \"world\"})`, false);
    }
    try {
      this.doc.execute({ type: "removeUcs", ucsId: ucs.id });
      return ok({ ucsId: ucs.id, removed: true, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("ucs_invalid", (e as Error).message, false);
    }
  }

  /** ucs.activate — the NON-VERSIONED current-workplane switch (the
   *  activeLayout precedent: editor state, no undo entry, survives
   *  save/open). */
  private cmdUcsActivate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown } | null;
    const resolved = this.resolveUcsRef(p ?? {});
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const ucs = resolved as UcsRecord;
    this.doc.setDraftingSettings({ ...this.doc.draftingSettings, activeUcs: ucs.id });
    return ok({ activeUcsId: ucs.id, ucs, snapshot: this.doc.snapshot() });
  }

  /** view3d.set — persist the deterministic 3D camera state as NON-VERSIONED
   *  editor settings (view state strictly separated from model history —
   *  never in the revision content hashes, never undoable). The merged
   *  state is validated + NORMALIZED through the shared camera module. */
  private cmdView3dSet(payload: unknown): CommandQueryResponse {
    const p = payload as {
      eye?: unknown; target?: unknown; up?: unknown;
      mode?: unknown; orthoHalfHeight?: unknown; fovDeg?: unknown;
    } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "view3d.set requires a payload object", true);
    }
    const current = this.view3dCamera();
    const vec3Or = (v: unknown, fallback: Vec3): Vec3 | null =>
      v === undefined ? fallback : isFiniteVec3(v) ? (v as Vec3) : null;
    const eye = vec3Or(p.eye, current.eye);
    const target = vec3Or(p.target, current.target);
    const up = vec3Or(p.up, current.up);
    if (eye === null || target === null || up === null) {
      return err("bad_payload", "view3d.set eye/target/up must be finite 3-vectors when present", true);
    }
    const mode = p.mode === undefined ? current.mode : p.mode === "orthographic" || p.mode === "perspective" ? p.mode : null;
    if (mode === null) {
      return err("bad_payload", "view3d.set mode must be 'orthographic' or 'perspective'", true);
    }
    const orthoHalfHeight = p.orthoHalfHeight === undefined ? current.orthoHalfHeight : p.orthoHalfHeight;
    const fovDeg = p.fovDeg === undefined ? current.fovDeg : p.fovDeg;
    if (typeof orthoHalfHeight !== "number" || !Number.isFinite(orthoHalfHeight) || orthoHalfHeight <= 0) {
      return err("bad_payload", "view3d.set orthoHalfHeight must be a finite number > 0", true);
    }
    if (typeof fovDeg !== "number" || !Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) {
      return err("bad_payload", "view3d.set fovDeg must be a finite number in (0, 180)", true);
    }
    const merged: Camera3DState = { eye: [...eye], target: [...target], up: [...up], mode, orthoHalfHeight, fovDeg };
    const failure = validateCamera(merged);
    if (failure !== null) return err("camera_invalid", `view3d.set: ${failure}`, false);
    const normalized = normalizeCamera(merged);
    if (normalized === null) return err("camera_invalid", "view3d.set: camera frame is degenerate", false);
    this.doc.setDraftingSettings({ ...this.doc.draftingSettings, view3d: normalized });
    return ok({ camera: normalized, echo: formatCamera(normalized), snapshot: this.doc.snapshot() });
  }

  /** view3d.fit — derive the camera from the deterministic model extents
   *  through the SHARED camera module and persist it (recenters + resizes;
   *  keeps the current view direction; the empty model falls back to the
   *  unit box — the EMPTY_MODEL_EXTENTS precedent). */
  private cmdView3dFit(payload: unknown): CommandQueryResponse {
    const p = payload as { aspect?: unknown; mode?: unknown } | null;
    const aspect = p !== null && typeof p === "object" && typeof p.aspect === "number" && Number.isFinite(p.aspect) && p.aspect > 0
      ? p.aspect
      : 1;
    let current = this.view3dCamera();
    if (p !== null && typeof p === "object" && (p.mode === "orthographic" || p.mode === "perspective")) {
      current = { ...current, mode: p.mode };
    }
    const fitted = fitCameraToBBox(current, this.model3dExtents(), aspect);
    if (fitted === null) return err("camera_invalid", "view3d.fit: the current camera frame is degenerate", false);
    const normalized = normalizeCamera(fitted);
    if (normalized === null) return err("camera_invalid", "view3d.fit: the fitted camera frame is degenerate", false);
    this.doc.setDraftingSettings({ ...this.doc.draftingSettings, view3d: normalized });
    return ok({ camera: normalized, echo: formatCamera(normalized), snapshot: this.doc.snapshot() });
  }

  /** view3d.standard — one of the six canonical standard views + the
   *  isometric preset, derived through the SHARED camera module and
   *  persisted. */
  private cmdView3dStandard(payload: unknown): CommandQueryResponse {
    const p = payload as { view?: unknown; aspect?: unknown; mode?: unknown } | null;
    const views: readonly string[] = ["top", "bottom", "front", "back", "left", "right", "iso"];
    if (p === null || typeof p !== "object" || typeof p.view !== "string" || !views.includes(p.view)) {
      return err("bad_payload", `view3d.standard requires view: one of ${views.join(", ")}`, true);
    }
    const view = p.view as StandardViewName;
    const aspect = typeof p.aspect === "number" && Number.isFinite(p.aspect) && p.aspect > 0 ? p.aspect : 1;
    let current = this.view3dCamera();
    if (p.mode === "orthographic" || p.mode === "perspective") {
      current = { ...current, mode: p.mode };
    }
    const camera = standardCameraFor(view, this.model3dExtents(), aspect, current.fovDeg, current.mode);
    this.doc.setDraftingSettings({ ...this.doc.draftingSettings, view3d: camera });
    return ok({ camera, echo: formatCamera(camera), snapshot: this.doc.snapshot() });
  }

  /** The shared solid-creation pipeline: build the UCS-placed descriptor
   *  (the EXISTING GeometryDescriptor vocabulary — transform-wrapped, no
   *  new engine ops), prepare it through the geometry adapter, persist the
   *  element with the engine result (meshToken/bbox/provenance) in the SAME
   *  atomic revision. */
  private async prepareModel3dSolid(descriptor: GeometryDescriptor): Promise<
    { ok: true; meshToken: string; bbox: readonly [number, number, number, number, number, number] } | { ok: false; response: CommandQueryResponse }
  > {
    const prep: Element = { id: "model3d:prepare", kind: "geometry", engineId: null, props: descriptor as unknown as Record<string, unknown> };
    let realized: { meshToken: string; bbox: readonly [number, number, number, number, number, number] };
    try {
      realized = await this.adapters.geometry.prepareGeometry(prep);
    } catch (e) {
      if (isAdapterFailure(e)) return { ok: false, response: err(e.code, e.message, e.retryable) };
      return { ok: false, response: err("engine_error", `geometry adapter failed: ${(e as Error).message}`, false) };
    }
    if (
      typeof realized !== "object" || realized === null ||
      typeof realized.meshToken !== "string" || realized.meshToken.length === 0 ||
      !Array.isArray(realized.bbox) || realized.bbox.length !== 6 ||
      !realized.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return { ok: false, response: err("engine_error", "geometry adapter returned an invalid GeometryResult", false) };
    }
    return { ok: true, meshToken: realized.meshToken, bbox: realized.bbox };
  }

  private addModel3dSolid(props: Record<string, unknown>): CommandQueryResponse {
    try {
      const elementId = this.doc.mintElementId();
      this.doc.execute({ type: "addElement", element: { id: elementId, kind: "geometry", engineId: null, props } });
      return ok({ elementId, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("model3d_invalid", (e as Error).message, false);
    }
  }

  /** model3d.box — a box solid placed through the ACTIVE UCS (base corner at
   *  the UCS origin — or `at` in UCS coordinates — edges along the UCS axes). */
  private async cmdModel3dBox(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { width?: unknown; depth?: unknown; height?: unknown; at?: unknown; ucsId?: unknown; ucsName?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "model3d.box requires a payload object", true);
    }
    const dims = [p.width, p.depth, p.height];
    if (!dims.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) {
      return err("bad_payload", "model3d.box requires width/depth/height as positive finite numbers", true);
    }
    const resolved = this.resolveUcsRef({ id: p.ucsId, name: p.ucsName });
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const ucs = resolved as UcsRecord;
    let at: Vec3 = [0, 0, 0];
    if (p.at !== undefined) {
      if (!isFiniteVec3(p.at)) return err("bad_payload", "model3d.box at must be a finite 3-vector (UCS coordinates) when present", true);
      at = p.at as Vec3;
    }
    let descriptor = placeBox(ucs, p.width as number, p.depth as number, p.height as number);
    if (at[0] !== 0 || at[1] !== 0 || at[2] !== 0) {
      descriptor = moveDescriptor(descriptor, ucsDirectionToWorld(ucs, at));
    }
    const prepared = await this.prepareModel3dSolid(descriptor);
    if (!prepared.ok) return prepared.response;
    return this.addModel3dSolid({
      type: "model3d.solid",
      shape: "box",
      width: p.width as number,
      depth: p.depth as number,
      height: p.height as number,
      ucsId: ucs.id,
      at: [...at],
      geometry: descriptor,
      meshToken: prepared.meshToken,
      meshBBox: [...prepared.bbox],
      geometryEngine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
    });
  }

  /** model3d.cylinder — a cylinder solid placed through the ACTIVE UCS
   *  (base center at the UCS origin — or `at` — axis along the UCS Z). */
  private async cmdModel3dCylinder(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { radius?: unknown; height?: unknown; at?: unknown; ucsId?: unknown; ucsName?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "model3d.cylinder requires a payload object", true);
    }
    if (typeof p.radius !== "number" || !Number.isFinite(p.radius) || p.radius <= 0) {
      return err("bad_payload", "model3d.cylinder requires a positive finite radius", true);
    }
    if (typeof p.height !== "number" || !Number.isFinite(p.height) || p.height <= 0) {
      return err("bad_payload", "model3d.cylinder requires a positive finite height", true);
    }
    const resolved = this.resolveUcsRef({ id: p.ucsId, name: p.ucsName });
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const ucs = resolved as UcsRecord;
    let at: Vec3 = [0, 0, 0];
    if (p.at !== undefined) {
      if (!isFiniteVec3(p.at)) return err("bad_payload", "model3d.cylinder at must be a finite 3-vector (UCS coordinates) when present", true);
      at = p.at as Vec3;
    }
    let descriptor = placeCylinder(ucs, p.radius as number, p.height as number);
    if (at[0] !== 0 || at[1] !== 0 || at[2] !== 0) {
      descriptor = moveDescriptor(descriptor, ucsDirectionToWorld(ucs, at));
    }
    const prepared = await this.prepareModel3dSolid(descriptor);
    if (!prepared.ok) return prepared.response;
    return this.addModel3dSolid({
      type: "model3d.solid",
      shape: "cylinder",
      radius: p.radius as number,
      height: p.height as number,
      ucsId: ucs.id,
      at: [...at],
      geometry: descriptor,
      meshToken: prepared.meshToken,
      meshBBox: [...prepared.bbox],
      geometryEngine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
    });
  }

  /** model3d.extrude — an extrusion-derived solid placed through the ACTIVE
   *  UCS (the profile polygon lives in the UCS XY plane, extruded along the
   *  UCS Z by height). */
  private async cmdModel3dExtrude(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { profile?: unknown; height?: unknown; baseZ?: unknown; at?: unknown; ucsId?: unknown; ucsName?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "model3d.extrude requires a payload object", true);
    }
    if (
      !Array.isArray(p.profile) || p.profile.length < 3 ||
      !p.profile.every((v) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)))
    ) {
      return err("bad_payload", "model3d.extrude requires a profile of at least 3 finite [x, y] points", true);
    }
    if (typeof p.height !== "number" || !Number.isFinite(p.height) || p.height <= 0) {
      return err("bad_payload", "model3d.extrude requires a positive finite height", true);
    }
    if (p.baseZ !== undefined && (typeof p.baseZ !== "number" || !Number.isFinite(p.baseZ))) {
      return err("bad_payload", "model3d.extrude baseZ must be a finite number when present", true);
    }
    const profile = p.profile as readonly (readonly [number, number])[];
    // Simple-polygon validation: no coincident consecutive points, a
    // non-degenerate shoelace area (the descriptor grammar — the same
    // validation the adapter applies, surfaced early + deterministically).
    let area2 = 0;
    for (let i = 0; i < profile.length; i += 1) {
      const a = profile[i]!;
      const b = profile[(i + 1) % profile.length]!;
      area2 += a[0]! * b[1]! - b[0]! * a[1]!;
    }
    if (Math.abs(area2) < 1e-12) {
      return err("model3d_invalid", "model3d.extrude profile has a degenerate (zero) area", false);
    }
    for (let i = 0; i < profile.length; i += 1) {
      const a = profile[i]!;
      const b = profile[(i + 1) % profile.length]!;
      if (a[0]! === b[0]! && a[1]! === b[1]!) {
        return err("model3d_invalid", "model3d.extrude profile has coincident consecutive points", false);
      }
    }
    const resolved = this.resolveUcsRef({ id: p.ucsId, name: p.ucsName });
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const ucs = resolved as UcsRecord;
    let at: Vec3 = [0, 0, 0];
    if (p.at !== undefined) {
      if (!isFiniteVec3(p.at)) return err("bad_payload", "model3d.extrude at must be a finite 3-vector (UCS coordinates) when present", true);
      at = p.at as Vec3;
    }
    let descriptor = placeExtrude(ucs, profile, p.height as number, p.baseZ ?? 0);
    if (at[0] !== 0 || at[1] !== 0 || at[2] !== 0) {
      descriptor = moveDescriptor(descriptor, ucsDirectionToWorld(ucs, at));
    }
    const prepared = await this.prepareModel3dSolid(descriptor);
    if (!prepared.ok) return prepared.response;
    return this.addModel3dSolid({
      type: "model3d.solid",
      shape: "extrude",
      profile: profile.map((v) => [v[0]!, v[1]!]),
      height: p.height as number,
      ...(p.baseZ !== undefined ? { baseZ: p.baseZ as number } : {}),
      ucsId: ucs.id,
      at: [...at],
      geometry: descriptor,
      meshToken: prepared.meshToken,
      meshBBox: [...prepared.bbox],
      geometryEngine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
    });
  }

  /** model3d.move/rotate/scale — UCS-aware transforms of existing solid
   *  elements: wrap the element's persisted descriptor with the
   *  deterministic transform matrix (fixed composition order), re-prepare
   *  through the adapter and persist the new engine result in the SAME
   *  atomic revision (the updateElement inverse restores the previous
   *  descriptor + engine state exactly — undo/redo/replay integrity). */
  private async cmdModel3dTransform(payload: unknown, op: "move" | "rotate" | "scale"): Promise<CommandQueryResponse> {
    const p = payload as {
      elementId?: unknown; delta?: unknown; axis?: unknown; deg?: unknown; factor?: unknown; base?: unknown;
      ucsId?: unknown; ucsName?: unknown;
    } | null;
    if (p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0) {
      return err("bad_payload", `model3d.${op} requires an elementId`, true);
    }
    const element = this.doc.allElements().find((el) => el.id === p.elementId);
    if (element === undefined) {
      return err("bad_id", `element '${p.elementId}' does not exist`, false);
    }
    if (element.props.type !== "model3d.solid" || element.props.geometry === undefined) {
      return err("not_a_solid", `element '${p.elementId}' is not a model3d solid — model3d.${op} transforms model3d.solid elements only`, false);
    }
    const resolved = this.resolveUcsRef({ id: p.ucsId, name: p.ucsName });
    if ("ok" in resolved && resolved.ok === false) return resolved;
    const ucs = resolved as UcsRecord;
    const descriptor = element.props.geometry as GeometryDescriptor;
    let transformed: GeometryDescriptor | null;
    if (op === "move") {
      if (!isFiniteVec3(p.delta)) {
        return err("bad_payload", "model3d.move requires a delta finite 3-vector (ACTIVE UCS coordinates)", true);
      }
      transformed = moveDescriptor(descriptor, ucsDirectionToWorld(ucs, p.delta as Vec3));
    } else if (op === "rotate") {
      if (!isFiniteVec3(p.axis)) {
        return err("bad_payload", "model3d.rotate requires an axis finite 3-vector (ACTIVE UCS coordinates)", true);
      }
      if (typeof p.deg !== "number" || !Number.isFinite(p.deg)) {
        return err("bad_payload", "model3d.rotate requires a finite deg", true);
      }
      let base: Vec3 = ucs.origin;
      if (p.base !== undefined) {
        if (!isFiniteVec3(p.base)) return err("bad_payload", "model3d.rotate base must be a finite 3-vector (UCS coordinates) when present", true);
        base = [
          ucs.origin[0] + ucs.xAxis[0]! * p.base[0] + ucs.yAxis[0]! * p.base[1] + ucs.zAxis[0]! * p.base[2],
          ucs.origin[1] + ucs.xAxis[1]! * p.base[0] + ucs.yAxis[1]! * p.base[1] + ucs.zAxis[1]! * p.base[2],
          ucs.origin[2] + ucs.xAxis[2]! * p.base[0] + ucs.yAxis[2]! * p.base[1] + ucs.zAxis[2]! * p.base[2],
        ];
      }
      transformed = rotateDescriptor(descriptor, ucsDirectionToWorld(ucs, p.axis as Vec3), p.deg, base);
      if (transformed === null) {
        return err("model3d_invalid", "model3d.rotate: the axis is degenerate (the zero vector in the ACTIVE UCS)", false);
      }
    } else {
      if (typeof p.factor !== "number" || !Number.isFinite(p.factor) || p.factor <= 0) {
        return err("bad_payload", "model3d.scale requires a positive finite factor", true);
      }
      let base: Vec3 = ucs.origin;
      if (p.base !== undefined) {
        if (!isFiniteVec3(p.base)) return err("bad_payload", "model3d.scale base must be a finite 3-vector (UCS coordinates) when present", true);
        base = [
          ucs.origin[0] + ucs.xAxis[0]! * p.base[0] + ucs.yAxis[0]! * p.base[1] + ucs.zAxis[0]! * p.base[2],
          ucs.origin[1] + ucs.xAxis[1]! * p.base[0] + ucs.yAxis[1]! * p.base[1] + ucs.zAxis[1]! * p.base[2],
          ucs.origin[2] + ucs.xAxis[2]! * p.base[0] + ucs.yAxis[2]! * p.base[1] + ucs.zAxis[2]! * p.base[2],
        ];
      }
      transformed = scaleDescriptor(descriptor, p.factor, base);
    }
    const prepared = await this.prepareModel3dSolid(transformed);
    if (!prepared.ok) return prepared.response;
    try {
      this.doc.execute({
        type: "updateElement",
        elementId: element.id,
        patch: {
          geometry: transformed,
          meshToken: prepared.meshToken,
          meshBBox: [...prepared.bbox],
          geometryEngine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
        },
      });
      // CAD-PARITY-010: eager LOD-cache invalidation — the element's
      // canonical geometry declaration changed (a new revision); the stale
      // descriptor-keyed entries are dropped (bounded-budget hygiene).
      this.tessellationCache.invalidateDescriptor(descriptor);
      return ok({ elementId: element.id, op, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("model3d_invalid", (e as Error).message, false);
    }
  }

  /** sectionplane.create — a named section/slice plane definition (one
   *  atomic revision; the document mints the `sp-NNNNNN` id; the normal is
   *  EXPLICITLY normalized at the command layer — the zero vector is a
   *  typed decline). */
  private cmdSectionPlaneCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; origin?: unknown; normal?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "sectionplane.create requires a payload object", true);
    }
    if (typeof p.name !== "string" || p.name.trim().length === 0 || p.name.length > 255) {
      return err("bad_payload", "sectionplane.create requires a name (non-empty string, max 255 chars)", true);
    }
    const name = p.name.trim();
    if (this.doc.sectionPlaneByName(name) !== undefined) {
      return err("sectionplane_invalid", `section plane name '${name}' already exists — section plane names are unique`, false);
    }
    if (!isFiniteVec3(p.origin) || !isFiniteVec3(p.normal)) {
      return err("bad_payload", "sectionplane.create requires origin/normal as finite 3-vectors", true);
    }
    const normal = normalizeSectionNormal(p.normal as Vec3);
    if (normal === null) {
      return err("sectionplane_invalid", "sectionplane.create: the normal is the zero vector — a section plane needs a direction", false);
    }
    try {
      const plane: SectionPlaneRecord = {
        id: this.doc.mintSectionPlaneId(),
        name,
        origin: [...(p.origin as Vec3)],
        normal,
        createdAt: AppApiHandler.MODEL3D_NOW,
      };
      this.doc.execute({ type: "addSectionPlane", sectionPlane: plane });
      return ok({ sectionPlaneId: plane.id, name, normal, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("sectionplane_invalid", (e as Error).message, false);
    }
  }

  /** sectionplane.update — patch name/origin/normal (the merged record
   *  re-validates as a whole; a present normal is explicitly re-normalized). */
  private cmdSectionPlaneUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "sectionplane.update requires a payload object with a patch", true);
    }
    const patch = { ...(p.patch as Record<string, unknown>) };
    if (patch.normal !== undefined) {
      if (!isFiniteVec3(patch.normal)) {
        return err("bad_payload", "sectionplane.update patch normal must be a finite 3-vector when present", true);
      }
      const normal = normalizeSectionNormal(patch.normal as Vec3);
      if (normal === null) {
        return err("sectionplane_invalid", "sectionplane.update: the normal is the zero vector — a section plane needs a direction", false);
      }
      patch.normal = normal;
    }
    let id: string | undefined;
    if (typeof p.id === "string" && p.id.length > 0) {
      if (this.doc.sectionPlaneById(p.id) === undefined) return err("bad_id", `section plane '${p.id}' does not exist`, false);
      id = p.id;
    } else if (typeof p.name === "string" && p.name.length > 0) {
      const plane = this.doc.sectionPlaneByName(p.name);
      if (plane === undefined) return err("bad_id", `section plane '${p.name}' does not exist`, false);
      id = plane.id;
    } else {
      return err("bad_payload", "sectionplane.update requires an id or name", true);
    }
    try {
      this.doc.execute({ type: "updateSectionPlane", sectionPlaneId: id, patch });
      return ok({ sectionPlaneId: id, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("sectionplane_invalid", (e as Error).message, false);
    }
  }

  /** sectionplane.remove — remove a section-plane definition (the derived
   *  preview recomputes on demand — nothing stored references it). */
  private cmdSectionPlaneRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "sectionplane.remove requires an id or name", true);
    }
    let plane: SectionPlaneRecord | undefined;
    if (typeof p.id === "string" && p.id.length > 0) {
      plane = this.doc.sectionPlaneById(p.id);
      if (plane === undefined) return err("bad_id", `section plane '${p.id}' does not exist`, false);
    } else if (typeof p.name === "string" && p.name.length > 0) {
      plane = this.doc.sectionPlaneByName(p.name);
      if (plane === undefined) return err("bad_id", `section plane '${p.name}' does not exist`, false);
    } else {
      return err("bad_payload", "sectionplane.remove requires an id or name", true);
    }
    try {
      this.doc.execute({ type: "removeSectionPlane", sectionPlaneId: plane.id });
      return ok({ sectionPlaneId: plane.id, removed: true, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("sectionplane_invalid", (e as Error).message, false);
    }
  }

  // -----------------------------------------------------------------------
  // CAD-PARITY-010 (Issue #93): boolean solids, mesh entities, exact
  // sections, topology-aware picking and the bounded LOD cache.
  // -----------------------------------------------------------------------

  /** model3d.boolean — compose TWO existing model3d.solid elements into ONE
   *  result solid (union/difference/intersection). The adapter realizes the
   *  composed descriptor; the result element persists the engine result +
   *  the operand provenance; the operands are removed in the SAME atomic
   *  applyEdits revision (exact undo/redo/replay). Empty/non-manifold
   *  results are the typed boolean_empty/boolean_invalid declines. */
  private async cmdModel3dBoolean(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { op?: unknown; elementIds?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "model3d.boolean requires a payload object", true);
    }
    if (typeof p.op !== "string") {
      return err("bad_payload", "model3d.boolean requires op: one of union, difference, intersection", true);
    }
    const op = parseBooleanOp(p.op);
    if (op === null) {
      return err("bad_payload", "model3d.boolean requires op: one of union, difference, intersection", true);
    }
    if (!Array.isArray(p.elementIds) || p.elementIds.length !== 2 || !p.elementIds.every((id) => typeof id === "string" && id.length > 0)) {
      return err("bad_payload", "model3d.boolean requires elementIds: exactly TWO distinct solid element ids (compose longer chains through repeated commands — each step one atomic revision)", true);
    }
    const [idA, idB] = p.elementIds as [string, string];
    if (idA === idB) {
      return err("boolean_operand", `model3d.boolean requires two DISTINCT elements ('${idA}' named twice) — ${BOOLEAN_OPERAND_DECLINE_REASON}`, false);
    }
    const elementA = this.doc.allElements().find((el) => el.id === idA);
    const elementB = this.doc.allElements().find((el) => el.id === idB);
    if (elementA === undefined || elementB === undefined) {
      const missing = elementA === undefined ? idA : idB;
      return err("bad_id", `element '${missing}' does not exist`, false);
    }
    const solidOf = (el: Element): { descriptor: GeometryDescriptor; meshToken: string } | null => {
      if (el.props.type !== "model3d.solid" || el.props.geometry === undefined) return null;
      const meshToken = el.props.meshToken;
      if (typeof meshToken !== "string" || meshToken.length === 0) return null;
      return { descriptor: el.props.geometry as GeometryDescriptor, meshToken };
    };
    const solidA = solidOf(elementA);
    const solidB = solidOf(elementB);
    if (solidA === null || solidB === null) {
      return err("boolean_operand", `boolean operands must be model3d solid elements with persisted geometry — ${BOOLEAN_OPERAND_DECLINE_REASON}`, false);
    }
    const descriptor = booleanDescriptor(op, solidA.descriptor, solidB.descriptor);
    const provenance = booleanProvenance(op, [
      { elementId: elementA.id, meshToken: solidA.meshToken },
      { elementId: elementB.id, meshToken: solidB.meshToken },
    ]);
    const prepared = await this.prepareModel3dSolid(descriptor);
    if (!prepared.ok) {
      // The typed boolean-outcome mapping: engine_empty_result →
      // boolean_empty; engine_non_manifold/engine_malformed_input →
      // boolean_invalid (the message carries the engine detail verbatim);
      // transport codes (engine_unavailable/timeout/error) pass through.
      const failure = prepared.response as { code?: unknown; message?: unknown; retryable?: unknown };
      const code = typeof failure.code === "string" ? booleanFailureCode(failure.code) : "engine_error";
      const message = typeof failure.message === "string" ? failure.message : "the geometry adapter failed";
      return err(
        code,
        code === "boolean_empty" ? `${message} — ${BOOLEAN_EMPTY_DECLINE_REASON}` : message,
        failure.retryable === true,
      );
    }
    try {
      const elementId = this.doc.mintElementId();
      this.doc.execute({
        type: "applyEdits",
        edits: [
          {
            type: "addElement",
            element: {
              id: elementId,
              kind: "geometry",
              engineId: null,
              props: {
                type: "model3d.solid",
                shape: "boolean",
                op,
                operands: provenance.operands,
                geometry: descriptor,
                meshToken: prepared.meshToken,
                meshBBox: [...prepared.bbox],
                geometryEngine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
              },
            },
          },
          { type: "removeElement", elementId: elementA.id },
          { type: "removeElement", elementId: elementB.id },
        ],
      });
      // Eager cache invalidation: the operands' geometry is gone from the
      // document (their descriptor-keyed LOD entries cannot be requested
      // again — bounded-budget hygiene).
      this.tessellationCache.invalidateDescriptor(solidA.descriptor);
      this.tessellationCache.invalidateDescriptor(solidB.descriptor);
      return ok({ elementId, op, operands: provenance.operands, meshToken: prepared.meshToken, bbox: [...prepared.bbox], snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("boolean_invalid", (e as Error).message, false);
    }
  }

  /** model3d.tessellate — persist a bounded engine-neutral MESH ENTITY
   *  element (model3d.mesh) from a solid at one of the closed quality
   *  presets. The entity is a read-only representation (the source solid
   *  remains the editing surface — mesh operations are a typed decline). */
  private async cmdModel3dTessellate(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { elementId?: unknown; quality?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0) {
      return err("bad_payload", "model3d.tessellate requires an elementId", true);
    }
    let quality: MeshQualityPreset = "full";
    if (p.quality !== undefined) {
      if (typeof p.quality !== "string" || parseMeshQuality(p.quality) === null) {
        return err("bad_payload", "model3d.tessellate quality must be one of low, medium, full", true);
      }
      quality = parseMeshQuality(p.quality)!;
    }
    const element = this.doc.allElements().find((el) => el.id === p.elementId);
    if (element === undefined) {
      return err("bad_id", `element '${p.elementId}' does not exist`, false);
    }
    if (element.props.type !== "model3d.solid" || element.props.geometry === undefined) {
      return err("not_a_solid", `element '${p.elementId}' is not a model3d solid — model3d.tessellate tessellates model3d.solid elements`, false);
    }
    const sourceMeshToken = element.props.meshToken;
    if (typeof sourceMeshToken !== "string" || sourceMeshToken.length === 0) {
      return err("not_a_solid", `element '${element.id}' has no realized geometry (no meshToken)`, false);
    }
    if (!isQualityMeshProvider(this.adapters.geometry)) {
      return err("mesh_unsupported", "the active geometry engine provides no quality-mesh capability (QualityMeshProvider) — the bounded LOD surface is unavailable", false);
    }
    const descriptor = element.props.geometry as GeometryDescriptor;
    const key = TessellationCache.key(descriptor, quality);
    let entry = this.tessellationCache.get(key);
    if (entry === null) {
      try {
        const result = await this.adapters.geometry.prepareMeshAtQuality(descriptor, quality);
        entry = { mesh: result.mesh, meshToken: result.meshToken, vertices: result.metadata.vertices, triangles: result.metadata.triangles };
      } catch (e) {
        if (isAdapterFailure(e)) {
          return err(e.code, e.message, e.retryable);
        }
        return err("engine_error", `geometry adapter failed: ${(e as Error).message}`, false);
      }
      this.tessellationCache.set(key, entry);
    }
    const built = buildMeshEntityProps({
      sourceElementId: element.id,
      sourceMeshToken,
      quality,
      vertices: entry.mesh.vertices,
      indices: entry.mesh.indices,
      engine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
    });
    if (!built.ok) {
      return err("mesh_invalid", `model3d.tessellate: ${built.reason}`, false);
    }
    try {
      const elementId = this.doc.mintElementId();
      this.doc.execute({
        type: "addElement",
        element: { id: elementId, kind: "geometry", engineId: null, props: built.props as unknown as Record<string, unknown> },
      });
      return ok({
        elementId,
        sourceElementId: element.id,
        quality,
        knobs: meshQualityKnobs(quality),
        meshToken: entry.meshToken,
        vertexCount: built.props.vertexCount,
        triangleCount: built.props.triangleCount,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("mesh_invalid", (e as Error).message, false);
    }
  }

  /** model3d.section (query) — the EXACT adapter-backed plane ∩ solid
   *  section: canonical loops/chains + hash. The adapter declining a
   *  descriptor's class is the typed section_exact_unsupported decline (the
   *  labeled extent preview remains the fallback — never an approximation
   *  presented as exact). */
  private async qModel3dSection(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { id?: unknown; name?: unknown; elementId?: unknown } | null;
    let plane: SectionPlaneRecord | undefined;
    if (p !== null && typeof p === "object" && typeof p.id === "string" && p.id.length > 0) {
      plane = this.doc.sectionPlaneById(p.id);
      if (plane === undefined) return err("bad_id", `section plane '${p.id}' does not exist`, false);
    } else if (p !== null && typeof p === "object" && typeof p.name === "string" && p.name.length > 0) {
      plane = this.doc.sectionPlaneByName(p.name);
      if (plane === undefined) return err("bad_id", `section plane '${p.name}' does not exist`, false);
    } else {
      const planes = this.doc.sectionPlaneRecords;
      if (planes.length === 1) {
        plane = planes[0];
      } else if (planes.length === 0) {
        return err("bad_id", "no section plane exists — create one with sectionplane.create", false);
      } else {
        return err("bad_payload", "model3d.section requires an id or name (multiple section planes exist)", true);
      }
    }
    const solids = this.model3dPickables()
      .filter((el) => el.id !== undefined)
      .map((el) => this.doc.allElements().find((d) => d.id === el.id))
      .filter((el): el is Element => el !== undefined && el.props.type === "model3d.solid" && el.props.geometry !== undefined);
    let targets = solids;
    if (p !== null && typeof p === "object" && typeof p.elementId === "string" && p.elementId.length > 0) {
      const one = solids.find((el) => el.id === p.elementId);
      if (one === undefined) {
        return err("bad_id", `element '${p.elementId}' is not a model3d solid with persisted geometry`, false);
      }
      targets = [one];
    }
    if (targets.length === 0) {
      return err("bad_id", "no model3d solids exist to section", false);
    }
    if (!isSectionProvider(this.adapters.geometry)) {
      return err("section_exact_unsupported", "the active geometry engine provides no exact-section capability (SectionProvider) — the labeled extent preview (model3d.sectionPreview) remains the bounded fallback", false);
    }
    const thePlane = plane as SectionPlaneRecord;
    const spec = { origin: thePlane.origin, normal: thePlane.normal };
    const inputs: { id: string; raw: SectionGeometry }[] = [];
    for (const el of targets) {
      try {
        const raw = await this.adapters.geometry.computeSection(el.props.geometry as GeometryDescriptor, spec);
        validateSectionGeometry(spec, raw);
        inputs.push({ id: el.id, raw });
      } catch (e) {
        if (isAdapterFailure(e)) {
          return err("section_exact_unsupported", `element '${el.id}': ${SECTION_EXACT_ENGINE_DECLINE_REASON} (engine: ${e.message})`, false);
        }
        if (e instanceof SectionGeometryValidationError) {
          return err("engine_error", `element '${el.id}': the engine's section output failed structural validation — ${e.message}`, false);
        }
        return err("engine_error", `element '${el.id}': section computation failed — ${(e as Error).message}`, false);
      }
    }
    const body = buildSectionExact(plane as SectionPlaneRecord, inputs);
    const hash = createHash("sha256").update(canonicalStringify(body)).digest("hex");
    return ok({
      sectionPlaneId: (plane as SectionPlaneRecord).id,
      name: (plane as SectionPlaneRecord).name,
      exact: true,
      section: body,
      hash,
      note: "exact adapter-backed section: the plane ∩ solid intersection curves through the active engine (canonical loops/chains; engine provenance recorded); the labeled extent preview remains available via model3d.sectionPreview",
    });
  }

  /** model3d.topology (query) — the deterministic topology map of one solid:
   *  canonical f/e/v ids assigned by canonical geometry ordering (engine
   *  enumeration order and triangulation details are irrelevant), engine
   *  keys as PROVENANCE only. The map is derived state (never persisted). */
  private async qModel3dTopology(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { elementId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0) {
      return err("bad_payload", "model3d.topology requires an elementId", true);
    }
    const map = await this.topologyOfElement(p.elementId);
    if ("ok" in map && map.ok === false) return map.response;
    const topology = (map as { topology: TopologyMap }).topology;
    const hash = createHash("sha256").update(canonicalStringify(topology)).digest("hex");
    return ok({ elementId: p.elementId, topology, counts: topology.counts, hash });
  }

  /** The shared topology computation for the topology query and the
   *  per-element sub-entity pick (typed declines throughout). */
  private async topologyOfElement(elementId: string): Promise<{ topology: TopologyMap } | { ok: false; response: CommandQueryResponse }> {
    const element = this.doc.allElements().find((el) => el.id === elementId);
    if (element === undefined) {
      return { ok: false, response: err("bad_id", `element '${elementId}' does not exist`, false) };
    }
    if (element.props.type !== "model3d.solid" || element.props.geometry === undefined) {
      return { ok: false, response: err("topology_unsupported", `element '${elementId}' is not a model3d solid with persisted geometry — ${TOPOLOGY_DECLINE_REASON}`, false) };
    }
    if (!isTopologyProvider(this.adapters.geometry)) {
      return { ok: false, response: err("topology_unsupported", "the active geometry engine provides no topology capability (TopologyProvider) — element-granularity picking (model3d.pick) remains available", false) };
    }
    try {
      const raw = await this.adapters.geometry.describeTopology(element.props.geometry as GeometryDescriptor);
      const topology = buildTopologyMap(element.id, raw);
      return { topology };
    } catch (e) {
      if (isAdapterFailure(e)) {
        return { ok: false, response: err("topology_unsupported", `element '${elementId}': ${e.message}`, false) };
      }
      if (e instanceof TopologyValidationError) {
        return { ok: false, response: err("engine_error", `element '${elementId}': the engine's topology output failed structural validation — ${e.message}`, false) }
      }
      return { ok: false, response: err("engine_error", `element '${elementId}': topology computation failed — ${(e as Error).message}`, false) };
    }
  }

  /** model3d.cacheStats (query) — the bounded tessellation cache's exact
   *  counters + the documented budgets (the deterministic
   *  performance-budget evidence; reproducible counters, not wall-clock). */
  private qModel3dCacheStats(): CommandQueryResponse {
    return ok({
      cache: this.tessellationCache.stats(),
      budgets: {
        maxCacheEntries: this.tessellationCache.stats().capacity,
        maxCachedVertices: this.tessellationCache.stats().vertexBudget,
        meshLodMaxVertices: 150_000,
        meshEntityMaxVertices: 150_000,
        topologyBounds: { faces: 512, edges: 1024, vertices: 1024 },
        sectionMaxPoints: 8192,
      },
    });
  }

  /** ucs.list (query) — the named-UCS inventory + the current-workplane
   *  context (non-mutating, computed fresh). */
  private qUcsList(): CommandQueryResponse {
    return ok({
      ucs: this.doc.ucsRecords,
      activeUcsId: this.doc.draftingSettings.activeUcs ?? "world",
    });
  }

  /** view3d.state (query) — the persisted deterministic 3D camera state (or
   *  the deterministic default when none is persisted). */
  private qView3dState(): CommandQueryResponse {
    const camera = this.view3dCamera();
    return ok({ camera, echo: formatCamera(camera) });
  }

  /** model3d.pick (query) — deterministic element-granularity 3D selection
   *  through the SHARED projection/ray math: the exactly-ordered hit list
   *  (distance, then canonical id — no tie ambiguity). Sub-entity
   *  (face/edge/vertex) picking is a typed decline — never a silent
   *  approximation. */
  private qModel3dPick(payload: unknown): CommandQueryResponse {
    const p = payload as {
      screenX?: unknown; screenY?: unknown;
      viewport?: unknown; subEntity?: unknown;
      elementId?: unknown; subEntityKind?: unknown; tolerance?: unknown;
    } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "model3d.pick requires a payload object", true);
    }
    // CAD-PARITY-010: the per-element topology-aware sub-entity pick. The
    // P009 semantics are PRESERVED byte-identically: sub-entity request
    // without an elementId remains the typed subentity_unsupported decline
    // (the global pick is element-granularity only).
    const wantsSubEntity = p.subEntity === true || typeof p.subEntityKind === "string";
    if (wantsSubEntity && typeof p.elementId !== "string") {
      return err("subentity_unsupported", SUBENTITY_DECLINE_REASON, false);
    }
    if (typeof p.elementId === "string" && !wantsSubEntity) {
      return err("bad_payload", "model3d.pick elementId applies to the per-element sub-entity pick — pass subEntity: true or subEntityKind: face|edge|vertex (the global pick needs no elementId)", true);
    }
    if (wantsSubEntity) {
      return this.qModel3dPickSubEntity(p, p.elementId as string);
    }
    if (typeof p.screenX !== "number" || !Number.isFinite(p.screenX) || typeof p.screenY !== "number" || !Number.isFinite(p.screenY)) {
      return err("bad_payload", "model3d.pick requires finite screenX/screenY", true);
    }
    const vp = p.viewport as { width?: unknown; height?: unknown } | null;
    if (
      vp === null || typeof vp !== "object" ||
      typeof vp.width !== "number" || !Number.isFinite(vp.width) || vp.width <= 0 ||
      typeof vp.height !== "number" || !Number.isFinite(vp.height) || vp.height <= 0
    ) {
      return err("bad_payload", "model3d.pick requires a viewport {width, height} of positive finite numbers", true);
    }
    const camera = this.view3dCamera();
    const ray = screenRay(camera, { width: vp.width as number, height: vp.height as number }, p.screenX, p.screenY);
    if (ray === null) {
      return err("camera_invalid", "model3d.pick: the camera frame is degenerate", false);
    }
    const hits = pickElements(ray, this.model3dPickables());
    return ok({ ray: { origin: ray.origin, direction: ray.direction }, hits, count: hits.length });
  }

  /** The CAD-PARITY-010 per-element sub-entity pick: the deterministic
   *  topology map is computed on demand through the adapter and picked with
   *  the SHARED ray math (faces exact; edges/vertices within tolerance;
   *  exactly ordered — distance then canonical id). Async through the
   *  adapter; dispatched from the async query entry. */
  private async qModel3dPickSubEntityAsync(
    p: { screenX?: unknown; screenY?: unknown; viewport?: unknown; subEntityKind?: unknown; tolerance?: unknown },
    elementId: string,
  ): Promise<CommandQueryResponse> {
    if (typeof p.screenX !== "number" || !Number.isFinite(p.screenX) || typeof p.screenY !== "number" || !Number.isFinite(p.screenY)) {
      return err("bad_payload", "model3d.pick requires finite screenX/screenY", true);
    }
    const vp = p.viewport as { width?: unknown; height?: unknown } | null;
    if (
      vp === null || typeof vp !== "object" ||
      typeof vp.width !== "number" || !Number.isFinite(vp.width) || vp.width <= 0 ||
      typeof vp.height !== "number" || !Number.isFinite(vp.height) || vp.height <= 0
    ) {
      return err("bad_payload", "model3d.pick requires a viewport {width, height} of positive finite numbers", true);
    }
    let filter: SubEntityKind | undefined;
    if (p.subEntityKind !== undefined) {
      if (p.subEntityKind !== "face" && p.subEntityKind !== "edge" && p.subEntityKind !== "vertex") {
        return err("bad_payload", "model3d.pick subEntityKind must be one of face, edge, vertex", true);
      }
      filter = p.subEntityKind;
    }
    let tolerance: number | undefined;
    if (p.tolerance !== undefined) {
      if (typeof p.tolerance !== "number" || !Number.isFinite(p.tolerance) || p.tolerance <= 0) {
        return err("bad_payload", "model3d.pick tolerance must be a positive finite number (world units)", true);
      }
      tolerance = p.tolerance;
    }
    const map = await this.topologyOfElement(elementId);
    if ("ok" in map && map.ok === false) return map.response;
    const topology = (map as { topology: TopologyMap }).topology;
    const camera = this.view3dCamera();
    const ray = screenRay(camera, { width: vp.width as number, height: vp.height as number }, p.screenX, p.screenY);
    if (ray === null) {
      return err("camera_invalid", "model3d.pick: the camera frame is degenerate", false);
    }
    const hits = pickSubEntity(ray, topology, { ...(filter === undefined ? {} : { filter }), ...(tolerance === undefined ? {} : { tolerance }) });
    return ok({
      elementId,
      ray: { origin: ray.origin, direction: ray.direction },
      hits,
      count: hits.length,
      topologyCounts: topology.counts,
    });
  }

  /** The synchronous shim keeping the P009 pick dispatch signature (the
   *  sub-entity path is async — dispatched from the query entry). */
  private qModel3dPickSubEntity(
    p: { screenX?: unknown; screenY?: unknown; viewport?: unknown; subEntityKind?: unknown; tolerance?: unknown },
    elementId: string,
  ): CommandQueryResponse {
    // This is unreachable through the dispatch (the async path is taken);
    // kept for the exhaustive type surface.
    return err("engine_error", "model3d.pick sub-entity dispatch regression (the async path must be used)", false);
  }

  /** model3d.sectionPreview (query) — the bounded section/slice PREVIEW
   *  foundation: the deterministic plane∩extent intersection surface with
   *  its canonical hash. Exact BRep cross-sections are a typed decline. */
  private qModel3dSectionPreview(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; exact?: unknown } | null;
    if (p !== null && typeof p === "object" && p.exact === true) {
      return err("section_exact_unsupported", SECTION_EXACT_DECLINE_REASON, false);
    }
    let plane: SectionPlaneRecord | undefined;
    if (p !== null && typeof p.id === "string" && p.id.length > 0) {
      plane = this.doc.sectionPlaneById(p.id);
      if (plane === undefined) return err("bad_id", `section plane '${p.id}' does not exist`, false);
    } else if (p !== null && typeof p.name === "string" && p.name.length > 0) {
      plane = this.doc.sectionPlaneByName(p.name);
      if (plane === undefined) return err("bad_id", `section plane '${p.name}' does not exist`, false);
    } else {
      const planes = this.doc.sectionPlaneRecords;
      if (planes.length === 1) {
        plane = planes[0];
      } else if (planes.length === 0) {
        return err("bad_id", "no section plane exists — create one with sectionplane.create", false);
      } else {
        return err("bad_payload", "model3d.sectionPreview requires an id or name (multiple section planes exist)", true);
      }
    }
    const preview = buildSectionPreview(plane as SectionPlaneRecord, this.model3dPickables());
    const hash = createHash("sha256").update(canonicalStringify(preview)).digest("hex");
    return ok({ sectionPlaneId: (plane as SectionPlaneRecord).id, name: (plane as SectionPlaneRecord).name, preview, hash, exactDecline: SECTION_EXACT_DECLINE_REASON });
  }

  /** model3d.mesh (query) — the engine mesh for a solid element's
   *  meshToken through the adapter's OPTIONAL MeshProvider capability; when
   *  the engine provides no mesh the result says so EXPLICITLY (the host
   *  renders the persisted bbox wireframe, labeled as such — never an
   *  approximation presented as exact). */
  private async qModel3dMesh(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { elementId?: unknown; quality?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0) {
      return err("bad_payload", "model3d.mesh requires an elementId", true);
    }
    const element = this.doc.allElements().find((el) => el.id === p.elementId);
    if (element === undefined) {
      return err("bad_id", `element '${p.elementId}' does not exist`, false);
    }
    // CAD-PARITY-010: the bounded LOD path — quality present → serve the
    // quality-preset mesh through the revision-tied cache (progressive
    // delivery with deterministic per-preset output). Absent quality keeps
    // the P009 behavior byte-identically (the prepared mesh by token).
    if (p.quality !== undefined) {
      if (typeof p.quality !== "string" || parseMeshQuality(p.quality) === null) {
        return err("bad_payload", "model3d.mesh quality must be one of low, medium, full", true);
      }
      const quality = parseMeshQuality(p.quality)!;
      if (element.props.type !== "model3d.solid" || element.props.geometry === undefined) {
        return err("not_a_solid", `element '${p.elementId}' is not a model3d solid — the LOD mesh surface serves model3d.solid elements`, false);
      }
      if (!isQualityMeshProvider(this.adapters.geometry)) {
        return err("mesh_unsupported", "the active geometry engine provides no quality-mesh capability (QualityMeshProvider) — the bounded LOD surface is unavailable", false);
      }
      const descriptor = element.props.geometry as GeometryDescriptor;
      const key = TessellationCache.key(descriptor, quality);
      let entry = this.tessellationCache.get(key);
      if (entry === null) {
        try {
          const result = await this.adapters.geometry.prepareMeshAtQuality(descriptor, quality);
          entry = { mesh: result.mesh, meshToken: result.meshToken, vertices: result.metadata.vertices, triangles: result.metadata.triangles };
        } catch (e) {
          if (isAdapterFailure(e)) {
            return err(e.code, e.message, e.retryable);
          }
          return err("engine_error", `geometry adapter failed: ${(e as Error).message}`, false);
        }
        this.tessellationCache.set(key, entry);
      }
      return ok({
        elementId: element.id,
        quality,
        knobs: meshQualityKnobs(quality),
        meshToken: entry.meshToken,
        mesh: entry.mesh,
        vertices: entry.vertices,
        triangles: entry.triangles,
        withinBudget: entry.vertices <= 150_000,
      });
    }
    const meshToken = element.props.meshToken;
    if (typeof meshToken !== "string" || meshToken.length === 0) {
      return err("bad_id", `element '${p.elementId}' has no realized geometry (no meshToken) — prepare it first`, false);
    }
    let mesh: { vertices: readonly number[]; indices: readonly number[] } | null = null;
    if (isMeshProvider(this.adapters.geometry)) {
      try {
        mesh = await this.adapters.geometry.describeMesh(meshToken);
      } catch {
        mesh = null;
      }
    }
    return ok({
      elementId: element.id,
      meshToken,
      mesh,
      meshAvailable: mesh !== null,
      ...(mesh === null
        ? { note: "the engine provides no mesh for this token — the viewport renders the persisted extent (bbox) wireframe, explicitly labeled extent-level" }
        : {}),
    });
  }

  /** drafting.snap (query) — deterministic snap resolution against the
   *  current document. Hidden layers are not snappable (visibility is
   *  pickability); defaults come from the document drafting settings. */
  private qDraftingSnap(payload: unknown): CommandQueryResponse {
    const p = payload as {
      point?: unknown;
      tolerance?: unknown;
      kinds?: unknown;
      gridSize?: unknown;
      exclude?: unknown;
    } | null;
    if (
      p === null || typeof p !== "object" ||
      !Array.isArray(p.point) || p.point.length !== 2 || !p.point.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "drafting.snap requires point: [x, y] finite numbers", true);
    }
    const settings = this.doc.draftingSettings;
    const tolerance = typeof p.tolerance === "number" && p.tolerance > 0 ? p.tolerance : settings.snap.tolerance;
    const kinds = Array.isArray(p.kinds)
      ? canonicalSnapKinds(p.kinds)
      : settings.snap.kinds;
    if (kinds.length === 0) return err("bad_payload", "drafting.snap kinds contains no known snap kind", true);
    const gridSize = typeof p.gridSize === "number" && p.gridSize > 0 ? p.gridSize : settings.grid.size;
    const visible = new Set(this.doc.layerTable.filter((l) => l.visible).map((l) => l.id));
    const entities = this.doc.allElements().filter((el) => {
      const layer = (el.props as Record<string, unknown>).layer;
      return typeof layer === "string" && visible.has(layer);
    });
    try {
      const result = resolveSnap({
        point: [p.point[0] as number, p.point[1] as number],
        tolerance,
        kinds,
        gridSize,
        entities,
        exclude: Array.isArray(p.exclude) ? (p.exclude as string[]) : undefined,
      });
      return ok(result);
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-003 (additive): canonical 2D entity commands ---------------

  // ---------------------------------------------------------------------
  // CAD-PARITY-005: annotation commands.
  // ---------------------------------------------------------------------

  /** The annotation.update vocabulary per type (content/placement/style —
   *  display + layer belong to entity.setDisplay). */
  private static annotationPatchFields(type: string): readonly string[] {
    switch (type) {
      case "text":
        return ["value", "height", "rotation", "style", "hAlign", "vAlign"];
      case "mtext":
        return ["value", "height", "rotation", "style", "attachment"];
      case "dim-linear":
        return ["textOverride", "textPos", "style"];
      case "dim-radius":
        return ["textOverride", "textPos", "style", "at"];
      case "dim-diameter":
        return ["textOverride", "textPos", "style", "angle"];
      case "dim-angular":
        return ["textOverride", "textPos", "style"];
      case "leader":
        return ["value", "style", "height"];
      case "mleader":
        return ["value", "style", "height"];
      default:
        return [];
    }
  }

  /** annotation.create — validate + apply ONE atomic batch of annotation
   *  entities (text/mtext/dimensions/leaders). Measurements for referenced
   *  targets (radius/diameter) are computed SERVER-side from the current
   *  geometry; dim-linear refs re-resolve p1/p2 server-side; every style
   *  name must resolve (built-in "Standard" or the user tables); display
   *  overrides follow the entity.create rules. One versioned command, one
   *  revision, one undo entry. */
  private cmdAnnotationCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { entities?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.entities) || p.entities.length === 0) {
      return err("bad_payload", "annotation.create requires a non-empty entities array", true);
    }
    try {
      const elements = this.doc.allElements();
      const byId = new Map(elements.map((el) => [el.id, el] as const));
      const edits: DocumentEdit[] = [];
      const summaries: string[] = [];
      for (const [index, raw] of (p.entities as unknown[]).entries()) {
        if (typeof raw !== "object" || raw === null) {
          throw new AnnotationError(`entities[${index}] must be an object`, "bad_input");
        }
        const input = { ...(raw as Record<string, unknown>) };
        const layer = typeof input.layer === "string" && input.layer.length > 0 ? input.layer : "0";
        if (this.doc.layerById(layer) === undefined) {
          throw new AnnotationError(`entities[${index}]: layer '${layer}' does not exist`, "bad_layer");
        }
        input.layer = layer;
        // Style names must resolve (text style for content entities; dim
        // style for dimensions).
        const kind = input.type;
        const isDim = kind === "dim-linear" || kind === "dim-radius" || kind === "dim-diameter" || kind === "dim-angular";
        const styleName = typeof input.style === "string" && input.style.length > 0 ? input.style : "Standard";
        if (isDim) {
          if (resolveDimStyle(styleName, this.doc.dimStyleTable) === null) {
            throw new AnnotationError(`entities[${index}]: unknown dim style '${styleName}'`, "bad_style");
          }
        } else if (kind === "text" || kind === "mtext" || kind === "leader" || kind === "mleader") {
          if (resolveTextStyle(styleName, this.doc.textStyleTable) === null) {
            throw new AnnotationError(`entities[${index}]: unknown text style '${styleName}'`, "bad_style");
          }
        } else {
          throw new AnnotationError(
            `entities[${index}]: unknown annotation type '${String(kind)}' (text/mtext/dim-linear/dim-radius/dim-diameter/dim-angular/leader/mleader)`,
            "bad_input",
          );
        }
        // Server-side measurement for referenced targets.
        let annotation: Annotation;
        switch (kind) {
          case "dim-radius":
          case "dim-diameter": {
            const target = typeof input.target === "string" ? input.target : "";
            const targetEl = byId.get(target);
            if (targetEl === undefined) {
              throw new AnnotationError(
                `entities[${index}]: ${String(kind)}.target '${target}' does not exist (create the geometry first, then dimension it)`,
                "bad_ref",
              );
            }
            const circle = circleGeomOf(targetEl);
            if (circle === null) {
              throw new AnnotationError(
                `entities[${index}]: ${String(kind)}.target '${target}' must be a circle or arc`,
                "bad_ref",
              );
            }
            input.center = circle.center;
            input.radius = circle.radius;
            input.measured = kind === "dim-radius" ? circle.radius : 2 * circle.radius;
            annotation = kind === "dim-radius" ? makeDimRadius(input) : makeDimDiameter(input);
            break;
          }
          case "dim-linear": {
            if (Array.isArray(input.refs)) {
              // Refs re-resolve p1/p2 SERVER-side (the references are the
              // truth; client p1/p2 are ignored).
              let p1x: unknown = undefined;
              let p2x: unknown = undefined;
              for (const [ri, refRaw] of (input.refs as unknown[]).entries()) {
                if (typeof refRaw !== "object" || refRaw === null) {
                  throw new AnnotationError(`entities[${index}].refs[${ri}] must be an object`, "bad_input");
                }
                const ref = refRaw as Record<string, unknown>;
                const targetEl = byId.get(typeof ref.id === "string" ? ref.id : "");
                if (targetEl === undefined) {
                  throw new AnnotationError(`entities[${index}].refs[${ri}]: target '${String(ref.id)}' does not exist`, "bad_ref");
                }
                const anchor = resolveAnchor(targetEl, ref.anchor as "start" | "end" | "center" | "midpoint");
                if (anchor === null) {
                  throw new AnnotationError(
                    `entities[${index}].refs[${ri}]: target '${String(ref.id)}' does not carry the '${String(ref.anchor)}' anchor`,
                    "bad_ref",
                  );
                }
                if (ref.to === "p1") p1x = anchor;
                else if (ref.to === "p2") p2x = anchor;
                else {
                  throw new AnnotationError(`entities[${index}].refs[${ri}].to must be p1 or p2 for dim-linear`, "bad_input");
                }
              }
              if (p1x === undefined || p2x === undefined) {
                throw new AnnotationError(
                  `entities[${index}]: dim-linear with refs needs one p1 ref and one p2 ref`,
                  "bad_ref",
                );
              }
              input.p1 = p1x;
              input.p2 = p2x;
              delete input.measured;
            }
            annotation = makeDimLinear(input);
            break;
          }
          case "dim-angular": {
            if (Array.isArray(input.refs)) {
              for (const [ri, refRaw] of (input.refs as unknown[]).entries()) {
                if (typeof refRaw !== "object" || refRaw === null) {
                  throw new AnnotationError(`entities[${index}].refs[${ri}] must be an object`, "bad_input");
                }
                const ref = refRaw as Record<string, unknown>;
                const targetEl = byId.get(typeof ref.id === "string" ? ref.id : "");
                if (targetEl === undefined) {
                  throw new AnnotationError(`entities[${index}].refs[${ri}]: target '${String(ref.id)}' does not exist`, "bad_ref");
                }
                if (resolveAnchor(targetEl, ref.anchor as "start" | "end" | "center" | "midpoint") === null) {
                  throw new AnnotationError(
                    `entities[${index}].refs[${ri}]: target '${String(ref.id)}' does not carry the '${String(ref.anchor)}' anchor`,
                    "bad_ref",
                  );
                }
              }
            }
            annotation = makeDimAngular(input);
            break;
          }
          case "text":
            annotation = makeText(input);
            break;
          case "mtext":
            annotation = makeMText(input);
            break;
          case "leader":
            annotation = makeLeader(input);
            break;
          case "mleader":
            annotation = makeMLeader(input);
            break;
          default:
            throw new AnnotationError(`entities[${index}]: unknown annotation type '${String(kind)}'`, "bad_input");
        }
        // Display overrides on creation (the entity.create rules).
        const props: Record<string, unknown> = annotationToProps(annotation);
        for (const key of ["color", "linetype", "lineweight", "transparency"] as const) {
          const v = (input as Record<string, unknown>)[key];
          if (v === undefined || v === "ByLayer") continue;
          if (key === "color") {
            if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) {
              throw new AnnotationError(`entities[${index}]: color must be 'ByLayer' or #RRGGBB`, "bad_input");
            }
          } else if (key === "linetype") {
            if (typeof v !== "string" || v.length === 0) {
              throw new AnnotationError(`entities[${index}]: linetype must be 'ByLayer' or a linetype name`, "bad_input");
            }
            if (!this.ltypeResolves(v)) {
              throw new AnnotationError(`entities[${index}]: unknown linetype '${v}'`, "bad_linetype");
            }
          } else if (key === "lineweight") {
            if (typeof v !== "number" || !Number.isFinite(v) || !(STANDARD_LINEWEIGHTS as readonly number[]).some((w) => Math.abs(w - v) < 1e-9)) {
              throw new AnnotationError(`entities[${index}]: lineweight must be 'ByLayer' or a standard lineweight (mm)`, "bad_input");
            }
          } else {
            if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 90) {
              throw new AnnotationError(`entities[${index}]: transparency must be 'ByLayer' or an integer 0–90`, "bad_input");
            }
          }
          props[key] = v;
        }
        edits.push({
          type: "addElement",
          element: { id: "", kind: "annotation", engineId: null, props },
        });
        summaries.push(String(kind));
      }
      if (edits.length === 0) {
        return ok({ applied: false, reason: "nothing to create", snapshot: this.doc.snapshot() });
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({
        applied: true,
        summary: `${edits.length} annotation${edits.length === 1 ? "" : "s"} created`,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof AnnotationError) return err(e.code, e.message, false);
      return err("annotation_invalid", (e as Error).message, false);
    }
  }

  /** annotation.update — patch annotation content/style/placement fields
   *  over a batch of annotations as ONE atomic revision. Applicable fields
   *  are validated per TYPE (a field that does not apply is a typed
   *  failure); null RESETS an optional field to its default; display
   *  overrides + layer are preserved (entity.setDisplay owns those). */
  private cmdAnnotationUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || !Array.isArray(p.ids) || p.ids.length === 0 ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "annotation.update requires ids + patch", true);
    }
    try {
      const elements = this.doc.allElements();
      const byId = new Map(elements.map((el) => [el.id, el] as const));
      const patch = { ...(p.patch as Record<string, unknown>) };
      const edits: DocumentEdit[] = [];
      for (const id of p.ids as string[]) {
        const el = byId.get(id);
        if (el === undefined) {
          throw new AnnotationError(`annotation '${id}' does not exist`, "bad_id");
        }
        const current = annotationFromElement(el);
        if (current === null) {
          throw new AnnotationError(`element '${id}' is not a CAD-PARITY-005 annotation`, "bad_annotation");
        }
        const allowed = AppApiHandler.annotationPatchFields(current.type);
        for (const key of Object.keys(patch)) {
          if (!(allowed as readonly string[]).includes(key)) {
            throw new AnnotationError(
              `annotation.update: field '${key}' does not apply to '${current.type}' (allowed: ${allowed.join(", ")})`,
              "bad_input",
            );
          }
        }
        // Style references must resolve.
        if (patch.style !== undefined && patch.style !== null) {
          const isDim = current.type.startsWith("dim-");
          const resolves = isDim
            ? resolveDimStyle(String(patch.style), this.doc.dimStyleTable) !== null
            : resolveTextStyle(String(patch.style), this.doc.textStyleTable) !== null;
          if (!resolves) {
            throw new AnnotationError(`annotation.update: unknown ${isDim ? "dim" : "text"} style '${String(patch.style)}'`, "bad_style");
          }
        }
        // Merge the patch into the current props; null RESETS optional
        // fields (drop the key); re-validate through the constructors.
        const props: Record<string, unknown> = { ...annotationToProps(current) };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete props[key];
          else props[key] = value;
        }
        // Re-validate: the merged record must construct cleanly.
        const updated = elementToAnnotation({ id, kind: "annotation", engineId: null, props });
        void updated;
        // Preserve the CAD-PARITY-004 display overrides + layer through the
        // full-record rewrite.
        for (const key of ["color", "linetype", "lineweight", "transparency"] as const) {
          const v = (el.props as Record<string, unknown>)[key];
          if (v !== undefined) props[key] = v;
        }
        edits.push({ type: "setProps", elementId: id, patch: props });
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({
        applied: true,
        summary: `${edits.length} annotation${edits.length === 1 ? "" : "s"} updated`,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof AnnotationError) return err(e.code, e.message, false);
      return err("annotation_invalid", (e as Error).message, false);
    }
  }

  /** annotation.remeasure — re-run the associative measurement for the
   *  given annotation ids (or EVERY dimension annotation when ids is
   *  absent/empty). One atomic batch; disassociated dimensions keep their
   *  last known values (typed notes in the result). */
  private cmdAnnotationRemeasure(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown } | null;
    const ids = p !== null && typeof p === "object" && Array.isArray(p.ids) ? (p.ids as string[]) : [];
    try {
      const elements = this.doc.allElements();
      const views = annotationViewsOf(elements);
      const selected = ids.length > 0
        ? views.filter((v) => (ids as string[]).includes(v.id))
        : views;
      const missing = ids.filter((id) => !selected.some((v) => v.id === id));
      if (missing.length > 0) {
        return err("bad_id", `annotation.remeasure: '${missing[0]}' is not a CAD-PARITY-005 annotation`, false);
      }
      const cascade = remeasureCascade(selected, elements);
      if (cascade.edits.length === 0) {
        return ok({
          applied: false,
          summary: "all measurements current",
          notes: [],
          snapshot: this.doc.snapshot(),
        });
      }
      this.doc.execute({ type: "applyEdits", edits: cascade.edits });
      return ok({
        applied: true,
        summary: `${cascade.edits.length} annotation${cascade.edits.length === 1 ? "" : "s"} re-measured`,
        notes: cascade.notes,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof AnnotationError) return err(e.code, e.message, false);
      return err("annotation_invalid", (e as Error).message, false);
    }
  }

  /** entity.create — validate + apply ONE atomic create batch of canonical
   *  2D entities (the CAD-2D-001 vocabulary through the shared geometry
   *  kernel; one versioned command, one revision, one undo entry). */
  private cmdEntityCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { entities?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.entities)) {
      return err("bad_payload", "entity.create requires an entities array", true);
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = createEntities(
        this.doc.allElements(),
        (id) => this.doc.layerById(id) !== undefined,
        p.entities,
        (name) => this.ltypeResolves(name),
      );
      if (outcome.edit === null) {
        return ok({ applied: false, reason: outcome.summary, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({ applied: true, created, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      if (e instanceof EntityOpError) return err(e.code, e.message, false);
      return err("entity_invalid", (e as Error).message, false);
    }
  }

  /** entity.modify — apply ONE canonical-geometry modify operation (the
   *  CAD-2D-002 vocabulary: move/copy/rotate/scale/mirror/offset/trim/
   *  extend/stretch/fillet/chamfer/break/join/explode/setGeometry) as a
   *  single atomic revision. CAD-PARITY-006: explode resolves block
   *  instances through the document's block table (the one-level
   *  materialization); move/copy/rotate/scale transform instance
   *  PLACEMENTS inside the same shared op. */
  private cmdEntityModify(payload: unknown): CommandQueryResponse {
    const p = payload as { op?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.op !== "string") {
      return err("bad_payload", "entity.modify requires an op string", true);
    }
    try {
      // CAD-PARITY-006: thread the block-definition table into explode so
      // block instances materialize through the shared expansion.
      const op =
        p.op === "explode"
          ? { ...p, blockDefById: (id: string) => this.doc.blockDefById(id) }
          : p;
      // CAD-PARITY-007: thread the declared constraint graph so the
      // geometry ops run the constraint-aware cascade (severance for
      // re-topologized targets + the deterministic re-solve with
      // fixed-restore — inside the SAME atomic revision).
      const outcome = modifyEntities(this.doc.allElements(), op as never, {
        constraints: this.doc.constraintTable,
      });
      if (outcome.edit === null) {
        return ok({ applied: false, reason: outcome.summary, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({
        applied: true,
        summary: outcome.summary,
        created: outcome.createdCount,
        modified: outcome.modifiedCount,
        removed: outcome.removedCount,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof EntityOpError) return err(e.code, e.message, false);
      return err("entity_invalid", (e as Error).message, false);
    }
  }

  /** The visible canonical entity view shared by the precision queries —
   *  identical filtering to the host renderers so queries and renderers see
   *  one world. CAD-PARITY-004: frozen layers are excluded like hidden ones
   *  (regeneration-class exclusion), and LOCKED layers are excluded from
   *  picking/snapping (AutoCAD-class: locked entities display but do not
   *  interact — modification is blocked at the document gate). */
  private visiblePrecisionEntities() {
    const renderable = new Set(
      this.doc.layerTable.filter((l) => l.visible && l.frozen !== true && l.locked !== true).map((l) => l.id),
    );
    return toPrecisionEntities(
      this.doc.allElements().filter((el) => {
        const layer = (el.props as Record<string, unknown>).layer;
        return typeof layer === "string" && renderable.has(layer);
      }),
    );
  }

  private static readonly OSNAP_MODES: readonly OsnapMode[] = [
    "endpoint",
    "midpoint",
    "center",
    "quadrant",
    "intersection",
    "node",
    "nearest",
    "perpendicular",
    "tangent",
  ];

  /** precision.snap (query) — the SAME resolveSnap the host renderers run
   *  over the SAME visible entity view (parity by construction). */
  private qPrecisionSnap(payload: unknown): CommandQueryResponse {
    const p = payload as {
      cursor?: unknown;
      settings?: unknown;
      lastPoint?: unknown;
    } | null;
    if (
      p === null || typeof p !== "object" ||
      !Array.isArray(p.cursor) || p.cursor.length !== 2 || !p.cursor.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "precision.snap requires cursor: [x, y] finite numbers", true);
    }
    const s = (p.settings ?? {}) as Record<string, unknown>;
    const modes = Array.isArray(s.osnapModes)
      ? (s.osnapModes as unknown[]).filter((m): m is OsnapMode =>
          typeof m === "string" && (AppApiHandler.OSNAP_MODES as readonly string[]).includes(m))
      : [];
    const settings: PrecisionSettings = {
      osnapModes: modes,
      ortho: s.ortho === true,
      polar: s.polar === true,
      polarAnglesDeg: Array.isArray(s.polarAnglesDeg)
        ? (s.polarAnglesDeg as unknown[]).filter((n) => typeof n === "number" && Number.isFinite(n)) as number[]
        : [0, 45, 90, 135, 180, 225, 270, 315],
      gridSnap: s.gridSnap === true,
      gridSize: typeof s.gridSize === "number" && s.gridSize > 0 ? s.gridSize : 10,
      aperture: typeof s.aperture === "number" && s.aperture > 0 ? s.aperture : 10,
      tracking: s.tracking === true,
    };
    const lastPoint = Array.isArray(p.lastPoint) && p.lastPoint.length === 2 && p.lastPoint.every((n) => typeof n === "number" && Number.isFinite(n))
      ? { x: p.lastPoint[0] as number, y: p.lastPoint[1] as number }
      : null;
    try {
      const result = precisionResolveSnap(
        this.visiblePrecisionEntities(),
        { x: p.cursor[0] as number, y: p.cursor[1] as number },
        settings,
        lastPoint,
      );
      return ok(result);
    } catch (e) {
      return err("precision_failed", (e as Error).message, false);
    }
  }

  /** precision.pick (query) — deterministic entity pick under the cursor. */
  private qPrecisionPick(payload: unknown): CommandQueryResponse {
    const p = payload as { cursor?: unknown; aperture?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      !Array.isArray(p.cursor) || p.cursor.length !== 2 || !p.cursor.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "precision.pick requires cursor: [x, y] finite numbers", true);
    }
    const aperture = typeof p.aperture === "number" && p.aperture > 0 ? p.aperture : 10;
    const hit = precisionPickAt(
      this.visiblePrecisionEntities(),
      { x: p.cursor[0] as number, y: p.cursor[1] as number },
      aperture,
    );
    return ok(hit === null ? { id: null } : { id: hit.id, type: hit.geom.type, layer: hit.layer });
  }

  /** precision.window (query) — deterministic window/crossing selection. */
  private qPrecisionWindow(payload: unknown): CommandQueryResponse {
    const p = payload as { mode?: unknown; min?: unknown; max?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      (p.mode !== "window" && p.mode !== "crossing") ||
      !Array.isArray(p.min) || p.min.length !== 2 || !p.min.every((n) => typeof n === "number" && Number.isFinite(n)) ||
      !Array.isArray(p.max) || p.max.length !== 2 || !p.max.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "precision.window requires mode ('window'|'crossing') and min/max: [x, y] finite numbers", true);
    }
    const ids = precisionSelectWindow(this.visiblePrecisionEntities(), {
      mode: p.mode as "window" | "crossing",
      min: { x: p.min[0] as number, y: p.min[1] as number },
      max: { x: p.max[0] as number, y: p.max[1] as number },
    });
    return ok({ ids });
  }

  // --- COMPAT-CAD-002 (additive): 3D/BIM authoring -----------------------------

  /** bim.createElements — validate + apply ONE atomic create batch (one
   *  versioned command, one revision, one undo entry). Element ids are minted
   *  by the document; the response reports the created ids. */
  private cmdBimCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { entities?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.entities)) {
      return err("bad_payload", "bim.createElements requires an entities array", true);
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = buildBimCreate(this.doc.allElements(), p.entities);
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({ created, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /** bim.move / bim.copy — translate / duplicate + declared hosted cascades. */
  private cmdBimTransform(payload: unknown, op: "move" | "copy"): CommandQueryResponse {
    const p = payload as { ids?: unknown; dx?: unknown; dy?: unknown; dz?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", `bim.${op} requires an ids string array`, true);
    }
    if (
      typeof p.dx !== "number" || !Number.isFinite(p.dx) ||
      typeof p.dy !== "number" || !Number.isFinite(p.dy) ||
      typeof p.dz !== "number" || !Number.isFinite(p.dz)
    ) {
      return err("bad_payload", `bim.${op} requires finite dx/dy/dz`, true);
    }
    try {
      const outcome = op === "move"
        ? moveBimElements(this.doc.allElements(), p.ids as string[], p.dx, p.dy, p.dz)
        : copyBimElements(this.doc.allElements(), p.ids as string[], p.dx, p.dy, p.dz, () => this.doc.mintElementId());
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      const before = new Set(this.doc.allElements().map((el) => el.id));
      this.doc.execute(outcome.edit);
      const created = op === "copy"
        ? this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id)
        : [];
      return ok({ applied: true, summary: outcome.summary, created, snapshot: this.doc.snapshot() });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("supported set")) {
        return err("bim_unsupported", message, false);
      }
      return err("bim_invalid", message, false);
    }
  }

  /** bim.delete — remove atomically (declared hosted cascades, itemized). */
  private cmdBimDelete(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "bim.delete requires an ids string array", true);
    }
    try {
      const outcome = deleteBimElements(this.doc.allElements(), p.ids as string[]);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /** bim.setProperties — whitelisted semantic property edits (merged +
   *  re-validated through the strict constructors). */
  private cmdBimSetProperties(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.elementId !== "string" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "bim.setProperties requires elementId + patch", true);
    }
    try {
      const outcome = setBimProperties(this.doc.allElements(), p.elementId, p.patch as Record<string, unknown>);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /** bim.setSettings — replace the non-versioned BIM workspace settings
   *  (camera preset), with a one-level merge like drafting.setSettings. */
  private cmdBimSetSettings(payload: unknown): CommandQueryResponse {
    const p = payload as { settings?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.settings !== "object" || p.settings === null) {
      return err("bad_payload", "bim.setSettings requires a settings object", true);
    }
    try {
      const cur = this.doc.bimSettings;
      const incoming = p.settings as Record<string, unknown>;
      const merged = {
        ...cur,
        ...incoming,
        camera: { ...cur.camera, ...((incoming.camera as object) ?? {}) },
      };
      const settings = validateBimSettings(merged);
      this.doc.setBimSettings(settings);
      return ok({ settings: this.doc.bimSettings, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /**
   * bim.buildGeometry — realize BIM element solids through the bound geometry
   * engine adapter (LOCK-003/018 — the only engine touchpoint, exactly like
   * geometry.prepare). For every addressed BIM element the pure core derives
   * the engine-independent descriptor; the adapter realizes it; the results
   * (meshToken + bbox + engine provenance) attach through ONE atomic
   * versioned batch, so engine realization is itself an immutable, replayable
   * revision. Elements without a solid (stories) are skipped with honest
   * reasons — never silently approximated.
   */
  private async cmdBimBuildGeometry(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { ids?: unknown } | null;
    if (p !== null && typeof p === "object" && p.ids !== undefined) {
      if (!Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
        return err("bad_payload", "bim.buildGeometry ids must be a string array when present", true);
      }
    }
    const ids = p !== null && typeof p === "object" && Array.isArray(p.ids) ? (p.ids as string[]) : null;
    const elements = this.doc.allElements();
    const allEntities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    // CAD-PARITY-011: the DETERMINISTIC ACTIVE-OPTION behavior — elements
    // whose option-group membership is INACTIVE (their group's activeOption
    // differs from their option) are excluded from geometry realization with
    // an explicit reason (never deleted, never silently built). The group
    // registry resolves over the FULL document, not the addressed subset.
    const optionGroups = new Map(
      allEntities
        .filter((x) => x.type === "bim.optionGroup")
        .map((g) => [g.id, g] as const),
    );
    const entities: NonNullable<ReturnType<typeof elementToBimEntityOrNull>>[] = [];
    const inactiveSkipped: { elementId: string; reason: string }[] = [];
    for (const entity of allEntities) {
      if (ids !== null && !ids.includes(entity.id)) continue;
      const meta = entity.meta;
      if (meta?.optionGroupId !== undefined && meta.option !== undefined) {
        const group = optionGroups.get(meta.optionGroupId);
        if (group !== undefined && group.type === "bim.optionGroup" && group.activeOption !== meta.option) {
          inactiveSkipped.push({
            elementId: entity.id,
            reason: `design-option member of group '${group.id}' option '${meta.option}' — the active option is '${group.activeOption}' (excluded from the build; set the active option or clear the membership to build it)`,
          });
          continue;
        }
      }
      entities.push(entity);
    }
    if (entities.length === 0 && inactiveSkipped.length === 0) {
      return err("bad_payload", "bim.buildGeometry found no BIM elements to build", true);
    }
    const ctx = bimGeometryContext(allEntities);
    interface BuildResult {
      readonly elementId: string;
      readonly meshToken: string;
      readonly bbox: readonly [number, number, number, number, number, number];
      readonly engine: { readonly engineId: string; readonly engineVersion: string };
    }
    const results: BuildResult[] = [];
    const skipped: { elementId: string; reason: string }[] = [];
    const edits: DocumentEdit[] = [];
    for (const entity of entities) {
      const { descriptor, reason } = bimSolidDescriptor(entity, ctx);
      if (descriptor === null) {
        skipped.push({ elementId: entity.id, reason });
        continue;
      }
      const element: Element = { id: "bim:build", kind: "bim", engineId: null, props: descriptor as Record<string, unknown> };
      let realized: { meshToken: string; bbox: readonly [number, number, number, number, number, number] };
      try {
        realized = await this.adapters.geometry.prepareGeometry(element);
      } catch (e) {
        if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
        return err("engine_error", `geometry adapter failed: ${(e as Error).message}`, false);
      }
      if (
        typeof realized !== "object" || realized === null ||
        typeof realized.meshToken !== "string" || realized.meshToken.length === 0 ||
        !Array.isArray(realized.bbox) || realized.bbox.length !== 6 ||
        !realized.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        return err("engine_error", "geometry adapter returned an invalid GeometryResult", false);
      }
      results.push({
        elementId: entity.id,
        meshToken: realized.meshToken,
        bbox: realized.bbox,
        engine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
      });
      edits.push({
        type: "updateElement",
        elementId: entity.id,
        patch: {
          meshToken: realized.meshToken,
          meshBBox: [...realized.bbox],
          geometryEngine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
        },
      });
    }
    if (edits.length > 0) {
      try {
        this.doc.execute({ type: "applyEdits", edits });
      } catch (e) {
        return err("edit_failed", (e as Error).message, false);
      }
    }
    return ok({ built: results.length, results, skipped: [...skipped, ...inactiveSkipped], snapshot: this.doc.snapshot() });
  }

  /** bim.getBuilding (query) — the story→elements structure with semantic
   *  summaries, deterministically ordered (stories by level then id;
   *  walls/slabs/spaces/openings/fills by id). */
  private qBimGetBuilding(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const ctx = bimGeometryContext(entities);
    const stories = entities
      .filter((x) => x.type === "bim.story")
      .sort((a, b) =>
        a.level !== b.level ? a.level - b.level : a.id < b.id ? -1 : 1,
      );
    const byStory = (type: string) =>
      entities
        .filter((x) => x.type === type && x.type !== "bim.story")
        .filter((x) => (x as { storyId?: unknown }).storyId !== undefined)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    const building = stories.map((story) => {
      const hosted = (type: string) => byStory(type).filter((x) => (x as { storyId: string }).storyId === story.id);
      const walls = hosted("bim.wall").map((wall) => ({
        ...extractElementSemanticsSafe(elements.find((el) => el.id === wall.id)!)!,
        openings: (ctx.openingsByHost.get(wall.id) ?? []).map((opening) => ({
          ...extractElementSemanticsSafe(elements.find((el) => el.id === opening.id)!)!,
          fills: entities
            .filter((x) => (x.type === "bim.door" || x.type === "bim.window") && x.openingId === opening.id)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((fill) => extractElementSemanticsSafe(elements.find((el) => el.id === fill.id)!)!),
        })),
      }));
      return {
        story: extractElementSemanticsSafe(elements.find((el) => el.id === story.id)!)!,
        walls,
        slabs: hosted("bim.slab").map((slab) => extractElementSemanticsSafe(elements.find((el) => el.id === slab.id)!)!),
        spaces: hosted("bim.space").map((space) => extractElementSemanticsSafe(elements.find((el) => el.id === space.id)!)!),
        // CAD-PARITY-011 (additive, Issue #97): the Archicad-class authoring
        // inventory — roofs and stairs hosted on the story (stairs also
        // report their top story), with hosted railings nested under their
        // stair (the stair→railing host relationship).
        roofs: hosted("bim.roof").map((roof) => extractElementSemanticsSafe(elements.find((el) => el.id === roof.id)!)!),
        stairs: hosted("bim.stair").map((stair) => ({
          ...extractElementSemanticsSafe(elements.find((el) => el.id === stair.id)!)!,
          railings: entities
            .filter((x) => x.type === "bim.railing" && x.hostId === stair.id)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((railing) => extractElementSemanticsSafe(elements.find((el) => el.id === railing.id)!)!),
        })),
      };
    });
    // CAD-PARITY-011: the zones (with their member spaces' semantics) and
    // the option groups (registry + active state), deterministically ordered.
    const zones = entities
      .filter((x) => x.type === "bim.zone")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((zone) => ({
        ...extractElementSemanticsSafe(elements.find((el) => el.id === zone.id)!)!,
        spaces: zone.spaceIds.map(
          (spaceId) => extractElementSemanticsSafe(elements.find((el) => el.id === spaceId)!)!,
        ),
      }));
    const optionGroups = entities
      .filter((x) => x.type === "bim.optionGroup")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((group) => ({
        ...extractElementSemanticsSafe(elements.find((el) => el.id === group.id)!)!,
        members: entities
          .filter((x) => x.meta?.optionGroupId === group.id)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((member) => ({
            elementId: member.id,
            type: member.type,
            option: member.meta?.option,
          })),
      }));
    return ok({ stories: building, zones, optionGroups, bimSettings: this.doc.bimSettings });
  }

  // --- CAD-PARITY-011 (additive, Issue #97): the meta/lifecycle commands ---

  /** The shared single-element lifecycle edit runner: validate + apply ONE
   *  atomic updateElement batch (one versioned command, one revision, one
   *  undo entry — the editops precedent). */
  private runBimLifecycleEdit(
    payload: unknown,
    op: string,
    build: (elements: readonly Element[], elementId: string) => ReturnType<typeof setBimClassification>,
    requiredFields: string,
  ): CommandQueryResponse {
    const p = payload as { elementId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0) {
      return err("bad_payload", `bim.${op} requires ${requiredFields}`, true);
    }
    try {
      const outcome = build(this.doc.allElements(), p.elementId);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("not supported on") || message.includes("outside the supported set")) {
        return err("bim_unsupported", message, false);
      }
      return err("bim_invalid", message, false);
    }
  }

  /** bim.setClassification — set (or clear with null) the canonical
   *  classification reference of one BIM element. */
  private cmdBimSetClassification(payload: unknown): CommandQueryResponse {
    const p = payload as { classificationRef?: unknown } | null;
    const ref = (p as { classificationRef?: unknown } | null)?.classificationRef;
    if (ref !== null && typeof ref !== "string") {
      return err("bad_payload", "bim.setClassification requires elementId + classificationRef (string or null)", true);
    }
    return this.runBimLifecycleEdit(
      payload,
      "setClassification",
      (elements, elementId) => setBimClassification(elements, elementId, ref as string | null),
      "elementId + classificationRef (string or null)",
    );
  }

  /** bim.setPropertySets — replace the structured property sets of one
   *  BIM element wholesale ([] clears them). */
  private cmdBimSetPropertySets(payload: unknown): CommandQueryResponse {
    const p = payload as { propertySets?: unknown } | null;
    if (!Array.isArray((p as { propertySets?: unknown } | null)?.propertySets)) {
      return err("bad_payload", "bim.setPropertySets requires elementId + a propertySets array", true);
    }
    return this.runBimLifecycleEdit(
      payload,
      "setPropertySets",
      (elements, elementId) => setBimPropertySets(elements, elementId, (p as { propertySets: unknown }).propertySets),
      "elementId + a propertySets array",
    );
  }

  /** bim.setRenovation — set the bounded renovation lifecycle state of one
   *  BIM element (existing | new | to-be-demolished; eligible types only). */
  private cmdBimSetRenovation(payload: unknown): CommandQueryResponse {
    const p = payload as { status?: unknown } | null;
    if (typeof (p as { status?: unknown } | null)?.status !== "string") {
      return err("bad_payload", "bim.setRenovation requires elementId + status ('existing' | 'new' | 'to-be-demolished')", true);
    }
    return this.runBimLifecycleEdit(
      payload,
      "setRenovation",
      (elements, elementId) => setBimRenovation(elements, elementId, (p as { status: string }).status),
      "elementId + status ('existing' | 'new' | 'to-be-demolished')",
    );
  }

  /** bim.setOptionMembership — set (or clear with nulls) the design-option
   *  membership pair of one BIM element. */
  private cmdBimSetOptionMembership(payload: unknown): CommandQueryResponse {
    const p = payload as { optionGroupId?: unknown; option?: unknown } | null;
    const groupId = (p as { optionGroupId?: unknown } | null)?.optionGroupId;
    const option = (p as { option?: unknown } | null)?.option;
    if (groupId !== null && typeof groupId !== "string") {
      return err("bad_payload", "bim.setOptionMembership requires elementId + optionGroupId/option (strings or nulls)", true);
    }
    if (option !== null && typeof option !== "string") {
      return err("bad_payload", "bim.setOptionMembership requires elementId + optionGroupId/option (strings or nulls)", true);
    }
    return this.runBimLifecycleEdit(
      payload,
      "setOptionMembership",
      (elements, elementId) => setBimOptionMembership(elements, elementId, groupId as string | null, option as string | null),
      "elementId + optionGroupId/option (strings or nulls)",
    );
  }

  /** bim.setActiveOption — set the ACTIVE option of an option group (the
   *  deterministic active-option behavior: inactive members are excluded
   *  from builds with explicit reasons — never deleted). */
  private cmdBimSetActiveOption(payload: unknown): CommandQueryResponse {
    const p = payload as { optionGroupId?: unknown; option?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      typeof p.optionGroupId !== "string" || typeof p.option !== "string"
    ) {
      return err("bad_payload", "bim.setActiveOption requires optionGroupId + option", true);
    }
    try {
      const outcome = setBimActiveOption(this.doc.allElements(), p.optionGroupId, p.option);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-011 (additive, Issue #97): the meta/lifecycle queries ---

  /** bim.getClassification (query) — the canonical classification table
   *  (the CLOSED vocabulary; codes in deterministic sorted order). */
  private qBimGetClassification(): CommandQueryResponse {
    const table = BIM_CLASSIFICATION_CODES.map((code) => ({
      code,
      label: BIM_CLASSIFICATION_TABLE[code]!.label,
      appliesTo: BIM_CLASSIFICATION_TABLE[code]!.appliesTo,
    }));
    return ok({ codes: table });
  }

  /** bim.getOptions (query) — the option-group registry with the active
   *  option and the members per option (deterministic ordering throughout).
   *  The ACTIVE-option behavior is observable here: each group reports its
   *  activeOption and every member's option. */
  private qBimGetOptions(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const groups = entities
      .filter((x) => x.type === "bim.optionGroup")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const registry = groups.map((group) => {
      const members = entities
        .filter((x) => x.meta?.optionGroupId === group.id)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      return {
        elementId: group.id,
        name: group.name,
        options: group.options,
        activeOption: group.activeOption,
        description: group.description,
        membersByOption: group.options.map((option) => ({
          option,
          active: option === group.activeOption,
          memberIds: members.filter((m) => m.meta?.option === option).map((m) => m.id),
        })),
      };
    });
    return ok({ groups: registry });
  }

  /** bim.getLifecycle (query) — the lifecycle (renovation + option) state of
   *  the BIM elements: one record per element with the EFFECTIVE renovation
   *  status (the derived default "existing") and the option membership + the
   *  membership's active/inactive state against its group. Optional
   *  elementId narrows to one element. */
  private qBimGetLifecycle(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown } | null;
    if (p !== null && typeof p === "object" && p.elementId !== undefined && typeof p.elementId !== "string") {
      return err("bad_payload", "bim.getLifecycle elementId must be a string when present", true);
    }
    const narrow = p !== null && typeof p === "object" && typeof p.elementId === "string" ? p.elementId : null;
    const elements = this.doc.allElements();
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((x) => narrow === null || x.id === narrow);
    const groups = new Map(
      entities
        .filter((x) => x.type === "bim.optionGroup")
        .map((g) => [g.id, g] as const),
    );
    const records = entities
      .filter((x) => x.type !== "bim.optionGroup" || narrow !== null)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((entity) => {
        const meta: BimElementMeta | undefined = entity.meta;
        const group = meta?.optionGroupId !== undefined ? groups.get(meta.optionGroupId) : undefined;
        return {
          elementId: entity.id,
          type: entity.type,
          renovationStatus: effectiveRenovationStatus(meta),
          ...(meta?.classificationRef !== undefined ? { classificationRef: meta.classificationRef } : {}),
          ...(meta?.propertySets !== undefined && meta.propertySets.length > 0 ? { propertySets: meta.propertySets } : {}),
          ...(meta?.optionGroupId !== undefined && meta.option !== undefined
            ? {
                optionGroupId: meta.optionGroupId,
                option: meta.option,
                optionActive: group !== undefined && group.type === "bim.optionGroup" ? group.activeOption === meta.option : false,
              }
            : {}),
        };
      });
    if (narrow !== null && records.length === 0) {
      return err("bad_payload", `bim.getLifecycle: no element '${narrow}'`, true);
    }
    return ok({ elements: records });
  }

  /** bim.getComponents (COMPAT-BIM-003, query) — the component/material/
   *  coordination inventory with DERIVED state: every instance reports its
   *  effective parameters (definition defaults ⊕ overrides) and effective
   *  material — the observable result of deterministic parametric
   *  propagation. Deterministic ordering (by id) throughout. */
  private qBimGetComponents(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const definitions = new Map<string, ComponentDefEntity>();
    for (const entity of entities) {
      if (entity.type === "bim.componentDef") definitions.set(entity.id, entity);
    }
    const materials = entities
      .filter((x): x is MaterialEntity => x.type === "bim.material")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((material) => ({
        elementId: material.id,
        name: material.name,
        ...(material.description !== undefined ? { description: material.description } : {}),
        ...(material.color !== undefined ? { color: material.color } : {}),
        properties: material.properties,
      }));
    const definitionRecords = [...definitions.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((def) => ({
        elementId: def.id,
        name: def.name,
        category: def.category,
        parameters: def.parameters,
        ...(def.materialId !== undefined ? { materialId: def.materialId } : {}),
      }));
    const instances: unknown[] = [];
    for (const entity of entities) {
      if (entity.type !== "bim.componentInstance") continue;
      const definition = definitions.get(entity.definitionId);
      if (definition === undefined) {
        return err(
          "bim_invalid",
          `component instance '${entity.id}' references missing definition '${entity.definitionId}' (stored props are inconsistent)`,
          false,
        );
      }
      instances.push({
        elementId: entity.id,
        definitionId: entity.definitionId,
        ...(entity.name !== undefined ? { name: entity.name } : {}),
        storyId: entity.storyId,
        position: entity.position,
        rotation: entity.rotation,
        baseOffset: entity.baseOffset,
        overrides: entity.overrides,
        effectiveParameters: effectiveParameters(definition, entity),
        effectiveBox: effectiveBox(definition, entity),
        effectiveMaterialId: effectiveMaterialId(definition, entity),
        ...(entity.materialId !== undefined ? { materialId: entity.materialId } : {}),
      });
    }
    instances.sort((a, b) => ((a as { elementId: string }).elementId < (b as { elementId: string }).elementId ? -1 : 1));
    const grids = entities
      .filter((x): x is GridEntity => x.type === "bim.grid")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((grid) => ({
        elementId: grid.id,
        storyId: grid.storyId,
        name: grid.name,
        uLines: grid.uLines,
        vLines: grid.vLines,
      }));
    const referencePlanes = entities
      .filter((x): x is ReferencePlaneEntity => x.type === "bim.referencePlane")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((plane) => ({
        elementId: plane.id,
        storyId: plane.storyId,
        name: plane.name,
        start: plane.start,
        end: plane.end,
      }));
    return ok({
      materials,
      definitions: definitionRecords,
      instances,
      grids,
      referencePlanes,
      // Declared unsupported set (LOCK-007): alignment constraints and
      // full parametric constraint solving are outside this slice.
      unsupported: {
        alignmentConstraints: "alignment constraints are outside the supported set of this slice",
      },
    });
  }

  /** bim.getSemantics (query) — extracted semantic records (all BIM elements,
   *  or one by elementId). */
  private qBimGetSemantics(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown } | null;
    if (p !== null && typeof p === "object" && p.elementId !== undefined) {
      if (typeof p.elementId !== "string") {
        return err("bad_payload", "bim.getSemantics elementId must be a string", true);
      }
      const el = this.doc.elementById(p.elementId);
      if (el === undefined) {
        return err("bad_payload", `bim.getSemantics: no element '${p.elementId}'`, true);
      }
      const record = extractElementSemanticsSafe(el);
      if (record === null) {
        return err("bim_invalid", `element '${p.elementId}' carries no BIM semantics`, false);
      }
      return ok(record);
    }
    const records = this.doc
      .allElements()
      .map((el) => extractElementSemanticsSafe(el))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.elementId < b.elementId ? -1 : 1));
    return ok({ semantics: records });
  }

  /** bim.camera (query) — the standard camera for a preset, derived from the
   *  model's analytic world bbox (pure, engine-free; identical on both hosts). */
  private qBimCamera(payload: unknown): CommandQueryResponse {
    const p = payload as { preset?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.preset !== "string") {
      return err("bad_payload", "bim.camera requires a preset string", true);
    }
    const entities = this.doc
      .allElements()
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const bbox = bimModelBBox(entities, bimGeometryContext(entities));
    try {
      const camera = standardCamera(p.preset, bbox);
      return ok({ camera, bbox });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-012 (additive, Issue #102): materials, grids, revcloud ---
  // Typed-error convention: material_bad_payload / grid_bad_payload /
  // revcloud_bad_payload = payload shape failures; material_invalid /
  // grid_invalid / revcloud_invalid = semantic validation failures;
  // material_exists / material_not_found / material_in_use /
  // grid_not_found = the reference-integrity codes. All explicit, no silent
  // approximation (LOCK-007). One payload = ONE atomic revision = one undo
  // entry throughout.

  /** The document's material entities (bim.material elements, id-sorted). */
  private bimMaterialEntities(): MaterialEntity[] {
    return this.doc
      .allElements()
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is MaterialEntity => x !== null && x.type === "bim.material")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The document's grid entities (bim.grid elements, id-sorted). */
  private bimGridEntities(): GridEntity[] {
    return this.doc
      .allElements()
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is GridEntity => x !== null && x.type === "bim.grid")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The block/xref table view the shared blocks expansion needs. */
  private blockTable(): { blockDefById: (id: string) => BlockDefinitionRecord | undefined; xrefById: (id: string) => XrefRecord | undefined } {
    return {
      blockDefById: (id: string) => this.doc.blockDefById(id),
      xrefById: (id: string) => this.doc.xrefById(id),
    };
  }

  /** material.create — validate + apply ONE atomic create through the bim
   *  createElement path (one revision, one undo entry; ids minted by the
   *  document). Absent color resolves to the deterministic category default. */
  private cmdMaterialCreate(payload: unknown): CommandQueryResponse {
    const p = payload as {
      name?: unknown;
      category?: unknown;
      color?: unknown;
      lineweight?: unknown;
      density?: unknown;
      description?: unknown;
    } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0) {
      return err("material_bad_payload", "material.create requires a non-empty name", true);
    }
    if (typeof p.category !== "string" || p.category.length === 0) {
      return err(
        "material_bad_payload",
        "material.create requires a category (Concrete|Steel|Masonry|Timber|Glass|Insulation|Finishes|Generic)",
        true,
      );
    }
    const name = p.name.trim();
    let color: readonly [number, number, number] | undefined;
    if (p.color !== undefined && p.color !== null) {
      if (
        !Array.isArray(p.color) || p.color.length !== 3 ||
        !p.color.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 255)
      ) {
        return err("material_invalid", "material.create color must be [r, g, b] integers in 0..255", false);
      }
      color = [p.color[0] as number, p.color[1] as number, p.color[2] as number];
    }
    let lineweight: number = DEFAULT_LINEWEIGHT;
    if (p.lineweight !== undefined && p.lineweight !== null) {
      if (typeof p.lineweight !== "number" || !Number.isFinite(p.lineweight)) {
        return err("material_invalid", "material.create lineweight must be a finite number", false);
      }
      lineweight = p.lineweight;
    }
    let density: number | null = null;
    if (p.density !== undefined && p.density !== null) {
      if (typeof p.density !== "number" || !Number.isFinite(p.density)) {
        return err("material_invalid", "material.create density must be a finite number", false);
      }
      density = p.density;
    }
    const description =
      typeof p.description === "string" && p.description.trim().length > 0 ? p.description.trim() : null;
    if (this.bimMaterialEntities().some((m) => m.name === name)) {
      return err("material_exists", `material name '${name}' is already taken (names are the document-unique exchange key)`, false);
    }
    const validation = validateMaterialFields({
      name,
      category: p.category,
      color: color ?? categoryDefaultColor(p.category),
      lineweight,
      density,
    });
    if (!validation.ok) {
      return err("material_invalid", validation.reason, false);
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = buildBimCreate(this.doc.allElements(), [
        {
          type: "bim.material",
          name,
          properties: {},
          ...(color !== undefined ? { color: [...color] } : {}),
          category: p.category,
          lineweight,
          ...(density !== null ? { density } : {}),
          ...(description !== null ? { description } : {}),
        },
      ]);
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({
        applied: true,
        summary: `material '${name}' (${p.category}) created`,
        materialId: created[0] ?? null,
        created,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("already taken")) return err("material_exists", message, false);
      return err("material_invalid", message, false);
    }
  }

  /** material.update — patch a material through a FULL-RECORD setProps
   *  rewrite (the canonical optional fields stay exactly absent when unset;
   *  null in the patch clears an optional field; the undo inverse restores
   *  the previous record byte-identically). */
  private cmdMaterialUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0 ||
      typeof p.patch !== "object" || p.patch === null || Array.isArray(p.patch)
    ) {
      return err("material_bad_payload", "material.update requires elementId + patch", true);
    }
    const el = this.doc.elementById(p.elementId);
    if (el === undefined || (el.props as Record<string, unknown>).type !== "bim.material") {
      return err("material_not_found", `no material '${p.elementId}'`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    const allowed = ["name", "category", "color", "lineweight", "density", "description"];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) {
        return err(
          "material_invalid",
          `material.update: '${key}' is not a settable material field (allowed: ${allowed.join(", ")})`,
          false,
        );
      }
    }
    if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.trim().length === 0)) {
      return err("material_invalid", "material.update name must be a non-empty string (the exchange key cannot be cleared)", false);
    }
    if (patch.category !== undefined && patch.category !== null && typeof patch.category !== "string") {
      return err("material_invalid", "material.update category must be a category string or null (clear)", false);
    }
    if (
      patch.color !== undefined && patch.color !== null &&
      (!Array.isArray(patch.color) || patch.color.length !== 3 ||
        !patch.color.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 255))
    ) {
      return err("material_invalid", "material.update color must be [r, g, b] integers in 0..255 or null (clear)", false);
    }
    if (
      patch.lineweight !== undefined && patch.lineweight !== null &&
      (typeof patch.lineweight !== "number" || !Number.isFinite(patch.lineweight))
    ) {
      return err("material_invalid", "material.update lineweight must be a finite number or null (clear)", false);
    }
    if (
      patch.density !== undefined && patch.density !== null &&
      (typeof patch.density !== "number" || !Number.isFinite(patch.density))
    ) {
      return err("material_invalid", "material.update density must be a finite number or null (clear)", false);
    }
    if (patch.description !== undefined && patch.description !== null && typeof patch.description !== "string") {
      return err("material_invalid", "material.update description must be a string or null (clear)", false);
    }
    const clearable = new Set(["category", "color", "lineweight", "density", "description"]);
    const merged: Record<string, unknown> = { ...(el.props as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null && clearable.has(key)) {
        delete merged[key];
        continue;
      }
      if (key === "name" && typeof value === "string") {
        merged[key] = value.trim();
        continue;
      }
      if (key === "description" && typeof value === "string") {
        merged.description = value.trim().length > 0 ? value.trim() : undefined;
        if (merged.description === undefined) delete merged.description;
        continue;
      }
      merged[key] = value;
    }
    try {
      const entity = makeMaterial(merged);
      if (entity.name !== (el.props as Record<string, unknown>).name) {
        if (this.bimMaterialEntities().some((m) => m.id !== p.elementId && m.name === entity.name)) {
          return err("material_exists", `material name '${entity.name}' is already taken (names are the document-unique exchange key)`, false);
        }
      }
      const element = bimEntityToElement({ ...entity, id: p.elementId });
      const nextProps = element.props as Record<string, unknown>;
      const prevProps = el.props as Record<string, unknown>;
      if (canonicalStringify(nextProps) === canonicalStringify(prevProps)) {
        return ok({ applied: false, reason: "update: no changes", snapshot: this.doc.snapshot() });
      }
      this.doc.execute({ type: "setProps", elementId: p.elementId, patch: nextProps });
      return ok({
        applied: true,
        summary: `material '${String(prevProps.name)}' updated`,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("material_invalid", (e as Error).message, false);
    }
  }

  /** material.remove — REFERENCE-CHECKED removal (any element's materialId
   *  assignment or any block definition's materialId default blocks the
   *  removal — no cascade, no silent orphaning). */
  private cmdMaterialRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0) {
      return err("material_bad_payload", "material.remove requires elementId", true);
    }
    const el = this.doc.elementById(p.elementId);
    if (el === undefined || (el.props as Record<string, unknown>).type !== "bim.material") {
      return err("material_not_found", `no material '${p.elementId}'`, false);
    }
    const assigned: string[] = [];
    for (const other of this.doc.allElements()) {
      if (other.id !== p.elementId && materialIdOf(other.props as Record<string, unknown>) === p.elementId) {
        assigned.push(other.id);
      }
    }
    const defs: string[] = [];
    for (const def of this.doc.blockDefTable) {
      if (def.materialId === p.elementId) defs.push(def.id);
    }
    if (assigned.length > 0 || defs.length > 0) {
      const refs = [...assigned, ...defs].sort();
      return err(
        "material_in_use",
        `material '${String((el.props as Record<string, unknown>).name)}' is still referenced by ${refs.length} element(s): ${refs.join(", ")} — unassign them first (no silent cascade)`,
        false,
      );
    }
    this.doc.execute({ type: "removeElement", elementId: p.elementId });
    return ok({
      applied: true,
      summary: `material '${String((el.props as Record<string, unknown>).name)}' removed`,
      snapshot: this.doc.snapshot(),
    });
  }

  /** material.assign — assign (or unassign with null) a material to a batch
   *  of elements through FULL-RECORD setProps rewrites in ONE versioned
   *  batch: absence is exactly representable and the undo inverse restores
   *  the previous props byte-identically (no undefined-hole class). */
  private cmdMaterialAssign(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown; materialId?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      !Array.isArray(p.ids) || p.ids.length === 0 || !p.ids.every((x) => typeof x === "string" && x.length > 0)
    ) {
      return err("material_bad_payload", "material.assign requires a non-empty ids string array", true);
    }
    if (p.materialId !== null && typeof p.materialId !== "string") {
      return err("material_bad_payload", "material.assign requires materialId (a material element id) or null (unassign)", true);
    }
    const materialId = p.materialId as string | null;
    if (materialId !== null) {
      const mat = this.doc.elementById(materialId);
      if (mat === undefined || (mat.props as Record<string, unknown>).type !== "bim.material") {
        return err("material_not_found", `no material '${materialId}'`, false);
      }
    }
    const edits: DocumentEdit[] = [];
    for (const id of p.ids as string[]) {
      const el = this.doc.elementById(id);
      if (el === undefined) {
        return err("material_invalid", `no such element: '${id}'`, false);
      }
      // Full-record setProps rewrite: the whole previous props with exactly
      // the materialId binding written (absence restored by the exact
      // inverse — canonical absence, never an undefined hole).
      const props: Record<string, unknown> = { ...(el.props as Record<string, unknown>) };
      if (materialId === null) {
        delete props.materialId;
      } else {
        props.materialId = materialId;
      }
      edits.push({ type: "setProps", elementId: id, patch: props });
    }
    this.doc.execute({ type: "applyEdits", edits });
    const target = materialId !== null
      ? `material '${String((this.doc.elementById(materialId)?.props as Record<string, unknown> | undefined)?.name ?? materialId)}'`
      : "(unassigned)";
    const n = (p.ids as string[]).length;
    return ok({
      applied: true,
      summary: `${n} element${n === 1 ? "" : "s"} assigned to ${target}`,
      assigned: n,
      snapshot: this.doc.snapshot(),
    });
  }

  /** grid.create — validate the full strictly-ascending u/v-set grammar and
   *  apply ONE atomic create through the bim createElement path (one
   *  revision, one undo entry). The story resolves from the explicit id or
   *  the document's single story; the name defaults deterministically. */
  private cmdGridCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; storyId?: unknown; uLines?: unknown; vLines?: unknown } | null;
    if (p === null || typeof p !== "object") {
      return err("grid_bad_payload", "grid.create requires a payload object", true);
    }
    const linesFailure = (value: unknown, axis: "u" | "v"): string | null => {
      if (!Array.isArray(value) || value.length === 0) {
        return `${axis}Lines must be a non-empty array of offsets`;
      }
      if (value.length > 64) {
        return `${axis}Lines exceeds the 64-line bound`;
      }
      for (const [i, x] of value.entries()) {
        if (typeof x !== "number" || !Number.isFinite(x)) {
          return `${axis}Lines[${i}] must be a finite number`;
        }
      }
      for (let i = 1; i < value.length; i++) {
        if ((value[i] as number) <= (value[i - 1] as number)) {
          return `${axis}Lines must be strictly ascending (entry ${i} is not greater than entry ${i - 1}; duplicates are rejected)`;
        }
      }
      return null;
    };
    const uFailure = linesFailure(p.uLines, "u");
    if (uFailure !== null) return err("grid_invalid", uFailure, false);
    const vFailure = linesFailure(p.vLines, "v");
    if (vFailure !== null) return err("grid_invalid", vFailure, false);
    const uLines = p.uLines as number[];
    const vLines = p.vLines as number[];
    // Story resolution: explicit id, else the document's single story.
    let storyId: string | null = null;
    if (p.storyId !== undefined && p.storyId !== null) {
      if (typeof p.storyId !== "string" || p.storyId.length === 0) {
        return err("grid_bad_payload", "grid.create storyId must be a story element id when present", true);
      }
      storyId = p.storyId;
    } else {
      const stories = this.doc
        .allElements()
        .filter((el) => (el.props as Record<string, unknown>).type === "bim.story");
      if (stories.length === 1) {
        storyId = stories[0]!.id;
      }
    }
    if (storyId === null) {
      return err(
        "grid_bad_payload",
        "grid.create requires a storyId (the document carries zero or multiple stories — the grid's host story must be explicit)",
        true,
      );
    }
    // Deterministic default name: Grid N over the existing grid count.
    let name: string;
    if (typeof p.name === "string" && p.name.trim().length > 0) {
      name = p.name.trim();
    } else {
      name = `Grid ${this.bimGridEntities().length + 1}`;
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = buildBimCreate(this.doc.allElements(), [
        { type: "bim.grid", storyId, name, uLines: [...uLines], vLines: [...vLines] },
      ]);
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({
        applied: true,
        summary: `grid '${name}' created (${uLines.length} u-lines, ${vLines.length} v-lines)`,
        gridId: created[0] ?? null,
        created,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("must reference a story")) return err("grid_bad_payload", message, true);
      return err("grid_invalid", message, false);
    }
  }

  /** grid.update — patch a bim.grid element (name / whole-array uLines /
   *  vLines replacements; full re-validation through the strict
   *  constructor). */
  private cmdGridUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.elementId !== "string" || p.elementId.length === 0 ||
      typeof p.patch !== "object" || p.patch === null || Array.isArray(p.patch)
    ) {
      return err("grid_bad_payload", "grid.update requires elementId + patch", true);
    }
    const el = this.doc.elementById(p.elementId);
    if (el === undefined || (el.props as Record<string, unknown>).type !== "bim.grid") {
      return err("grid_not_found", `no grid '${p.elementId}'`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    const allowed = ["name", "uLines", "vLines"];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) {
        return err(
          "grid_invalid",
          `grid.update: '${key}' is not a settable grid field (allowed: ${allowed.join(", ")})`,
          false,
        );
      }
    }
    const linesFailure = (value: unknown, axis: "u" | "v"): string | null => {
      if (!Array.isArray(value) || value.length === 0) {
        return `${axis}Lines must be a non-empty array of offsets`;
      }
      if (value.length > 64) {
        return `${axis}Lines exceeds the 64-line bound`;
      }
      for (const [i, x] of value.entries()) {
        if (typeof x !== "number" || !Number.isFinite(x)) {
          return `${axis}Lines[${i}] must be a finite number`;
        }
      }
      for (let i = 1; i < value.length; i++) {
        if ((value[i] as number) <= (value[i - 1] as number)) {
          return `${axis}Lines must be strictly ascending (entry ${i} is not greater than entry ${i - 1}; duplicates are rejected)`;
        }
      }
      return null;
    };
    if (patch.uLines !== undefined) {
      const failure = linesFailure(patch.uLines, "u");
      if (failure !== null) return err("grid_invalid", failure, false);
    }
    if (patch.vLines !== undefined) {
      const failure = linesFailure(patch.vLines, "v");
      if (failure !== null) return err("grid_invalid", failure, false);
    }
    if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.trim().length === 0)) {
      return err("grid_invalid", "grid.update name must be a non-empty string", false);
    }
    const normalized: Record<string, unknown> = { ...patch };
    if (typeof normalized.name === "string") normalized.name = normalized.name.trim();
    try {
      const outcome = setBimProperties(this.doc.allElements(), p.elementId, normalized);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("grid_invalid", (e as Error).message, false);
    }
  }

  /** revcloud.create — persist the closed scalloped revision-cloud polyline
   *  with the bounded marker "revcloud" as ONE atomic revision. The element
   *  canonical-serializes, open-validates and is excluded from clash. */
  private cmdRevcloudCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { cornerA?: unknown; cornerB?: unknown; layer?: unknown } | null;
    const pointOf = (v: unknown, field: string): { x: number; y: number } | null => {
      if (typeof v !== "object" || v === null) return null;
      const o = v as { x?: unknown; y?: unknown };
      if (typeof o.x !== "number" || !Number.isFinite(o.x) || typeof o.y !== "number" || !Number.isFinite(o.y)) {
        return null;
      }
      void field;
      return { x: o.x, y: o.y };
    };
    if (p === null || typeof p !== "object") {
      return err("revcloud_bad_payload", "revcloud.create requires a payload object", true);
    }
    const cornerA = pointOf(p.cornerA, "cornerA");
    if (cornerA === null) {
      return err("revcloud_bad_payload", "revcloud.create requires cornerA {x, y} finite numbers", true);
    }
    const cornerB = pointOf(p.cornerB, "cornerB");
    if (cornerB === null) {
      return err("revcloud_bad_payload", "revcloud.create requires cornerB {x, y} finite numbers", true);
    }
    if (isDegenerateRect(cornerA, cornerB)) {
      return err(
        "revcloud_invalid",
        "revision cloud corners must span a non-degenerate rectangle (zero width or height has no edge to scallop)",
        false,
      );
    }
    const layer = typeof p.layer === "string" && p.layer.length > 0 ? p.layer : "0";
    if (!this.doc.layerTable.some((l) => l.id === layer)) {
      return err("revcloud_invalid", `layer '${layer}' does not exist`, false);
    }
    const vertices = revisionCloudGeom(cornerA, cornerB);
    const props: Record<string, unknown> = {
      drafting: true,
      type: "polyline",
      layer,
      vertices: vertices.map((v) => ({ x: v.x, y: v.y })),
      closed: true,
      marker: "revcloud",
    };
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      this.doc.execute({
        type: "applyEdits",
        edits: [{ type: "addElement", element: { id: "", kind: "geometry", engineId: null, props } }],
      });
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({
        applied: true,
        summary: `revision cloud created (${vertices.length} vertices on layer '${layer}')`,
        elementId: created[0] ?? null,
        created,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("revcloud_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-012 (additive, Issue #102): the read surfaces ------------

  /** components.list (query) — the component (block-definition) inventory
   *  with the materialId default + instance counts and ids (the
   *  block-ref element scan, id-sorted). */
  private qComponentsList(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const out = [...this.doc.blockDefTable]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((def) => {
        const instanceIds = elements
          .filter((el) => {
            const props = el.props as Record<string, unknown>;
            return props.drafting === true && props.type === "block-ref" && props.blockId === def.id;
          })
          .map((el) => el.id)
          .sort();
        return {
          id: def.id,
          name: def.name,
          materialId: def.materialId ?? null,
          instanceCount: instanceIds.length,
          instanceIds,
        };
      });
    return ok({ components: out });
  }

  /** materials.list (query) — the material table with the parity fields
   *  (absent optional fields omitted entirely — the canonical form). */
  private qMaterialsList(): CommandQueryResponse {
    const materials = this.bimMaterialEntities().map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.category !== undefined ? { category: m.category } : {}),
      ...(m.color !== undefined ? { color: [...m.color] } : {}),
      ...(m.lineweight !== undefined ? { lineweight: m.lineweight } : {}),
      ...(m.density !== undefined ? { density: m.density } : {}),
      ...(m.description !== undefined ? { description: m.description } : {}),
    }));
    return ok({ materials });
  }

  /** materials.bom (query) — the deterministic quantity takeoff over the
   *  concrete 2D view (block instances measure their expanded content as
   *  ONE element; the unassigned row is last). */
  private qMaterialsBom(): CommandQueryResponse {
    const materialsById = new Map(this.bimMaterialEntities().map((m) => [m.id, m] as const));
    const rows = billOfMaterials(this.doc.allElements(), materialsById, this.blockTable());
    return ok({ unit: "document units", rows });
  }

  /** grids.list (query) — the bim.grid entities with DERIVED Excel-style
   *  labels (A, B, C… for u; 1, 2, 3… for v — minted from the sorted line
   *  order, never stored). */
  private qGridsList(): CommandQueryResponse {
    const grids = this.bimGridEntities().map((g) => ({
      id: g.id,
      name: g.name,
      storyId: g.storyId,
      uLines: [...g.uLines],
      vLines: [...g.vLines],
      uLabels: gridULabels(g),
      vLabels: gridVLabels(g),
    }));
    return ok({ grids });
  }

  /** coordination.clash (query) — the deterministic pairwise clash result
   *  over the concrete 2D view (BBox prefilter + the exact kernel; hits map
   *  back to block INSTANCE ids). */
  private qCoordinationClash(): CommandQueryResponse {
    const result = detectClashes({ elements: this.doc.allElements(), blockTable: this.blockTable() });
    return ok(result);
  }

  // --- COMPAT-CAD-003 (additive): documentation commands --------------------
  // Typed-error convention: docs_invalid = validation/consistency failure of
  // documentation content; docs_unsupported = an operation outside this
  // slice's declared vocabulary (e.g. PDF/DWG writers); both explicit, no
  // silent approximation (LOCK-007).

  /** docs.createViews — create view definitions as ONE atomic versioned
   *  batch (one revision, one undo). Ids are minted by the document
   *  (`vw-NNNNNN`) when missing; explicit ids must be unused. */
  private cmdDocsCreateViews(payload: unknown): CommandQueryResponse {
    const p = payload as { views?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.views) || p.views.length === 0) {
      return err("bad_payload", "docs.createViews requires a non-empty views array", true);
    }
    try {
      const edits: DocumentEdit[] = [];
      const ids: string[] = [];
      for (const raw of p.views) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("each view must be an object");
        }
        const input = raw as Record<string, unknown>;
        const id = typeof input.id === "string" && input.id.length > 0 ? input.id : this.doc.mintViewId();
        const view = validateDocsViewRecord({ ...input, id });
        edits.push({ type: "addView", view });
        ids.push(view.id);
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ created: ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.updateView — whitelisted patch on one view definition. */
  private cmdDocsUpdateView(payload: unknown): CommandQueryResponse {
    const p = payload as { viewId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.viewId !== "string" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "docs.updateView requires viewId + patch", true);
    }
    try {
      this.doc.execute({ type: "updateView", viewId: p.viewId, patch: p.patch as Record<string, unknown> });
      return ok({ view: this.doc.viewById(p.viewId), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.removeView — remove one view (rejected while sheets/annotations/
   *  detail sources still reference it — no silent cascade). */
  private cmdDocsRemoveView(payload: unknown): CommandQueryResponse {
    const p = payload as { viewId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.viewId !== "string") {
      return err("bad_payload", "docs.removeView requires viewId", true);
    }
    try {
      this.doc.execute({ type: "removeView", viewId: p.viewId });
      return ok({ removed: p.viewId, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.createSheets — create sheets/layouts with title blocks as ONE
   *  atomic versioned batch (`sh-NNNNNN` minting; placements validated
   *  inside the drawable region, non-overlapping, referencing views). */
  private cmdDocsCreateSheets(payload: unknown): CommandQueryResponse {
    const p = payload as { sheets?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.sheets) || p.sheets.length === 0) {
      return err("bad_payload", "docs.createSheets requires a non-empty sheets array", true);
    }
    try {
      const edits: DocumentEdit[] = [];
      const ids: string[] = [];
      for (const raw of p.sheets) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("each sheet must be an object");
        }
        const input = raw as Record<string, unknown>;
        const id = typeof input.id === "string" && input.id.length > 0 ? input.id : this.doc.mintSheetId();
        const sheet = validateDocsSheetRecord({ ...input, id });
        edits.push({ type: "addSheet", sheet });
        ids.push(sheet.id);
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ created: ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.updateSheet — whitelisted patch on one sheet. */
  private cmdDocsUpdateSheet(payload: unknown): CommandQueryResponse {
    const p = payload as { sheetId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.sheetId !== "string" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "docs.updateSheet requires sheetId + patch", true);
    }
    try {
      this.doc.execute({ type: "updateSheet", sheetId: p.sheetId, patch: p.patch as Record<string, unknown> });
      return ok({ sheet: this.doc.sheetById(p.sheetId), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.removeSheet — remove one sheet (top-level object; views and
   *  annotations are NOT cascaded). */
  private cmdDocsRemoveSheet(payload: unknown): CommandQueryResponse {
    const p = payload as { sheetId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.sheetId !== "string") {
      return err("bad_payload", "docs.removeSheet requires sheetId", true);
    }
    try {
      this.doc.execute({ type: "removeSheet", sheetId: p.sheetId });
      return ok({ removed: p.sheetId, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.addAnnotations — create documentation annotations (docs.dim /
   *  docs.tag / docs.note elements, kind "annotation") as ONE atomic batch.
   *  Views must exist; dim/tag references must be existing BIM elements —
   *  annotations stay associated with CANONICAL element identities. */
  private cmdDocsAddAnnotations(payload: unknown): CommandQueryResponse {
    const p = payload as { annotations?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.annotations) || p.annotations.length === 0) {
      return err("bad_payload", "docs.addAnnotations requires a non-empty annotations array", true);
    }
    try {
      const elements = this.doc.allElements();
      const bimIds = new Set(
        elements
          .map((el) => elementToBimEntityOrNull(el))
          .filter((x) => x !== null)
          .map((x) => (x as { id: string }).id),
      );
      const edits: DocumentEdit[] = [];
      const ids: string[] = [];
      for (const raw of p.annotations) {
        if (typeof raw !== "object" || raw === null) throw new Error("each annotation must be an object");
        const input = raw as Record<string, unknown>;
        if (!isDocsAnnotationType(input.type)) {
          throw new Error(`annotation type must be one of docs.dim | docs.tag | docs.note, got ${JSON.stringify(input.type)}`);
        }
        const view = this.doc.viewById(input.viewId as string);
        if (view === undefined) {
          throw new Error(`annotation references unknown view '${String(input.viewId)}'`);
        }
        if (input.type === "docs.dim") {
          for (const ref of input.refIds as string[]) {
            if (!bimIds.has(ref)) {
              throw new Error(`docs.dim refIds must reference existing BIM elements — '${ref}' does not`);
            }
          }
        }
        if (input.type === "docs.tag" && !bimIds.has(input.targetId as string)) {
          throw new Error(`docs.tag targetId must reference an existing BIM element — '${String(input.targetId)}' does not`);
        }
        const props =
          input.type === "docs.dim" ? makeDocsDim(input) :
          input.type === "docs.tag" ? makeDocsTag(input) :
          makeDocsNote(input);
        const id = typeof input.id === "string" && input.id.length > 0 ? input.id : this.doc.mintElementId();
        const element = annotationElement(id, props as unknown as Parameters<typeof annotationElement>[1]);
        edits.push({ type: "addElement", element });
        ids.push(id);
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ created: ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.removeAnnotations — remove annotation elements atomically. */
  private cmdDocsRemoveAnnotations(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "docs.removeAnnotations requires an ids string array", true);
    }
    try {
      const elements = this.doc.allElements();
      const known = new Set(elements.filter((el) => {
        const a = el.props.type;
        return el.kind === "annotation" && isDocsAnnotationType(a);
      }).map((el) => el.id));
      for (const id of p.ids as string[]) {
        if (!known.has(id)) {
          throw new Error(`'${id}' is not a documentation annotation element`);
        }
      }
      const edits = (p.ids as string[]).map((id) => ({ type: "removeElement", elementId: id }) as DocumentEdit);
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ removed: p.ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.regenerate — recompute every view's projection (with canonical
   *  content hashes — the determinism proof) and refresh every annotation's
   *  derived values through ONE atomic versioned batch. No-op regenerations
   *  (nothing changed) record NO revision — identical inputs producing
   *  identical output is the invariant, reported not versioned. */
  private cmdDocsRegenerate(): CommandQueryResponse {
    try {
      const report = regenerateDocumentation(
        this.doc.viewTable,
        this.doc.sheetTable,
        this.doc.allElements(),
        this.doc.history.revisions.length.toString(),
      );
      if (report.updates.length > 0) {
        const edits = report.updates.map((u) => ({ type: "setProps", elementId: u.elementId, patch: u.props }) as DocumentEdit);
        this.doc.execute({ type: "applyEdits", edits });
      }
      return ok({ report, applied: report.updates.length, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-013 (additive, Issue #104): the documentation production
  // commands — navigator nodes (View Map folders + Layout Book subsets),
  // title blocks, schedules, revisions, publisher sets + the generic
  // layout.update patch. Typed-error convention (the CAD-PARITY-012 style):
  // bad_payload = malformed input; navigator_invalid / titleblock_invalid /
  // schedule_invalid / revision_invalid / publisher_invalid / layout_invalid
  // = semantic validation failures (the shared validators in
  // caddocument/workspace.ts re-validate at the document boundary — LOCK-007
  // reject-never-repair); navigator_exists-ish duplicates are *_exists;
  // missing targets are *_not_found; gated removals are navigator_in_use /
  // titleblock_in_use. One payload = ONE DocumentEdit = one version = one
  // undo entry throughout (publisher.run is NON-VERSIONED — the
  // plot.export/plot.publish precedent). Ids `xx-NNNNNN` are minted by the
  // document (monotonic, never reused) and the FIXED deterministic
  // timestamps (LAYOUTS_NOW pattern) keep every record byte-deterministic.

  /** Fixed deterministic creation timestamp (provenance; NEVER wall clock). */
  private static readonly DOCS_P013_NOW = "2026-01-01T00:00:00.000Z";

  /** Resolve a navigator parent reference (null/undefined/"" = root; the
   *  target must exist and share the child's kind — folders under folders,
   *  subsets under subsets). */
  private navigatorParentRef(value: unknown, kind: "folder" | "subset"): { ok: true; parentId: string | null } | ErrResult {
    if (value === undefined || value === null || value === "") return { ok: true, parentId: null };
    if (typeof value !== "string" || value.length === 0) {
      return err("bad_payload", `the navigator parent must be a node id or null (root), got ${JSON.stringify(value)}`, true);
    }
    const node = this.doc.navigatorNodeById(value);
    if (node === undefined) {
      return err("navigator_invalid", `parentId '${value}' does not reference an existing navigator node`, false);
    }
    if (node.kind !== kind) {
      return err(
        "navigator_invalid",
        `parentId '${value}' is a '${node.kind}' node — parents must share the node kind (${kind} under ${kind})`,
        false,
      );
    }
    return { ok: true, parentId: value };
  }

  /** The next sibling order for a new navigator node (max sibling order + 1,
   *  1 for the first child — deterministic append-at-end). */
  private nextNavigatorOrder(kind: "folder" | "subset", parentId: string | null): number {
    let max = 0;
    for (const n of this.doc.navigatorNodeTable) {
      if (n.kind === kind && n.parentId === parentId) max = Math.max(max, n.order);
    }
    return max + 1;
  }

  /** Run the shared record-grammar validation over a DRAFT record (placeholder
   *  id) BEFORE any canonical id is minted, mapping a grammar failure to the
   *  command's typed code. Returns null when the draft validates — the caller
   *  mints the id and re-executes through the SAME grammar (a failing command
   *  never burns a `xx-NNNNNN` identity; host-parity determinism). */
  private draftRecordError(code: string, validate: () => void): CommandQueryResponse | null {
    try {
      validate();
      return null;
    } catch (e) {
      return err(code, (e as Error).message, false);
    }
  }

  /** navigator.createFolder — add ONE View Map folder (`nav-NNNNNN`, document
   *  minted; the record validates through the shared grammar; pre-validation
   *  runs BEFORE minting so a failing command never burns an id). */
  private cmdNavigatorCreateFolder(payload: unknown): CommandQueryResponse {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || (p.name as string).trim().length === 0 || (p.name as string).trim().length > 80) {
      return err("bad_payload", "navigator.createFolder requires a name (non-empty string, max 80 chars)", true);
    }
    // Strict payload grammar (LOCK-007 — reject, never silently repair):
    // subset-only fields on a FOLDER are the record-grammar violation
    // (navigator_invalid); any OTHER unknown key is malformed input.
    for (const key of Object.keys(p)) {
      if (key === "prefix" || key === "numbering" || key === "customNumber") {
        return err(
          "navigator_invalid",
          `navigator.createFolder: '${key}' is a subset-only field — folder nodes must not carry it`,
          false,
        );
      }
      if (key !== "name" && key !== "parentId") {
        return err("bad_payload", `navigator.createFolder: unknown field '${key}' (allowed: name, parentId)`, true);
      }
    }
    const parent = this.navigatorParentRef(p.parentId, "folder");
    if (parent.ok === false) return parent;
    // PRE-MINT draft validation through the shared grammar (the placeholder
    // id is replaced by the minted one only after the record validates).
    const draft: NavigatorNodeRecord = {
      id: "nav-draft",
      kind: "folder",
      name: (p.name as string).trim(),
      parentId: parent.parentId,
      order: this.nextNavigatorOrder("folder", parent.parentId),
    };
    const invalid = this.draftRecordError("navigator_invalid", () => validateNavigatorNodeRecord(draft));
    if (invalid !== null) return invalid;
    const node: NavigatorNodeRecord = { ...draft, id: this.doc.mintNavigatorNodeId() };
    try {
      this.doc.execute({ type: "addNavigatorNode", node });
      return ok({ node, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("navigator_invalid", (e as Error).message, false);
    }
  }

  /** navigator.createSubset — add ONE Layout Book subset node (subset-only
   *  prefix/numbering/customNumber grammar; numbering "custom" requires
   *  customNumber). */
  private cmdNavigatorCreateSubset(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; parentId?: unknown; prefix?: unknown; numbering?: unknown; customNumber?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0 || p.name.trim().length > 80) {
      return err("bad_payload", "navigator.createSubset requires a name (non-empty string, max 80 chars)", true);
    }
    if (p.numbering !== undefined && p.numbering !== null && p.numbering !== "none" && p.numbering !== "custom") {
      return err("bad_payload", "navigator.createSubset numbering must be \"none\" | \"custom\" when present", true);
    }
    for (const key of Object.keys(p)) {
      if (key !== "name" && key !== "parentId" && key !== "prefix" && key !== "numbering" && key !== "customNumber") {
        return err("bad_payload", `navigator.createSubset: unknown field '${key}' (allowed: name, parentId, prefix, numbering, customNumber)`, true);
      }
    }
    const parent = this.navigatorParentRef(p.parentId, "subset");
    if (parent.ok === false) return parent;
    const numbering = p.numbering === "custom" ? "custom" : undefined;
    // PRE-MINT draft validation (the shared subset grammar — a failing
    // command never burns a nav- id).
    const draft: NavigatorNodeRecord = {
      id: "nav-draft",
      kind: "subset",
      name: p.name.trim(),
      parentId: parent.parentId,
      order: this.nextNavigatorOrder("subset", parent.parentId),
      ...(typeof p.prefix === "string" && p.prefix.length > 0 ? { prefix: p.prefix } : {}),
      ...(numbering !== undefined ? { numbering } : {}),
      ...(numbering === "custom" && typeof p.customNumber === "string" && p.customNumber.length > 0 ? { customNumber: p.customNumber } : {}),
    };
    const invalid = this.draftRecordError("navigator_invalid", () => validateNavigatorNodeRecord(draft));
    if (invalid !== null) return invalid;
    const node: NavigatorNodeRecord = { ...draft, id: this.doc.mintNavigatorNodeId() };
    try {
      this.doc.execute({ type: "addNavigatorNode", node });
      return ok({ node, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("navigator_invalid", (e as Error).message, false);
    }
  }

  /** navigator.removeNode — gated removal (children, view folderId refs,
   *  layout subsetId refs, publisher subset items — no silent cascade). */
  private cmdNavigatorRemoveNode(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "navigator.removeNode requires a node id", true);
    }
    if (this.doc.navigatorNodeById(p.id) === undefined) {
      return err("navigator_invalid", `no navigator node '${p.id}'`, false);
    }
    try {
      this.doc.execute({ type: "removeNavigatorNode", nodeId: p.id });
      return ok({ removed: p.id, snapshot: this.doc.snapshot() });
    } catch (e) {
      // The reference gates (children/views/layouts/publisher items).
      const message = (e as Error).message;
      if (message.startsWith("removeNavigatorNode:")) {
        return err("navigator_in_use", message, false);
      }
      return err("navigator_invalid", message, false);
    }
  }

  /** titleblock.create — add ONE reusable title-block definition (rows
   *  1..12, the row field grammar; the name is the unique user address). */
  private cmdTitleBlockCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; widthMm?: unknown; heightMm?: unknown; rowHeightMm?: unknown; rows?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0) {
      return err("bad_payload", "titleblock.create requires a name", true);
    }
    const name = p.name.trim();
    if (this.doc.titleBlockByName(name) !== undefined) {
      return err("titleblock_exists", `title block name '${name}' already exists — title block names are unique`, false);
    }
    // PRE-MINT draft validation (the shared geometry/rows grammar — a
    // failing command never burns a tb- id).
    const draft = {
      id: "tb-draft",
      name,
      widthMm: p.widthMm,
      heightMm: p.heightMm,
      rowHeightMm: p.rowHeightMm,
      rows: p.rows,
    } as unknown as TitleBlockRecord;
    const invalid = this.draftRecordError("titleblock_invalid", () => validateTitleBlockRecord(draft));
    if (invalid !== null) return invalid;
    const block: TitleBlockRecord = {
      id: this.doc.mintTitleBlockId(),
      name,
      widthMm: p.widthMm as number,
      heightMm: p.heightMm as number,
      rowHeightMm: p.rowHeightMm as number,
      rows: p.rows as TitleBlockRecord["rows"],
    };
    try {
      this.doc.execute({ type: "addTitleBlock", titleBlock: block });
      return ok({ titleBlock: block, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("titleblock_invalid", (e as Error).message, false);
    }
  }

  /** titleblock.update — whitelisted patch (name kept unique; the merged
   *  record re-validates as a whole). */
  private cmdTitleBlockUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0 || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "titleblock.update requires id + patch", true);
    }
    const current = this.doc.titleBlockById(p.id);
    if (current === undefined) {
      return err("titleblock_not_found", `no title block '${p.id}'`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    if (Object.keys(patch).length === 0) {
      return err("bad_payload", "titleblock.update requires a non-empty patch", true);
    }
    if (typeof patch.name === "string" && patch.name.trim().length > 0) {
      const clash = this.doc.titleBlockByName(patch.name.trim());
      if (clash !== undefined && clash.id !== p.id) {
        return err("titleblock_exists", `title block name '${patch.name.trim()}' already exists — title block names are unique`, false);
      }
    }
    try {
      this.doc.execute({ type: "updateTitleBlock", titleBlockId: p.id, patch });
      return ok({ titleBlock: this.doc.titleBlockById(p.id), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("titleblock_invalid", (e as Error).message, false);
    }
  }

  /** titleblock.remove — gated (layout placements reference it). */
  private cmdTitleBlockRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "titleblock.remove requires an id", true);
    }
    if (this.doc.titleBlockById(p.id) === undefined) {
      return err("titleblock_not_found", `no title block '${p.id}'`, false);
    }
    try {
      this.doc.execute({ type: "removeTitleBlock", titleBlockId: p.id });
      return ok({ removed: p.id, snapshot: this.doc.snapshot() });
    } catch (e) {
      const message = (e as Error).message;
      if (message.startsWith("removeTitleBlock:")) {
        return err("titleblock_in_use", message, false);
      }
      return err("titleblock_invalid", message, false);
    }
  }

  /** schedule.create — add ONE schedule/index definition (the closed
   *  per-source column vocabulary + the dynamic ps:<set>.<key> columns).
   *  Rows are ALWAYS derived fresh (schedules.run) — never stored. */
  private cmdScheduleCreate(payload: unknown): CommandQueryResponse {
    const p = payload as {
      name?: unknown; source?: unknown; filter?: unknown; columns?: unknown;
      sort?: unknown; grouping?: unknown; conditions?: unknown;
    } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0) {
      return err("bad_payload", "schedule.create requires a name", true);
    }
    const name = p.name.trim();
    if (this.doc.scheduleByName(name) !== undefined) {
      return err("schedule_exists", `schedule name '${name}' already exists — schedule names are unique`, false);
    }
    const filter =
      p.filter === undefined || p.filter === null ? undefined : (p.filter as NonNullable<ScheduleRecord["filter"]>);
    // CAD-PARITY-015 (Issue #110): the optional sort/grouping/conditions
    // pass through to the validator (the same closed grammar as the record).
    const sort = p.sort === undefined || p.sort === null ? undefined : (p.sort as NonNullable<ScheduleRecord["sort"]>);
    const grouping = p.grouping === undefined || p.grouping === null ? undefined : (p.grouping as NonNullable<ScheduleRecord["grouping"]>);
    const conditions = p.conditions === undefined || p.conditions === null ? undefined : (p.conditions as NonNullable<ScheduleRecord["conditions"]>);
    // PRE-MINT draft validation (the shared source/column vocabulary — a
    // failing command never burns a sch- id).
    const draft = {
      id: "sch-draft",
      name,
      source: p.source,
      ...(filter !== undefined ? { filter } : {}),
      columns: p.columns,
      ...(sort !== undefined ? { sort } : {}),
      ...(grouping !== undefined ? { grouping } : {}),
      ...(conditions !== undefined ? { conditions } : {}),
    } as unknown as ScheduleRecord;
    const invalid = this.draftRecordError("schedule_invalid", () => validateScheduleRecord(draft));
    if (invalid !== null) return invalid;
    const schedule: ScheduleRecord = {
      id: this.doc.mintScheduleId(),
      name,
      source: p.source as ScheduleRecord["source"],
      ...(filter !== undefined ? { filter } : {}),
      columns: p.columns as ScheduleRecord["columns"],
      ...(sort !== undefined ? { sort } : {}),
      ...(grouping !== undefined ? { grouping } : {}),
      ...(conditions !== undefined ? { conditions } : {}),
    };
    try {
      this.doc.execute({ type: "addSchedule", schedule });
      return ok({ schedule, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("schedule_invalid", (e as Error).message, false);
    }
  }

  /** schedule.update — whitelisted patch (name/source/filter/columns). */
  private cmdScheduleUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0 || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "schedule.update requires id + patch", true);
    }
    if (this.doc.scheduleById(p.id) === undefined) {
      return err("schedule_not_found", `no schedule '${p.id}'`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    if (Object.keys(patch).length === 0) {
      return err("bad_payload", "schedule.update requires a non-empty patch", true);
    }
    if (typeof patch.name === "string" && patch.name.trim().length > 0) {
      const clash = this.doc.scheduleByName(patch.name.trim());
      if (clash !== undefined && clash.id !== p.id) {
        return err("schedule_exists", `schedule name '${patch.name.trim()}' already exists — schedule names are unique`, false);
      }
    }
    try {
      this.doc.execute({ type: "updateSchedule", scheduleId: p.id, patch });
      return ok({ schedule: this.doc.scheduleById(p.id), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("schedule_invalid", (e as Error).message, false);
    }
  }

  /** schedule.remove — no gates (nothing references a schedule; rows are
   *  always derived). */
  private cmdScheduleRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "schedule.remove requires an id", true);
    }
    if (this.doc.scheduleById(p.id) === undefined) {
      return err("schedule_not_found", `no schedule '${p.id}'`, false);
    }
    try {
      this.doc.execute({ type: "removeSchedule", scheduleId: p.id });
      return ok({ removed: p.id, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("schedule_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-015 (additive, Issue #110): the property-definition
  // registry command surface. Declarations only — property VALUES live on
  // the canonical element property-set overlay (bim.metaOfProps), never in
  // the registry: there is NO parallel source of truth. ---

  /** property.create — add ONE property definition (unique name; unique
   *  (set, key) address; closed type/unit/appliesTo grammar). */
  private cmdPropertyDefCreate(payload: unknown): CommandQueryResponse {
    const p = payload as {
      name?: unknown; set?: unknown; key?: unknown; type?: unknown; unit?: unknown; appliesTo?: unknown;
    } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0) {
      return err("bad_payload", "property.create requires a name", true);
    }
    const name = p.name.trim();
    if (this.doc.propertyDefByName(name) !== undefined) {
      return err("property_exists", `property definition name '${name}' already exists — names are unique`, false);
    }
    if (typeof p.set === "string" && typeof p.key === "string") {
      const clash = this.doc.propertyDefByAddress(p.set, p.key);
      if (clash !== undefined) {
        return err("property_exists", `property definition address '${p.set}.${p.key}' already exists — (set, key) addresses are unique`, false);
      }
    }
    // PRE-MINT draft validation (a failing command never burns a prd- id).
    const draft = {
      id: "prd-draft",
      name,
      set: p.set,
      key: p.key,
      type: p.type,
      ...(p.unit !== undefined && p.unit !== null ? { unit: p.unit } : {}),
      ...(p.appliesTo !== undefined && p.appliesTo !== null ? { appliesTo: p.appliesTo } : {}),
    } as unknown as PropertyDefRecord;
    const invalid = this.draftRecordError("property_invalid", () => validatePropertyDefRecord(draft));
    if (invalid !== null) return invalid;
    const propertyDef: PropertyDefRecord = {
      id: this.doc.mintPropertyDefId(),
      name,
      set: p.set as string,
      key: p.key as string,
      type: p.type as PropertyDefRecord["type"],
      ...(p.unit !== undefined && p.unit !== null ? { unit: (p.unit as string).trim() } : {}),
      ...(p.appliesTo !== undefined && p.appliesTo !== null ? { appliesTo: p.appliesTo as readonly string[] } : {}),
    };
    try {
      this.doc.execute({ type: "addPropertyDef", propertyDef });
      return ok({ propertyDef, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("property_invalid", (e as Error).message, false);
    }
  }

  /** property.update — whitelisted patch (name/set/key/type/unit/appliesTo;
   *  null unit/appliesTo removes the field). */
  private cmdPropertyDefUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0 || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "property.update requires id + patch", true);
    }
    if (this.doc.propertyDefById(p.id) === undefined) {
      return err("property_not_found", `no property definition '${p.id}'`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    if (Object.keys(patch).length === 0) {
      return err("bad_payload", "property.update requires a non-empty patch", true);
    }
    if (typeof patch.name === "string" && patch.name.trim().length > 0) {
      const clash = this.doc.propertyDefByName(patch.name.trim());
      if (clash !== undefined && clash.id !== p.id) {
        return err("property_exists", `property definition name '${patch.name.trim()}' already exists — names are unique`, false);
      }
    }
    if (typeof patch.set === "string" && typeof patch.key === "string") {
      const clash = this.doc.propertyDefByAddress(patch.set, patch.key);
      if (clash !== undefined && clash.id !== p.id) {
        return err("property_exists", `property definition address '${patch.set}.${patch.key}' already exists — (set, key) addresses are unique`, false);
      }
    }
    try {
      this.doc.execute({ type: "updatePropertyDef", propertyDefId: p.id, patch });
      return ok({ propertyDef: this.doc.propertyDefById(p.id), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("property_invalid", (e as Error).message, false);
    }
  }

  /** property.remove — no gates (schedule pd:<id> columns render the
   *  deterministic missing cell afterwards; nothing is stored stale). */
  private cmdPropertyDefRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "property.remove requires an id", true);
    }
    if (this.doc.propertyDefById(p.id) === undefined) {
      return err("property_not_found", `no property definition '${p.id}'`, false);
    }
    try {
      this.doc.execute({ type: "removePropertyDef", propertyDefId: p.id });
      return ok({ removed: p.id, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("property_invalid", (e as Error).message, false);
    }
  }

  /** revision.add — add ONE document revision record (unique code; the
   *  fixed deterministic timestamp; layoutIds must all exist). */
  private cmdRevisionAdd(payload: unknown): CommandQueryResponse {
    const p = payload as { code?: unknown; description?: unknown; issued?: unknown; layoutIds?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.code !== "string" || p.code.trim().length === 0 || p.code.trim().length > 12) {
      return err("bad_payload", "revision.add requires a code (non-empty string, max 12 chars, e.g. \"P01\")", true);
    }
    const code = p.code.trim();
    if (this.doc.revisionByCode(code) !== undefined) {
      return err("revision_exists", `revision code '${code}' already exists — revision codes are unique`, false);
    }
    if (p.issued !== undefined && typeof p.issued !== "boolean") {
      return err("bad_payload", "revision.add issued must be a boolean when present", true);
    }
    // PRE-MINT draft validation (the shared record grammar + layoutIds
    // existence — a failing command never burns a rev- id).
    const draft = {
      id: "rev-draft",
      code,
      description: p.description,
      issued: p.issued ?? false,
      createdAt: AppApiHandler.DOCS_P013_NOW,
      layoutIds: p.layoutIds === undefined || p.layoutIds === null ? [] : p.layoutIds,
    } as unknown as RevisionRecord;
    const invalid = this.draftRecordError("revision_invalid", () => {
      const record = validateRevisionRecord(draft);
      for (const layoutId of record.layoutIds) {
        if (this.doc.layoutById(layoutId) === undefined) {
          throw new Error(`revision references unknown layout '${layoutId}'`);
        }
      }
    });
    if (invalid !== null) return invalid;
    const revision: RevisionRecord = {
      id: this.doc.mintRevisionId(),
      code,
      description: typeof p.description === "string" ? p.description : "",
      issued: p.issued === true,
      createdAt: AppApiHandler.DOCS_P013_NOW,
      layoutIds: Array.isArray(p.layoutIds) ? (p.layoutIds as string[]) : [],
    };
    try {
      this.doc.execute({ type: "addRevision", revision });
      return ok({ revision, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("revision_invalid", (e as Error).message, false);
    }
  }

  /** revision.update — whitelisted patch (code kept unique; layoutIds must
   *  all exist; id/createdAt immutable). */
  private cmdRevisionUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0 || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "revision.update requires id + patch", true);
    }
    if (this.doc.revisionById(p.id) === undefined) {
      return err("revision_not_found", `no revision '${p.id}'`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    if (Object.keys(patch).length === 0) {
      return err("bad_payload", "revision.update requires a non-empty patch", true);
    }
    if (typeof patch.code === "string" && patch.code.trim().length > 0) {
      const clash = this.doc.revisionByCode(patch.code.trim());
      if (clash !== undefined && clash.id !== p.id) {
        return err("revision_exists", `revision code '${patch.code.trim()}' already exists — revision codes are unique`, false);
      }
    }
    try {
      this.doc.execute({ type: "updateRevision", revisionId: p.id, patch });
      return ok({ revision: this.doc.revisionById(p.id), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("revision_invalid", (e as Error).message, false);
    }
  }

  /** revision.remove — NO document-level gates (layouts reference revisions
   *  the other way): the command strips the reference from every referencing
   *  layout in the SAME atomic batch (the explicit-cascade precedent; one
   *  revision, one undo entry restores both together). */
  private cmdRevisionRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "revision.remove requires an id", true);
    }
    const revision = this.doc.revisionById(p.id);
    if (revision === undefined) {
      return err("revision_not_found", `no revision '${p.id}'`, false);
    }
    try {
      const edits: DocumentEdit[] = [];
      const detachedLayouts: string[] = [];
      for (const layout of this.doc.layoutTable) {
        if ((layout.revisionIds ?? []).includes(p.id)) {
          edits.push({
            type: "updateLayout",
            layoutId: layout.id,
            patch: { revisionIds: (layout.revisionIds ?? []).filter((id) => id !== p.id) },
          });
          detachedLayouts.push(layout.id);
        }
      }
      edits.push({ type: "removeRevision", revisionId: p.id });
      this.doc.execute(edits.length === 1 ? edits[0]! : { type: "applyEdits", edits });
      return ok({ removed: p.id, detachedLayouts, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("revision_invalid", (e as Error).message, false);
    }
  }

  /** Expand publisher items to the ordered layout list (subsets → their
   *  layouts in book order through the shared book.ts derivation — the SAME
   *  rule the document gate enforces; the expanded list must contain no
   *  duplicate layout). */
  private expandPublisherItems(items: readonly PublisherItem[]): { ok: true; entries: { layout: LayoutRecord; format: "pdf" | "svg" | "plot-ir" }[] } | ErrResult {
    const nodes = this.doc.navigatorNodeTable;
    const layouts = this.doc.layoutTable;
    const entries: { layout: LayoutRecord; format: "pdf" | "svg" | "plot-ir" }[] = [];
    for (const item of items) {
      if (item.kind === "layout") {
        const layout = this.doc.layoutById(item.id);
        if (layout === undefined) {
          return err("publisher_invalid", `publisher set item references unknown layout '${item.id}'`, false);
        }
        entries.push({ layout, format: item.format });
      } else {
        const node = this.doc.navigatorNodeById(item.id);
        if (node === undefined || node.kind !== "subset") {
          return err("publisher_invalid", `publisher set item references navigator node '${item.id}' that is not a subset`, false);
        }
        for (const layout of subsetLayouts(item.id, nodes, layouts)) {
          entries.push({ layout, format: item.format });
        }
      }
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.layout.id)) {
        return err(
          "publisher_invalid",
          `publisher set expansion contains layout '${entry.layout.id}' twice — a layout cannot be published twice (check overlapping subset/layout items)`,
          false,
        );
      }
      seen.add(entry.layout.id);
    }
    return { ok: true, entries };
  }

  /** publisher.create — add ONE saved publisher set (name unique; every item
   *  target must exist with the right kind; the expanded layout list must
   *  contain no duplicate). */
  private cmdPublisherCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; items?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || p.name.trim().length === 0) {
      return err("bad_payload", "publisher.create requires a name", true);
    }
    const name = p.name.trim();
    if (this.doc.publisherSetByName(name) !== undefined) {
      return err("publisher_exists", `publisher set name '${name}' already exists — publisher set names are unique`, false);
    }
    // PRE-MINT draft validation (the shared item grammar + the expansion —
    // a failing command never burns a pub- id).
    const draft = { id: "pub-draft", name, items: p.items } as unknown as PublisherSetRecord;
    const invalid = this.draftRecordError("publisher_invalid", () => validatePublisherSetRecord(draft));
    if (invalid !== null) return invalid;
    const items = p.items as readonly PublisherItem[];
    const expansion = this.expandPublisherItems(items);
    if (expansion.ok === false) return expansion;
    const set: PublisherSetRecord = {
      id: this.doc.mintPublisherSetId(),
      name,
      items: p.items as PublisherItem[],
    };
    try {
      this.doc.execute({ type: "addPublisherSet", set });
      return ok({ publisherSet: set, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("publisher_invalid", (e as Error).message, false);
    }
  }

  /** publisher.update — whitelisted patch (name/items). */
  private cmdPublisherUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0 || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "publisher.update requires id + patch", true);
    }
    if (this.doc.publisherSetById(p.id) === undefined) {
      return err("publisher_not_found", `no publisher set '${p.id}'`, false);
    }
    const patch = p.patch as Record<string, unknown>;
    if (Object.keys(patch).length === 0) {
      return err("bad_payload", "publisher.update requires a non-empty patch", true);
    }
    if (typeof patch.name === "string" && patch.name.trim().length > 0) {
      const clash = this.doc.publisherSetByName(patch.name.trim());
      if (clash !== undefined && clash.id !== p.id) {
        return err("publisher_exists", `publisher set name '${patch.name.trim()}' already exists — publisher set names are unique`, false);
      }
    }
    try {
      this.doc.execute({ type: "updatePublisherSet", setId: p.id, patch });
      return ok({ publisherSet: this.doc.publisherSetById(p.id), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("publisher_invalid", (e as Error).message, false);
    }
  }

  /** publisher.remove — no gates (publisher.run is non-versioned output
   *  automation; nothing stored references a set). */
  private cmdPublisherRemove(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "publisher.remove requires an id", true);
    }
    if (this.doc.publisherSetById(p.id) === undefined) {
      return err("publisher_not_found", `no publisher set '${p.id}'`, false);
    }
    try {
      this.doc.execute({ type: "removePublisherSet", setId: p.id });
      return ok({ removed: p.id, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("publisher_invalid", (e as Error).message, false);
    }
  }

  /** publisher.run — NON-VERSIONED output automation (the plot.publish
   *  precedent: no DocumentEdit, no revision, no undo entry, no snapshot):
   *  expand the items (subsets → their layouts in book order), build the
   *  Plot IRs through the shared machinery and report the deterministic
   *  per-page artifacts (sha256 over the page's serialized output — the svg
   *  string, or the canonical IR JSON for plot-ir/pdf pages) + the
   *  multi-page PDF of the pdf-format pages (pdfSha256/pdfSize, omitted when
   *  the set has no pdf pages). */
  private cmdPublisherRun(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "publisher.run requires a publisher set id", true);
    }
    const set = this.doc.publisherSetById(p.id);
    if (set === undefined) {
      return err("publisher_not_found", `no publisher set '${p.id}'`, false);
    }
    const expansion = this.expandPublisherItems(set.items);
    if (expansion.ok === false) return expansion;
    // The plot-style gate (the plot.export/publish precedent — CTB/STB plot
    // style application is a typed limitation of the plot surface).
    for (const entry of expansion.entries) {
      if (entry.layout.pageSetup.plotStyleKind !== "none") {
        return err(
          "plot_unsupported",
          `layout '${entry.layout.name}' references the ${entry.layout.pageSetup.plotStyleKind.toUpperCase()} plot style table '${entry.layout.pageSetup.plotStyleTable}' — proprietary CTB/STB plot style application is a typed limitation of this slice`,
          false,
        );
      }
    }
    try {
      const irs = expansion.entries.map((entry) => buildPlotIR(this.plotIRInputOf(entry.layout)));
      const pages = expansion.entries.map((entry, i) => {
        const ir = irs[i]!;
        const serialized = entry.format === "svg" ? plotIRToSVG(ir) : canonicalStringify(ir);
        return {
          layoutId: entry.layout.id,
          layoutName: entry.layout.name,
          format: entry.format,
          revisions: revisionCodesOf(entry.layout, this.doc.revisionTable),
          sha256: createHash("sha256").update(serialized).digest("hex"),
        };
      });
      const pdfIrs = irs.filter((_, i) => expansion.entries[i]!.format === "pdf");
      const pdf = pdfIrs.length > 0 ? plotIRsToPDF(pdfIrs) : null;
      return ok({
        set: { id: set.id, name: set.name },
        pages,
        ...(pdf !== null
          ? { pdfSha256: createHash("sha256").update(pdf).digest("hex"), pdfSize: pdf.length }
          : {}),
      });
    } catch (e) {
      return err("publisher_invalid", `publisher.run failed: ${(e as Error).message}`, false);
    }
  }

  /** layout.update — the NEW generic patch command (the CAD-PARITY-013
   *  additive layout fields; layout.rename/layout.setPageSetup stay
   *  untouched). Whitelist: subsetId / masterId / titleBlockPlacement /
   *  revisionIds — null unassigns, an empty revisionIds array normalizes to
   *  absent (canonical-minimal records). */
  private cmdLayoutUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown; name?: unknown; patch?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.patch !== "object" || p.patch === null) {
      return err("bad_payload", "layout.update requires a patch object (subsetId / masterId / titleBlockPlacement / revisionIds)", true);
    }
    const patch = p.patch as Record<string, unknown>;
    const allowed: readonly string[] = ["subsetId", "masterId", "titleBlockPlacement", "revisionIds"];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) {
        return err(
          "layout_invalid",
          `layout.update patch key '${key}' is not allowed (allowed: ${allowed.join(", ")}; layout.rename/layout.setPageSetup own name/pageSetup)`,
          false,
        );
      }
    }
    if (Object.keys(patch).length === 0) {
      return err("bad_payload", "layout.update requires a non-empty patch", true);
    }
    let layout: LayoutRecord | undefined;
    if (typeof p.id === "string" && p.id.length > 0) {
      layout = this.doc.layoutById(p.id);
    } else if (typeof p.name === "string" && p.name.length > 0) {
      layout = this.doc.layoutByName(p.name);
    } else {
      const activeId = this.doc.draftingSettings.activeLayout;
      layout = (activeId !== undefined ? this.doc.layoutById(activeId) : undefined) ?? this.doc.layoutTable[0];
    }
    if (layout === undefined) {
      return err("layout_not_found", `layout '${String(p.id ?? p.name ?? "(active)")}' does not exist`, false);
    }
    try {
      this.doc.execute({ type: "updateLayout", layoutId: layout.id, patch });
      return ok({ layoutId: layout.id, layout: this.doc.layoutById(layout.id), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("layout_invalid", (e as Error).message, false);
    }
  }

  // --- COMPAT-IFC-001 (additive): IFC/openBIM interoperability -------------
  // Typed-error convention: ifc_unavailable = no interop adapter bound to
  // this host's engine bundle (hosts opt in); ifc_invalid = payload/file/
  // validation failure; ifc_unsupported = an operation outside the declared
  // vocabulary (e.g. unsupported source units). All explicit (LOCK-007);
  // loss/unsupported FIELD semantics live in the reconciliation reports.

  /** Fixed deterministic import-record timestamp (deterministic records;
   *  the record is already distinguished by its source + report hashes). */
  static readonly IFC_IMPORT_NOW = "2026-01-01T00:00:00.000Z";

  private ifcInterop(): IfcInteropAdapter | null {
    const candidate: unknown = this.adapters.ifc;
    return candidate !== undefined && isIfcInteropProvider(candidate) ? candidate : null;
  }

  /** ifc.export — deterministically export the document's BIM model to IFC
   *  bytes (byte-identical for equal inputs; identity psets carry the
   *  canonical ids; GlobalIds derive from them). CAD-PARITY-014: the P013
   *  documentation tables ride as IfcGroup entities (the D2 carrier) —
   *  absent tables (the legacy model) keep the export BYTE-IDENTICAL to the
   *  pre-P014 bytes (no groups are created; the fixture-pinned invariant). */
  private async cmdIfcExport(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { projectName?: unknown } | null;
    const projectName = p !== null && typeof p.projectName === "string" && p.projectName.length > 0 ? p.projectName : "Offisos Export";
    try {
      const snapshot = this.doc.snapshot();
      const entities = snapshot.elements
        .map((el) => elementToBimEntityOrNull(el))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      const rawPropsById = new Map(snapshot.elements.map((el) => [el.id, el.props as Readonly<Record<string, unknown>>] as const));
      const storyLevels = new Map<string, number>();
      for (const entity of entities) {
        if (entity.type === "bim.story") storyLevels.set(entity.id, entity.level);
      }
      const outcome = buildIfcExportRequest(entities, rawPropsById, storyLevels, projectName);
      // CAD-PARITY-014 (D2): the documentation tables → IfcGroup exchange
      // records. Attached ONLY when at least one table is non-empty (the
      // legacy byte-identity invariant).
      const tables = {
        views: snapshot.docsViews ?? [],
        layouts: snapshot.layouts ?? [],
        navigatorNodes: snapshot.navigatorNodes ?? [],
        titleBlocks: snapshot.titleBlocks ?? [],
        schedules: snapshot.schedules ?? [],
        revisions: snapshot.revisions ?? [],
        publisherSets: snapshot.publisherSets ?? [],
      };
      const documentation =
        tables.views.length > 0 || tables.layouts.length > 0 || tables.navigatorNodes.length > 0 ||
        tables.titleBlocks.length > 0 || tables.schedules.length > 0 || tables.revisions.length > 0 ||
        tables.publisherSets.length > 0
          ? buildIfcDocumentationExport(tables, (snapshot.docsSheets ?? []).length)
          : null;
      const built = await adapter.build({
        ...outcome.request,
        ...(documentation !== null ? { documentation: { groups: documentation.groups } } : {}),
      });
      return ok({
        ifc: built.ifc,
        size: built.size,
        sha256: built.sha256,
        schema: "IFC4",
        engineVersion: built.engineVersion,
        counts: outcome.counts,
        ...(documentation !== null ? { documentation: documentation.counts } : {}),
      });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.import — parse + reconcile an IFC file into the canonical model as
   *  ONE atomic versioned command (created elements + reconciliation
   *  patches + the deterministic import record; one revision, one undo).
   *  GlobalIds are retained as engineId provenance only (LOCK-019). */
  private async cmdIfcImport(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { ifc?: unknown; defaultStoryHeight?: unknown; defaultSpaceHeight?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.ifc !== "string" || p.ifc.length === 0) {
      return err("bad_payload", "ifc.import requires an ifc base64 payload", true);
    }
    const options: { defaultStoryHeight?: number; defaultSpaceHeight?: number; mintId?: () => string } = {};
    if (typeof p.defaultStoryHeight === "number" && Number.isFinite(p.defaultStoryHeight) && p.defaultStoryHeight > 0) {
      options.defaultStoryHeight = p.defaultStoryHeight;
    }
    if (typeof p.defaultSpaceHeight === "number" && Number.isFinite(p.defaultSpaceHeight) && p.defaultSpaceHeight > 0) {
      options.defaultSpaceHeight = p.defaultSpaceHeight;
    }
    options.mintId = (): string => this.doc.mintElementId();
    try {
      const bytes = Buffer.from(p.ifc, "base64");
      const sourceHash = createHash("sha256").update(bytes).digest("hex");
      const parsed = await adapter.parse(p.ifc);
      const snapshot = this.doc.snapshot();
      const outcome = reconcileIfcImport(parsed, sourceHash, snapshot.elements, options);
      const newElements = importEntitiesToElements(outcome.entities, (i) => outcome.globalIds[i] ?? null);
      const edits: DocumentEdit[] = newElements.map((element) => ({ type: "addElement", element }) as DocumentEdit);
      for (const patch of outcome.patches) {
        edits.push({ type: "setProps", elementId: patch.elementId, patch: patch.patch });
      }
      // CAD-PARITY-014 (D2): the documentation IfcGroup records reconcile
      // against the current tables and re-create as document records (fresh
      // minted ids, linkage resolved through the DomainId map; the record
      // drafts re-validate through the SAME grammars at execute). Story
      // links resolve through the target elements (preserved identities +
      // the existing elements — the element-id map below).
      const documentation = parsed.documentation ?? null;
      let documentationOutcome: ReturnType<typeof reconcileIfcDocumentation> | null = null;
      if (documentation !== null) {
        const elementIdByDomainId = new Map<string, string>();
        for (const el of snapshot.elements) elementIdByDomainId.set(el.id, el.id);
        for (const el of newElements) {
          if (el.id.length > 0) elementIdByDomainId.set(el.id, el.id);
        }
        const existing: IfcDocsTargetState = {
          views: this.doc.viewTable,
          layouts: this.doc.layoutTable,
          navigatorNodes: this.doc.navigatorNodeTable,
          titleBlocks: this.doc.titleBlockTable,
          schedules: this.doc.scheduleTable,
          revisions: this.doc.revisionTable,
          publisherSets: this.doc.publisherSetTable,
          elementIdByDomainId,
        };
        const mint: IfcDocsMint = {
          view: () => this.doc.mintViewId(),
          layout: () => this.doc.mintLayoutId(),
          navigatorNode: () => this.doc.mintNavigatorNodeId(),
          titleBlock: () => this.doc.mintTitleBlockId(),
          schedule: () => this.doc.mintScheduleId(),
          revision: () => this.doc.mintRevisionId(),
          publisherSet: () => this.doc.mintPublisherSetId(),
        };
        documentationOutcome = reconcileIfcDocumentation(documentation, existing, mint);
        edits.push(...this.documentationEditsOf(documentationOutcome.drafts));
      }
      edits.push({
        type: "addIfcImport",
        record: { ...outcome.record, id: "", at: AppApiHandler.IFC_IMPORT_NOW },
      });
      this.doc.execute({ type: "applyEdits", edits });
      const records = this.doc.ifcImportRecords;
      const record = records[records.length - 1];
      return ok({
        record,
        report: outcome.report,
        reportHash: outcome.record.reportHash,
        created: newElements.map((e) => e.id).filter((id) => id.length > 0),
        patched: outcome.patches.map((patch) => patch.elementId),
        ...(documentationOutcome !== null
          ? {
              documentation: {
                report: documentationOutcome.report,
                reportHash: documentationOutcome.reportHash,
                created: {
                  views: documentationOutcome.drafts.views.length,
                  layouts: documentationOutcome.drafts.layouts.length,
                  navigatorNodes: documentationOutcome.drafts.navigatorNodes.length,
                  titleBlocks: documentationOutcome.drafts.titleBlocks.length,
                  schedules: documentationOutcome.drafts.schedules.length,
                  revisions: documentationOutcome.drafts.revisions.length,
                  publisherSets: documentationOutcome.drafts.publisherSets.length,
                },
              },
            }
          : {}),
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      const message = (e as Error).message;
      if (message.startsWith("IFC import: unsupported length unit")) {
        return err("ifc_unsupported", message, false);
      }
      return err("ifc_invalid", message, false);
    }
  }

  /** CAD-PARITY-014 (D2): the documentation record drafts → DocumentEdits in
   *  dependency order (one atomic batch with the element edits): navigator
   *  nodes topologically parent-first, title blocks, views source-view-first
   *  (story + folder links resolve; a detail's source must EXIST when the
   *  detail applies — the draft order is guid-sorted, not dependency order),
   *  layouts masters-first WITHOUT revisionIds, then revisions (layoutIds
   *  resolve), then the revisionIds layout patches, schedules and publisher
   *  sets — the apply-time cross-reference order. */
  private documentationEditsOf(drafts: import("../ifc/docmap.js").IfcDocsRecordDrafts): DocumentEdit[] {
    const edits: DocumentEdit[] = [];
    // Navigator nodes: parents before children (deterministic depth order,
    // then the source order).
    const byId = new Map(drafts.navigatorNodes.map((node) => [node.id, node] as const));
    const depthOf = (id: string, seen: ReadonlySet<string> = new Set()): number => {
      const node = byId.get(id);
      if (node === undefined || node.parentId === null || seen.has(id)) return 0;
      return 1 + depthOf(node.parentId, new Set([...seen, id]));
    };
    const nodes = [...drafts.navigatorNodes].sort((a, b) =>
      depthOf(a.id) - depthOf(b.id) || drafts.navigatorNodes.indexOf(a) - drafts.navigatorNodes.indexOf(b));
    for (const node of nodes) {
      edits.push({ type: "addNavigatorNode", node });
    }
    for (const titleBlock of drafts.titleBlocks) {
      edits.push({ type: "addTitleBlock", titleBlock });
    }
    // Views: source views before their details (deterministic source-depth
    // order, then the draft order — the drafts arrive guid-sorted).
    const viewById = new Map(drafts.views.map((view) => [view.id, view] as const));
    const sourceDepth = (id: string, seen: ReadonlySet<string> = new Set()): number => {
      const view = viewById.get(id);
      if (view === undefined || view.sourceViewId === undefined || seen.has(id)) return 0;
      return 1 + sourceDepth(view.sourceViewId, new Set([...seen, id]));
    };
    const views = [...drafts.views].sort((a, b) =>
      sourceDepth(a.id) - sourceDepth(b.id) || drafts.views.indexOf(a) - drafts.views.indexOf(b));
    for (const view of views) {
      edits.push({ type: "addView", view });
    }
    // Layouts: masters first (single-level masters), revisionIds deferred.
    const layoutById = new Map(drafts.layouts.map((layout) => [layout.id, layout] as const));
    const masterDepth = (id: string, seen: ReadonlySet<string> = new Set()): number => {
      const layout = layoutById.get(id);
      if (layout === undefined || layout.masterId === undefined || seen.has(id)) return 0;
      return 1 + masterDepth(layout.masterId, new Set([...seen, id]));
    };
    const layouts = [...drafts.layouts].sort((a, b) =>
      masterDepth(a.id) - masterDepth(b.id) || drafts.layouts.indexOf(a) - drafts.layouts.indexOf(b));
    for (const layout of layouts) {
      const { revisionIds: _deferred, ...withoutRevisions } = layout;
      edits.push({ type: "addLayout", layout: withoutRevisions });
    }
    for (const revision of drafts.revisions) {
      edits.push({ type: "addRevision", revision });
    }
    for (const layout of layouts) {
      if (layout.revisionIds !== undefined && layout.revisionIds.length > 0) {
        edits.push({ type: "updateLayout", layoutId: layout.id, patch: { revisionIds: [...layout.revisionIds] } });
      }
    }
    for (const schedule of drafts.schedules) {
      edits.push({ type: "addSchedule", schedule });
    }
    for (const set of drafts.publisherSets) {
      edits.push({ type: "addPublisherSet", set });
    }
    return edits;
  }

  /** ifc.bcfCreate — build a BCF-XML v3 .bcf container binding topics to
   *  CANONICAL elements (IfcGuids derived deterministically from the
   *  canonical ids). BCF is a transport contract, never the system of
   *  record (Issue #47). CAD-PARITY-014 (D3): topics may carry a camera
   *  viewpoint (position/direction/up; orthogonal with viewToWorldScale)
   *  and a sourceRevision lineage (the caller-chosen canonical model state
   *  reference — carried as the topic's document reference). The container
   *  is byte-deterministic (fixed dates + deterministic guids in the
   *  worker). */
  private async cmdIfcBcfCreate(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { topics?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.topics) || p.topics.length === 0) {
      return err("bad_payload", "ifc.bcfCreate requires a non-empty topics array", true);
    }
    try {
      const topics = p.topics.map((raw, index) => {
        if (typeof raw !== "object" || raw === null) {
          throw new Error(`topics[${index}] must be an object`);
        }
        const t = raw as Record<string, unknown>;
        if (typeof t.title !== "string" || t.title.length === 0) {
          throw new Error(`topics[${index}].title must be a non-empty string`);
        }
        if (typeof t.description !== "string") {
          throw new Error(`topics[${index}].description must be a string`);
        }
        const elementIds = Array.isArray(t.elementIds) ? t.elementIds : [];
        const known = new Set(this.doc.allElements().map((el) => el.id));
        for (const id of elementIds) {
          if (typeof id !== "string" || !known.has(id)) {
            throw new Error(`topics[${index}]: element id '${String(id)}' does not exist in the document`);
          }
        }
        // CAD-PARITY-014 (D3): the optional viewpoint + lineage (validated
        // strictly — LOCK-007; absent = the legacy topic shape).
        let viewpoint: IfcBcfViewpoint | undefined;
        if (t.viewpoint !== undefined && t.viewpoint !== null) {
          if (typeof t.viewpoint !== "object") {
            throw new Error(`topics[${index}].viewpoint must be an object`);
          }
          const v = t.viewpoint as Record<string, unknown>;
          const vec = (key: string): [number, number, number] => {
            const raw2 = v[key];
            if (!Array.isArray(raw2) || raw2.length !== 3 || !raw2.every((x) => typeof x === "number" && Number.isFinite(x))) {
              throw new Error(`topics[${index}].viewpoint.${key} must be an array of 3 finite numbers`);
            }
            return [raw2[0] as number, raw2[1] as number, raw2[2] as number];
          };
          viewpoint = {
            cameraViewPoint: vec("cameraViewPoint"),
            cameraDirection: vec("cameraDirection"),
            cameraUpVector: vec("cameraUpVector"),
            ...(v.orthogonal === true ? { orthogonal: true } : {}),
            ...(typeof v.viewToWorldScale === "number" && Number.isFinite(v.viewToWorldScale) ? { viewToWorldScale: v.viewToWorldScale } : {}),
          };
          if (viewpoint.orthogonal === true && viewpoint.viewToWorldScale === undefined) {
            throw new Error(`topics[${index}].viewpoint.viewToWorldScale is required for orthogonal cameras`);
          }
          if (viewpoint.viewToWorldScale !== undefined && !(viewpoint.viewToWorldScale > 0)) {
            throw new Error(`topics[${index}].viewpoint.viewToWorldScale must be positive`);
          }
        }
        const sourceRevision =
          typeof t.sourceRevision === "string" && t.sourceRevision.length > 0 ? t.sourceRevision : undefined;
        return {
          title: t.title,
          description: t.description,
          author: typeof t.author === "string" ? t.author : "offisos",
          type: typeof t.type === "string" ? t.type : "Issue",
          status: typeof t.status === "string" ? t.status : "Open",
          references: (elementIds as string[]).map((id) => ifcGuidFor(id)),
          comment: typeof t.comment === "string" && t.comment.length > 0 ? t.comment : null,
          commentAuthor: typeof t.commentAuthor === "string" ? t.commentAuthor : null,
          ...(viewpoint !== undefined ? { viewpoint } : {}),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
        };
      });
      const built = await adapter.buildBcf(topics);
      return ok({ bcf: built.bcf, size: built.size, referencedCanonicalIds: topics.flatMap((t) => t.references).length });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.probe — engine/toolchain availability. */
  private async qIfcProbe(): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return ok({ available: false, engineVersion: null, message: "no IFC interop adapter is bound to this host's engine bundle" });
    }
    const probe = await adapter.probe();
    return ok(probe);
  }

  /** ifc.compare — dry-run reconciliation of an IFC file against the current
   *  canonical state (field-level exact/tolerance/lossy/unsupported). */
  private async qIfcCompare(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { ifc?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.ifc !== "string" || p.ifc.length === 0) {
      return err("bad_payload", "ifc.compare requires an ifc base64 payload", true);
    }
    try {
      const bytes = Buffer.from(p.ifc, "base64");
      const sourceHash = createHash("sha256").update(bytes).digest("hex");
      const parsed = await adapter.parse(p.ifc);
      const outcome = reconcileIfcImport(parsed, sourceHash, this.doc.snapshot().elements, {});
      return ok({ report: outcome.report, reportHash: outcome.record.reportHash });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      const message = (e as Error).message;
      if (message.startsWith("IFC import: unsupported length unit")) {
        return err("ifc_unsupported", message, false);
      }
      return err("ifc_invalid", message, false);
    }
  }

  /** ifc.idsValidate — IDS validation through the proven IfcTester toolchain,
   *  with every per-entity result bound to canonical provenance (the
   *  identity pset DomainId; null for external entities). */
  private async qIfcIdsValidate(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { ifc?: unknown; ids?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.ids !== "string" || p.ids.trim().length === 0) {
      return err("bad_payload", "ifc.idsValidate requires a non-empty ids XML string", true);
    }
    try {
      let ifcPayload: string = typeof p.ifc === "string" && p.ifc.length > 0 ? p.ifc : "";
      if (ifcPayload.length === 0) {
        // default: validate the current document's export
        const exportResult = await this.cmdIfcExport({ projectName: "Offisos IDS Validation" });
        if (exportResult.ok !== true) {
          return exportResult;
        }
        ifcPayload = (exportResult.value as { ifc: string }).ifc;
      }
      const [result, parsed] = await Promise.all([
        adapter.validateIds(ifcPayload, p.ids as string),
        adapter.parse(ifcPayload),
      ]);
      const canonicalByGuid = new Map<string, string>();
      for (const el of parsed.elements) {
        const identity = el.psets["Pset_OffisosIdentity"] as Record<string, unknown> | undefined;
        const domainId = identity?.DomainId;
        if (typeof domainId === "string" && domainId.length > 0) {
          canonicalByGuid.set(el.globalId, domainId);
        }
      }
      const classByGuid = new Map(parsed.elements.map((el) => [el.globalId, el.ifcClass] as const));
      const nameByGuid = new Map(parsed.elements.map((el) => [el.globalId, el.name] as const));
      const specs = result.specs.map((spec) => ({
        name: spec.name,
        status: spec.status,
        entities: spec.applicable.map((guid) => ({
          globalId: guid,
          canonicalId: canonicalByGuid.get(guid) ?? null,
          ifcClass: classByGuid.get(guid) ?? null,
          name: nameByGuid.get(guid) ?? null,
          passed: spec.passed.includes(guid),
        })),
      }));
      return ok({ specs, schema: parsed.schema });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.bcfParse — parse a .bcf container; every IfcGuid reference resolves
   *  back to a canonical element id when one exists in the current document
   *  (derived guid match or engineId provenance). BCF never becomes the
   *  system of record. */
  private async qIfcBcfParse(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { bcf?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.bcf !== "string" || p.bcf.length === 0) {
      return err("bad_payload", "ifc.bcfParse requires a bcf base64 payload", true);
    }
    try {
      const parsed = await adapter.parseBcf(p.bcf);
      // canonical resolution: derived guids (exports) + engineId provenance (imports)
      const canonicalByGuid = new Map<string, string>();
      for (const el of this.doc.allElements()) {
        canonicalByGuid.set(ifcGuidFor(el.id), el.id);
        if (typeof el.engineId === "string" && el.engineId.length > 0) {
          canonicalByGuid.set(el.engineId, el.id);
        }
      }
      const topics = parsed.topics.map((topic) => ({
        ...topic,
        references: topic.references,
        resolvedCanonicalIds: topic.references.map((guid) => canonicalByGuid.get(guid) ?? null),
      }));
      return ok({ topics });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.listImports — the persisted deterministic import records. */
  private qIfcListImports(): CommandQueryResponse {
    return ok({ records: this.doc.ifcImportRecords });
  }

  // --- CAD-PARITY-014 (additive, Issue #107): file interoperability ----------
  // Typed-error convention (the ifc.* house rules): dxf_unsupported = a
  // construct/unit outside the bounded DXF vocabulary; dwg_unsupported =
  // THE proprietary DWG boundary (the binary magic is detected and declined,
  // never parsed); dxf_invalid = a malformed bounded file; bad_payload =
  // wire-shape failures (retryable). Skipped out-of-boundary constructs are
  // COUNTED in the typed reports, never silently approximated (LOCK-007).

  /** The writer input of the current drafting surface (pure data — both
   *  hosts build the identical DXF bytes; the plotIRInputOf discipline). */
  private dxfWriteInputOf(): DxfWriteInput {
    const settings = this.doc.draftingSettings;
    return {
      elements: this.doc.allElements(),
      layers: this.doc.layerTable,
      ltypes: this.doc.ltypeTable,
      ...(settings.standards !== undefined ? { standards: settings.standards } : {}),
    };
  }

  /** dxf.export (query, NON-VERSIONED — the plot.export precedent): the
   *  bounded deterministic DXF R2000 ASCII text of the current drafting
   *  surface. Identical document state → byte-identical DXF. */
  private qDxfExport(): CommandQueryResponse {
    try {
      const written = writeDxf(this.dxfWriteInputOf());
      const bytes = Buffer.from(written.text, "utf8");
      return ok({
        format: "dxf",
        bytesBase64: bytes.toString("base64"),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        counts: written.counts,
        skippedKinds: written.skippedKinds,
      });
    } catch (e) {
      return err("dxf_invalid", (e as Error).message, false);
    }
  }

  /** dxf.import (command, VERSIONED — the ifc.import pattern): parse the
   *  bounded DXF, map through the strict canonical constructors and apply
   *  ONE atomic edit batch (ltypes + layers + elements; ids minted by the
   *  document authority; one revision, one undo). Unsupported constructs
   *  are skipped + counted per type; the DWG binary magic is the typed
   *  proprietary decline; units outside the declared vocabulary fail
   *  dxf_unsupported (no guessing). */
  private cmdDxfImport(payload: unknown): CommandQueryResponse {
    const p = payload as { dxf?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.dxf !== "string" || p.dxf.length === 0) {
      return err("bad_payload", "dxf.import requires a dxf base64 payload", true);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(p.dxf, "base64");
    } catch {
      return err("bad_payload", "dxf.import requires a dxf base64 payload", true);
    }
    // THE explicit DWG boundary (D5): the binary magic is detected and
    // declined typed — never parsed, never guessed.
    if (looksLikeDwg(bytes)) {
      return err(
        "dwg_unsupported",
        "the payload is a proprietary DWG binary (the 'AC' version magic) — reading DWG is an explicit work-item non-goal (reverse engineering is out of scope); DXF is the open interchange path for the same content class",
        false,
      );
    }
    let text: string;
    try {
      text = bytes.toString("utf8");
    } catch {
      return err("dxf_invalid", "dxf.import requires UTF-8 ASCII DXF text", false);
    }
    try {
      const parsed = readDxf(text);
      const unit = dxfUnitFactor(parsed.header.insunits);
      if (unit === null) {
        return err(
          "dxf_unsupported",
          `DXF import: unsupported $INSUNITS value ${String(parsed.header.insunits)} (the declared set is in/ft/mm/cm/m — no guessing)`,
          false,
        );
      }
      const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
      const mapped = mapDxfImport(parsed, { layers: this.doc.layerTable, ltypes: this.doc.ltypeTable }, unit, {
        mintLayerId: () => this.doc.mintLayerId(),
        mintElementId: () => this.doc.mintElementId(),
      });
      const edits: DocumentEdit[] = [
        ...mapped.ltypeEdits,
        ...mapped.layerEdits,
        ...mapped.elements.map((element) => ({ type: "addElement", element }) as DocumentEdit),
      ];
      if (edits.length > 0) {
        this.doc.execute({ type: "applyEdits", edits });
      }
      const report = {
        sourceSha256,
        unit: unit.unit,
        scaleToMm: unit.factor,
        counts: {
          elements: mapped.elements.length,
          layers: mapped.layerEdits.length,
          ltypes: mapped.ltypeEdits.length,
          unsupported: mapped.unsupported.reduce((sum, u) => sum + u.count, 0),
        },
        rows: mapped.rows,
        unsupported: mapped.unsupported,
      };
      return ok({
        report,
        reportHash: createHash("sha256").update(canonicalStringify(report)).digest("hex"),
        created: mapped.created,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof DxfError) return err(e.code, e.message, false);
      return err("dxf_invalid", (e as Error).message, false);
    }
  }

  /** interop.exchangeReport (query) — the P014 authoritative exchange
   *  classification (the successor surface; the P013 docs.exchangeReport
   *  stays the frozen slice record). */
  private qInteropExchangeReport(): CommandQueryResponse {
    const snapshot = this.doc.snapshot();
    const views = snapshot.docsViews ?? [];
    return ok(buildInteropExchangeReport({
      elements: snapshot.elements.length,
      layers: (snapshot.layers ?? []).length,
      views: views.length,
      sheets: (snapshot.docsSheets ?? []).length,
      layouts: (snapshot.layouts ?? []).length,
      titleBlocks: (snapshot.titleBlocks ?? []).length,
      schedules: (snapshot.schedules ?? []).length,
      revisions: (snapshot.revisions ?? []).length,
      publisherSets: (snapshot.publisherSets ?? []).length,
      navigatorNodes: (snapshot.navigatorNodes ?? []).length,
    }));
  }

  /** interop.archivalList (query) — the archival format registry (the legal
   *  compatibility surface: open standards, published specs, the
   *  proprietary DWG decline). */
  private qInteropArchivalList(): CommandQueryResponse {
    return ok(archivalList());
  }

  /** interop.roundtripReport (query, NON-VERSIONED) — the format round-trip
   *  verification loops (D6). "dxf" is pure TS (export → parse → the DRY
   *  mapping + the per-element field classification + the source sha);
   *  "ifc" composes export → parse → the DRY element + documentation
   *  reconciliation through the IFC adapter (typed ifc_unavailable when no
   *  adapter is bound). Nothing is written — the DRY loops never mutate. */
  private async qInteropRoundtripReport(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { format?: unknown } | null;
    if (p === null || typeof p !== "object" || (p.format !== "ifc" && p.format !== "dxf")) {
      return err("bad_payload", "interop.roundtripReport requires format ('ifc' | 'dxf')", true);
    }
    if (p.format === "dxf") {
      try {
        const outcome = dxfRoundtripReport(this.dxfWriteInputOf());
        return ok(outcome);
      } catch (e) {
        if (e instanceof DxfError) return err(e.code, e.message, false);
        return err("dxf_invalid", (e as Error).message, false);
      }
    }
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use the ifc round-trip report)", false);
    }
    try {
      // Export the CURRENT document (deterministic bytes), parse it back
      // and reconcile DRY against the same state — zero-loss by design;
      // the documentation dimension rides the IfcGroup carrier.
      const exportResult = await this.cmdIfcExport({ projectName: "Offisos Round-trip" });
      if (exportResult.ok !== true) {
        return exportResult;
      }
      const ifcPayload = (exportResult.value as { ifc: string }).ifc;
      const bytes = Buffer.from(ifcPayload, "base64");
      const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
      const parsed = await adapter.parse(ifcPayload);
      const elementsOutcome = reconcileIfcImport(parsed, sourceSha256, this.doc.snapshot().elements, {});
      const snapshot = this.doc.snapshot();
      const elementIdByDomainId = new Map<string, string>();
      for (const el of snapshot.elements) elementIdByDomainId.set(el.id, el.id);
      const docsOutcome = parsed.documentation !== undefined
        ? reconcileIfcDocumentation(parsed.documentation, {
          views: this.doc.viewTable,
          layouts: this.doc.layoutTable,
          navigatorNodes: this.doc.navigatorNodeTable,
          titleBlocks: this.doc.titleBlockTable,
          schedules: this.doc.scheduleTable,
          revisions: this.doc.revisionTable,
          publisherSets: this.doc.publisherSetTable,
          elementIdByDomainId,
        }, null)
        : null;
      const report = {
        format: "ifc" as const,
        sourceSha256,
        elements: elementsOutcome.report,
        ...(docsOutcome !== null ? { documentation: docsOutcome.report } : {}),
      };
      return ok({
        ...report,
        reportHash: createHash("sha256").update(canonicalStringify(report)).digest("hex"),
      });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  // --- COMPAT-CAD-003 (additive): documentation queries ----------------------

  /** docs.listViews — every view with its CURRENT content hash, primitive
   *  count and honest error (dangling story etc.). */
  private qDocsListViews(): CommandQueryResponse {
    const views = this.doc.viewTable;
    const projections = projectAllViews(views, this.doc.allElements());
    const result = views.map((view) => {
      const r = projections.get(view.id);
      if (r === undefined || r.projection === null) {
        return { view, contentHash: null, primitiveCount: 0, skipCount: 0, error: r?.error ?? "not projected" };
      }
      return {
        view,
        contentHash: viewContentHash(r.projection),
        primitiveCount: r.projection.primitives.length,
        skipCount: r.projection.skips.length,
        error: null,
      };
    });
    return ok({ views: result });
  }

  /** docs.getViewGeometry — one view's FRESH projection (derived on demand,
   *  never stored) + content hash + resolved annotations. */
  private qDocsGetViewGeometry(payload: unknown): CommandQueryResponse {
    const p = payload as { viewId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.viewId !== "string") {
      return err("bad_payload", "docs.getViewGeometry requires viewId", true);
    }
    const view = this.doc.viewById(p.viewId);
    if (view === undefined) {
      return err("docs_invalid", `no view '${p.viewId}'`, false);
    }
    const projections = projectAllViews(this.doc.viewTable, this.doc.allElements());
    const r = projections.get(view.id);
    if (r === undefined || r.projection === null) {
      return err("docs_invalid", `view '${view.id}' does not project: ${r?.error ?? "unknown"}`, false);
    }
    const annotations = this.doc
      .allElements()
      .filter((el) => el.kind === "annotation" && isDocsAnnotationType(el.props.type) && el.props.viewId === view.id)
      .map((el) => ({ id: el.id, ...el.props }));
    return ok({
      view,
      primitives: r.projection.primitives,
      skips: r.projection.skips,
      bbox: r.projection.bbox,
      contentHash: viewContentHash(r.projection),
      primitiveCount: r.projection.primitives.length,
      annotations,
    });
  }

  /** docs.listSheets — every sheet record. */
  private qDocsListSheets(): CommandQueryResponse {
    return ok({ sheets: this.doc.sheetTable });
  }

  /** docs.exportSheet — the canonical Sheet IR (the interchange contract) or
   *  the deterministic pdf/svg writers (CAD-PARITY-014, D4: the Sheet IR
   *  bridges onto the existing plot writers through interop/sheet-export.ts
   *  — the plot.export bytes-return precedent). dwg stays the typed
   *  docs_unsupported decline (the proprietary DWG writer boundary; DXF is
   *  the open interchange path). */
  private qDocsExportSheet(payload: unknown): CommandQueryResponse {
    const p = payload as { sheetId?: unknown; format?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.sheetId !== "string" ||
      !isDocsExportFormat(p.format)
    ) {
      return err("bad_payload", "docs.exportSheet requires sheetId + format ('sheet-ir' | 'pdf' | 'svg' | 'dwg')", true);
    }
    if (p.format === "dwg") {
      return err(
        "docs_unsupported",
        "the proprietary DWG writer boundary — DWG is not legally compatible for this writer and writing it is an explicit non-goal; the canonical Sheet IR ('sheet-ir') and the deterministic pdf/svg writers are the export paths, DXF is the open interchange path for the same content class",
        false,
      );
    }
    const sheet = this.doc.sheetById(p.sheetId);
    if (sheet === undefined) {
      return err("docs_invalid", `no sheet '${p.sheetId}'`, false);
    }
    try {
      const built = buildSheetIR(sheet as DocsSheetRecord, this.doc.viewTable, this.doc.allElements());
      if (p.format === "sheet-ir") {
        return ok({ format: "sheet-ir", sheetId: sheet.id, ir: built.ir, canonical: built.canonical, hash: built.hash });
      }
      // CAD-PARITY-014 (D4): the Sheet IR → Plot IR bridge → the EXISTING
      // deterministic writers (byte-identical on every host; the plot
      // discipline — no timestamps, fixed construction order).
      const plotIR = sheetIRToPlotIR(built.ir);
      if (p.format === "svg") {
        const svg = plotIRToSVG(plotIR);
        return ok({
          format: "svg",
          sheetId: sheet.id,
          text: svg,
          size: svg.length,
          sha256: createHash("sha256").update(svg).digest("hex"),
          irHash: built.hash,
        });
      }
      const pdf = plotIRToPDF(plotIR);
      return ok({
        format: "pdf",
        sheetId: sheet.id,
        bytesBase64: Buffer.from(pdf).toString("base64"),
        size: pdf.length,
        sha256: createHash("sha256").update(pdf).digest("hex"),
        irHash: built.hash,
      });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-013 (additive, Issue #104): the documentation production
  // read surfaces (non-mutating, computed fresh every call — queries never
  // mutate and never persist derived state; ordering: children by (order,
  // id), rows/views/layouts/sheets/stories in DOCUMENT order).

  /** navigator.tree (query) — the full navigator projection: the project map
   *  (stories + element counts), the View Map folder tree with the views
   *  filed under their folders (fresh content hashes), the Layout Book
   *  subset tree with the layouts filed under their subsets (derived sheet
   *  numbers), and the publisher-set registry. Root-level views/layouts sit
   *  in the map root's `views`/`layouts` arrays. */
  private qNavigatorTree(): CommandQueryResponse {
    const nodes = this.doc.navigatorNodeTable;
    const layouts = this.doc.layoutTable;
    const views = this.doc.viewTable;
    const elements = this.doc.allElements();
    // projectMap: stories in document order. elementCount = the non-story
    // BIM elements whose story association resolves to the story —
    // storyId === story.id OR one-level hosted-by-such (hostId → the host
    // element's storyId; the docs projection's association rule, see
    // docs/project.ts: openings scope through their host wall's story).
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const entityById = new Map(entities.map((entity) => [entity.id, entity] as const));
    const storyOf = (entity: object): string | null => {
      const record = entity as Record<string, unknown>;
      if (typeof record.storyId === "string") return record.storyId;
      if (typeof record.hostId === "string") {
        const host = entityById.get(record.hostId);
        const hostStory = host !== undefined ? (host as unknown as Record<string, unknown>).storyId : undefined;
        return typeof hostStory === "string" ? hostStory : null;
      }
      return null;
    };
    const stories: { id: string; name: string; level: number; height: number; elementCount: number }[] = [];
    for (const entity of entities) {
      if (entity.type !== "bim.story") continue;
      let elementCount = 0;
      for (const other of entities) {
        if (other.type === "bim.story") continue;
        if (storyOf(other) === entity.id) elementCount += 1;
      }
      stories.push({ id: entity.id, name: entity.name, level: entity.level, height: entity.height, elementCount });
    }
    // The fresh view projections (the docs.listViews derivation — never
    // stored hashes).
    const projections = projectAllViews(views, elements);
    const viewRowOf = (view: DocsViewRecord): Record<string, unknown> => {
      const result = projections.get(view.id);
      return {
        viewId: view.id,
        kind: view.kind,
        title: view.title,
        ...(view.scale !== undefined ? { scale: view.scale } : {}),
        ...(result !== undefined && result.projection !== null ? { contentHash: viewContentHash(result.projection) } : {}),
      };
    };
    const viewChildrenOf = (parentId: string | null): unknown[] =>
      nodes
        .filter((n) => n.kind === "folder" && n.parentId === parentId)
        .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1))
        .map((node) => ({
          node,
          views: views.filter((v) => v.folderId === node.id).map(viewRowOf),
          children: viewChildrenOf(node.id),
        }));
    const viewMap = {
      views: views.filter((v) => v.folderId === undefined).map(viewRowOf),
      children: viewChildrenOf(null),
    };
    // The Layout Book (subset tree + derived sheet numbers).
    const revisions = this.doc.revisionTable;
    const layoutRowOf = (layout: LayoutRecord): Record<string, unknown> => ({
      layoutId: layout.id,
      name: layout.name,
      sheetNumber: sheetNumberOf(layout, nodes, layouts),
      ...(layout.masterId !== undefined ? { masterId: layout.masterId } : {}),
      ...(layout.titleBlockPlacement !== undefined ? { titleBlockId: layout.titleBlockPlacement.titleBlockId } : {}),
      revisionCodes: revisionCodesOf(layout, revisions),
    });
    const bookChildrenOf = (parentId: string | null): unknown[] =>
      nodes
        .filter((n) => n.kind === "subset" && n.parentId === parentId)
        .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1))
        .map((node) => ({
          node,
          layouts: layouts.filter((l) => l.subsetId === node.id).map(layoutRowOf),
          children: bookChildrenOf(node.id),
        }));
    const layoutBook = {
      layouts: layouts.filter((l) => l.subsetId === undefined).map(layoutRowOf),
      children: bookChildrenOf(null),
    };
    return ok({
      projectMap: { stories },
      viewMap,
      layoutBook,
      publisherSets: this.doc.publisherSetTable.map((s) => ({ id: s.id, name: s.name, itemCount: s.items.length })),
    });
  }

  /** schedules.list (query) — the schedule table inventory. */
  private qSchedulesList(): CommandQueryResponse {
    return ok({
      schedules: this.doc.scheduleTable.map((s) => ({
        id: s.id,
        name: s.name,
        source: s.source,
        columnCount: s.columns.length,
      })),
    });
  }

  /** schedules.run (query) — the FRESH deterministic row derivation over the
   *  CURRENT canonical state (no rows are ever stored; the same snapshot
   *  yields the same rows + sha256 on every host). */
  private qSchedulesRun(payload: unknown): CommandQueryResponse {
    const p = payload as { id?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || p.id.length === 0) {
      return err("bad_payload", "schedules.run requires a schedule id", true);
    }
    const schedule = this.doc.scheduleById(p.id);
    if (schedule === undefined) {
      return err("schedule_not_found", `no schedule '${p.id}'`, false);
    }
    const ctx: ScheduleRunContext = {
      elements: this.doc.allElements(),
      views: this.doc.viewTable,
      sheets: this.doc.sheetTable,
      layouts: this.doc.layoutTable,
      viewports: this.doc.viewportTable,
      navigatorNodes: this.doc.navigatorNodeTable,
      revisions: this.doc.revisionTable,
      titleBlocks: this.doc.titleBlockTable,
      layers: this.doc.layerTable,
      // CAD-PARITY-015 (Issue #110): the pd:<prd-NNNNNN> column resolution.
      propertyDefs: this.doc.propertyDefTable,
    };
    const result = runSchedule(schedule, ctx);
    // CAD-PARITY-015: groups/totals are present ONLY when the schedule
    // declares grouping — the P013 response shape stays byte-identical.
    return ok({
      schedule,
      rows: result.rows,
      rowCount: result.rowCount,
      sha256: result.sha256,
      ...(result.groups !== undefined && result.totals !== undefined
        ? { groups: result.groups, totals: result.totals }
        : {}),
    });
  }

  // --- CAD-PARITY-015 (additive, Issue #110): the properties/quantities
  // query surfaces (computed fresh on every call, never persisted). ---

  /** properties.list (query) — the property-definition registry inventory
   *  with the LIVE lineage statistics: the values are counted from the
   *  canonical element property-set overlay ONLY (bim.metaOfProps — the
   *  single source of truth); a value whose observed type does not match
   *  the declared type is counted as a typeMismatch (reported, never
   *  silently coerced — LOCK-007). */
  private qPropertiesList(): CommandQueryResponse {
    interface PropertyRow {
      readonly id: string;
      readonly name: string;
      readonly set: string;
      readonly key: string;
      readonly type: PropertyDefRecord["type"];
      readonly unit?: string;
      readonly appliesTo?: readonly string[];
      readonly elementsWithValue: number;
      readonly typeMatches: number;
      readonly typeMismatches: number;
    }
    const elements = this.doc.allElements();
    const rows: PropertyRow[] = this.doc.propertyDefTable.map((d) => {
      let elementsWithValue = 0;
      let typeMatches = 0;
      let typeMismatches = 0;
      for (const el of elements) {
        const meta = bimMetaOfProps(el.props as Readonly<Record<string, unknown>>);
        const set = meta?.propertySets?.find((s) => s.name === d.set);
        const property = set?.properties.find((pr) => pr.key === d.key);
        if (property === undefined) continue;
        elementsWithValue += 1;
        const observed = typeof property.value;
        const declared = d.type === "text" ? "string" : d.type;
        if (observed === declared) typeMatches += 1;
        else typeMismatches += 1;
      }
      return {
        id: d.id, name: d.name, set: d.set, key: d.key, type: d.type,
        ...(d.unit !== undefined ? { unit: d.unit } : {}),
        ...(d.appliesTo !== undefined ? { appliesTo: [...d.appliesTo] } : {}),
        elementsWithValue, typeMatches, typeMismatches,
      };
    });
    return ok({
      contract: "offisos-properties/1",
      valueSource: "element-property-set-overlay",
      propertyDefs: rows,
    });
  }

  /** quantities.run (query) — the FRESH deterministic, revision-bound
   *  quantity takeoff over the CURRENT canonical state (the closed
   *  canonical rule table; nothing is stored, the report carries the
   *  RevisionRef of the model head it was computed over). */
  private qQuantitiesRun(payload: unknown): CommandQueryResponse {
    let input: ReturnType<typeof parseQuantityTakeoffInput>;
    const sourceField = (payload as { source?: unknown } | null | undefined)?.source;
    if (
      typeof payload !== "object" || payload === null || Array.isArray(payload) ||
      typeof sourceField !== "string" || sourceField.length === 0
    ) {
      return err("bad_payload", "quantities.run requires an object payload { source, groupBy?, filter? } with a source", true);
    }
    try {
      input = parseQuantityTakeoffInput(payload);
    } catch (e) {
      return err("quantities_invalid", (e as Error).message, false);
    }
    const report = runQuantityTakeoff(input, {
      elements: this.doc.allElements(),
      history: this.doc.history,
    });
    return ok(report);
  }

  /** quantities.rules (query) — the closed canonical rule table + the live
   *  per-type element counts: the EXPLICIT typed-unsupported surface of the
   *  quantity workflows (types outside the table carry count only — never
   *  approximated). */
  private qQuantitiesRules(): CommandQueryResponse {
    const counts = new Map<string, number>();
    for (const el of this.doc.allElements()) {
      const type = (el.props as Readonly<Record<string, unknown>>)["type"];
      if (typeof type === "string") counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return ok({
      contract: "offisos-quantity-rules/1",
      units: QUANTITY_MEASURE_UNITS,
      measures: ["count", "length", "area", "volume", "mass"],
      sources: [...QUANTITY_SOURCES],
      groupings: [...QUANTITY_GROUPINGS],
      rules: QUANTITY_RULE_TABLE.map((entry) => ({ ...entry })),
      liveCounts: [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([type, count]) => ({ type, count })),
    });
  }

  /** revisions.list (query) — the revision table (document order). */
  private qRevisionsList(): CommandQueryResponse {
    return ok({
      revisions: this.doc.revisionTable.map((r) => ({
        id: r.id,
        code: r.code,
        description: r.description,
        issued: r.issued,
        createdAt: r.createdAt,
        layoutIds: [...r.layoutIds],
      })),
    });
  }

  /** publisher.list (query) — the publisher-set table (document order). */
  private qPublisherList(): CommandQueryResponse {
    return ok({
      publisherSets: this.doc.publisherSetTable.map((s) => ({ id: s.id, name: s.name, items: [...s.items] })),
    });
  }

  /** docs.exchangeReport (query) — the typed IFC/documentation exchange
   *  classification report (the ifc/report.ts classification vocabulary;
   *  counts = the CURRENT document tables). This is the explicit
   *  "typed unsupported outcomes" evidence for the documentation surface:
   *  only the model elements exchange exactly; the documentation production
   *  constructs are project-internal (unsupported) or presentation-derived
   *  (lossy) — never silently approximated. */
  private qDocsExchangeReport(): CommandQueryResponse {
    interface DocsExchangeEntry {
      readonly concept: string;
      readonly classification: IfcFieldClassification;
      readonly note: string;
    }
    const classifications: readonly DocsExchangeEntry[] = [
      { concept: "model-elements", classification: "exact", note: "Model geometry and material semantics exchange through ifc.export (COMPAT-IFC-001)." },
      { concept: "navigator-structure", classification: "unsupported", note: "IFC has no navigator/project-map concept; the tree is project-internal." },
      { concept: "saved-views", classification: "unsupported", note: "Saved plan/elevation/section/detail views have no IFC carrier; use Sheet IR for documentation exchange." },
      { concept: "sheets", classification: "unsupported", note: "Documentation sheets serialize through the offisos-sheet-IR contract, not IFC." },
      { concept: "layouts", classification: "unsupported", note: "Layout/master-layout/paper-space semantics are not representable in IFC." },
      { concept: "title-blocks", classification: "unsupported", note: "Title-block placements are layout-space constructs with no IFC entity." },
      { concept: "schedules", classification: "lossy", note: "Schedule/index presentation is derived; IFC exchanges the underlying property/model data, not the presentation." },
      { concept: "revisions", classification: "unsupported", note: "Document revision metadata has no IFC carrier in the supported contract (BCF topics are the coordination channel, out of scope here)." },
      { concept: "publisher-sets", classification: "unsupported", note: "Publisher sets are an output-automation concept with no IFC representation." },
    ];
    return ok({
      contract: "offisos-docs-exchange/1",
      classifications,
      counts: {
        views: this.doc.viewTable.length,
        sheets: this.doc.sheetTable.length,
        layouts: this.doc.layoutTable.length,
        titleBlocks: this.doc.titleBlockTable.length,
        schedules: this.doc.scheduleTable.length,
        revisions: this.doc.revisionTable.length,
        publisherSets: this.doc.publisherSetTable.length,
        navigatorNodes: this.doc.navigatorNodeTable.length,
      },
    });
  }

  // ===========================================================================
  // CAD-PARITY-016 (additive, Issue #112): the collaboration/recovery/scale
  // command + query surface. The CADDocument remains the single canonical
  // system of record (LOCK-019); every store below is a session-side
  // support mechanism bound to canonical revisions/objects.
  // ===========================================================================

  /** The shared typed-error mapping for the P016 support cores. */
  private p016Err(e: unknown): CommandQueryResponse {
    if (e instanceof CollabError) return err(e.code, e.message, false);
    if (e instanceof JobError) return err(e.code, e.message, false);
    if (e instanceof StreamError) return err(e.code, e.message, false);
    return err("p016_failed", (e as Error).message, false);
  }

  // --- recovery -------------------------------------------------------------

  /** recovery.checkpoint — capture a durable versioned checkpoint of the
   *  CURRENT canonical revision (manual cause; the autosave policy runs in
   *  the background on every version-changing command). */
  private cmdRecoveryCheckpoint(): CommandQueryResponse {
    const view = this.mintCheckpoint("manual");
    return ok({
      checkpoint: view,
      policy: this.checkpoints.recoveryPolicy,
      retained: this.checkpoints.checkpointCount,
      snapshot: this.doc.snapshot(),
    });
  }

  /** recovery.autosave — force an autosave-cause checkpoint through the SAME
   *  store path the automatic policy takes (the policy escape hatch). */
  private cmdRecoveryAutosave(): CommandQueryResponse {
    this.autosaveCount += 1;
    this.mutationsSinceAutosave = 0;
    const view = this.mintCheckpoint("autosave");
    return ok({
      checkpoint: view,
      policy: this.checkpoints.recoveryPolicy,
      retained: this.checkpoints.checkpointCount,
      snapshot: this.doc.snapshot(),
    });
  }

  /** recovery.restore — deterministic crash/session recovery. A pre-restore
   *  safety checkpoint of the CURRENT state is minted first (nothing is
   *  lost); the requested checkpoint (default: the latest VALID one) is
   *  rebuilt through the canonical CADDocument.open path and integrity-
   *  validated hash-exactly; corrupt candidates are skipped with typed
   *  reasons — never a silent repair. The restored document IS the
   *  canonical document. */
  private cmdRecoveryRestore(payload: unknown): CommandQueryResponse {
    const p = payload as { checkpointId?: unknown } | null;
    if (p !== null && typeof p === "object" && p.checkpointId !== undefined &&
        (typeof p.checkpointId !== "string" || p.checkpointId.length === 0)) {
      return err("bad_payload", "recovery.restore checkpointId must be a non-empty string when present", true);
    }
    const requestedId =
      p !== null && typeof p === "object" && typeof p.checkpointId === "string" && p.checkpointId.length > 0
        ? p.checkpointId
        : null;
    const pre = this.mintCheckpoint("pre-restore");
    try {
      const { doc: restored, report } = this.checkpoints.scanAndRestore(
        requestedId,
        (snapshot) => CADDocument.open(snapshot as CADDocumentSnapshot, this.options.createdBy),
        (d) => d.currentContentHash(),
        (d) => this.freshXrefStatuses(d),
        this.sessionClock,
      );
      this.doc = restored;
      this.docEpoch += 1;
      this.restoreCount += 1;
      this.mutationsSinceAutosave = 0;
      this.collab.noteSystemEvent(
        "recovery.restored",
        `recovery restored ${report.chosen.id} (cause ${report.chosen.cause}, v${report.restoredVersionNumber}, ${report.skipped.length} skipped) — pre-restore ${pre.id} retained`,
        this.sessionClock,
      );
      return ok({
        report,
        preRestoreCheckpoint: pre,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      return err("recovery_failed", (e as Error).message, false);
    }
  }

  /** recovery.list — the retained checkpoint inventory + the policy + the
   *  recovery counters (fresh, never persisted stale). */
  private qRecoveryList(): CommandQueryResponse {
    return ok({
      checkpoints: this.checkpoints.list(),
      policy: this.checkpoints.recoveryPolicy,
      counters: {
        commands: this.commandCount,
        mutationsSinceAutosave: this.mutationsSinceAutosave,
        autosaves: this.autosaveCount,
        restores: this.restoreCount,
        retained: this.checkpoints.checkpointCount,
      },
    });
  }

  // --- collaboration ----------------------------------------------------------

  /** collab.join — register a project-scoped member with a closed role. */
  private cmdCollabJoin(payload: unknown): CommandQueryResponse {
    const p = payload as { userId?: unknown; role?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.userId !== "string" || typeof p.role !== "string") {
      return err("bad_payload", "collab.join requires { userId, role }", true);
    }
    try {
      const member = this.collab.join(p.userId, p.role as CollabMemberView["role"], this.sessionClock);
      return ok({ member, documentVersion: this.doc.snapshot().version.version_number });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** collab.presence — the heartbeat (liveness + the revision the member is
   *  viewing; deterministic session-clock semantics). */
  private cmdCollabPresence(payload: unknown): CommandQueryResponse {
    const p = payload as { userId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.userId !== "string") {
      return err("bad_payload", "collab.presence requires { userId }", true);
    }
    try {
      const member = this.collab.presence(
        p.userId,
        this.sessionClock,
        this.doc.snapshot().version.version_number,
      );
      return ok({ member, presenceTtl: PRESENCE_TTL });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** collab.comment — add a permission-checked comment linked to a canonical
   *  target (document / element id / model revision), bound to the document
   *  version at creation. */
  private cmdCollabComment(payload: unknown): CommandQueryResponse {
    const p = payload as { userId?: unknown; body?: unknown; target?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.userId !== "string" || typeof p.body !== "string") {
      return err("bad_payload", "collab.comment requires { userId, body, target? }", true);
    }
    let target: CommentTarget = { kind: "document" };
    if (p.target !== undefined && p.target !== null) {
      const t = p.target as { kind?: unknown; id?: unknown; revisionRef?: unknown };
      if (typeof t !== "object" || typeof t.kind !== "string") {
        return err("bad_payload", "comment target must be { kind, id?, revisionRef? }", true);
      }
      if (t.kind !== "document" && t.kind !== "element" && t.kind !== "revision") {
        return err("bad_payload", "comment target kind must be document|element|revision", true);
      }
      target = {
        kind: t.kind,
        ...(typeof t.id === "string" ? { id: t.id } : {}),
        ...(typeof t.revisionRef === "string" ? { revisionRef: t.revisionRef } : {}),
      };
    }
    // The canonical-target validation (a comment must link a REAL canonical
    // object/revision — never a dangling reference).
    if (target.kind === "element") {
      if (typeof target.id !== "string" || this.doc.elementById(target.id) === undefined) {
        return err(
          "collab_bad_target",
          `comment target element '${String(target.id)}' does not exist in the canonical document`,
          false,
        );
      }
    } else if (target.kind === "revision") {
      if (typeof target.revisionRef !== "string") {
        return err("collab_bad_target", "revision comment target requires a revisionRef", true);
      }
      const known = new Set<string>(this.doc.history.revisions.map((r) => r.revision_id));
      known.add(headRevisionIdOf(this.doc.history).id);
      if (!known.has(target.revisionRef)) {
        return err(
          "collab_bad_target",
          `comment target revision '${target.revisionRef}' is not a canonical model revision of this document`,
          false,
        );
      }
    }
    try {
      const comment = this.collab.addComment(
        p.userId,
        p.body,
        target,
        this.sessionClock,
        this.doc.snapshot().version.version_number,
      );
      return ok({ comment });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** collab.resolveComment — record the resolving member. */
  private cmdCollabResolveComment(payload: unknown): CommandQueryResponse {
    const p = payload as { commentId?: unknown; userId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.commentId !== "string" || typeof p.userId !== "string") {
      return err("bad_payload", "collab.resolveComment requires { commentId, userId }", true);
    }
    try {
      const comment = this.collab.resolveComment(p.commentId, p.userId, this.sessionClock);
      return ok({ comment });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** collab.commit — the versioned transactional change. ONE atomic
   *  versioned revision per applied transaction (the applyEdits batch —
   *  the same atomicity the professional batch commands use); a moved head
   *  produces the explicit reproducible conflict record. */
  private cmdCollabCommit(payload: unknown): CommandQueryResponse {
    const p = payload as { userId?: unknown; baseVersion?: unknown; edits?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      typeof p.userId !== "string" ||
      typeof p.baseVersion !== "number" || !Number.isInteger(p.baseVersion) ||
      !Array.isArray(p.edits) || p.edits.length === 0
    ) {
      return err("bad_payload", "collab.commit requires { userId, baseVersion, edits }", true);
    }
    if (p.edits.length > 200) {
      return err("bad_payload", "collab.commit edits are bounded to 200 per transaction", true);
    }
    for (const edit of p.edits) {
      const e = edit as { type?: unknown; elementId?: unknown; element?: unknown };
      if (typeof e?.type !== "string") {
        return err("bad_payload", "each collab edit requires a type", true);
      }
      if (e.type === "addElement") {
        if (typeof e.element !== "object" || e.element === null) {
          return err("bad_payload", "addElement requires element", true);
        }
      } else if (e.type === "removeElement" || e.type === "updateElement" || e.type === "setProps") {
        if (typeof e.elementId !== "string" || e.elementId.length === 0) {
          return err("bad_payload", `${e.type} requires elementId`, true);
        }
      } else {
        return err(
          "bad_payload",
          `collab edit type must be addElement|removeElement|updateElement|setProps (got '${e.type}')`,
          true,
        );
      }
    }
    const edits = p.edits as DocumentEdit[];
    try {
      const currentVersion = this.doc.snapshot().version.version_number;
      const outcome = this.collab.commit(
        p.userId,
        p.baseVersion,
        edits,
        this.sessionClock,
        currentVersion,
        (batch) => {
          this.doc.execute({ type: "applyEdits", edits: batch as DocumentEdit[] });
          return this.doc.snapshot().version.version_number;
        },
      );
      return ok({
        applied: outcome.applied,
        transaction: outcome.view,
        ...(outcome.applied ? { snapshot: this.doc.snapshot() } : {}),
      });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** collab.merge — resolve an open conflict through the closed
   *  rebase/discard vocabulary with recorded merge/resolution lineage. */
  private cmdCollabMerge(payload: unknown): CommandQueryResponse {
    const p = payload as { transactionId?: unknown; userId?: unknown; strategy?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      typeof p.transactionId !== "string" ||
      typeof p.userId !== "string" ||
      typeof p.strategy !== "string"
    ) {
      return err("bad_payload", "collab.merge requires { transactionId, userId, strategy }", true);
    }
    if (p.strategy !== "rebase" && p.strategy !== "discard") {
      return err("bad_payload", "collab.merge strategy must be rebase|discard", true);
    }
    try {
      const currentVersion = this.doc.snapshot().version.version_number;
      const outcome = this.collab.merge(
        p.transactionId,
        p.userId,
        p.strategy,
        this.sessionClock,
        currentVersion,
        (batch) => {
          this.doc.execute({ type: "applyEdits", edits: batch as DocumentEdit[] });
          return this.doc.snapshot().version.version_number;
        },
      );
      return ok({
        transaction: outcome.view,
        merge: outcome.merge,
        ...(outcome.merge.resultingVersion !== null ? { snapshot: this.doc.snapshot() } : {}),
      });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** collab.state — the member roster with computed presence liveness. */
  private qCollabState(): CommandQueryResponse {
    return ok({
      members: this.collab.memberList(this.sessionClock),
      presenceTtl: PRESENCE_TTL,
      sessionClock: this.sessionClock,
      commands: this.commandCount,
      documentVersion: this.doc.snapshot().version.version_number,
    });
  }

  /** collab.comments — the comment list (canonical targets + revision
   *  bindings). */
  private qCollabComments(): CommandQueryResponse {
    return ok({ comments: this.collab.commentList() });
  }

  /** collab.activity — the bounded append-only activity stream. */
  private qCollabActivity(): CommandQueryResponse {
    return ok({ activity: this.collab.activityList() });
  }

  /** collab.transactions — the versioned transaction inventory with the
   *  conflict and merge/resolution lineage. */
  private qCollabTransactions(): CommandQueryResponse {
    return ok({ transactions: this.collab.transactionList() });
  }

  // --- background regeneration (durable jobs) --------------------------------

  /** jobs.create — queue a durable background-regeneration job (closed kind
   *  vocabulary; read-only document work; never authority). */
  private cmdJobsCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { kind?: unknown; params?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.kind !== "string") {
      return err("bad_payload", "jobs.create requires { kind, params? }", true);
    }
    try {
      const params = p.params === undefined || p.params === null ? {} : p.params;
      const job = this.jobs.create(p.kind as JobKind, params, this.sessionClock, this.doc);
      this.collab.noteSystemEvent(
        "job.created",
        `job ${job.id} queued (${job.kind}, ${job.totalSteps} step(s))`,
        this.sessionClock,
      );
      return ok({ job });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** jobs.tick — advance ONE job by ONE deterministic step (the
   *  serverless-honest durable execution model — no hidden background
   *  thread). */
  private cmdJobsTick(payload: unknown): CommandQueryResponse {
    const p = payload as { jobId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.jobId !== "string" || p.jobId.length === 0) {
      return err("bad_payload", "jobs.tick requires { jobId }", true);
    }
    try {
      const job = this.jobs.tick(p.jobId, this.sessionClock, {
        doc: this.doc,
        streamPage: (doc, pageIndex, pageSize) => this.stream.page(doc, pageIndex, pageSize),
      });
      if (job.status === "succeeded") {
        this.collab.noteSystemEvent(
          "job.succeeded",
          `job ${job.id} succeeded (${job.kind}, ${job.step}/${job.totalSteps} steps)`,
          this.sessionClock,
        );
      } else if (job.status === "failed") {
        this.collab.noteSystemEvent(
          "job.failed",
          `job ${job.id} failed (${job.kind}: ${job.failure?.code ?? "job_failed"})`,
          this.sessionClock,
        );
      }
      return ok({ job });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** jobs.list / jobs.get — the durable job states (read-only). */
  private qJobsList(): CommandQueryResponse {
    return ok({ jobs: this.jobs.list() });
  }

  private qJobsGet(payload: unknown): CommandQueryResponse {
    const p = payload as { jobId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.jobId !== "string" || p.jobId.length === 0) {
      return err("bad_payload", "jobs.get requires { jobId }", true);
    }
    const job = this.jobs.byId(p.jobId);
    if (job === null) {
      return err("job_not_found", `job '${p.jobId}' does not exist`, false);
    }
    return ok({ job });
  }

  // --- large-model streaming (bounded, cache non-authority) -------------------

  /** model.stream — ONE canonical id-sorted element page (version +
   *  content-hash bound; the bounded page-size grammar). */
  private qModelStream(payload: unknown): CommandQueryResponse {
    const p = payload as { pageIndex?: unknown; pageSize?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.pageIndex !== "number" || !Number.isInteger(p.pageIndex) || p.pageIndex < 0) {
      return err("bad_payload", "model.stream requires { pageIndex, pageSize? }", true);
    }
    const pageSize =
      p.pageSize === undefined
        ? STREAM_PAGE_SIZE_DEFAULT
        : typeof p.pageSize === "number" && Number.isInteger(p.pageSize)
          ? p.pageSize
          : -1;
    try {
      const page = this.stream.page(this.doc, p.pageIndex, pageSize);
      return ok({ page });
    } catch (e) {
      return this.p016Err(e);
    }
  }

  /** model.streamStats — the bounded stream cache's exact counters (the
   *  explicit non-authority + performance-budget evidence). */
  private qModelStreamStats(): CommandQueryResponse {
    return ok({ stats: this.stream.stats() });
  }

  // --- external references (fresh status + explicit outcomes) ------------------

  /** The fresh external-reference status computation (the P016 outcome
   *  table — computed against the supplied document, never persisted
   *  stale). */
  private freshXrefStatuses(doc: CADDocument): readonly XrefStatusView[] {
    const elements = doc.allElements();
    const binding = {
      documentVersionNumber: doc.snapshot().version.version_number,
      contentHash: doc.currentContentHash(),
    };
    return doc.xrefTable.map((rec) => {
      let instances = 0;
      for (const el of elements) {
        const props = el.props as Record<string, unknown>;
        if (props.drafting === true && props.type === "xref-ref" && props.xrefId === rec.id) instances++;
      }
      const ext = pathExtensionOf(rec.path);
      let outcome: XrefOutcome;
      let detail: string;
      if (rec.status === "unresolved") {
        outcome = "unavailable";
        detail = "external source not supplied (unresolved record — content required at attach/reload)";
      } else if (ext === ".dwg" || ext === ".rvt" || ext === ".dgn") {
        outcome = "unsupported";
        detail = `declared source format '${ext}' is outside the bounded external-reference support (the dwg_unsupported-class decline)`;
      } else {
        outcome = "available";
        detail = `loaded (sha ${rec.sourceHash?.slice(0, 12) ?? ""}…, ${rec.entities.length} entit${rec.entities.length === 1 ? "y" : "ies"}, ${instances} instance${instances === 1 ? "" : "s"})`;
      }
      return {
        id: rec.id,
        name: rec.name,
        path: rec.path,
        recordStatus: rec.status,
        sourceHash: rec.sourceHash,
        entityCount: rec.entities.length,
        instances,
        outcome,
        detail,
        revisionBinding: binding,
      };
    });
  }

  /** xrefs.status — the fresh external-reference status with the explicit
   *  available/unavailable/unsupported outcomes + the canonical revision
   *  binding. */
  private qXrefsStatus(): CommandQueryResponse {
    return ok({ xrefs: this.freshXrefStatuses(this.doc) });
  }

  /** xrefs.probe — the client-supplied source-hash probe (the explicit
   *  STALE outcome: the record's attach/reload-time hash vs the current
   *  external source hash; the record is never mutated by a probe). */
  private qXrefsProbe(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; sourceHash?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.name !== "string" || typeof p.sourceHash !== "string" || p.sourceHash.length === 0) {
      return err("bad_payload", "xrefs.probe requires { name, sourceHash }", true);
    }
    const rec = this.doc.xrefByName(p.name);
    if (rec === undefined) {
      return err("xref_not_found", `external reference '${p.name}' does not exist`, false);
    }
    if (rec.status === "unresolved" || rec.sourceHash === null) {
      return ok({
        probe: {
          id: rec.id,
          name: rec.name,
          recordSourceHash: null,
          probedSourceHash: p.sourceHash,
          outcome: "unavailable" as XrefOutcome,
          detail: "record is unresolved — no recorded source hash to compare against",
        },
      });
    }
    const outcome: XrefOutcome = rec.sourceHash === p.sourceHash ? "available" : "stale";
    const detail =
      outcome === "available"
        ? "record and probed source hashes match — the external source is current"
        : `record sha ${rec.sourceHash.slice(0, 12)}… vs probed ${p.sourceHash.slice(0, 12)}… — the external source moved (reload to adopt)`;
    return ok({
      probe: {
        id: rec.id,
        name: rec.name,
        recordSourceHash: rec.sourceHash,
        probedSourceHash: p.sourceHash,
        outcome,
        detail,
      },
    });
  }

  // --- observable performance budgets (revision-bound) -------------------------

  /** The declared observable performance-budget thresholds (the smoke
   *  measures wall-clock per call and asserts these; only deterministic
   *  counters are pinned — never the wall-clock values). */
  private static readonly P016_PERF_BUDGETS: readonly {
    workflow: string;
    thresholdMs: number;
  }[] = [
    { workflow: "recovery.checkpoint (per call)", thresholdMs: 2000 },
    { workflow: "recovery.restore (per call)", thresholdMs: 5000 },
    { workflow: "collab.comment (per call)", thresholdMs: 1000 },
    { workflow: "collab.commit (per call)", thresholdMs: 2000 },
    { workflow: "model.stream page (cache miss, 500+ elements)", thresholdMs: 3000 },
    { workflow: "jobs.tick (per step)", thresholdMs: 2000 },
  ];

  /** perf.budgets — the declared thresholds + the deterministic P016
   *  counters, bound to the current canonical revision. */
  private qPerfBudgets(): CommandQueryResponse {
    const snapshot = this.doc.snapshot();
    const head = headRevisionIdOf(this.doc.history);
    const view: PerfBudgetsView = {
      revision: {
        documentVersionId: snapshot.version.version_id,
        documentVersionNumber: snapshot.version.version_number,
        contentHash: this.doc.currentContentHash(),
        modelRevisionNumber: head.number,
        modelRevisionId: head.id,
        elementCount: snapshot.elements.length,
      },
      budgets: AppApiHandler.P016_PERF_BUDGETS.map((b) => ({
        workflow: b.workflow,
        thresholdMs: b.thresholdMs,
        unit: "ms" as const,
        measuredBy: "smoke-observed" as const,
      })),
      counters: {
        commands: this.commandCount,
        checkpoints: this.checkpoints.checkpointCount + this.autosaveCount + this.restoreCount,
        autosaves: this.autosaveCount,
        restores: this.restoreCount,
        comments: this.collab.commentCount,
        presenceBeats: this.collab.presenceBeatCount,
        transactions: this.collab.transactionCount,
        conflicts: this.collab.conflictCount,
        merges: this.collab.mergeCount,
        streamPages: this.stream.servedPageCount,
        cacheHits: this.stream.hitCount,
        cacheMisses: this.stream.missCount,
        cacheStaleEvictions: this.stream.staleEvictionCount,
        jobTicks: this.jobs.jobTickCount,
      },
    };
    return ok(view);
  }

}
