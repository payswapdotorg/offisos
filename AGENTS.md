# Agent Operating Rules — Offisos / ConstructionOS

This repository is designed to be executable by an LLM Architect plus one or more implementation agents without relying on chat history.

## Authority hierarchy

1. `spec/architecture-lock.md` and other architecture-controlled artifacts.
2. `spec/development-workflow.md` and `governance/workflow-states.json`.
3. The relevant roadmap/work-item definition and its governance record.
4. For CAD parity sequencing specifically: `docs/cad/autocad-parity-roadmap.md` and `docs/cad/browser-agent-phase-gate.md`.
5. Existing VERIFIED milestones and their revision-bound evidence.
6. Implementation code and tests.
7. PR descriptions/comments are supporting evidence, not canonical architecture authority.

When two sources conflict, stop and reconcile against the higher authority rather than guessing.

## Roles

### Architect

The Architect is the independent technical reviewer and owns:

- release authorization (`DRAFT → READY` and `READY → ASSIGNED` when acting as release Architect);
- `VERIFYING → ARCHITECT_REVIEW`;
- `ARCHITECT_REVIEW → APPROVED`;
- `MERGED → VERIFIED`.

The Architect must never mark VERIFIED from implementation status alone.

For CAD roadmap work, the Architect must also verify the exact deployed revision through the mandatory browser-agent black-box gate before `VERIFIED`.

### Implementation agent

The implementation agent:

- starts implementation only after a legal `READY → ASSIGNED → IMPLEMENTING` path;
- implements only the frozen scope;
- records evidence and opens the PR;
- stops at `PR_OPEN/VERIFYING`;
- must not self-approve or self-verify.

## Hard architecture rules

- Construction Graph is canonical system of record.
- CADDocument is the editor/working representation.
- Native geometry/BIM technologies stay behind EngineAdapterBundle/worker boundaries.
- Renderer/application code must not import geometry-engine internals.
- Engine GlobalIds are provenance, not canonical identity.
- Canonical identities are document/domain-owned and deterministic.
- Unsupported operations return typed explicit failures; never fabricate geometry, semantics, or confidence.
- Web and Electron must use the same semantic contracts and application behavior.
- Deterministic persisted semantic results are required where the work item calls for them.
- Architecture v1.1 is frozen. Protected-path modifications require the ACR lifecycle.

## Governance rules

Use the repository validator, not intuition:

```bash
npm run governance -- validate
npm run governance -- check-protected --base main
npm run governance -- check-verified-revisions
npm test
```

A new real work-item record must be born in the legal initial state (`DRAFT`) and traverse the lifecycle through legal transitions. Do not create an already-ASSIGNED/APPROVED/VERIFIED real record to bypass gates.

`VERIFIED` evidence must be one of the accepted reproducible evidence types and revision-bound to the implementation under verification. Screenshot/narrative/demo evidence alone can never justify VERIFIED.

## CAD roadmap operating rule

The authoritative AutoCAD-class roadmap is `docs/cad/autocad-parity-roadmap.md`.

Every CAD work item must pass `docs/cad/browser-agent-phase-gate.md` after merge and exact-head deployment. The Architect updates the roadmap with the measured score, retired/new defects, exact evidence and next authorized work item before releasing a successor.

Do not use stale historical P019/P020 sequencing or old COMPAT-CAD-001 evidence as current CAD product authority. Current black-box behavior and the authoritative CAD roadmap control sequencing after the verified P020 baseline.

## Implementation stop gate

When a work item reaches `PR_OPEN/VERIFYING`, stop implementation-side lifecycle advancement. Never add `APPROVED`, `MERGED`, or `VERIFIED` merely to make the record appear complete.

## Handoff discipline

Every meaningful milestone must leave enough repository evidence for a fresh Architect to answer:

- What is the current main commit?
- What work item is active?
- What scope is frozen?
- What has been implemented?
- Which evidence was produced and on exactly which revision?
- Which findings were raised?
- Which findings were resolved?
- Which lifecycle gates remain?
- What exact commands reproduce the evidence?
- What must not be changed without an ACR?

The canonical answer belongs in repository files, governance records, tests/fixtures, and revision-bound evidence—not in chat history.

## Security

Never place GitHub PATs, Vercel tokens, deployment credentials, database secrets, or other credentials in tracked files, PR bodies, comments, fixtures, or logs.
