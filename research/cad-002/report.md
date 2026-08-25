# RESEARCH-CAD-002 — Findings Report

**Work item:** RESEARCH-CAD-002 (GitHub issue #2)
**Architecture version:** 1.0 (FROZEN)
**Evidence run:** `evidence/run-001/` (69 pass / 0 fail / 0 unknown)
**Engine:** FreeCAD 1.1.3 (official AppImage, SHA256
3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef,
build 20260725) with its bundled OpenCascade kernel, run headless via
FreeCADCmd console mode
**Environment:** Linux x86_64, Python 3.12 (host harness)
(see `evidence/run-001/environment.json`)

This report separates measured results (NATIVE/ADAPTER/OBSERVED/
CALCULATED) from inferred conclusions (INFERRED). It does not decide the
final CAD engine. The recommendation at the end is subject to Architect
review and to the later feasibility gates (performance thresholds, IFC
fidelity, licensing).

---

## 1. 2D drafting (scope 1)

- **Precision / coordinate entry [NATIVE]:** endpoints entered with 12
  decimals read back exactly; line length matches the analytic hypotenuse
  within 1e-12. Circles: radius exact, area = πr² within 1e-9. Arcs: edge
  length = πr/2 for 90° within 1e-9. [cad2-2d/*]
- **Layers/visibility [NATIVE]:** layer membership round-trips exactly
  (3 objects in A-WALL, 0 in A-ANNO-DIMS); layer and object visibility
  toggle exactly through the console API. On-screen rendering of
  visibility requires the GUI runtime (state itself is console-capable).
- **Dimensions/annotations [NATIVE]:** linear dimensions measure fixture
  lengths exactly (8.0/5.0); text annotations store and return exact
  content.
- **Edit/recompute [NATIVE]:** editing a line endpoint marks it Touched,
  recompute restores Up-to-date with the exact new analytic length;
  FCStd persistence/reopen preserves exact geometry.

## 2. Snapping and object inference (scope 1)

- **Parameter system [NATIVE]:** Draft snap parameters (objectSnap,
  gridSnap, gridSpacing, snapRange) read/write exactly in console mode.
- **Object inference [NATIVE]:** `distToShape` reports the exact nearest
  distance and nearest point on a solid (2.0 → (4, 0, 0)); crossing-edge
  intersection via `distToShape` reports distance 0 with the exact
  crossing point (4, 0). Note: `edge.common()` computes overlap, not
  crossing — distToShape is the correct query.
- **Adapter snapping [ADAPTER]:** endpoint/midpoint/intersection/grid
  snapping built from the native geometry queries are all exact at 1e-12.
- **GUI boundary [OBSERVED FINDING]:** in console mode FreeCADGui imports
  only as a stub with no GUI API (no getMainWindow/activeDocument) and
  TechDrawGui cannot load at all. All geometry queries snapping needs are
  console-capable; only the interactive snap toolbar/highlight UX layer
  requires the GUI runtime.

## 3. Geometric constraints (scope 1/3)

- **Full constraint [NATIVE]:** rectangle with geometric + dimensional +
  origin-anchor constraints reports `FullyConstrained` (DoF 0) and solver
  rc 0.
- **Datum edit propagation [NATIVE]:** DistanceX 4.0 → 6.5 re-solves width
  to exactly 6.5 while height holds at exactly 3.0; the top-right corner
  tracks to (6.5, 3.0); origin-anchored corners stay fixed.
- **Tangent [NATIVE]:** fully constrained circle+line tangency forces the
  line to y = ±2.0 **exactly** (distance center-to-line = radius).
- **Perpendicular/equal [NATIVE]:** perpendicular solves the shared corner
  to exactly (4, 0) with the vertical end at exactly (4, 3); Equal +
  single length datum changes BOTH lines to exactly 5.0 (measured
  point-to-point; the solver slides unanchored lines).
- **Conflict/redundancy detection [NATIVE]:** a second conflicting
  dimension on the same measured distance is detected (solver rc −2,
  RedundantConstraints populated).
- **Invalid datums [NATIVE]:** zero and negative unsigned Distance datums
  are rejected with typed `ValueError`.

### Solver-semantics findings (recorded, not worked around)

1. **`sketch.solve()` returns a solver return code, NOT the DoF.** An
   unconstrained sketch also returns 0. `FullyConstrained` is the actual
   DoF-0 indicator. Adapter code must not conflate solver success with
   constraint completeness. [cad2-constraints/rectangle-full-constraint
   details; verified with an unconstrained control sketch]
2. **Underconstrained tangency can "converge" without geometric
   tangency:** an underconstrained circle+line+Tangent sketch returned
   solver rc 0 with the line at y = 2.235 ≠ r = 2.0. Fully constraining
   the sketch restores exact tangency. Implication: adapters must treat
   solver success and geometric satisfaction as separate assertions.

## 4. 3D geometry (scope 2)

- **Scripted booleans [NATIVE]:** fuse/cut/common of two 2×2×2 boxes with
  1×1×2 overlap are exactly 14/6/2 m³ (1e-9); a cylinder drill through a
  plate matches the analytic value within 1e-9; disjoint fuse honestly
  yields a 2-solid shape with exact total volume (topology change
  measurable, not silent).
- **Parametric booleans [NATIVE]:** a Part::Cut document object computes
  72 − 2π exactly; editing the base length (6→8) and the tool radius
  (1→0.5) both propagate to the exact new analytic volumes.
- **Transforms/placements [NATIVE]:** placement with 90° Z-rotation +
  translation moves the origin vertex to exactly (10, 20, 30) and swaps
  extents exactly; matrix move+rotate on a shape produces exact extents
  per matrix composition semantics.

## 5. Parametric modeling (scope 2/3)

- **Primitives [NATIVE]:** Part::Box length edit 2.0→5.0 changes volume
  from exactly 24.0 to exactly 60.0.
- **PartDesign chain [NATIVE]:** Body + constrained sketch + Pad = exactly
  profile×length (24.0); sketch datum edit 4.0→6.0 propagates to exactly
  36.0; pad length edit propagates to exactly 54.0; Pocket subtracts the
  exact cylinder volume (πr²h within 1e-6) and a pocket-radius edit
  propagates to the exact new volume.
- **Dependency/recompute [NATIVE]:** editing the base sketch marks it (and
  dependents) Touched; a full recompute restores all objects to
  Up-to-date, returns a positive recomputed count, and regenerates the
  exact expected volume; an incremental edit touches exactly one feature
  and recomputes it in 0.2 ms.
- **Failure behavior [NATIVE]:** an invalid (negative) length leaves the
  object in the detectable `Invalid` state (no crash, no fake geometry);
  correcting the parameter recovers it to Up-to-date with the exact
  volume.

### Constraint-semantics finding (caught by exact assertions)

3. **Coincident-to-origin on a circle anchors its CENTER.** An early
   benchmark version anchored the pocket-hole circle with
   `Coincident(0, 3, -1, 1)`, silently moving the hole center to the pad
   corner and cutting a quarter-cylinder — caught only because the volume
   assertion was exact. Hole positions must use DistanceX/DistanceY
   constraints on the center point. Recorded as an adapter-construction
   rule.

## 6. Assemblies (scope 2)

- **App::Link [NATIVE]:** instances carry the exact source volume, honor
  placements exactly, and update when the source is edited (single link,
  link array with ElementCount=5 → exact 5× volume).
- **Medium assembly [NATIVE]:** 100 independently placed links (rotations
  0/90/180/270°) — every instance has the exact unit volume, no Invalid
  states, creation 2.5 ms, recompute 0.4 ms; a source edit propagates to
  all 100 instances to exactly 2.0 volume each after one recompute.

## 7. Automation/API determinism (scope 4)

- **Stable adapter [ADAPTER]:** every CAD operation is invocable through
  the `CadEngineAdapter` contract, with each operation executed in a fresh
  FreeCADCmd process and state persisted explicitly via FCStd — there is
  no application-global state by construction.
- **Workflow determinism [OBSERVED]:** the identical adapter workflow
  (create 3×4×5 box → edit length to 6.0 → export STEP → reimport), run
  twice with fresh processes, produces identical results for every
  semantic measurement; the workflow computes exact values (60.0 → 120.0,
  reimport matches within 1e-9, 1 solid).
- **In-process determinism [NATIVE]:** building the identical parametric
  cut model twice in one process yields bit-identical volume and topology
  counts.

### Export determinism findings

4. **STEP exports are NOT byte-deterministic** (the STEP header embeds a
   generation timestamp). Reimporting both exports yields the identical
   exact volume — semantic content IS deterministic. Same for **FCStd**
   saves (container embeds save timestamps). Implication: Offisos change
   detection must be semantic (geometry/properties), never file-byte
   based.
- **Typed failures [ADAPTER]:** adapter operations on a missing document
  raise the typed `InvalidInputError` (no silent fallback).

## 8. Performance (single-environment observations, not thresholds)

| Measurement | Value |
|---|---|
| 100-feature parametric document: creation / full recompute | 78 ms / 4.5 ms |
| Incremental recompute (1 feature edited) | 0.2 ms (1 object recomputed) |
| PartDesign chain recompute after datum edit | 3.2 ms |
| 100-instance assembly: creation / recompute | 2.5 ms / 0.4 ms |
| STEP export / import of 100 solids | 63 ms / 186 ms (579 KB) |
| FCStd save (104 objects) | 37 ms (98 KB) |
| Peak RSS of the engine benchmark process | 108 MiB |

## 9. Limitations (explicit)

1. Interactive snapping UI, TechDraw SVG/PDF export and any GUI workflow
   remain GUI-only (geometry queries, parameter state and DXF export are
   console-capable).
2. Performance numbers are single-environment observations; thresholds are
   RESEARCH-CAD-006's scope.
3. This benchmark does not exercise the IFC/BIM layer (RESEARCH-CAD-003's
   scope) and does not decide the final engine.
4. Solver findings (rc vs DoF; underconstrained tangency drift) are
   recorded as adapter obligations, not engine defects.

## 10. Recommendation (INFERRED — decision belongs to the Architect)

The measured evidence **supports proceeding with FreeCAD/OpenCascade as
the current CAD geometry candidate behind the frozen adapter boundary**:
precision is exact across all scoped capability areas; parametric
propagation, failure detection and assembly behavior are deterministic;
automation through a stable, process-isolated adapter is proven. The
recorded findings (solver return-code semantics, underconstrained-tangency
drift, circle-center anchoring, non-byte-deterministic exports, GUI-only
UX layer) are adapter-level obligations, not architecture changes.

No Architecture Change Request is required by this evidence. Remaining
gates before any final decision: performance thresholds
(RESEARCH-CAD-006), IFC/BIM fidelity (RESEARCH-CAD-003) and
licensing/composition (LICENSE-001).
