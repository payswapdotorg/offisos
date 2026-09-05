# COMPAT-CAD-007 — Z.ai Implementation Directive

## Role
You are the implementation worker for Offisos. Implement **only** the frozen COMPAT-CAD-007 scope below and stop at **PR_OPEN / VERIFYING**.

Do not approve, merge, or verify your own work. The Architect owns ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED.

## Repository / authority
- Repository: `payswapdotorg/offisos`
- GitHub issue: **#1**
- Work-item record: `governance/work-items/COMPAT-CAD-007.json`
- Architecture: ConstructionOS Architecture **v1.1 — FROZEN**
- Verified predecessor: COMPAT-CAD-006 at merge `eb3406340df08d1ab39e771c40681d6248840d2e`
- Benchmark: CAD-BENCH-RW-001, current program score **18/100**; do not claim a score increase without a benchmark rerun.

## Mission
Restore the next bounded CAD editing layer: deterministic object-selection and core modify workflows over the verified shared geometry/precision/navigation foundations.

The objective is to address the Phase-3 roadmap ownership for **DEF-006 / DEF-007 / DEF-021** without changing canonical authority, architecture boundaries, or unrelated successor scopes.

## Scope

### 1. Shared deterministic selection
- Use the existing canonical selection state and the shared screen/world transform/picking foundations from COMPAT-CAD-005/006.
- Make supported object selection deterministic across click, window and crossing workflows required by the declared browser gates.
- Selection results must remain canonical, live-element filtered and consistent with Properties/status surfaces.
- Web and Electron must not develop divergent semantic selection implementations.

### 2. Core editing semantics
Implement the smallest complete set of edit operations required for the affected G1/G2/G4/G10 workflows, using the existing engine-free shared geometry contracts.

Supported operations must:
- operate on canonical document entities;
- produce deterministic geometry;
- create exactly one canonical revision per mutating command where the existing command contract requires it;
- preserve stable canonical identities unless an operation explicitly creates a new entity, in which case use the existing document identity-minting rules;
- integrate with existing undo/redo and replay semantics.

Do not add speculative editing features merely because they are convenient.

### 3. Interactive command state
- Previews, hover state and temporary selection remain presentation/editor state.
- Only the committed mutation crosses into canonical document history.
- Invalid/unsupported inputs must produce explicit typed outcomes.
- Never emit a success echo before the canonical mutation commits.

### 4. Host parity
- Shared semantic core first.
- Web/Electron must execute the same governed command semantics through the existing App API/transport boundaries.
- No direct engine imports in renderer, App API, CADDocument or shared workspace/domain modules.

### 5. Regression preservation
The following verified behavior must remain intact:
- COMPAT-CAD-005 canonical layer identity and active-layer behavior;
- NEW/reset semantics;
- canonical selection pruning and entity counts;
- deterministic screen-space picking;
- commit-authoritative feedback;
- COMPAT-CAD-006 clipping, ZOOM, PAN, REGEN and shared transform behavior;
- Web/Electron semantic parity.

## Non-goals / protected boundaries
- No ARRAY materialization/render/selectability — COMPAT-CAD-008.
- No durable SAVE/OPEN or serverless multi-instance session persistence — COMPAT-CAD-011 / infrastructure track.
- No DXF — COMPAT-CAD-012.
- No layout/sheet viewport identity — COMPAT-CAD-013.
- No unrelated BIM/documentation/interop expansion.
- No architecture changes. If implementation requires a protected architecture change, stop and report an ACR requirement instead of editing around the boundary.
- No full AutoCAD parity claim.

## Required evidence
Before returning PR_OPEN / VERIFYING, provide revision-bound evidence for:

1. Deterministic automated tests covering the supported selection/edit semantics, invalid/unsupported cases, revision/history behavior and no-fabrication guarantees.
2. Negative tests proving selection/editor previews do not mutate canonical state before commit and failed edits do not emit false success.
3. Web/Electron parity for the affected semantic stream.
4. Regression execution for COMPAT-CAD-005 and COMPAT-CAD-006 behavior.
5. Exact-head CI with the known pre-existing `CAD-PARITY-020.json` governance failure explicitly distinguished from PR-attributable failures if it recurs.
6. Exact-head deployment and independent browser-agent evidence.
7. Golden browser gates **G1, G2, G4 and G10**, plus targeted probes for the affected DEF-006/007/021 behavior.
8. Exact revision bindings in `governance/work-items/COMPAT-CAD-007.json`.

## Implementation discipline
- Read the authoritative governance workflow, architecture lock, work-item record, this prompt, and relevant existing CAD-005/CAD-006 evidence before changing code.
- Audit current main, not historical assumptions.
- Keep changes minimal and shared-core-first.
- Add tests before or alongside implementation so failure modes are explicit.
- Do not modify an already-VERIFIED governance record belonging to another work item.
- Do not change benchmark scoring merely to make the phase pass.
- Record any newly discovered defect in the work-item evidence and triage it honestly.

## Stop condition
Return only when:
- implementation is complete for this frozen scope;
- deterministic tests and required local gates are complete;
- CI has been allowed to reach terminal state;
- exact deployment/browser evidence is captured;
- `governance/work-items/COMPAT-CAD-007.json` is revision-bound to the actual implementation/evidence heads;
- the PR is open and the governance record is **VERIFYING**.

Do not add ARCHITECT_REVIEW, APPROVED, MERGED or VERIFIED transitions yourself.

## Expected handoff
Return:
- PR number and final PR head;
- implementation commit(s);
- exact changed-file list;
- test/CI results;
- deployment identity and exact commit binding;
- browser-agent transcript/results for G1/G2/G4/G10;
- known limitations and deferred defects;
- confirmation that the working tree is clean and the stop gate is PR_OPEN / VERIFYING.
