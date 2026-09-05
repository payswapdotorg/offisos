# COMPAT-CAD-008 — Z-AI implementation directive

## Authority

Work item: `COMPAT-CAD-008`  
GitHub issue: `#5`  
Governance record: `governance/work-items/COMPAT-CAD-008.json`  
Architecture: ConstructionOS Architecture v1.1 — **FROZEN**  
Dependency: `COMPAT-CAD-007` — **VERIFIED** at physical merge `9232c90e4340475bcf5c6818a30d9748ea04330a`  
Current repository main at authorization repair: `f1d82dbfcd14e5e9a6386fe6a0863dd030720eaa`  
State: **ASSIGNED — IMPLEMENTATION AUTHORIZED**  
Implementation agent: `z-ai-implementation-agent`  
Implementation stop gate: **PR_OPEN / VERIFYING**

This is the current implementation directive. Earlier CC008 preparation-only comments and prompt versions are historical context and are superseded by the current governance record, authoritative roadmap and this directive.

## 1. Legal lifecycle boundary

The repository state already records the legal Architect release `DRAFT → READY → ASSIGNED`. The implementation agent may now perform the implementer-owned transition `ASSIGNED → IMPLEMENTING`, implement the frozen scope, then advance only through the implementer-owned path to `PR_OPEN → VERIFYING`.

The implementation agent **must stop at `PR_OPEN / VERIFYING`**. It must not self-approve, merge, or verify the work item. The Architect owns independent review, approval, merge, post-merge evidence reconciliation and final `MERGED → VERIFIED`.

## 2. Objective

Implement the bounded ARRAY capability owned by the authoritative CAD roadmap and retire `DEF-015` within these frozen boundaries: deterministic rectangular and polar array semantics; path-array behavior only where genuinely supported by the frozen contract; canonical materialization of members; deterministic stable identities and ordering; rendering and selectability; explicit source/member ownership semantics; compatibility with existing edit/erase behavior; one atomic canonical revision; undo/redo; invalid and unsupported typed outcomes; deterministic serialization/byte identity; and Web/Electron semantic parity.

The detailed semantic contract is authoritative for array semantics and evidence fixture design:

`docs/work-items/COMPAT-CAD-008-SEMANTIC-CONTRACT.md`

## 3. Implementation input and base reconciliation

The existing preparation branch is implementation input only:

`work/compat-cad-008-array-preparation`

The preparation spike was created before CC007 verification. Reconcile its useful implementation/test work onto the then-current `main` before producing the implementation PR. Do not treat the old preparation base or commit `284bc28` as the current product revision.

Current authorization must be reconciled against current `main` rather than replaying stale lifecycle assumptions.

## 4. Frozen architecture and ownership boundaries

- Construction Graph remains the canonical system of record.
- `CADDocument` remains the editor/working representation.
- Architecture v1.1 remains frozen.
- Shared engine-free command semantics are the first implementation path.
- Native engines remain behind the existing `EngineAdapterBundle` / worker boundary.
- Renderer, application and domain code must not import native engine internals directly.
- Engine GlobalIds are provenance only and never canonical identity.
- Canonical identities are deterministic and domain-owned.
- Interactive previews and transient selection remain presentation state until canonical commit.
- Every successful mutating ARRAY command produces exactly one canonical revision under the existing history semantics.
- Unsupported and invalid behavior must be explicit typed failures; never fabricate geometry, semantics, confidence or success.
- Web and Electron must converge through the same semantic command/query contracts.

Do not modify protected architecture artifacts. Any required architecture change must stop implementation and follow the existing ACR lifecycle.

## 5. Exact bounded scope

### Rectangular ARRAY

Implement and prove:

- row/column semantics;
- spacing semantics, including documented boundary values;
- deterministic row-major member ordering;
- deterministic member identity derivation;
- canonical member materialization;
- rendering and selection of materialized members;
- edit/erase interaction;
- invalid input behavior;
- one atomic canonical revision.

### Polar ARRAY

Implement and prove:

- center semantics;
- count semantics;
- angular spacing semantics;
- deterministic orientation and ordering;
- deterministic member identity derivation;
- canonical member materialization;
- rendering and selection;
- edit/erase interaction;
- invalid input behavior;
- full-circle and partial-span boundary behavior defined by the frozen contract;
- one atomic canonical revision.

### Path ARRAY

Implement path arrays **only where the existing frozen contract provides a genuine bounded supported behavior**. If a path variant is outside the supported contract, return an explicit typed unsupported outcome and preserve no-mutation guarantees. Do not fabricate path geometry merely to pass a test.

### Source/member ownership

Define and implement deterministic source/member ownership, including delete, undo and redo behavior. Materialized members must live in the canonical entity partition and must not become hidden application-local duplicates.

### Selection/render integration

Reuse the CC007 selection/prompt path. Rendering, hit-testing and command selection must identify the same canonical materialized members. No second selection system may be introduced.

### Determinism and parity

Equivalent executions must produce the same semantic state, member ordering, identities and serialized representation, including byte-level identity wherever the existing evidence contract requires it. Web and Electron must produce equivalent affected canonical serialized state through the shared semantic command path.

## 6. Required negative behavior

At minimum prove:

- zero/negative/invalid counts and spacing/angle values follow the frozen typed behavior;
- signed spacing errors fail typed before canonical mutation;
- rectangular 1×1 and polar count=1 follow the specified deterministic no-op semantics;
- degenerate and unsupported path inputs do not fabricate geometry;
- failed plans do not mutate canonical state and do not emit false success;
- no phantom or duplicate members are created;
- selection does not retain stale/ghost members after undo/redo;
- source/member erase behavior is deterministic;
- unsupported variants remain explicit and typed.

## 7. Required deterministic evidence

Before returning the PR, produce reproducible evidence for:

- rectangular happy paths and boundaries;
- polar happy paths and boundaries;
- supported/unsupported path behavior;
- deterministic ordering and stable identities;
- deterministic serialized/byte output;
- no-mutation-before-commit;
- one canonical revision per successful ARRAY mutation;
- exact UNDO and REDO restoration;
- immediate post-commit selectability of materialized members;
- ERASE/modify interaction with members;
- Web/Electron semantic parity;
- COMPAT-CAD-005/006/007 regression coverage.

Evidence must record the exact implementation revision, invocation, output/result, environment details where material, and known limitations. Narrative-only evidence is insufficient.

## 8. Required browser gate after merge

The Architect will run the mandatory independent black-box browser gate against the exact deployed revision. The implementation must therefore leave deterministic workflows for at least:

- **G3** parking/repetition workflow;
- **G5** fixture/block-adjacent repetition behavior without implementing CC009 block semantics;
- **G6/G7** visibility/selectability interactions involving arrays;
- targeted **DEF-015** probes;
- invalid/negative ARRAY behavior;
- UNDO/REDO;
- no-phantom-member checks.

The browser agent must operate as a real user through the visible product UI and must not use hidden APIs to perform the workflow under test.

## 9. Regression contract

Do not regress verified behavior from:

- COMPAT-CAD-005;
- COMPAT-CAD-006;
- COMPAT-CAD-007.

In particular preserve canonical selection, prompt ownership, transform behavior, viewport behavior, canonical revision semantics and no-mutation guarantees.

## 10. Explicit non-goals

Do **not** opportunistically implement:

- blocks, inserts, attributes or symbol libraries — `COMPAT-CAD-009`;
- hatch, annotation, dimension or inspection expansion — `COMPAT-CAD-010`;
- durable SAVE/OPEN or multi-instance persistence — `COMPAT-CAD-011` / infrastructure;
- DXF import/export — `COMPAT-CAD-012`;
- layout/sheet viewport identity — `COMPAT-CAD-013`;
- command-language completion or unrelated history expansion owned by later roadmap phases;
- architecture changes without an approved ACR;
- benchmark-score changes without a measured full benchmark rerun.

Do not widen scope merely because adjacent functionality is convenient to touch.

## 11. Return package and stop gate

Return at `PR_OPEN / VERIFYING` with:

- implementation PR and exact head SHA;
- changed-files summary and architecture-boundary statement;
- deterministic test commands and exact results;
- Web/Electron parity evidence;
- regression results;
- negative/unsupported-path evidence;
- exact-head CI references;
- deployment identity prepared for the Architect’s post-merge gate;
- known limitations and deferred behavior;
- any architectural concern routed explicitly to ACR instead of silently changing the architecture.

Do not add `APPROVED`, `MERGED` or `VERIFIED` transitions. Do not claim the benchmark score has changed.

## 12. Security

Never commit, print or expose GitHub tokens, deployment credentials, database credentials, private keys or other secrets. Evidence and fixtures must remain credential-free.
