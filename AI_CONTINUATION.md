# ConstructionOS / Offisos — AI Continuation

This is the first stop for a new LLM Architect, reviewer, or implementation agent taking over without chat history. Chat history is non-authoritative.

## Current authoritative state

- Repository: `payswapdotorg/offisos`
- **Current main revision must always be resolved from `refs/heads/main` immediately before acting.** This file cannot safely self-embed its own final commit SHA because updating it advances `main` again.
- Last canonical state update before this continuation write: `9f302ca7d5a2ddf825ad493fe90958d1baf3ac4e` (CC008 governance record returned to IMPLEMENTING after Architect review).
- Architecture: ConstructionOS Architecture **v1.1 — FROZEN**
- Canonical system of record: **Construction Graph**
- Editor/working representation: **CADDocument**
- Native CAD/BIM engines: only behind the established **EngineAdapterBundle / worker** boundary
- Web/Electron: shared semantic contracts and application behavior
- Engine GlobalIds: provenance only, never canonical identity
- Unsupported capability: explicit typed failure, never fabricated semantics
- Governance lifecycle: `DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`
- Failure loop: `VERIFYING → ARCHITECT_REVIEW → IMPLEMENTING` or `VERIFYING → IMPLEMENTATION_BLOCKED` as authorized by the state machine.
- Architect owns `VERIFYING → ARCHITECT_REVIEW`, `ARCHITECT_REVIEW → APPROVED`, `ARCHITECT_REVIEW → IMPLEMENTING`, and `MERGED → VERIFIED`.
- Implementation agents stop at `PR_OPEN / VERIFYING` and may not self-approve, merge or verify.

## Authority hierarchy

1. `spec/architecture-lock.md` and architecture-controlled specifications.
2. `spec/development-workflow.md` and `governance/workflow-states.json`.
3. `governance/work-items/*.json` and other canonical governance records.
4. `docs/cad/autocad-parity-roadmap.md` for CAD sequencing and successor selection.
5. `docs/cad/browser-agent-phase-gate.md` for CAD verification.
6. Revision-bound evidence and verified milestones.
7. Tests, fixtures, implementation code and CI configuration.
8. GitHub issues, PRs, comments and worker reports as supporting evidence.
9. This file, `AGENTS.md`, prompts and other handoff summaries must reflect the authorities above and never override them.

## Current CAD execution

- Latest verified CAD product revision: `9232c90e4340475bcf5c6818a30d9748ea04330a`
- Verified work item: **COMPAT-CAD-007** — GitHub Issue **#1** — governance state **VERIFIED**.
- Permanent benchmark baseline: **18/100** from `CAD-BENCH-RW-001`. No score increase is authoritative without a full benchmark rerun.
- Current active work item: **COMPAT-CAD-008** — Arrays/materialization/render/selectability.
- Current GitHub issue: **#5** (open).
- Current governance state: **IMPLEMENTING — ARCHITECT CHANGES REQUESTED**.
- Implementation agent: `z-ai-implementation-agent` (governance identity; not a GitHub account/assignee).
- Current implementation PR: **#11**, open and not approved/merged/verified.
- Governance record: `governance/work-items/COMPAT-CAD-008.json`.
- Implementation prompt: `docs/work-items/COMPAT-CAD-008-ZAI-PROMPT.md`.
- Implementation stop gate: **PR_OPEN / VERIFYING**.
- Predecessor dependency: `COMPAT-CAD-007` VERIFIED at `9232c90e4340475bcf5c6818a30d9748ea04330a`.
- Next work item after CC008: **COMPAT-CAD-009**, planned by the authoritative CAD roadmap. It must not be released until CC008 is independently verified.

## CC008 review disposition

PR #11 reached `VERIFYING` with deterministic implementation and governance evidence. The Architect independently reviewed the implementation and issued **DEC-001 / changes_requested**, then legally returned the work item:

`VERIFYING → ARCHITECT_REVIEW → IMPLEMENTING`

The reviewed implementation head was `ae0d85b1bc152ea5690d01afedb449c1816d2ffa`.

The rejection does **not** waive or weaken the existing acceptance contract. It identifies three bounded remediation gaps:

1. Materialized ARRAY members do not establish/prove deterministic canonical ARRAY provenance and ownership linking members to the ARRAY operation and source occurrence/index.
2. Source deletion ownership semantics are not implemented/proven well enough to establish that source deletion cannot leave orphaned ARRAY-owned canonical entities, including exact undo/redo behavior.
3. Path-array unsupported behavior is only proven at the prompt-plan layer; direct typed semantic/App-boundary evidence is required where the existing error taxonomy supports it, or the canonical boundary must be explicitly documented and proven.

Required remediation remains strictly within CC008. No CC009+ scope expansion and no Architecture v1.1 change are authorized. PR #11 remains open so the worker can remediate and return through `PR_OPEN / VERIFYING`.

## CC008 evidence already established

- EV-001: deterministic app suite at implementation head `ae0d85b1...`: 1484 tests, 1428 pass, 0 fail, 56 OCCT/IFC-gated skips, including 14 CC008 fixtures and no-forbidden-imports.
- EV-002: governance validation at the implementation head/base combination: 588/588 validation, 200/200 governance tests, protected-path check, verified-revision audit, root typecheck and app typecheck.
- EV-003: independent Architect review identifying the acceptance gaps above.

These are revision-bound evidence for the rejected attempt. They do not justify `VERIFIED`.

## Mandatory browser gate

The Architect has **not** started the post-merge browser gate for CC008 because the implementation has not been approved or merged. After a successful remediation reaches `VERIFYING`, the Architect must independently review again; only after approval and merge should the exact deployed revision receive the mandatory black-box browser gate covering G3, G5, G6, G7, targeted DEF-015 probes, invalid/unsupported ARRAY behavior, undo/redo, source-deletion/orphan checks and no-phantom-member checks.

## Governance repair already completed

The earlier CC008 schema defect on `6007d0df36d75852a9334312a824928452e6b5c8` was a governance-only defect: the DRAFT→READY transition carried an illegal `dependency` reference. That was repaired without changing product scope. Fresh governance CI subsequently passed before CC008 implementation began.

## Benchmark assets

The authoritative roadmap cites `CAD-BENCH-RW-001` and the permanent baseline of 18/100. The requested historical filenames `docs/cad/autocad-real-world-benchmark.md` and `docs/cad/autocad-benchmark-corpus.json` are not present at those exact paths on the current main tree; do not invent or substitute them.

## Required reproduction commands

```bash
npm install
npm run governance -- validate
npm run governance -- check-protected --base main
npm run governance -- check-verified-revisions
npm test
```

For the implementation attempt, the worker evidence commands are recorded in EV-001/EV-002 in the CC008 governance record. On the next returned PR, re-run the exact commands against the new implementation head and bind fresh evidence.

## Fresh-Architect takeover order

Read in this order before making a CAD decision:

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. `spec/architecture-lock.md`
4. `spec/development-workflow.md`
5. `governance/workflow-states.json`
6. `docs/governance/architect-return-protocol.md`
7. `docs/cad/autocad-parity-roadmap.md`
8. `docs/cad/browser-agent-phase-gate.md`
9. `governance/work-items/COMPAT-CAD-008.json`
10. `docs/work-items/COMPAT-CAD-008-ZAI-PROMPT.md`
11. current GitHub Issue #5 / PR #11 or its successor remediation PR
12. exact revision-bound CI, deployment and browser evidence.

Reconcile any disagreement against the authority hierarchy before making a lifecycle decision.

## Broader roadmap

The CAD sequence is:

`CAD-BENCH-RW-001 → COMPAT-CAD-005 → COMPAT-CAD-006 → COMPAT-CAD-007 → COMPAT-CAD-008 → COMPAT-CAD-009 → COMPAT-CAD-010 → COMPAT-CAD-011 → COMPAT-CAD-012 → COMPAT-CAD-013 → COMPAT-CAD-014 → COMPAT-CAD-015 → COMPAT-CAD-016 → COMPAT-CAD-017 → COMPAT-CAD-018 → COMPAT-CAD-019 → COMPAT-CAD-020 → COMPAT-CAD-021 → CAD-CERT-001`

The roadmap is authoritative for sequencing and successor selection.

## ACR boundary

Architecture v1.1 is frozen. Never change protected architecture, workflow-state rules, canonical authority, engine boundaries or other architecture-controlled artifacts inside an implementation work item. Route required architecture changes through the existing Architecture Change Request lifecycle.

## Security

Never place GitHub PATs, Vercel tokens, deployment credentials, database secrets, private keys or other credentials in tracked files, PRs, issue comments, fixtures or logs. Evidence must prove behavior without leaking secrets.
