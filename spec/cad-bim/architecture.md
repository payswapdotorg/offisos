# CAD/BIM Product Architecture v1.0

**Status:** FROZEN
**Parent architecture:** ConstructionOS Architecture 1.1 (FROZEN)
**Role:** Product architecture for the CAD/BIM application. This document does not replace or modify ConstructionOS Architecture 1.1.

## 1. Product objective

Deliver a professional CAD/BIM application whose workflows are familiar to AutoCAD-class drafting users and Archicad-class BIM users while preserving ConstructionOS domain authority and provider independence.

Target: feature/workflow parity, not source-code cloning. Compatibility is measured by workflow completion, semantic fidelity, determinism, interoperability, usability, and performance.

## 2. Product topology

```text
                         CAD/BIM Product
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
   Web Application                             Desktop/Electron
        │                                           │
   React/Next UI                              BrowserWindow UI
        │                                           │
        └────────────────────┬──────────────────────┘
                             │
                    Shared Renderer Core
                             │
                     Shared App API
                             │
                   CAD/BIM Application Core
                             │
      ┌──────────────┬──────┴──────┬──────────────┐
      │              │             │              │
  2D Drafting    BIM Semantics  Documentation  Coordination
      │              │             │              │
      └──────────────┴──────┬──────┴──────────────┘
                             │
                     Construction Graph
                             │
                    Adapter/Worker Boundary
              ┌──────────────┼──────────────┐
              │              │              │
          Geometry         IFC/BIM         Files
        OCCT/FreeCAD      IfcOpenShell    DWG/DXF/IFC
```

The renderer, CADDocument, application contracts, and domain models never import native engine APIs. Engine execution occurs through explicit adapters and disposable workers. Web uses server/domain transports; Electron uses allowlisted local/native transports.

## 3. Canonical layers

### 3.1 Presentation

A dense professional workspace inspired by AutoCAD and Archicad interaction patterns:

- application menu and command search;
- ribbon/toolbars and context toolbars;
- command line and keyboard-first command execution;
- tool palettes and properties/inspector;
- navigator/project browser;
- canvas/model viewport and multiple tabs;
- status bar with units, snapping, coordinates and active workplane;
- sheets/layouts and drawing tabs;
- contextual selection/edit handles;
- diagnostics and progress surfaces.

Presentation is replaceable and may differ visually between Web and Electron only where platform conventions require it; semantic results must remain equivalent.

### 3.2 Application/API

All product operations are typed commands, queries, jobs and capabilities. UI actions never mutate domain state directly.

### 3.3 Editor model

CADDocument remains the versioned working representation. It owns document-local identity, editor history, undo/redo, workspace state, document content, source lineage and serialization metadata.

### 3.4 Domain semantics

Construction Graph remains authoritative for project/asset identity and cross-application semantics. CADDocument elements map to Graph identities through explicit contracts; engine IDs are provenance only.

### 3.5 Engine layer

Geometry, BIM exchange, rendering acceleration and file conversion engines remain behind adapters. Engines can be replaced without changing semantic APIs.

## 4. CAD domain model

The domain model is organized into stable identity categories:

- primitives: line, polyline, circle, arc, ellipse, spline, region, text, multiline text;
- dimensions/leaders/tables/hatches;
- layers, linetypes, lineweights, colors, transparency, styles;
- blocks/symbol definitions, block instances, attributes and dynamic parameters;
- external references and underlays;
- coordinate systems/UCS/workplanes;
- 3D solids, surfaces, meshes, boolean results, transforms and section/clipping state;
- BIM elements: stories/levels, walls, slabs, roofs, doors, windows, openings, stairs, railings, spaces/zones, components, materials, grids/reference planes;
- documentation objects: views, sections, elevations, details, sheets/layouts, title blocks, annotations, tags, schedules;
- project organization: navigator folders, view sets, sheet subsets, templates and publication sets.

All identities are canonical and monotonic where generated. Deletion never permits silent identity reuse.

## 5. Geometry architecture

Use a tiered geometry strategy:

1. Pure analytic 2D kernel for drafting operations and deterministic predicates.
2. OCCT-backed 3D kernel for exact solids, booleans, transforms, mass properties and tessellation.
3. Optional FreeCAD orchestration for interactive parametric workflows where proven useful.
4. Geometry caches are derived and disposable; canonical state never depends on cache identity.

Heavy geometry calls run in isolated workers with timeouts, resource ceilings, bounded output and typed failure mapping.

## 6. Constraint architecture

The product constraint system is declarative and bounded, not a general symbolic solver. Constraint records reference canonical geometry IDs and expose deterministic graph ordering, residuals, diagnostics and solver outcomes.

Required base vocabulary:

- horizontal, vertical, coincident, parallel, perpendicular;
- equal, tangent, fixed;
- distance, horizontal distance, vertical distance, radius, angle where supported.

Unsupported combinations fail explicitly. Every solve reports one of SATISFIED, UNDER_CONSTRAINED, OVER_CONSTRAINED, UNSATISFIED or UNSUPPORTED.

## 7. Parametric/BIM architecture

Definitions own schemas and default parameters. Instances own placement plus explicit overrides. Effective parameters are derived deterministically as definition defaults overridden by instance values. Definition changes produce immutable revisions and a deterministic affected-instance set.

Materials are canonical domain records independent of engine internals. IFC mapping is additive and explicit.

## 8. Documentation architecture

Views are definitions, not baked geometry. Plans/elevations/sections/details are deterministic projections of the BIM model. Sheets contain placements and title-block metadata. Annotations associate to canonical IDs and recompute from current semantic geometry.

## 9. File architecture

Canonical internal editing format is semantic and revision-aware. Import/export adapters implement source-format parsing/writing with round-trip verification.

Priority compatibility targets:

1. DXF and deterministic exchange formats;
2. IFC/openBIM;
3. DWG interoperability through an explicitly replaceable adapter/writer path;
4. PDF/SVG plotting and documentation outputs;
5. native archival formats where legally/license compatible.

Source artifacts and lineage are always preserved.

## 10. UI architecture

The interface is a professional workspace, not a simplified web canvas. The canonical information architecture is:

```text
Top:      Menu / Ribbon / Command Search
Left:     Tool Palettes / Project Navigator
Center:   Drawing + Model Viewports / Tabs
Right:    Properties / Inspector / Layers / Attributes
Bottom:   Command Line / Status / Coordinates / Snaps
Context:  Selection grips / mini-toolbar / contextual properties
```

Users can work mouse-first, keyboard-first or command-first. Every major action has a discoverable command, shortcut and contextual UI affordance where appropriate.

## 11. Collaboration

Local editor state is optimistic and disposable. Authoritative project/BIM transactions are versioned through the existing domain transaction architecture. Presence/cursor/viewport state is non-authoritative.

## 12. Performance architecture

Performance budgets are explicit per workflow and tier. Large files, tessellation, imports, booleans, regeneration and exports may execute asynchronously. Long native jobs are cancellable only by worker termination; in-process cancellation is not assumed.

## 13. Compatibility methodology

Parity is measured in layers:

- command/workflow parity;
- geometry/semantic parity;
- file import/export parity;
- UI task-completion parity;
- keyboard/mouse interaction parity;
- performance parity;
- failure/diagnostic parity.

The benchmark corpus grows by representative professional workflows rather than by marketing feature counts.

## 14. Explicit non-goals of this freeze

This architecture does not require copying Autodesk or Graphisoft implementation details, private APIs, source code, file-format internals, trade secrets or proprietary algorithms. It also does not force immediate support for every specialized AutoCAD toolset or every Archicad discipline module. Those become subsequent parity requirements with explicit evidence thresholds.
