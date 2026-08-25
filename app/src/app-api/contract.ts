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
import type { CADDocumentSnapshot, DocumentEdit, VersionMeta } from "../contracts/caddocument.js";
import { CADDocument } from "../caddocument/index.js";
import { deserialize, serialize } from "../caddocument/index.js";
import { err, ok } from "../contracts/app-api.js";
import { IdempotencyCache } from "./idempotency.js";

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
    this.doc = CADDocument.open(snapshot, this.options.createdBy);
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
      default: {
        const _exhaustive: never = query.name;
        return err("unknown_query", `unknown query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
