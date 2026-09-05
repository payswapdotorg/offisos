# COMPAT-CAD-008 — Z-AI implementation directive

## Authority

Work item: `COMPAT-CAD-008`  
GitHub issue: `#5`  
Architecture: ConstructionOS Architecture v1.1 — **FROZEN**  
Dependency: `COMPAT-CAD-007`  
State at publication: **DRAFT / PREPARATION ONLY**

### Critical governance constraint

`COMPAT-CAD-007` is merged but its required post-merge verification is currently externally blocked by GitHub Actions. Therefore CC008 is **not READY and not ASSIGNED**, and this document does not authorize a PR, approval, merge, or verification claim.

The implementation agent may use this directive for architecture/test/spec preparation only. Do not mutate the CC008 governance lifecycle, do not open a CC008 PR, and do not claim successor authorization until the Architect records the legal dependency transition.

## Objective

Prepare the next bounded CAD parity slice for **DEF-015**: ARRAY creation with deterministic materialization, rendering and selectability, canonical identities, undo/redo, and Web/Electron semantic parity.

## Frozen boundaries

- Construction Graph remains the canonical system of record.
- CADDocument remains editor/working representation.
- Architecture v1.1 remains frozen.
- Shared engine-free command semantics first.
- Native engines remain behind existing EngineAdapterBundle/worker boundaries.
- No direct renderer/app/domain imports of native engines.
- Interactive previews and transient selection are presentation state until canonical commit.
- Every mutating command produces exactly one canonical revision under existing history semantics.
- Unsupported or invalid behavior must be typed and explicit; never fabricate geometry or success.

## CC008 scope to prepare

1. Define the exact supported ARRAY vocabulary and command state machine before implementation.
2. Define rectangular-array semantics: rows, columns, spacing, deterministic member order and identity derivation.
3. Define polar-array semantics: center, count, angular spacing, deterministic orientation/order and identity derivation.
4. Define path-array scope only if the existing benchmark requirement can be met without widening the frozen slice; otherwise record a typed unsupported boundary for a later work item.
5. Materialize members as canonical entities rather than presentation-only clones.
6. Ensure all materialized members participate in the canonical flat partition, rendering, selection and existing edit/erase semantics.
7. Define source/member identity and ownership semantics explicitly, including delete/undo behavior and no hidden duplicates.
8. Preserve exact deterministic serialized output and byte identity across repeated runs.
9. Reuse CC007 selection and prompt semantics rather than introducing a second selection/prompt system.
10. Prove Web/Electron parity over the same semantic command path.

## Required deterministic test design

Prepare tests for:

- rectangular array happy paths and boundary values;
- polar array happy paths and boundary values;
- deterministic ordering and stable IDs;
- zero/negative/invalid counts and spacing/angle inputs;
- degenerate geometry and unsupported path cases;
- no canonical mutation before commit;
- one revision per successful mutating ARRAY command;
- exact UNDO restore and redo behavior;
- selection of materialized members immediately after commit;
- ERASE/modify interaction with members;
- repeated execution byte identity;
- Web/Electron equivalent serialized state;
- CC005/006/007 regression coverage, especially prompt ownership, canonical selection and transform behavior.

## Browser gate design

The eventual required independent black-box browser evidence must cover at least:

- G3 parking/repetition workflow;
- G5 fixture/block-adjacent repetition behavior without implementing CC009 block semantics;
- G6/G7 visibility/selectability interactions where arrays are part of the workflow;
- targeted DEF-015 probes;
- negative/invalid ARRAY flow;
- undo/redo and no-phantom-member checks.

No benchmark score change may be claimed from these tests alone.

## Deliverable from preparatory work

Produce implementation-ready notes/tests/spec changes on the worker branch only after the Architect legally advances CC008 beyond DRAFT. Until then, keep this directive as the authoritative preparation boundary and do not open a PR.
