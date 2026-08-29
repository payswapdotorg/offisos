/**
 * CAD/BIM App API — the semantic command/query contract v1 (§5.3, §5.5,
 * api-contract.md).
 *
 * This contract sits below the hosts and above the CAD/BIM engine. The same
 * contract is testable through both the Web Host and the Electron Host (§5.5).
 * The contract exposes stable construction-domain capabilities, not internal
 * implementation details (api-contract.md §1, §12). Mutating operations
 * support idempotency keys (api-contract.md §4).
 */

export const APP_API_VERSION = "1" as const;
export type AppApiVersion = typeof APP_API_VERSION;

// --- Command names (mutating; idempotency-supported) ---
// `document.create` resets to a fresh empty document (new entity id, root
// version, cleared selection). `document.setSelection` mutates the ephemeral
// editor selection WITHOUT bumping the document version or pushing an undo
// entry (selection is non-versioned editor state, §5.4). `document.save`
// persists the snapshot through the file adapter and returns file bytes.
// `geometry.prepare` (CAD-IMPLEMENT-002, additive per api-contract.md §8)
// asks the geometry engine adapter to realize an engine-independent
// GeometryDescriptor (contracts/geometry.ts) and returns the deterministic
// GeometryResult { meshToken, bbox } (+ optional viewport mesh and
// selection/query metadata when the concrete adapter provides them). It does
// NOT mutate the document — callers persist the result via
// document.applyEdit(addElement) with the returned meshToken in props.
export type CommandName =
  | "document.create"
  | "document.open"
  | "document.applyEdit"
  | "document.setSelection"
  | "document.undo"
  | "document.redo"
  | "document.serialize"
  | "document.deserialize"
  | "document.save"
  | "geometry.prepare"
  // --- CAD-PARITY-003 (additive, Issue #78): canonical 2D entities ---
  | "entity.create"
  | "entity.modify"
  // --- COMPAT-CAD-001 (additive, api-contract.md §8): 2D drafting ---
  | "drafting.createEntities"
  | "drafting.move"
  | "drafting.copy"
  | "drafting.delete"
  | "drafting.trim"
  | "drafting.extend"
  | "drafting.setSettings"
  | "drafting.addLayer"
  | "drafting.updateLayer"
  | "drafting.removeLayer"
  // --- COMPAT-CAD-002 (additive, api-contract.md §8): 3D/BIM authoring ---
  | "bim.createElements"
  | "bim.move"
  | "bim.copy"
  | "bim.delete"
  | "bim.setProperties"
  | "bim.setSettings"
  | "bim.buildGeometry"
  // --- COMPAT-CAD-003 (additive, api-contract.md §8): documentation ---
  | "docs.createViews"
  | "docs.updateView"
  | "docs.removeView"
  | "docs.createSheets"
  | "docs.updateSheet"
  | "docs.removeSheet"
  | "docs.addAnnotations"
  | "docs.removeAnnotations"
  | "docs.regenerate"
  // COMPAT-IFC-001 (additive): IFC/openBIM interoperability (export bytes,
  // reconciling import, BCF topic containers). Read-only surfaces are queries.
  | "ifc.export"
  | "ifc.import"
  | "ifc.bcfCreate"
  // --- CAD-PARITY-004 (additive, Issue #80): layers, properties, styles ---
  // The professional properties & palettes command surface. Layer-table
  // edits stay on the COMPAT-CAD-001 drafting.* commands (extended fields);
  // these additions cover display overrides, standards, styles, states and
  // isolation.
  | "entity.setDisplay"
  | "layer.setActive"
  | "layer.applyStandard"
  | "layer.isolate"
  | "layer.unisolate"
  | "layerState.save"
  | "layerState.restore"
  | "layerState.remove"
  | "ltype.create"
  | "ltype.update"
  | "ltype.remove"
  | "textStyle.create"
  | "textStyle.update"
  | "textStyle.remove"
  | "dimStyle.create"
  | "dimStyle.update"
  | "dimStyle.remove"
  // --- CAD-PARITY-005 (additive, Issue #82): annotation/text/dimension ---
  // The annotation command surface. annotation.create validates + applies
  // ONE atomic batch of annotation entities (text/mtext/dims/leaders) with
  // server-side measurement for referenced targets; annotation.update
  // patches annotation content/style/placement fields (full-record props
  // rewrite, display overrides preserved); annotation.remeasure re-runs the
  // associative measurement for the given annotations (or every dimension).
  | "annotation.create"
  | "annotation.update"
  | "annotation.remeasure"
  // --- CAD-PARITY-006 (additive, Issue #84): blocks/attributes/xrefs ---
  // block.create validates + converts the source elements into canonical
  // inline content and removes them — ONE atomic conversion revision;
  // block.insert places an instance (uniform scale + rotation + attribute
  // values validated against the definition slots); block.update patches a
  // definition (name/basePoint/description/entities — instances propagate
  // through the shared expansion); block.remove is reference-checked;
  // attribute.update rewrites one per-instance attribute value; xref.attach
  // /detach/reload implement the bounded external-reference lifecycle
  // (detach removes record + instances as ONE atomic batch; reload requires
  // the re-supplied external content).
  | "block.create"
  | "block.insert"
  | "block.update"
  | "block.remove"
  | "attribute.update"
  | "xref.attach"
  | "xref.detach"
  | "xref.reload"
  // --- CAD-PARITY-007 (additive, Issue #86): parametric constraints ---
  // constraint.create validates + declares ONE constraint and APPLIES it
  // through the shared deterministic solver (the closed-form geometry
  // adjustment + propagation patches + the associative-annotation cascade
  // travel as element edits in the SAME atomic revision — one undo entry);
  // constraint.update re-declares a dimensional value and re-solves;
  // constraint.remove deletes the record; constraint.solve re-runs the
  // deterministic solve over the whole graph (the explicit diagnostics
  // surface — six typed outcomes, never a silent approximation).
  | "constraint.create"
  | "constraint.update"
  | "constraint.remove"
  | "constraint.solve"
  // --- CAD-PARITY-008 (additive, Issue #88): layouts, viewports, plot ---
  // layout.create/rename/clone/remove manage the paper-space layout table
  // (clone/remove are ONE atomic revision each — clone copies the layout
  // AND its viewports with fresh document-minted identities; remove cascades
  // the viewports away with the record); layout.setPageSetup patches the
  // embedded page setup (a detected no-op returns unchanged without a
  // revision); layout.activate/layout.setSpace are the NON-VERSIONED editor
  // context (the active tab + the TILEMODE-class model/paper switch — the
  // activeLayer precedent, no undo entry); viewport.create fits/projects
  // through the shared transform (fit = the deterministic model extents,
  // window = an explicit model window, scale = an explicit denominator);
  // viewport.update patches scale/rotation/lock/camera/frame/layer
  // overrides (a locked view rejects camera/scale/rotation edits with a
  // typed viewport_locked error — the frame still moves); plot.export and
  // plot.publish are NON-MUTATING deterministic exports (SVG + the minimal
  // deterministic PDF writer + the Plot IR; proprietary formats are typed
  // plot_unsupported declines).
  | "layout.create"
  | "layout.rename"
  | "layout.clone"
  | "layout.remove"
  | "layout.setPageSetup"
  | "layout.activate"
  | "layout.setSpace"
  | "viewport.create"
  | "viewport.update"
  | "viewport.remove"
  | "plot.export"
  | "plot.publish";

// --- Query names (non-mutating) ---
// `document.getSelection` returns the ephemeral editor selection (orthogonal
// to the versioned snapshot, so it does not affect the parity hash, §5.5).
// CAD-IMPLEMENT-003 (additive, api-contract.md §8): the model/revision and
// Construction Graph bridge surface is read-only queries —
// `model.getHistory` returns the immutable ModelRevision log persisted with
// the document; `model.getGraphEvents` returns the deterministic
// graph-facing event stream (model.created / model.version.created) produced
// by the Construction Graph bridge from that history; `model.replay`
// deterministically replays the history to a given revision number
// (0 = base) — information-state correct, no future leakage.
// RESEARCH-CAD-007 (additive, api-contract.md §8): `impact.cascade` runs the
// deterministic downstream chain for one model transition —
// quantity.recalculate.requested → quantity.changed → estimate.recalculated
// → rfq.scope.impact.detected plus the aggregate commercial impact — caused
// by the corresponding `model.version.created` graph event. Quantities are
// computed through the bound geometry engine adapter (engine ids are
// provenance only; every downstream identity is canonical and engine-free).
// Non-mutating.
export type QueryName =
  | "document.getState"
  | "document.getVersion"
  | "document.canUndo"
  | "document.canRedo"
  | "document.getSelection"
  | "model.getHistory"
  | "model.getGraphEvents"
  | "model.replay"
  | "impact.cascade"
  // COMPAT-CAD-001 (additive): deterministic snap resolution.
  | "drafting.snap"
  // CAD-PARITY-003 (additive, Issue #78): the shared precision engine as
  // queries — the SAME modules the host renderers run (parity by
  // construction).
  | "precision.snap"
  | "precision.pick"
  | "precision.window"
  // COMPAT-CAD-002 (additive): BIM structure, semantics and cameras.
  | "bim.getBuilding"
  // COMPAT-BIM-003 (additive): component/material/coordination inventory
  // with derived parametric state.
  | "bim.getComponents"
  | "bim.getSemantics"
  | "bim.camera"
  // COMPAT-CAD-003 (additive): documentation views, geometry and exports.
  | "docs.listViews"
  | "docs.getViewGeometry"
  | "docs.listSheets"
  | "docs.exportSheet"
  // COMPAT-IFC-001 (additive): IFC engine probe, dry-run reconciliation,
  // IDS validation, BCF parsing and the persisted import-record list.
  | "ifc.probe"
  | "ifc.compare"
  | "ifc.idsValidate"
  | "ifc.bcfParse"
  | "ifc.listImports"
  // CAD-PARITY-006 (additive): the blocks/xrefs inventory with instance
  // counts + attribute tags / status diagnostics (non-mutating).
  | "blocks.list"
  | "xrefs.list"
  // CAD-PARITY-007 (additive): the declared constraint graph inventory and
  // the on-demand solver diagnostics (satisfaction per constraint, the
  // per-component degrees-of-freedom accounting, the typed outcome —
  // non-mutating, computed fresh every call, never persisted stale).
  | "constraints.list"
  | "constraints.diagnostics"
  // CAD-PARITY-008 (additive): the layout/viewport inventory (tables + the
  // non-versioned editor context) and the deterministic plot preview (the
  // canonical Plot IR + its hash — the same IR the export writers and both
  // hosts' paper canvases consume; non-mutating, computed fresh every
  // call, never persisted stale).
  | "layouts.list"
  | "plot.preview";

export interface Command {
  readonly type: "command";
  readonly name: CommandName;
  readonly payload: unknown;
  /** Idempotency key for mutating operations (api-contract.md §4). Two
   *  commands with the same key are applied at most once. */
  readonly idempotencyKey?: string;
}

export interface Query {
  readonly type: "query";
  readonly name: QueryName;
  readonly payload: unknown;
}

export type CommandQueryRequest = Command | Query;

export interface OkResult {
  readonly ok: true;
  readonly value: unknown;
}

export interface ErrResult {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  /** Whether the caller may retry (api-contract.md §7). */
  readonly retryable: boolean;
}

export type CommandQueryResponse = OkResult | ErrResult;

/** Stable wire envelope. The transport carries this JSON; both hosts decode
 *  to the same `CommandQueryRequest`/`CommandQueryResponse`. Versioning is
 *  additive (api-contract.md §8): breaking changes create a new version. */
export interface WireEnvelope {
  readonly api: AppApiVersion;
  readonly body: CommandQueryRequest;
}

export function ok(value: unknown): OkResult {
  return { ok: true, value };
}

export function err(code: string, message: string, retryable = false): ErrResult {
  return { ok: false, code, message, retryable };
}
