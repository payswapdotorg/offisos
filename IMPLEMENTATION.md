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
9. for CAD work, `docs/cad/autocad-parity-roadmap.md` and `docs/cad/browser-agent-phase-gate.md`
10. `docs/governance/architect-return-protocol.md`

Confirm the dependency is `VERIFIED` before entering implementation, unless the governing work item explicitly authorizes a different legal state.

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

At `PR_OPEN/VERIFYING`, stop implementation-side lifecycle advancement. Do not add Architect approval or VERIFIED transitions from the implementation side.

The worker's return of the PR is the handoff trigger for the Architect; no additional `next/go/continue` instruction is expected.

## Architect review and automatic continuation

The Architect independently reviews the exact implementation head and evidence. A review finding must be recorded and either resolved with new revision-bound evidence or left explicitly open.

When the worker returns at `PR_OPEN/VERIFYING`, the Architect must follow `docs/governance/architect-return-protocol.md` and continue through all legal downstream governance steps without an intermediate user prompt.

A successful item proceeds through approval, merge, post-merge verification, exact-head deployment/browser validation, `MERGED → VERIFIED`, governance closure, roadmap update and successor work-item/prompt release in the same execution cycle. A failed item proceeds to a repository-backed remediation directive and prompt, then stops for worker action.

## Merge / verification

Merge is a separate act from verification. The Architect must not equate a successful merge with `VERIFIED`.

After approval and merge, the Architect:

1. binds the exact merge commit;
2. polls required post-merge workflows to terminal and classifies failures/cancellations/queue blocks;
3. verifies the merged tree against the reviewed implementation;
4. performs the required exact-revision deployment;
5. executes the required black-box/browser verification;
6. reconciles the evidence and score/regression result;
7. records the qualifying Architect decision and `MERGED → VERIFIED` only when the verification gate passes;
8. updates the authoritative roadmap and releases the successor through the repository.

## Stop conditions

The Architect must not stop merely because one governance gate completed. It stops only when the autonomous loop reaches a defined terminal condition:

- changes requested and remediation prompt persisted;
- Architecture Change Request required and routed;
- external hard blocker recorded with exact unblock condition;
- Product Owner decision required outside existing authorization; or
- successful verification followed by a fully persisted successor handoff.

## P018 historical note

Historical P018 details may remain in older handoff records for traceability. They do not override the current `AI_CONTINUATION.md`, authoritative roadmap, or active governance record.
