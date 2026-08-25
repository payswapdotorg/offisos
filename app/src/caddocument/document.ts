/**
 * CADDocument — the editor's canonical working representation (§5.4, §15,
 * data-model.md §2, LOCK-019).
 *
 * Provides document-local object identity, editor state, command/undo/redo
 * semantics, model tree, source artifact lineage and format/version metadata.
 * NOT the Construction Graph (LOCK-019): CADDocument identity is editor/file
 * identity; Construction Graph identity is mapped through explicit versioned
 * contracts/events.
 *
 * Versioned document transactions (§15): each `execute` creates a child
 * version whose id is derived from the canonical content hash (deterministic,
 * reproducible). `undo` reverts to the parent version; `redo` re-applies the
 * child version. The same command sequence through any host yields the same
 * version chain and content hash (Web/Electron parity, §5.5).
 */

import { createHash } from "node:crypto";
import type {
  CADDocumentSnapshot,
  DocumentEdit,
  Element,
  EditorState,
  VersionMeta,
} from "../contracts/caddocument.js";
import { childVersion, rootVersion } from "./versioning.js";
import { canonicalHash, canonicalStringify } from "./serialization.js";

interface UndoEntry {
  readonly forward: DocumentEdit;
  readonly inverse: DocumentEdit;
  readonly fromVersion: VersionMeta;
  readonly toVersion: VersionMeta;
}

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z").toISOString();

export class CADDocument {
  private version: VersionMeta;
  private readonly elements: Map<string, Element> = new Map();
  private readonly format: string;
  private readonly formatVersion: string;
  private readonly sourceArtifactLineage: string[];
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  private readonly createdBy: string;

  private constructor(
    version: VersionMeta,
    elements: Iterable<Element>,
    format: string,
    formatVersion: string,
    lineage: Iterable<string>,
    createdBy: string,
  ) {
    this.version = version;
    for (const e of elements) this.elements.set(e.id, e);
    this.format = format;
    this.formatVersion = formatVersion;
    this.sourceArtifactLineage = [...lineage];
    this.createdBy = createdBy;
  }

  /** Open a snapshot: load state, set version, clear undo/redo. */
  static open(snapshot: CADDocumentSnapshot, createdBy: string): CADDocument {
    return new CADDocument(
      snapshot.version,
      snapshot.elements,
      snapshot.format,
      snapshot.formatVersion,
      snapshot.sourceArtifactLineage,
      createdBy,
    );
  }

  /** Create an empty document (root version). */
  static empty(entityId: string, format: string, formatVersion: string, createdBy: string): CADDocument {
    const root = rootVersion(entityId, createdBy, null, FIXED_NOW);
    return new CADDocument(root, [], format, formatVersion, [], createdBy);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get commandDepth(): number {
    return this.undoStack.length;
  }

  /** Apply an edit, bump version, push inverse onto undo stack, clear redo.
   *  Returns the computed inverse (for audit). */
  execute(edit: DocumentEdit): DocumentEdit {
    const inverse = this.computeInverse(edit);
    const fromVersion = this.version;
    this.applyEdit(edit);
    const contentHash = this.contentHashAt(fromVersion);
    this.version = childVersion(fromVersion, contentHash, this.createdBy, fromVersion.source_snapshot_id, FIXED_NOW);
    this.undoStack.push({ forward: edit, inverse, fromVersion, toVersion: this.version });
    this.redoStack.length = 0;
    return inverse;
  }

  /** Undo the last edit. Reverts content and version. Returns the undone
   *  forward edit, or null if there is nothing to undo. */
  undo(): DocumentEdit | null {
    const entry = this.undoStack.pop();
    if (entry === undefined) return null;
    this.applyEdit(entry.inverse);
    this.version = entry.fromVersion;
    this.redoStack.push(entry);
    return entry.forward;
  }

  /** Redo the last undone edit. Re-applies content and version. Returns the
   *  re-applied forward edit, or null if there is nothing to redo. */
  redo(): DocumentEdit | null {
    const entry = this.redoStack.pop();
    if (entry === undefined) return null;
    this.applyEdit(entry.forward);
    this.version = entry.toVersion;
    this.undoStack.push(entry);
    return entry.forward;
  }

  /** An immutable point-in-time snapshot (§5.4). */
  snapshot(): CADDocumentSnapshot {
    const editorState: EditorState = {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      commandDepth: this.commandDepth,
    };
    return {
      version: this.version,
      format: this.format,
      formatVersion: this.formatVersion,
      sourceArtifactLineage: this.sourceArtifactLineage,
      editorState,
      elements: [...this.elements.values()],
    };
  }

  // --- Internals -----------------------------------------------------------

  private applyEdit(edit: DocumentEdit): void {
    switch (edit.type) {
      case "addElement": {
        if (edit.element === undefined) throw new Error("addElement requires element");
        this.elements.set(edit.element.id, edit.element);
        break;
      }
      case "removeElement": {
        if (edit.elementId === undefined) throw new Error("removeElement requires elementId");
        this.elements.delete(edit.elementId);
        break;
      }
      case "updateElement": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("updateElement requires elementId + patch");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`updateElement: no element '${edit.elementId}'`);
        this.elements.set(edit.elementId, { ...el, props: { ...el.props, ...edit.patch } });
        break;
      }
      case "setProps": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("setProps requires elementId + patch (full props)");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`setProps: no element '${edit.elementId}'`);
        this.elements.set(edit.elementId, { ...el, props: edit.patch });
        break;
      }
      default: {
        const _exhaustive: never = edit.type;
        throw new Error(`unreachable edit type: ${_exhaustive}`);
      }
    }
  }

  private computeInverse(edit: DocumentEdit): DocumentEdit {
    switch (edit.type) {
      case "addElement": {
        if (edit.element === undefined) throw new Error("addElement requires element");
        return { type: "removeElement", elementId: edit.element.id };
      }
      case "removeElement": {
        if (edit.elementId === undefined) throw new Error("removeElement requires elementId");
        const existing = this.elements.get(edit.elementId);
        if (existing === undefined) throw new Error(`removeElement: no element '${edit.elementId}'`);
        return { type: "addElement", element: existing };
      }
      case "updateElement": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("updateElement requires elementId + patch");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`updateElement: no element '${edit.elementId}'`);
        const prevValues: Record<string, unknown> = {};
        for (const k of Object.keys(edit.patch)) {
          prevValues[k] = (el.props as Record<string, unknown>)[k];
        }
        return { type: "updateElement", elementId: edit.elementId, patch: prevValues };
      }
      case "setProps": {
        if (edit.elementId === undefined || edit.patch === undefined) {
          throw new Error("setProps requires elementId + patch");
        }
        const el = this.elements.get(edit.elementId);
        if (el === undefined) throw new Error(`setProps: no element '${edit.elementId}'`);
        return { type: "setProps", elementId: edit.elementId, patch: { ...el.props } };
      }
      default: {
        const _exhaustive: never = edit.type;
        throw new Error(`unreachable edit type: ${_exhaustive}`);
      }
    }
  }

  /** Canonical content hash excluding the version metadata itself (so the
   *  hash is a pure function of document content, not of the version label). */
  private contentHashAt(_atVersion: VersionMeta): string {
    const content = {
      format: this.format,
      formatVersion: this.formatVersion,
      sourceArtifactLineage: this.sourceArtifactLineage,
      elements: [...this.elements.values()],
    };
    return createHash("sha256").update(canonicalStringify(content)).digest("hex");
  }

  /** Expose the canonical hash of the current snapshot (for parity tests). */
  currentContentHash(): string {
    return canonicalHash(this.snapshot());
  }
}
