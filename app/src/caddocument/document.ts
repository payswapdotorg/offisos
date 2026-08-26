/**
 * CADDocument — the editor's canonical working representation (§5.4, §15,
 * data-model.md §2, LOCK-019).
 *
 * Provides document-local object identity, editor state, command/undo/redo
 * semantics, model tree, source artifact lineage, format/version metadata
 * and — since CAD-IMPLEMENT-003 — an immutable, append-only model revision
 * history (contracts/model.ts) that persists with the snapshot (save/open)
 * and replays deterministically. NOT the Construction Graph (LOCK-019):
 * CADDocument identity is editor/file identity; Construction Graph identity
 * is mapped through explicit versioned contracts/events (the graph bridge).
 *
 * Versioned document transactions (§15): each `execute` creates a child
 * version whose id is derived from the canonical content hash (deterministic,
 * reproducible). `undo` reverts to the parent version; `redo` re-applies the
 * child version. The same command sequence through any host yields the same
 * version chain, revision history and content hash (Web/Electron parity,
 * §5.5).
 *
 * Identity (§5.4 "document-local object identity"): element ids are the
 * canonical document identity — stable across revisions, save/open and
 * replay. `addElement` with a missing/empty id mints a document identity
 * (`el-000001`, monotonic, never reused); a duplicate id is rejected (an id
 * must identify ONE element for its whole lifetime). `engineId` remains a
 * provenance field only.
 */

import { createHash } from "node:crypto";
import type {
  CADDocumentSnapshot,
  DocumentEdit,
  DraftingSettings,
  Element,
  EditorState,
  LayerRecord,
  VersionMeta,
} from "../contracts/caddocument.js";
import type { ModelHistory } from "../contracts/model.js";
import { childVersion, rootVersion } from "./versioning.js";
import { canonicalStringify } from "./serialization.js";
import {
  DEFAULT_LAYER,
  applyLayerPatch,
  defaultDraftingSettings,
  deriveLayerSequence,
  elementLayerReference,
  validateDraftingSettings,
  validateLayerRecord,
} from "./workspace.js";
import {
  appendRevision,
  canonicalHashOf,
  cloneHistory,
  createdHistory,
  deepFreeze,
  deriveElementSequence,
  historyHash,
  openedHistory,
  validateHistoryLinkage,
  validateModelHistory,
} from "./history.js";

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
  /** Immutable, append-only model revision history (CAD-IMPLEMENT-003). */
  private historyState: ModelHistory;
  /** Monotonic mint counter for document-issued element identities. */
  private nextElementSequence: number;
  /** COMPAT-CAD-001: the persistent drawing layer table (insertion-ordered;
   *  edited ONLY through the DocumentEdit command model). */
  private readonly layers: Map<string, LayerRecord> = new Map();
  /** COMPAT-CAD-001: monotonic mint counter for `ly-NNNNNN` identities. */
  private nextLayerSequence: number;
  /** COMPAT-CAD-001: non-versioned drafting workspace settings (grid/snap/
   *  view; persisted with the snapshot, mutated without a version bump). */
  private draftingSettingsState: DraftingSettings = defaultDraftingSettings();
  /** Ephemeral editor selection (§5.4 editor state). Orthogonal to the
   *  versioned document content: it is NOT in the version-id derivation and
   *  NOT in the parity content hash (§5.5). Since COMPAT-CAD-001 it IS
   *  persisted with the snapshot (save/open preserves the selection); it is
   *  still cleared by undo-insensitive and re-adopted on open. */
  #selection: string[] = [];

  private constructor(
    version: VersionMeta,
    elements: Iterable<Element>,
    format: string,
    formatVersion: string,
    lineage: Iterable<string>,
    createdBy: string,
    selection: Iterable<string>,
    history: ModelHistory,
    nextElementSequence: number,
    layers: Iterable<LayerRecord>,
    nextLayerSequence: number,
    draftingSettings: DraftingSettings,
  ) {
    this.version = version;
    for (const e of elements) this.elements.set(e.id, e);
    this.format = format;
    this.formatVersion = formatVersion;
    this.sourceArtifactLineage = [...lineage];
    this.createdBy = createdBy;
    this.#selection = [...selection];
    this.historyState = history;
    this.nextElementSequence = nextElementSequence;
    for (const l of layers) this.layers.set(l.id, l);
    this.nextLayerSequence = nextLayerSequence;
    this.draftingSettingsState = draftingSettings;
  }

  /** Open a snapshot: load state, set version, clear undo/redo, adopt the
   *  persisted selection (COMPAT-CAD-001) — a legacy snapshot without one
   *  opens with an empty selection. Adopts the persisted model history when
   *  the snapshot carries one (validated structurally + linked to the
   *  snapshot version); otherwise seeds a fresh history whose base IS the
   *  opened state (legacy artifact). COMPAT-CAD-001: the layer table and
   *  drafting settings are adopted when present; a legacy snapshot without a
   *  layer table materializes the canonical default layer "0" (documented
   *  default for the additive feature, not a repair — element content and
   *  revision hashes are untouched). */
  static open(snapshot: CADDocumentSnapshot, createdBy: string): CADDocument {
    let history: ModelHistory;
    let nextElementSequence: number;
    if (snapshot.modelHistory !== undefined) {
      validateModelHistory(snapshot.modelHistory);
      validateHistoryLinkage(snapshot.modelHistory, snapshot.version, snapshot.format, snapshot.formatVersion);
      history = deepFreeze(cloneHistory(snapshot.modelHistory));
      nextElementSequence = history.next_element_sequence;
    } else {
      history = openedHistory(
        snapshot.version.entity_id,
        snapshot.format,
        snapshot.formatVersion,
        snapshot.version,
        snapshot.elements,
        snapshot.sourceArtifactLineage,
      );
      nextElementSequence = deriveElementSequence(snapshot.elements);
    }
    const layers = [...(snapshot.layers ?? [DEFAULT_LAYER])];
    for (const layer of layers) validateLayerRecord(layer);
    const draftingSettings = snapshot.draftingSettings !== undefined
      ? validateDraftingSettings(snapshot.draftingSettings)
      : defaultDraftingSettings();
    return new CADDocument(
      snapshot.version,
      snapshot.elements,
      snapshot.format,
      snapshot.formatVersion,
      snapshot.sourceArtifactLineage,
      createdBy,
      snapshot.selection ?? [],
      history,
      Math.max(nextElementSequence, history.next_element_sequence),
      layers,
      Math.max(deriveLayerSequence(layers), history.next_layer_sequence ?? 1),
      draftingSettings,
    );
  }

  /** Create an empty document (root version, fresh "created" history). The
   *  drafting workspace starts with the canonical default layer "0" and the
   *  canonical default drafting settings (COMPAT-CAD-001). */
  static empty(entityId: string, format: string, formatVersion: string, createdBy: string): CADDocument {
    const root = rootVersion(entityId, createdBy, null, FIXED_NOW);
    const history = createdHistory(entityId, format, formatVersion, root);
    return new CADDocument(
      root,
      [],
      format,
      formatVersion,
      [],
      createdBy,
      [],
      history,
      1,
      [DEFAULT_LAYER],
      1,
      defaultDraftingSettings(),
    );
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
  /** Current ephemeral editor selection (orthogonal to the versioned snapshot). */
  get selection(): readonly string[] {
    return this.#selection;
  }
  /** COMPAT-CAD-001: the persistent drawing layer table (insertion order). */
  get layerTable(): readonly LayerRecord[] {
    return [...this.layers.values()];
  }
  /** COMPAT-CAD-001: the non-versioned drafting workspace settings. */
  get draftingSettings(): DraftingSettings {
    return this.draftingSettingsState;
  }
  /** The immutable model revision history (frozen; LOCK-005). */
  get history(): ModelHistory {
    return this.historyState;
  }
  /** Canonical hash of the model history (persistence/parity anchor). */
  getHistoryHash(): string {
    return historyHash(this.historyState);
  }

  /** Replace the editor selection. Does NOT bump the version or push undo. */
  setSelection(ids: readonly string[]): void {
    this.#selection = [...ids];
  }

  /** COMPAT-CAD-001: replace the drafting workspace settings (validated +
   *  canonicalized). Does NOT bump the version or push undo — settings are
   *  presentation/configuration state, like the selection, but persisted. */
  setDraftingSettings(settings: DraftingSettings): void {
    this.draftingSettingsState = validateDraftingSettings(settings);
  }

  /** Apply an edit, bump version, push inverse onto undo stack, clear redo,
   *  append an immutable revision to the model history. Returns the computed
   *  inverse (for audit).
   *
   *  COMPAT-CAD-001: `applyEdits` batches are atomic — sub-edits are applied
   *  in order with their per-sub-edit inverses captured INTERLEAVED (a later
   *  sub-edit's inverse may depend on the state produced by an earlier
   *  sub-edit), and the recorded inverse is the reversed inverse batch. One
   *  execute = one version = one revision = one undo entry. */
  execute(edit: DocumentEdit): DocumentEdit {
    const normalized = this.normalizeEdit(edit);
    const beforeElements = [...this.elements.values()];
    const inverse = this.applyWithInverse(normalized);
    const fromVersion = this.version;
    const contentHash = this.contentHashAt(fromVersion);
    this.version = childVersion(fromVersion, contentHash, this.createdBy, fromVersion.source_snapshot_id, FIXED_NOW);
    this.undoStack.push({ forward: normalized, inverse, fromVersion, toVersion: this.version });
    this.redoStack.length = 0;
    this.historyState = appendRevision({
      history: this.historyState,
      fromVersionId: fromVersion.version_id,
      toVersion: this.version,
      contentHash,
      appliedEdit: normalized,
      note: "edit",
      createdBy: this.createdBy,
      beforeElements,
      afterElements: [...this.elements.values()],
      nextElementSequence: this.nextElementSequence,
      nextLayerSequence: this.nextLayerSequence,
    });
    return inverse;
  }

  /** Apply an edit AND compute its inverse in one pass. For composite batches
   *  the sub-edit inverses are captured between applications (state-correct). */
  private applyWithInverse(edit: DocumentEdit): DocumentEdit {
    if (edit.type === "applyEdits") {
      const inverses: DocumentEdit[] = [];
      for (const sub of edit.edits) {
        inverses.push(this.applyWithInverse(sub));
      }
      inverses.reverse();
      return { type: "applyEdits", edits: inverses };
    }
    const inverse = this.computeInverse(edit);
    this.applyEdit(edit);
    return inverse;
  }

  /** Undo the last edit. Reverts content and version, records the inverse
   *  transition as a revision. Returns the undone forward edit, or null if
   *  there is nothing to undo. */
  undo(): DocumentEdit | null {
    const entry = this.undoStack.pop();
    if (entry === undefined) return null;
    const fromVersion = this.version; // the version being left
    const beforeElements = [...this.elements.values()];
    this.applyEdit(entry.inverse);
    this.version = entry.fromVersion;
    this.redoStack.push(entry);
    const contentHash = this.contentHashAt(entry.fromVersion);
    this.historyState = appendRevision({
      history: this.historyState,
      fromVersionId: fromVersion.version_id,
      toVersion: entry.fromVersion,
      contentHash,
      appliedEdit: entry.inverse,
      note: "undo",
      createdBy: this.createdBy,
      beforeElements,
      afterElements: [...this.elements.values()],
      nextElementSequence: this.nextElementSequence,
      nextLayerSequence: this.nextLayerSequence,
    });
    return entry.forward;
  }

  /** Redo the last undone edit. Re-applies content and version, records the
   *  transition as a revision. Returns the re-applied forward edit, or null
   *  if there is nothing to redo. */
  redo(): DocumentEdit | null {
    const entry = this.redoStack.pop();
    if (entry === undefined) return null;
    const fromVersion = this.version; // the version being left
    const beforeElements = [...this.elements.values()];
    this.applyEdit(entry.forward);
    this.version = entry.toVersion;
    this.undoStack.push(entry);
    const contentHash = this.contentHashAt(entry.toVersion);
    this.historyState = appendRevision({
      history: this.historyState,
      fromVersionId: fromVersion.version_id,
      toVersion: entry.toVersion,
      contentHash,
      appliedEdit: entry.forward,
      note: "redo",
      createdBy: this.createdBy,
      beforeElements,
      afterElements: [...this.elements.values()],
      nextElementSequence: this.nextElementSequence,
      nextLayerSequence: this.nextLayerSequence,
    });
    return entry.forward;
  }

  /** An immutable point-in-time snapshot (§5.4), including the immutable
   *  model revision history (persisted through save/open; CAD-IMPLEMENT-003)
   *  and — since COMPAT-CAD-001 — the layer table, the editor selection and
   *  the drafting workspace settings (all persisted through save/open). */
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
      modelHistory: this.historyState,
      layers: [...this.layers.values()],
      selection: [...this.#selection],
      draftingSettings: this.draftingSettingsState,
    };
  }

  // --- Internals -----------------------------------------------------------

  /** Canonical-identity normalization for incoming edits (§5.4):
   *  - addElement with a missing/non-string/empty id → the DOCUMENT mints a
   *    canonical identity (`el-NNNNNN`, monotonic, never reused);
   *  - addElement with an id that already exists → rejected (an id must
   *    identify ONE element for its whole lifetime — identity stability);
   *  - COMPAT-CAD-001: addLayer with a missing/empty id → the DOCUMENT mints
   *    `ly-NNNNNN` the same way (monotonic, never reused); applyEdits batches
   *    normalize their sub-edits recursively, in order. */
  private normalizeEdit(edit: DocumentEdit): DocumentEdit {
    if (edit.type === "applyEdits") {
      if (edit.edits.length === 0) {
        throw new Error("applyEdits requires at least one sub-edit (an empty batch is a no-op command)");
      }
      return { type: "applyEdits", edits: edit.edits.map((sub) => this.normalizeEdit(sub)) };
    }
    if (edit.type === "addLayer") {
      const layer = validateLayerRecord(edit.layer);
      if (this.layers.has(layer.id)) {
        throw new Error(
          `addLayer: layer id '${layer.id}' already exists — canonical layer identity must not be reused while the layer exists`,
        );
      }
      return edit;
    }
    if (edit.type !== "addElement") return edit;
    const element = edit.element;
    if (element === undefined) throw new Error("addElement requires element");
    const id = (element as { id?: unknown }).id;
    const needsMint = typeof id !== "string" || id.length === 0;
    if (!needsMint) {
      const elementId = id as string;
      if (this.elements.has(elementId)) {
        throw new Error(
          `addElement: element id '${elementId}' already exists — canonical element identity must not be reused while the element exists (remove it first)`,
        );
      }
      return edit;
    }
    const minted = `el-${String(this.nextElementSequence).padStart(6, "0")}`;
    this.nextElementSequence += 1;
    return { ...edit, element: { ...element, id: minted } } as DocumentEdit;
  }

  /** Mint a canonical layer identity (`ly-NNNNNN`, monotonic, never reused).
   *  Exposed for the drafting layer builders in the App API layer. */
  mintLayerId(): string {
    const minted = `ly-${String(this.nextLayerSequence).padStart(6, "0")}`;
    this.nextLayerSequence += 1;
    return minted;
  }

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
      // --- COMPAT-CAD-001 (additive): composite + layer edits ---
      case "applyEdits": {
        for (const sub of edit.edits) this.applyEdit(sub);
        break;
      }
      case "addLayer": {
        const layer = validateLayerRecord(edit.layer);
        if (this.layers.has(layer.id)) {
          throw new Error(`addLayer: layer id '${layer.id}' already exists`);
        }
        this.layers.set(layer.id, layer);
        break;
      }
      case "updateLayer": {
        if (edit.layerId === undefined || edit.patch === undefined) {
          throw new Error("updateLayer requires layerId + patch");
        }
        const current = this.layers.get(edit.layerId);
        if (current === undefined) throw new Error(`updateLayer: no layer '${edit.layerId}'`);
        this.layers.set(edit.layerId, applyLayerPatch(current, edit.patch));
        break;
      }
      case "removeLayer": {
        if (edit.layerId === undefined) throw new Error("removeLayer requires layerId");
        if (!this.layers.has(edit.layerId)) throw new Error(`removeLayer: no layer '${edit.layerId}'`);
        let references = 0;
        for (const el of this.elements.values()) {
          if (elementLayerReference(el.props) === edit.layerId) references += 1;
        }
        if (references > 0) {
          throw new Error(
            `removeLayer: layer '${edit.layerId}' is still referenced by ${references} element(s) — reassign or delete them first (no silent cascade)`,
          );
        }
        this.layers.delete(edit.layerId);
        break;
      }
      default: {
        const _exhaustive = edit satisfies never;
        throw new Error(`unreachable edit type: ${JSON.stringify(_exhaustive)}`);
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
      // --- COMPAT-CAD-001 (additive): composite + layer edits ---
      case "applyEdits": {
        // Composite inverses are captured interleaved in applyWithInverse —
        // a bare computeInverse on a batch cannot be state-correct.
        throw new Error("computeInverse: applyEdits is handled by applyWithInverse (interleaved inverses)");
      }
      case "addLayer": {
        const layer = validateLayerRecord(edit.layer);
        return { type: "removeLayer", layerId: layer.id };
      }
      case "updateLayer": {
        if (edit.layerId === undefined || edit.patch === undefined) {
          throw new Error("updateLayer requires layerId + patch");
        }
        const current = this.layers.get(edit.layerId);
        if (current === undefined) throw new Error(`updateLayer: no layer '${edit.layerId}'`);
        const prevValues: Record<string, unknown> = {};
        for (const k of Object.keys(edit.patch)) {
          prevValues[k] = (current as unknown as Record<string, unknown>)[k];
        }
        return { type: "updateLayer", layerId: edit.layerId, patch: prevValues };
      }
      case "removeLayer": {
        if (edit.layerId === undefined) throw new Error("removeLayer requires layerId");
        const existing = this.layers.get(edit.layerId);
        if (existing === undefined) throw new Error(`removeLayer: no layer '${edit.layerId}'`);
        return { type: "addLayer", layer: existing };
      }
      default: {
        const _exhaustive = edit satisfies never;
        throw new Error(`unreachable edit type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Current mint counter for layer identities (persisted via the history;
   *  COMPAT-CAD-001). */
  get layerSequence(): number {
    return this.nextLayerSequence;
  }

  /** Look up a layer by canonical id. */
  layerById(id: string): LayerRecord | undefined {
    return this.layers.get(id);
  }

  /** Element lookup by canonical id (drafting command support). */
  elementById(id: string): Element | undefined {
    return this.elements.get(id);
  }

  /** All elements in insertion order (drafting command support). */
  allElements(): readonly Element[] {
    return [...this.elements.values()];
  }

  /** Canonical content hash excluding the version metadata itself (so the
   *  hash is a pure function of document content, not of the version label).
   *  The model revision history is also excluded: two documents with the
   *  same content but different paths to it converge to the same content
   *  hash (§5.4/§5.5); history has its own hash (`getHistoryHash`). */
  private contentHashAt(_atVersion: VersionMeta): string {
    const content = {
      format: this.format,
      formatVersion: this.formatVersion,
      sourceArtifactLineage: this.sourceArtifactLineage,
      elements: [...this.elements.values()],
    };
    return createHash("sha256").update(canonicalStringify(content)).digest("hex");
  }

  /** Expose the canonical hash of the current snapshot (for parity tests).
   *  Excludes the model history, the ephemeral editor selection AND the
   *  ephemeral editor state (undo/redo stacks do not survive open by design)
   *  — the parity hash captures PERSISTED document content: version,
   *  format/lineage, elements, layers and drafting settings (COMPAT-CAD-001).
   *  Parity of the history/event stream is asserted separately (historyHash
   *  + bridge events hash). */
  currentContentHash(): string {
    const {
      modelHistory: _history,
      selection: _selection,
      editorState: _editorState,
      ...content
    } = this.snapshot();
    void _history;
    void _selection;
    void _editorState;
    return canonicalHashOf(content);
  }
}
