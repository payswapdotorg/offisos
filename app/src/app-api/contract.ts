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
// COMPAT-CAD-002: the pure BIM authoring core (LOCK-018 scanned).
import {
  buildBimCreate,
  bimGeometryContext,
  bimModelBBox,
  bimSolidDescriptor,
  copyBimElements,
  deleteBimElements,
  elementToBimEntityOrNull,
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
import { isIfcInteropProvider } from "../contracts/adapter.js";
import type { IfcInteropAdapter } from "../contracts/adapter.js";
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

export interface AppApiHandlerOptions {
  readonly adapterBundle: EngineAdapterBundle;
  readonly entityId: string;
  readonly format: string;
  readonly formatVersion: string;
  readonly createdBy: string;
}

export class AppApiHandler {
  private doc: CADDocument;
  private readonly adapters: EngineAdapterBundle;
  private readonly options: AppApiHandlerOptions;
  private readonly idempotency: IdempotencyCache = new IdempotencyCache();

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

  /** Process a command/query request. Idempotent for commands with a key. */
  async handle(request: CommandQueryRequest): Promise<CommandQueryResponse> {
    if (request.type === "command" && request.idempotencyKey !== undefined) {
      const cached = this.idempotency.get(request.idempotencyKey);
      if (cached !== undefined) return cached;
    }
    const response =
      request.type === "command" ? await this.handleCommand(request) : await this.handleQuery(request);
    if (request.type === "command" && request.idempotencyKey !== undefined) {
      this.idempotency.set(request.idempotencyKey, response);
    }
    return response;
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
   *  entities); instances propagate through the shared expansion. */
  private cmdBlockUpdate(payload: unknown): CommandQueryResponse {
    const p = payload as { name?: unknown; blockId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "block.update requires name|blockId + patch", true);
    }
    try {
      const def = this.resolveBlockDef(p);
      this.doc.execute({ type: "updateBlockDef", blockId: def.id, patch: p.patch as Record<string, unknown> });
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
   *  pure inputs both hosts pass — parity by construction). */
  private plotIRInputOf(layout: LayoutRecord): PlotIRInput {
    const settings = this.doc.draftingSettings;
    return {
      layout,
      viewports: this.doc.viewportsOfLayout(layout.id),
      elements: this.doc.allElements(),
      layers: this.doc.layerTable,
      ltypes: this.doc.ltypeTable,
      textStyles: this.doc.textStyleTable,
      dimStyles: this.doc.dimStyleTable,
      ...(settings.standards !== undefined ? { standards: settings.standards } : {}),
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
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((entity) => ids === null || ids.includes(entity.id));
    if (entities.length === 0) {
      return err("bad_payload", "bim.buildGeometry found no BIM elements to build", true);
    }
    const ctx = bimGeometryContext(entities);
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
    return ok({ built: results.length, results, skipped, snapshot: this.doc.snapshot() });
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
      };
    });
    return ok({ stories: building, bimSettings: this.doc.bimSettings });
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
   *  canonical ids; GlobalIds derive from them). */
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
      const built = await adapter.build(outcome.request);
      return ok({
        ifc: built.ifc,
        size: built.size,
        sha256: built.sha256,
        schema: "IFC4",
        engineVersion: built.engineVersion,
        counts: outcome.counts,
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

  /** ifc.bcfCreate — build a BCF-XML v3 .bcf container binding topics to
   *  CANONICAL elements (IfcGuids derived deterministically from the
   *  canonical ids). BCF is a transport contract, never the system of
   *  record (Issue #47). */
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
        return {
          title: t.title,
          description: t.description,
          author: typeof t.author === "string" ? t.author : "offisos",
          type: typeof t.type === "string" ? t.type : "Issue",
          status: typeof t.status === "string" ? t.status : "Open",
          references: (elementIds as string[]).map((id) => ifcGuidFor(id)),
          comment: typeof t.comment === "string" && t.comment.length > 0 ? t.comment : null,
          commentAuthor: typeof t.commentAuthor === "string" ? t.commentAuthor : null,
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

  /** docs.exportSheet — the canonical Sheet IR (the PDF/DWG adapter
   *  contract). pdf/dwg are CONTRACTS ONLY in this slice: the writers are
   *  not implemented and the request fails typed docs_unsupported. */
  private qDocsExportSheet(payload: unknown): CommandQueryResponse {
    const p = payload as { sheetId?: unknown; format?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.sheetId !== "string" ||
      !isDocsExportFormat(p.format)
    ) {
      return err("bad_payload", "docs.exportSheet requires sheetId + format ('sheet-ir' | 'pdf' | 'dwg')", true);
    }
    if (p.format !== "sheet-ir") {
      return err(
        "docs_unsupported",
        `'${p.format}' writer is not implemented in this slice — the export CONTRACT is the canonical Sheet IR ('sheet-ir'); future adapters consume it (explicit, no partial writer)`,
        false,
      );
    }
    const sheet = this.doc.sheetById(p.sheetId);
    if (sheet === undefined) {
      return err("docs_invalid", `no sheet '${p.sheetId}'`, false);
    }
    try {
      const built = buildSheetIR(sheet as DocsSheetRecord, this.doc.viewTable, this.doc.allElements());
      return ok({ format: "sheet-ir", sheetId: sheet.id, ir: built.ir, canonical: built.canonical, hash: built.hash });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

}
