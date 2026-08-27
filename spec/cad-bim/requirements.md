# CAD/BIM Product Requirements v1.0

This is the parity requirements registry for the CAD/BIM product. IDs are product requirements; existing ConstructionOS requirements remain authoritative for cross-domain governance.

## Foundation and workspace
- CAD-P-001 Shared Web/Electron renderer and semantic App API.
- CAD-P-002 Professional command system: command search, aliases, shortcuts, command line and contextual actions.
- CAD-P-003 Professional workspace: ribbon/toolbars, palettes, properties, navigator, status bar, tabs, viewports and docking.
- CAD-P-004 Deterministic selection, snapping, coordinates, grips and contextual editing.

## 2D drafting parity
- CAD-2D-001 Primitive geometry: line, polyline, circle, arc, ellipse, spline, point, ray/xline, region.
- CAD-2D-002 Modify: move, copy, rotate, scale, mirror, offset, trim, extend, stretch, fillet, chamfer, break, join, explode.
- CAD-2D-003 Precision aids: object snap, tracking, polar/ortho, dynamic input, coordinate entry, temporary overrides.
- CAD-2D-004 Layers/styles: layer states, linetypes, lineweights, color, transparency, property overrides, standards.
- CAD-2D-005 Annotation: text, mtext, leaders, multileaders, dimensions, tolerance, tables, fields, annotative behavior.
- CAD-2D-006 Hatches/fills: associative boundaries, patterns, gradients and editing diagnostics.
- CAD-2D-007 Blocks/symbols: definitions, inserts, attributes, dynamic parameters, visibility and nested blocks.
- CAD-2D-008 References: xrefs, overlays, underlays, binding/detaching and reference status diagnostics.
- CAD-2D-009 Layouts/plotting: model/paper space, viewports, scales, page setup, plot preview and deterministic sheet output.
- CAD-2D-010 Constraints: geometric/dimensional constraints within the bounded supported solver; explicit unsupported cases.

## 3D/CAD modeling
- CAD-3D-001 Solid/surface/mesh creation and editing.
- CAD-3D-002 Boolean union/subtract/intersect, shell/section and mass properties.
- CAD-3D-003 Transform/navigation: UCS, workplanes, orbit/pan/zoom, clipping, view styles.
- CAD-3D-004 Parametric feature history where the engine capability is reliable and portable.
- CAD-3D-005 Tessellation/cache performance and large-model interaction.

## BIM / architecture
- CAD-BIM-001 Stories/levels, walls, slabs, roofs, openings, doors, windows, stairs, railings and spaces.
- CAD-BIM-002 Components/families, instances, materials and parameter propagation.
- CAD-BIM-003 Grids/reference planes and coordination tools.
- CAD-BIM-004 Classification, properties, IDs, schedules and element information.
- CAD-BIM-005 Renovation/design-option style lifecycle states where useful.
- CAD-BIM-006 IFC/BCF/IDS interoperability and semantic reconciliation.

## Documentation
- CAD-DOC-001 Plans, elevations, sections, details and 3D documents.
- CAD-DOC-002 Associative dimensions, labels, tags, keynotes and annotations.
- CAD-DOC-003 Sheets/layout book, masters, subsets and publication sets.
- CAD-DOC-004 Schedules/legends/indexes and model-linked documentation.
- CAD-DOC-005 Revision/change-management workflow.

## Collaboration / data
- CAD-COL-001 Source lineage, autosave/recovery, version history and deterministic replay.
- CAD-COL-002 Presence, comments, review states and scoped collaboration through ConstructionOS domain APIs.
- CAD-COL-003 Large-project performance, bounded workers and crash-safe persistence.

## UX quality
- CAD-UX-001 Task completion parity benchmark for common professional workflows.
- CAD-UX-002 Keyboard-first parity for core commands.
- CAD-UX-003 Contextual editing parity for selected objects.
- CAD-UX-004 Multi-window/view/tab workflow parity.
- CAD-UX-005 Accessibility and discoverability without sacrificing expert density.

## Future specialized toolsets
- CAD-SPEC-001 Architectural automation/tools.
- CAD-SPEC-002 Mechanical drafting/toolset.
- CAD-SPEC-003 MEP/electrical/plant primitives through extension-capability contracts.
- CAD-SPEC-004 Raster/map/point-cloud workflows where justified.
- CAD-SPEC-005 External APIs/automation: scriptable commands, event hooks and extension SDK.
