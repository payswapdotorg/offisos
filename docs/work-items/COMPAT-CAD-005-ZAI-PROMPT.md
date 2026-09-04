# COMPAT-CAD-005 — Z.ai Implementation Brief

**Authoritative issue:** #135  
**Governance record:** `governance/work-items/COMPAT-CAD-005.json`  
**Baseline:** current `main` at the time of assignment  
**Agent:** `z-ai-implementation-agent`  
**Stop gate:** `PR_OPEN / VERIFYING`

## Mission

Repair the real-world 2D drafting foundation exposed by **CAD-BENCH-RW-001**. Treat the production black-box benchmark as the user-facing truth. Do not assume the historical COMPAT-CAD-001 / PR #38 guarantees are still present: current mainline behavior is authoritative.

## Highest-priority slice

1. Unify layer identity between UI and canonical document/engine state.
2. Make active-layer changes affect subsequent entity creation.
3. Make `NEW` fully reset document/editor state: active layer, selection, transient command state, view state and entity counts; remove dangling references and phantom entities.
4. Unify command selection, canvas picking and Properties selection into one canonical selection state.
5. Implement deterministic screen-space picking with a declared tolerance appropriate for the rendered viewport.
6. Eliminate phantom entity counts/stale graph state.
7. Emit command success only after the canonical transaction commits; failures must be explicit typed failures without a preceding false success echo.

## Acceptance evidence

Re-run the affected golden black-box workflows from `docs/cad/autocad-real-world-benchmark.md` and prove them through the real browser UI, not only through API/unit tests:

- **G1** floor plan: layers + entity creation.
- **G2** real-scale site plan: selection/navigation prerequisite behavior.
- **G3** parking/repetition: selection prerequisite.
- **G5** block-selection prerequisite.
- **G7** BIM host-object selection prerequisite.
- **G8** layout/viewport selection prerequisite.
- **G9** persistence/identity prerequisite where this slice touches state.
- **G10** undo/state consistency.

Deterministic automated coverage must accompany the browser evidence.

## Boundaries

- Architecture v1.1 is FROZEN.
- Construction Graph is canonical.
- CADDocument is the editor/working representation.
- Engine-native IDs are provenance only.
- Native engines remain behind EngineAdapterBundle/worker boundaries.
- Web/Electron share semantic application contracts.
- No architecture changes without ACR.
- Do not spend this slice on HATCH, cosmetic UI, additional BIM authoring, or Project/scheduling work.
- Viewport clipping, zoom/pan and ARRAY materialization are the next slice after the state/selection foundation is stable.

## Quality bar

Do not patch individual symptoms independently when they share a state/identity root. Locate the canonical source-of-truth boundary, repair it, then prove the browser behavior and regression coverage. Preserve existing CAD/BIM baselines.

Do not claim APPROVED or VERIFIED. Stop with a focused PR and complete evidence package at `PR_OPEN / VERIFYING` for Architect review.
