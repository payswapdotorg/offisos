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
  // --- CAD-PARITY-011 (additive, Issue #97): classification, structured
  // property sets, renovation lifecycle, design-option membership and the
  // active option — the dedicated meta/lifecycle command surface. ---
  | "bim.setClassification"
  | "bim.setPropertySets"
  | "bim.setRenovation"
  | "bim.setOptionMembership"
  | "bim.setActiveOption"
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
  // --- CAD-PARITY-014 (additive, Issue #107): file interoperability ---
  // dxf.import — the bounded DXF R2000 ASCII reader → canonical document
  // edits as ONE atomic versioned command (the ifc.import pattern: ltype/
  // layer/element creation through the document authority, ids minted,
  // unsupported constructs skipped + counted typed). The DWG binary is the
  // explicit typed decline (dwg_unsupported). Export is a QUERY (dxf.export).
  | "dxf.import"
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
  // --- COMPAT-CAD-010 (additive, Issue #18): hatch + bounded inspection ---
  // hatch.create validates + applies ONE atomic batch of hatch entities
  // (bounded pattern registry, boundary loops resolved SERVER-side from
  // the referenced closed geometry, associative snapshots stored);
  // hatch.update patches pattern/scale/angle (HATCHEDIT-class, bounded —
  // boundary re-association is out of scope) with validation BEFORE
  // mutation. Hatch erasure rides the existing drafting.delete (the
  // boundary cascade erases orphaned hatches in the same revision).
  | "hatch.create"
  | "hatch.update"
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
  | "plot.publish"
  // --- CAD-PARITY-009 (additive, Issue #90): 3D navigation, UCS/workplanes
  // and bounded 3D modeling ---
  // ucs.define/update/remove manage the named-UCS table (the World UCS is
  // implicit, never a record; removing the ACTIVE UCS is a typed ucs_active
  // decline — activate World first); ucs.activate is the NON-VERSIONED
  // current-workplane editor context (the activeLayout precedent, no undo
  // entry); view3d.set persists the deterministic 3D camera state as
  // non-versioned editor settings (view state strictly separated from model
  // history); view3d.fit/view3d.standard derive a camera from the document
  // (the deterministic model extents / the standard-view presets) through
  // the SHARED camera module and set it; model3d.box/cylinder/extrude create
  // solid elements placed through the ACTIVE UCS using the EXISTING
  // GeometryDescriptor vocabulary (transform-wrapped — no new engine ops),
  // prepare them through the geometry adapter and persist meshToken/bbox/
  // engine provenance in the SAME atomic revision; model3d.move/rotate/
  // scale transform existing solids through the ACTIVE UCS (deterministic
  // matrix composition, exact inverses, ONE atomic revision); sectionplane.
  // create/update/remove manage the section-plane table (the bounded
  // section/slice PREVIEW foundation — the derived preview is a query).
  | "ucs.define"
  | "ucs.update"
  | "ucs.remove"
  | "ucs.activate"
  | "view3d.set"
  | "view3d.fit"
  | "view3d.standard"
  | "model3d.box"
  | "model3d.cylinder"
  | "model3d.extrude"
  | "model3d.move"
  | "model3d.rotate"
  | "model3d.scale"
  | "sectionplane.create"
  | "sectionplane.update"
  | "sectionplane.remove"
  // --- CAD-PARITY-010 (additive, Issue #93): boolean solids and bounded
  // mesh entities. model3d.boolean composes TWO existing model3d.solid
  // elements (union/difference/intersection — the descriptor triad fuse/
  // cut/intersect) into ONE result solid: the adapter realizes the composed
  // descriptor, the result element persists the meshToken/bbox/engine
  // provenance AND the operand provenance (element ids + their tokens at
  // composition), and the operands are REMOVED in the SAME atomic
  // applyEdits revision (exact undo/redo/replay; an empty or non-manifold
  // result is the typed boolean_empty/boolean_invalid decline — never a
  // fabricated solid). model3d.tessellate persists a bounded engine-neutral
  // MESH ENTITY element (model3d.mesh) from a solid at one of the closed
  // quality presets (progressive delivery; deterministic serialization;
  // read-only representation — the source solid remains the editing
  // surface). ---
  | "model3d.boolean"
  // --- CAD-PARITY-012 (additive, Issue #102): components, materials and
  // coordination expansion. Materials ARE the bim.material elements + the
  // additive parity fields (category/lineweight/density over the closed
  // 8-value vocabulary); material.create/update/remove/assign run through
  // the bim createElement/edit paths with typed failure codes
  // (material_exists/invalid/not_found/in_use) and FULL-RECORD setProps
  // rewrites for assignment (absence exactly representable, exact undo
  // inverse). grid.create/grid.update author bim.grid entities with the
  // full strictly-ascending u/v-set grammar (grid_bad_payload/grid_invalid/
  // grid_not_found). revcloud.create persists the closed scalloped polyline
  // with the bounded marker:"revcloud" (revcloud_bad_payload/
  // revcloud_invalid). One payload = ONE DocumentEdit = one version = one
  // undo entry. ---
  | "model3d.tessellate"
  | "material.create"
  | "material.update"
  | "material.remove"
  | "material.assign"
  | "grid.create"
  | "grid.update"
  | "revcloud.create"
  // --- CAD-PARITY-013 (additive, Issue #104): documentation production ---
  // The navigator (View Map folders + Layout Book subsets), title blocks,
  // schedules, revisions and publisher sets — five document-owned record
  // tables edited through the DocumentEdit command model (one payload = ONE
  // DocumentEdit = one version = one undo entry; typed failure codes
  // navigator_*/titleblock_*/schedule_*/revision_*/publisher_*). layout.update
  // is the NEW generic patch command (subsetId/masterId/titleBlockPlacement/
  // revisionIds — layout.rename/layout.setPageSetup stay untouched);
  // publisher.run is NON-VERSIONED output automation (the plot.publish
  // precedent — no DocumentEdit, no revision, no undo entry).
  | "navigator.createFolder"
  | "navigator.createSubset"
  | "navigator.removeNode"
  | "titleblock.create"
  | "titleblock.update"
  | "titleblock.remove"
  | "schedule.create"
  | "schedule.update"
  | "schedule.remove"
  // --- CAD-PARITY-015 (additive, Issue #110): the property-definition
  // registry command surface (document-owned declarations; values live on
  // the canonical element property-set overlay). ---
  | "property.create"
  | "property.update"
  | "property.remove"
  | "revision.add"
  | "revision.update"
  | "revision.remove"
  | "publisher.create"
  | "publisher.update"
  | "publisher.remove"
  | "publisher.run"
  | "layout.update"
  // --- CAD-PARITY-016 (additive, Issue #112): the collaboration/recovery/
  // scale command surface. recovery.checkpoint captures a durable versioned
  // checkpoint of the CURRENT canonical revision (cause manual; autosave
  // checkpoints are minted automatically by the bounded autosave policy and
  // recovery.autosave forces one); recovery.restore deterministically
  // restores a checkpoint (default: the latest VALID one — corrupt
  // candidates are skipped with typed reasons, never silently repaired)
  // through the canonical CADDocument.open path after capturing a
  // pre-restore safety checkpoint; collab.join registers a project-scoped
  // member with a closed role vocabulary (viewer/commenter/editor —
  // server-side permission checks, typed collab_forbidden on violation);
  // collab.presence is the heartbeat (liveness + the revision the member is
  // viewing, deterministic session-clock semantics); collab.comment adds a
  // comment linked to a canonical target (document/element id/revision,
  // bound to the document version at creation); collab.resolveComment
  // records the resolving member; collab.commit applies a versioned
  // transactional change authored against a declared baseVersion (ONE
  // atomic versioned revision — a moved head produces an explicit
  // reproducible conflict record with the intervening transactions and the
  // overlapping canonical element ids); collab.merge resolves an open
  // conflict through the closed rebase/discard vocabulary with recorded
  // merge/resolution lineage (parents = [baseVersion, headVersion]);
  // jobs.create queues a durable background-regeneration job (closed kind
  // vocabulary, read-only document work, never authority); jobs.tick
  // advances ONE deterministic step per call (the serverless-honest
  // durable execution model — no hidden background thread). ---
  | "recovery.checkpoint"
  | "recovery.restore"
  | "recovery.autosave"
  | "collab.join"
  | "collab.presence"
  | "collab.comment"
  | "collab.resolveComment"
  | "collab.commit"
  | "collab.merge"
  | "jobs.create"
  | "jobs.tick"
  // --- CAD-PARITY-017 (additive, Issue #116): the automation/extension
  // API command surface (API-001 — versioned typed automation contracts
  // over the governed App API). automation.authenticate registers a
  // project-scoped automation principal with a closed role drawn from the
  // SAME P016 collaboration vocabulary (the authorization hook at the API
  // boundary — server-side ability checks on every mutating request, typed
  // automation_forbidden on violation; no parallel identity subsystem);
  // automation.registerScript validates + registers a bounded typed script
  // MANIFEST (steps reference governed App API capabilities ONLY — the
  // closed registry is discovered through automation.capabilities; any
  // other capability, kind or version is the typed unsupported decline,
  // never a fabricated semantic); automation.runScript executes a script
  // DETERMINISTICALLY (each step dispatches through the SAME handle()
  // path every direct caller uses — the governed mutation route is the
  // ONLY mutation route; the run outcome digest is reproducible for
  // identical canonical inputs + the declared profile);
  // automation.deleteScript removes a registered script (owner or
  // transact-ability); automation.subscribe/unsubscribe manage the
  // bounded scoped event-subscription declarations (the derived feed is
  // automation.events — a pure fold over the durable canonical records,
  // never authority); automation.registerExtension registers a
  // capability-scoped extension MANIFEST (DATA ONLY — manifests carrying
  // code/entry/url fields are rejected typed, so extension code cannot
  // import or bypass protected engine/renderer/domain boundaries by
  // construction) and installs its declared scripts. ---
  | "automation.authenticate"
  | "automation.registerScript"
  | "automation.runScript"
  | "automation.deleteScript"
  | "automation.subscribe"
  | "automation.unsubscribe"
  | "automation.registerExtension"
  // --- CAD-PARITY-018 (additive, Issue #118): the specialized-toolsets
  // command surface (bounded architecture/MEP/mechanical/raster
  // composition over the verified core). toolset.arch* commands emit
  // EXACTLY the element-creation batches the existing bim/drafting paths
  // produce (ONE atomic revision per command, document-minted element
  // identities — no parallel element semantics, no fabricated geometry;
  // typed declines for everything outside the bounded model);
  // toolset.mepAddRun/mepSetRun/mepRemoveRun manage the document-owned
  // bounded MEP run records (tls- identities, route-grammar validation,
  // in-record connections via mepConnect with typed domain/kind
  // mismatch declines); toolset.mechAddEquipment/mechSetEquipment/
  // mechRemoveEquipment manage the bounded mechanical equipment records
  // (ordinal port ids, port metadata); toolset.mechArray composes the
  // deterministic equipment array (ports move with the equipment);
  // toolset.rasterAddSource registers the canonical underlay source
  // records (identity + digest + bounded lineWork); rasterAttach/
  // rasterSetReference/rasterRemoveReference manage the reference
  // records (transform/clipping/visibility; the ok/stale/missing status
  // is DERIVED, never stored); rasterCommitTrace commits traced vectors
  // as canonical line elements through the existing element-creation
  // path with the lineage recorded in the element props. ---
  | "toolset.archWallRun"
  | "toolset.archHostedOpening"
  | "toolset.archRoof"
  | "toolset.archStairRun"
  | "toolset.archSpaceGrid"
  | "toolset.archDimChain"
  | "toolset.archComponentArray"
  | "toolset.mepAddRun"
  | "toolset.mepSetRun"
  | "toolset.mepRemoveRun"
  | "toolset.mepConnect"
  | "toolset.mechAddEquipment"
  | "toolset.mechSetEquipment"
  | "toolset.mechRemoveEquipment"
  | "toolset.mechArray"
  | "toolset.rasterAddSource"
  | "toolset.rasterAttach"
  | "toolset.rasterSetReference"
  | "toolset.rasterRemoveReference"
  | "toolset.rasterCommitTrace"
  // --- COMPAT-CAD-004 (additive, Issue #121): the bounded consolidated
  // parametrics/associative/patterns commands. pattern.mirror = the
  // bounded deterministic mirror over drafting geometry AND symbol
  // instances (geometry through the verified cascade-aware modify path;
  // block instances through the reflected placement — the additive
  // `mirrored` state; xref/annotation/BIM targets decline typed);
  // assoc.refresh = the ONE-revision atomic refresh (annotation
  // re-measurement + documentation regeneration composed; dangling
  // references disassociate honestly, never a silent re-target). ---
  | "pattern.mirror"
  | "assoc.refresh";

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
  // CAD-PARITY-011 (additive, Issue #97): the canonical classification
  // table, the option-group registry with active states and members, and
  // the lifecycle (renovation + option) state of the BIM elements.
  | "bim.getClassification"
  | "bim.getOptions"
  | "bim.getLifecycle"
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
  // COMPAT-CAD-010 (additive, Issue #18): the bounded entity inspection
  // surface (the LIST workflow): deterministic per-entity semantic
  // summaries (type/layer/canonical id, key geometry and stored
  // measurements, hatch pattern/scale/loops, associativity references) —
  // non-mutating, computed fresh from the canonical state, never a
  // fabricated measurement (the OSNAP/OTRACK/measurement program is
  // COMPAT-CAD-018's scope, not this one).
  | "inspection.list"
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
  | "plot.preview"
  // CAD-PARITY-009 (additive): the UCS inventory + current-workplane context,
  // the persisted 3D camera state, deterministic 3D selection (the exactly
  // ordered element hit list — distance then canonical id; sub-entity
  // face/edge/vertex picking is a typed decline) and the bounded section
  // preview foundation (the deterministic plane∩bbox intersection surface
  // with its canonical hash; exact BRep cross-sections are a typed decline).
  // All non-mutating, computed fresh every call, never persisted stale.
  | "ucs.list"
  | "view3d.state"
  | "model3d.pick"
  | "model3d.sectionPreview"
  | "model3d.mesh"
  // --- CAD-PARITY-010 (additive, Issue #93): the exact-section, topology
  // and cache-evidence queries (non-mutating, computed fresh every call).
  // model3d.section computes the EXACT adapter-backed plane ∩ solid section
  // (canonical loops/chains + hash; the adapter declining the geometry's
  // class is the typed section_exact_unsupported decline — the labeled
  // extent preview remains the fallback); model3d.topology returns the
  // deterministic topology map (canonical f/e/v ids, engine keys as
  // provenance); model3d.pick with elementId + subEntity performs the
  // topology-aware sub-entity pick (faces exact, edges/vertices tolerance;
  // exactly ordered); model3d.mesh with quality serves the bounded LOD mesh
  // through the revision-tied cache; model3d.cacheStats reports the bounded
  // cache's exact counters (the performance-budget evidence). ---
  | "model3d.section"
  | "model3d.topology"
  | "model3d.cacheStats"
  // --- CAD-PARITY-012 (additive, Issue #102): the components/materials/
  // coordination read surfaces (non-mutating, computed fresh every call,
  // never persisted stale). components.list = the block-system component
  // inventory with materialId + instance counts/ids; materials.list = the
  // material table with the parity fields (absent optional fields omitted
  // entirely); materials.bom = the deterministic quantity takeoff over the
  // concrete 2D view (unassigned row last); grids.list = the bim.grid
  // entities with DERIVED Excel-style labels (A,B,C…/1,2,3… — never
  // stored); coordination.clash = the deterministic pairwise clash result
  // (pairs + points + checked/excluded counts). ---
  | "components.list"
  | "materials.list"
  | "materials.bom"
  | "grids.list"
  | "coordination.clash"
  // --- CAD-PARITY-013 (additive, Issue #104): the documentation production
  // read surfaces (non-mutating, computed fresh every call, never persisted
  // stale). navigator.tree = the project map (stories + element counts) +
  // the View Map folder tree + the Layout Book subset tree + the publisher
  // set registry; schedules.run = the deterministic fresh row derivation
  // over the CURRENT canonical state (no parallel source of truth);
  // revisions.list/publisher.list = the table inventories;
  // docs.exchangeReport = the typed IFC/documentation exchange
  // classification report. ---
  | "navigator.tree"
  | "schedules.list"
  | "schedules.run"
  // --- CAD-PARITY-015 (additive, Issue #110): the properties/quantities
  // query surfaces (the property registry inventory with live lineage
  // stats; the deterministic revision-bound quantity takeoff + the closed
  // canonical rule table). ---
  | "properties.list"
  | "quantities.run"
  | "quantities.rules"
  | "revisions.list"
  | "publisher.list"
  | "docs.exchangeReport"
  // --- CAD-PARITY-014 (additive, Issue #107): file interoperability read
  // surfaces (non-mutating, computed fresh every call, never persisted
  // stale). dxf.export = the bounded deterministic DXF R2000 ASCII writer
  // over the current drafting surface (bytes + counts + the skipped-kind
  // classification — the plot.export bytes precedent);
  // interop.exchangeReport = the P014 authoritative exchange
  // classification; interop.archivalList = the archival format registry
  // (the legal compatibility surface); interop.roundtripReport = the
  // format round-trip verification loops (dxf pure-TS, ifc adapter-bound). ---
  | "dxf.export"
  | "interop.exchangeReport"
  | "interop.archivalList"
  | "interop.roundtripReport"
  // CAD-PARITY-018 (additive, Issue #118 criterion 14 — the corrective
  // interop coverage): the specialized-toolsets IFC/BCF/IDS typed-outcome
  // surface (the static concept × surface matrix + the live per-record DRY
  // classification through the REAL carrier codec; non-mutating, pure,
  // deterministic — no adapter required).
  | "interop.toolsetsReport"
  // --- CAD-PARITY-016 (additive, Issue #112): the collaboration/recovery/
  // scale query surfaces (non-mutating, computed fresh every call, never
  // persisted stale). recovery.list = the retained checkpoint inventory +
  // the autosave policy + the recovery counters; collab.state = the
  // project-scoped member roster with computed presence liveness;
  // collab.comments = the comment list (canonical targets + revision
  // bindings); collab.activity = the bounded append-only activity stream;
  // collab.transactions = the versioned transaction inventory with the
  // conflict and merge/resolution lineage; jobs.list/jobs.get = the durable
  // job states (read-only); model.stream = ONE canonical id-sorted element
  // page (bounded pageSize grammar, version+contentHash-bound — the
  // large-model access surface); model.streamStats = the bounded stream
  // cache's exact counters (the explicit non-authority + performance-budget
  // evidence); xrefs.status = the fresh external-reference status with the
  // explicit available/unavailable/unsupported outcomes + the canonical
  // revision binding; xrefs.probe = the client-supplied source-hash probe
  // (the explicit stale outcome — record hash vs the current external
  // source hash, never mutating the record); perf.budgets = the declared
  // observable performance-budget thresholds + the deterministic P016
  // counters, bound to the current canonical revision. ---
  | "recovery.list"
  | "collab.state"
  | "collab.comments"
  | "collab.activity"
  | "collab.transactions"
  | "jobs.list"
  | "jobs.get"
  | "model.stream"
  | "model.streamStats"
  | "xrefs.status"
  | "xrefs.probe"
  | "perf.budgets"
  // --- CAD-PARITY-017 (additive, Issue #116): the automation/extension
  // API query surfaces (non-mutating, computed fresh every call, never
  // persisted stale). automation.capabilities = the versioned typed
  // capability discovery table (the closed registry + the profile + the
  // bounds, bound to the current canonical revision);
  // automation.principals = the registered principal roster;
  // automation.scripts = the registered script inventory (manifest step
  // summaries); automation.runs = the bounded run history (revision-bound
  // outcomes + the reproducible outcome digests); automation.events = the
  // bounded, ordered, explicitly scoped derived event feed for a
  // principal's subscriptions (authoritative:false — a pure fold over the
  // durable canonical records); automation.extensions = the registered
  // extension manifests. ---
  | "automation.capabilities"
  | "automation.principals"
  | "automation.scripts"
  | "automation.runs"
  | "automation.events"
  | "automation.extensions"
  // --- CAD-PARITY-018 (additive, Issue #118): the specialized-toolsets
  // query surfaces (non-mutating, computed fresh every call, never
  // persisted stale). toolset.capabilities = the versioned typed
  // discovery table (the closed registry + one-line summaries);
  // toolset.listRecords = the specialized-record inventory (id-sorted);
  // toolset.mepValidateRoute = the deterministic route violations of one
  // run; toolset.mepClashReport = the deterministic clash/clearance
  // diagnostics of the runs against the canonical wall/slab bodies;
  // toolset.rasterStatus = the fresh ok/stale/missing reference table
  // (typed reasons); toolset.rasterTrace = the typed NON-AUTHORITATIVE
  // trace derivation (scale → rotation → origin, clipping applied). ---
  | "toolset.capabilities"
  | "toolset.listRecords"
  | "toolset.mepValidateRoute"
  | "toolset.mepClashReport"
  | "toolset.rasterStatus"
  | "toolset.rasterTrace"
  // --- COMPAT-CAD-004 (additive, Issue #121): the bounded consolidated
  // parametrics/associative/patterns queries (non-mutating, computed
  // fresh every call, never persisted stale). parametrics.capabilities =
  // the versioned typed capability discovery table (the closed registry
  // with honest origin provenance); assoc.report = the consolidated
  // typed associative report (annotations, symbol relationships, xrefs,
  // raster references, docs annotations — ok/dangling/source_loss/
  // missing/stale outcomes, deterministic ordering + digest). ---
  | "parametrics.capabilities"
  | "assoc.report"
  // --- CAD-PARITY-019 rev 2 (additive, the architect review on PR #125):
  // the certification corpus catalog (non-mutating, pure data, computed
  // fresh every call from the version-pinned corpus — the single source of
  // truth the Certification workbench renders: the version pin + sha256,
  // the auditable Autodesk reference manifest, the command bindings
  // (documented + semantic analogs) and the derived per-workflow
  // phases/expectations counts; nothing is hard-coded in the UI). ---
  | "certification.corpusCatalog"
  // --- CAD-PARITY-020 (additive, Issue #123): the derived ARCHICAD corpus
  // catalog — the second version-pinned certification corpus (the Graphisoft
  // Archicad 27 reference manifest + the command-analog map + the derived
  // per-workflow counts; nothing hard-coded in the UI). ---
  | "certification.archicadCatalog";

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
