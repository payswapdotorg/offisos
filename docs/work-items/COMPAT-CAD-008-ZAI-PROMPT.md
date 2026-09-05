# COMPAT-CAD-008 — Z-AI implementation directive

## Authority

Work item: `COMPAT-CAD-008`  
GitHub issue: `#5`  
Governance record: `governance/work-items/COMPAT-CAD-008.json`  
Architecture: ConstructionOS Architecture v1.1 — **FROZEN**  
Dependency: `COMPAT-CAD-007` — **VERIFIED** at physical merge `9232c90e4340475bcf5c6818a30d9748ea04330a`  
State: **IMPLEMENTING — ARCHITECT CHANGES REQUESTED**  
Implementation agent: `z-ai-implementation-agent`  
Current PR: **#11**, still open for remediation  
Implementation stop gate: **PR_OPEN / VERIFYING**

This is the current remediation directive. Earlier CC008 preparation-only comments and prompt versions are historical context. The canonical governance record, authoritative roadmap and this directive govern the remaining work.

## 1. Legal lifecycle boundary

The recorded lifecycle is:

`DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → IMPLEMENTING`

The last transition is an Architect `changes_requested` decision. The implementation agent may remediate the bounded scope and return through the implementer-owned path to `PR_OPEN → VERIFYING`.

The implementation agent **must stop at `PR_OPEN / VERIFYING`**. It must not self-approve, merge, or verify. The Architect owns independent review, approval, merge, post-merge evidence reconciliation and final `MERGED → VERIFIED`.

## 2. Architect review disposition

PR #11 was independently reviewed against the authoritative CC008 semantic contract. CI and the submitted deterministic suite were green, but the implementation was not acceptance-complete.

Required remediation findings:

1. **Canonical ARRAY provenance / ownership:** materialized members must have deterministic canonical provenance/ownership linking each member to the ARRAY operation and source occurrence, with deterministic member index/order metadata where supported by the existing model.
2. **Source deletion semantics:** define and enforce a deterministic source/member ownership policy so deleting a source cannot leave orphaned ARRAY-owned canonical entities. Prove the policy through direct tests, including undo/redo and no-phantom-member behavior.
3. **Typed unsupported behavior:** prove path-array unsupported behavior at the canonical semantic/App boundary where the existing error taxonomy supports such a typed outcome, or provide repository evidence that the existing prompt-level typed decline is intentionally the canonical boundary.

These are bounded CC008 requirements. No architecture change is authorized or implied.

## 3. Objective

Implement the bounded ARRAY capability owned by the authoritative CAD roadmap and retire `DEF-015` within these frozen boundaries: deterministic rectangular and polar array semantics; path-array behavior only where genuinely supported by the frozen contract; canonical materialization of members; deterministic stable identities and ordering; explicit ARRAY/member provenance and ownership; rendering and selectability; deterministic source/member deletion semantics; compatibility with existing edit/erase behavior; one atomic canonical revision; undo/redo; invalid and unsupported typed outcomes; deterministic serialization/byte identity; and Web/Electron semantic parity.

The detailed semantic contract is authoritative for array semantics and evidence fixture design:

`docs/work-items/COMPAT-CAD-008-SEMANTIC-CONTRACT.md`

## 4. Implementation input and base reconciliation

The existing preparation branch is implementation input only:

`work/compat-cad-008-array-preparation`

Reconcile only useful implementation/test work onto the **current `main` ref at implementation start**. Do not treat the old preparation base or commit `284bc28` as the current product revision.

Resolve the current `main` ref immediately before continuing implementation. Governance/doc commits are not product baselines.

## 5. Frozen architecture and ownership boundaries

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
- ARRAY provenance must use the existing canonical entity/data model; do not introduce a competing application-local authority.

Do not modify protected architecture artifacts. Any genuinely required architecture change must stop implementation and follow the existing ACR lifecycle.

## 6. Exact bounded scope

### Rectangular ARRAY

Implement and prove:

- row/column semantics;
- spacing semantics, including documented boundary values;
- deterministic row-major member ordering;
- deterministic member identity derivation;
- canonical member materialization;
- canonical ARRAY/source/member provenance and ownership;
- rendering and selection of materialized members;
- edit/erase interaction;
- source deletion policy and orphan prevention;
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
- canonical ARRAY/source/member provenance and ownership;
- rendering and selection;
- edit/erase interaction;
- source deletion policy and orphan prevention;
- invalid input behavior;
- full-circle and partial-span boundary behavior defined by the frozen contract;
- one atomic canonical revision.

### Path ARRAY

Implement path arrays **only where the existing frozen contract provides a genuine bounded supported behavior**. If a path variant is outside the supported contract, return an explicit typed unsupported outcome and preserve no-mutation guarantees. Do not fabricate path geometry merely to pass a test.

## 7. Source/member ownership policy

The remediation must make the ownership policy explicit in code and tests. At minimum establish:

- what canonical record identifies the ARRAY operation;
- how each member records its ARRAY provenance and source occurrence/index;
- deterministic member ordering and stable identity derivation;
- what happens when the source entity is erased;
- what happens when an individual member is erased or modified;
- how undo restores the exact pre-delete canonical state;
- how redo restores the exact post-delete canonical state;
- how selection/rendering avoid stale or orphaned members after these operations.

Use the existing canonical revision/history machinery. Do not add hidden state that is authoritative only in one host.

## 8. Required negative behavior

At minimum prove:

- zero/negative/invalid counts and spacing/angle values follow the frozen typed behavior;
- signed spacing errors fail typed before canonical mutation;
- rectangular 1×1 and polar count=1 follow the specified deterministic no-op semantics;
- degenerate and unsupported path inputs do not fabricate geometry;
- failed plans do not mutate canonical state and do not emit false success;
- no phantom or duplicate members are created;
- selection does not retain stale/ghost members after undo/redo;
- source deletion cannot leave orphaned ARRAY-owned members;
- source deletion undo/redo is exact and deterministic;
- individual member erase/modify follows the documented ownership policy;
- unsupported variants remain explicit and typed at the canonical boundary where supported.

## 9. Required deterministic evidence

Before returning the PR, produce reproducible evidence for:

- rectangular happy paths and boundaries;
- polar happy paths and boundaries;
- supported/unsupported path behavior;
- ARRAY operation provenance and member ownership;
- deterministic member index/order and stable identities;
- deterministic serialized/byte output;
- no-mutation-before-commit;
- one canonical revision per successful ARRAY mutation;
- exact UNDO and REDO restoration;
- source deletion, orphan prevention and undo/redo around source deletion;
- immediate post-commit selectability of materialized members;
- ERASE/modify interaction with members;
- Web/Electron semantic parity;
- COMPAT-CAD-005/006/007 regression coverage.

Evidence must record the exact implementation revision, invocation, output/result, environment details where material, and known limitations. Narrative-only evidence is insufficient.

## 10. Required browser gate after merge

The Architect will run the mandatory independent black-box browser gate against the exact deployed revision. The implementation must therefore leave deterministic workflows for at least:

- **G3** parking/repetition workflow;
- **G5** fixture/block-adjacent repetition behavior without implementing CC009 block semantics;
- **G6/G7** visibility/selectability interactions involving arrays;
- targeted **DEF-015** probes;
- invalid/negative ARRAY behavior;
- UNDO/REDO;
- source-deletion/orphan probes;
- no-phantom-member checks.

The browser agent must operate as a real user through the visible product UI and must not use hidden APIs to perform the workflow under test.

## 11. Regression contract

Do not regress verified behavior from:

- COMPAT-CAD-005;
- COMPAT-CAD-006;
- COMPAT-CAD-007.

In particular preserve canonical selection, prompt ownership, transform behavior, viewport behavior, canonical revision semantics and no-mutation guarantees.

## 12. Explicit non-goals

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

## 13. Return package and stop gate

Return at `PR_OPEN / VERIFYING` with:

- implementation PR and exact head SHA;
- changed-files summary and architecture-boundary statement;
- deterministic test commands and exact results;
- ARRAY provenance/ownership evidence;
- source-deletion/orphan/undo/redo evidence;
- Web/Electron parity evidence;
- regression results;
- negative/unsupported-path evidence;
- exact-head CI references;
- deployment identity prepared for the Architect’s post-merge gate;
- known limitations and deferred behavior;
- any architectural concern routed explicitly to ACR instead of silently changing the architecture.

Do not add `APPROVED`, `MERGED` or `VERIFIED` transitions. Do not claim the benchmark score has changed.

## 14. Security

Never commit, print or expose GitHub tokens, deployment credentials, database credentials, private keys or other secrets. Evidence and fixtures must remain credential-free.
