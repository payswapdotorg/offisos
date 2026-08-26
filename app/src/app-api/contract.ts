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
import {
  isAdapterFailure,
  isGeometryMetadataProvider,
  isMeshProvider,
} from "../contracts/geometry.js";
import type { GeometryPrepareResult } from "../contracts/geometry.js";
import { IdempotencyCache } from "./idempotency.js";
import { bridgeModelHistory } from "../graph/index.js";
import { verifiedReplay } from "../caddocument/history.js";
import type { ModelReplayResult } from "../contracts/model.js";

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
      default: {
        const _exhaustive: never = query.name;
        return err("unknown_query", `unknown query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
