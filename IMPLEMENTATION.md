# Implementation Protocol — Offisos

## Before implementation

Read, in order:

1. `AI_CONTINUATION.md`
2. `AGENTS.md`
3. `spec/architecture-lock.md`
4. `spec/development-workflow.md`
5. `spec/roadmap-v1.1.md`
6. `spec/requirements.md`
7. the relevant GitHub Issue and governance work-item record
8. the latest VERIFIED predecessor record and its evidence

Confirm the dependency is `VERIFIED` before entering implementation.

## Working method

Use the established shared-core-first pattern:

`contracts → pure semantics → canonical domain/document authority → App API → deterministic tests → Web host → Electron host/parity → interoperability → reproducible smoke/fixture → CI → deployment/browser evidence`

Keep engine-specific mechanisms behind the existing adapter/worker boundary. Prefer composition over existing verified builders rather than parallel semantics.

## Determinism

A reproducible operation must be a pure function of declared canonical inputs and declared environment/profile. Avoid wall-clock time, random values, unstable iteration order, environment leakage, or hidden external authority in semantic results.

Persist only canonical state. Derived views, diagnostics, reports, traces, and other recomputable results must remain derived unless the relevant work item explicitly requires otherwise.

Use document-owned deterministic identifiers where required. Failed validation should not burn canonical identifiers.

## Testing and evidence

Every work item defines its own evidence requirements. At minimum for CAD/BIM slices:

- deterministic unit/domain tests;
- exact replay/undo/redo tests where mutation exists;
- save/open round-trip where persistence exists;
- byte-identical pinned fixture;
- Web/Electron semantic parity when both hosts expose the surface;
- forbidden-import/boundary checks;
- full regression matrix;
- real browser evidence for new Web UI;
- real Electron evidence when a new Electron surface exists;
- exact-head deployment evidence where required;
- governance evidence bound to exact revisions.

Typed unsupported outcomes are evidence. Silent approximation is not.

## PR lifecycle

Implementation agent lifecycle:

`ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING`

At `PR_OPEN/VERIFYING`, stop. Do not add Architect approval or VERIFIED transitions from the implementation side.

## Architect review

The Architect independently reviews the exact implementation head and evidence. A review finding must be recorded and either resolved with new revision-bound evidence or left explicitly open. A green CI result does not erase a semantic acceptance gap.

## Merge / verification

Merge is a separate act from verification. After merge:

1. record `APPROVED → MERGED` with the exact merge commit;
2. poll post-merge workflows to terminal;
3. verify merged-tree regression safety;
4. only then perform `MERGED → VERIFIED` with an approved Architect decision and qualifying evidence.

Never equate a successful merge with VERIFIED.

## P018 concrete state

At the time this file was added:

- P017: VERIFIED
- P018 / Issue #118 / PR #120: **MERGED, pending post-merge Architect verification**
- merge commit: `3edd5506d972dc309b22c21baad7643f021f27d4`
- final corrective pre-merge implementation head reviewed by Architect: `714a34e5712abf8b4a1dd015b806958ff9568ec2`
- P018 review blocker from review `5096872026` was resolved before merge by dedicated IFC/BCF/IDS specialized-toolset coverage.

The next Architect must reconcile the governance record and complete the final post-merge verification gate. See `AI_CONTINUATION.md` for the exact checklist.
