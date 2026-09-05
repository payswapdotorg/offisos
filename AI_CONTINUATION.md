# ConstructionOS / Offisos — AI Continuation

This is the first stop for a new LLM Architect, reviewer, or implementation agent taking over without chat history. Chat history is non-authoritative.

## Current authoritative state

- Repository: `payswapdotorg/offisos`
- **Current main revision must always be resolved from `refs/heads/main` immediately before acting.** A handoff document cannot safely self-embed its own commit SHA because updating that document advances `main` again.
- Last fully validated governance-tree baseline before this final continuation write: `cd0cce7bc847319418b1cc17de50a26fd86de1ab`.
- Architecture: ConstructionOS Architecture **v1.1 — FROZEN**
- Canonical system of record: **Construction Graph**
- Editor/working representation: **CADDocument**
- Native CAD/BIM engines: only behind the established **EngineAdapterBundle / worker** boundary
- Web/Electron: shared semantic contracts and application behavior
- Engine GlobalIds: provenance only, never canonical identity
- Unsupported capability: explicit typed failure, never fabricated semantics
- Governance lifecycle: `DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`
- Architect owns `VERIFYING → ARCHITECT_REVIEW`, `ARCHITECT_REVIEW → APPROVED`, and `MERGED → VERIFIED`.
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
- CC007 governance evidence is bound to the physical merge and includes deterministic tests, real-host smoke, CI, deployment and independent browser evidence; its final governance evidence is recorded in `governance/work-items/COMPAT-CAD-007.json`.
- Permanent benchmark baseline: **18/100** from `CAD-BENCH-RW-001`. No score increase is authoritative without a full benchmark rerun.
- Current active work item: **COMPAT-CAD-008** — Arrays/materialization/render/selectability.
- Current GitHub issue: **#5** (open).
- Current governance state: **ASSIGNED — IMPLEMENTATION AUTHORIZED**.
- Implementation agent: `z-ai-implementation-agent` (governance identity; this value is not a GitHub account/assignee).
- Governance record: `governance/work-items/COMPAT-CAD-008.json`.
- Implementation prompt: `docs/work-items/COMPAT-CAD-008-ZAI-PROMPT.md`.
- Implementation stop gate: **PR_OPEN / VERIFYING**.
- Predecessor dependency: `COMPAT-CAD-007` VERIFIED at `9232c90e4340475bcf5c6818a30d9748ea04330a`.
- Next work item after CC008: **COMPAT-CAD-009**, planned by the authoritative CAD roadmap. It must not be released until CC008 is independently verified.

## CC008 scope

CC008 owns **DEF-015** and only the bounded ARRAY/materialization slice. Required behavior includes deterministic rectangular and polar ARRAY semantics; path behavior only where genuinely supported by the frozen contract, otherwise explicit typed unsupported failure; canonical materialized members; deterministic stable identities and ordering; source/member ownership semantics; rendering and selectability; edit/erase interaction; one atomic canonical revision; undo/redo; invalid/unsupported behavior; deterministic serialization/byte identity; Web/Electron parity; and regression preservation for CC005/006/007.

Explicit non-goals are CC009 blocks/inserts/attributes/symbols; CC010 hatch/annotation/dimension expansion; CC011 durable SAVE/OPEN and multi-instance persistence; CC012 DXF; CC013 layouts/sheets; unrelated command/history expansion; architecture changes without ACR; and benchmark score changes without a full rerun.

The detailed semantic contract is `docs/work-items/COMPAT-CAD-008-SEMANTIC-CONTRACT.md`.

## Current lifecycle instruction

The CC008 preparation-only restriction is **retired**. The active directive authorizes `z-ai-implementation-agent` to reconcile the preparation branch `work/compat-cad-008-array-preparation` onto current `main`, then implement the frozen CC008 scope.

The implementation agent owns the next lifecycle transition `ASSIGNED → IMPLEMENTING`, followed by `IMPLEMENTING → PR_OPEN → VERIFYING`. The Architect must never fabricate `IMPLEMENTING`, `PR_OPEN`, or `VERIFYING` on behalf of the worker.

When the worker returns at `PR_OPEN / VERIFYING`, the Architect must autonomously execute the full return protocol in `docs/governance/architect-return-protocol.md`: reconcile exact head; validate deterministic evidence and CI; conduct independent requirements/architecture/engineering/evidence review; approve if warranted; merge; wait for terminal post-merge workflows; reconcile the merged tree; deploy the exact revision; execute the mandatory independent browser gate; compare regressions and predecessor baseline; then mark `VERIFIED` only with revision-bound proof; update the authoritative roadmap; and release the next legal work item and prompt.

On failure, record the exact finding and reproduction, return legally to `IMPLEMENTING`, write the repository-backed remediation prompt, and stop.

## Mandatory CAD browser gate

Every CAD work item must pass `docs/cad/browser-agent-phase-gate.md` after merge against the exact deployed revision. For CC008, required workflows include G3, G5, G6, G7, targeted DEF-015 probes, invalid/unsupported ARRAY paths, undo/redo, no-phantom-member checks, and appropriate no-regression sweeps. The browser agent must use visible UI as a real user and must not use hidden APIs to perform the workflow under test.

## Governance state and known repair

The previous CC008 governance record had an illegal extra property in the first `DRAFT → READY` transition's `references` object. The state-machine contract permits the `issue` reference for that transition; the prior record incorrectly carried additional `dependency` and `merge_commit` reference properties. This was a governance metadata defect, not a product defect. It was repaired by removing the unsupported reference keys while preserving the dependency and merge facts in canonical work-item text and the verified predecessor record.

The repair was committed at `f1d82dbfcd14e5e9a6386fe6a0863dd030720eaa`, followed by the active prompt and continuation reconciliation commits. Fresh governance CI then passed on the repaired tree: deterministic governance suite, canonical state-machine/work-item validation, and the verified-revision drift audit all succeeded.

The earlier governance workflow on `6007d0df36d75852a9334312a824928452e6b5c8` failed because `COMPAT-CAD-008` violated its schema. That failure was correctly treated as a governance defect and not as product evidence.

## Benchmark assets

The authoritative roadmap cites `CAD-BENCH-RW-001` and the permanent baseline of 18/100. The requested historical filenames `docs/cad/autocad-real-world-benchmark.md` and `docs/cad/autocad-benchmark-corpus.json` are **not present at those exact paths on the current main tree**; do not invent or substitute them. Use the authoritative roadmap and actual repository benchmark assets when discovered.

## Required reproduction commands

```bash
npm install
npm run governance -- validate
npm run governance -- check-protected --base main
npm run governance -- check-verified-revisions
npm test
```

The current main governance workflow runs typecheck, deterministic governance tests, canonical state validation, and verified-revision auditing. Its protected-path step is PR-scoped and therefore may be skipped on direct main pushes; protected-path compliance for an implementation PR must be checked on that PR before approval.

For CC008 implementation evidence, the active worker prompt defines the required deterministic, Web/Electron parity and regression commands. The Architect must additionally run the exact-head CI, deployment and browser-agent gate after merge.

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
11. current GitHub Issue #5 / any implementation PR
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
