# COMPAT-CAD-006 — Z.ai Implementation Directive

## Authority

Implement exactly GitHub Issue #138 and `governance/work-items/COMPAT-CAD-006.json` against the latest VERIFIED `main` baseline.

Architecture: ConstructionOS Architecture v1.1 — FROZEN.
Dependency: `COMPAT-CAD-005` VERIFIED at `74d1b39578916f1915674e20d215bde79d1c10cd`.

## Mission

Repair the CAD viewport/navigation foundation identified by CAD-BENCH-RW-001:

- deterministic partial viewport clipping;
- stable zoom and window-zoom;
- deterministic pan;
- redraw/regen without document mutation;
- one shared deterministic screen↔world coordinate transform contract across Web/Electron;
- preservation of COMPAT-CAD-005 canonical layer, selection and commit-authority semantics.

## Required implementation rules

1. Do not introduce a new canonical document/project store.
2. Keep CADDocument as the working representation and Construction Graph as the project/asset authority.
3. Keep native geometry/BIM engines behind existing adapter/worker boundaries.
4. Use the shared renderer/editor core for Web and Electron; host-specific code may only supply transport/capabilities.
5. Navigation state must remain editor/view state. ZOOM, PAN and REGEN must not mutate canonical entity content, document version or undo history except where an explicitly existing presentation-only mechanism requires equivalent non-content state.
6. Keep the COMPAT-CAD-005 fixed-height command line and canonical selection/picking behavior intact.
7. Do not implement ARRAY materialization, persistence, DXF, layout identity or unrelated BIM features in this work item.

## Required test/evidence work

Create deterministic tests for:

- line/arc/polyline or equivalent geometry that crosses the viewport boundary;
- partial clipping versus fully off-screen geometry;
- zoom and window-zoom view-transform determinism;
- pan transform determinism;
- repeated REGEN/redraw idempotence;
- round-trip screen→world→screen coordinate mapping within the declared precision;
- unchanged CADDocument entities/version/history after navigation;
- Web/Electron semantic parity.

Extend browser evidence with:

- G1 floor-plan continuation after navigation;
- G2 real-scale site-plan flow where an endpoint begins outside the initial viewport;
- G3 parking/repetition navigation prerequisite;
- explicit pan/zoom/window-zoom probes;
- negative navigation probes confirming no document mutation.

Use visible UI paths for browser evidence. Supporting network/runtime inspection is allowed, but hidden APIs must not perform the workflow under test.

## Required regression gates

- full deterministic application suite;
- Web lint/typecheck/build;
- Electron typecheck and affected real-UI smokes;
- all relevant existing CAD/BIM regression smokes;
- exact-head GitHub Actions;
- exact-head preview deployment;
- independent browser-agent Golden 10 targeted regression.

## Scope honesty

Do not claim AutoCAD parity from a passing navigation probe. Update the benchmark/defect evidence only from observed behavior. ARRAY materialization remains COMPAT-CAD-008; durable persistence remains COMPAT-CAD-011.

## Governance stop gate

After implementation and evidence are complete:

- update the governance record with revision-bound evidence;
- open/refresh the implementation PR;
- set the work item to `PR_OPEN/VERIFYING`;
- stop implementation-side lifecycle advancement.

Do not add `ARCHITECT_REVIEW`, `APPROVED`, `MERGED`, or `VERIFIED`. The Architect will automatically continue the governance loop from the worker return.
