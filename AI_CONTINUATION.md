# ConstructionOS / Offisos — AI Continuation

This is the first stop for a new LLM Architect, reviewer, or implementation agent taking over without chat history.

## Current authoritative state

- Repository: `payswapdotorg/offisos`
- Architecture: ConstructionOS Architecture **v1.1 — FROZEN**
- Canonical system of record: **Construction Graph**
- Editor/working representation: **CADDocument**
- Native CAD/BIM engines: only behind the established **EngineAdapterBundle / worker** boundary
- Web/Electron: shared semantic contracts and application behavior
- Engine GlobalIds: provenance only, never canonical identity
- Unsupported capability: explicit typed failure, never fabricated semantics
- Governance lifecycle: `DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`
- Architect owns `ARCHITECT_REVIEW → APPROVED → VERIFIED`.
- Implementation agents stop at `PR_OPEN/VERIFYING`.

## Architect continuation rule

When the implementation worker returns a work item at `PR_OPEN/VERIFYING`, that return is the trigger for the Architect to execute the complete downstream governance loop defined in `docs/governance/architect-return-protocol.md`.

The Architect does not wait for `next`, `go`, `continue`, or equivalent chat input between routine governance gates. A successful returned work item is carried through independent review, approval, merge, exact-revision post-merge checks, deployment/browser validation, `VERIFIED`, roadmap update, and the next repository-backed work-item implementation prompt. A failed item is carried through the legal remediation path until the repository contains the exact changes-required directive and worker prompt.

The Architect stops only for an explicit changes-required/remediation handoff, Architecture Change Request, external hard blocker, or Product Owner decision outside existing authorization.

## CAD product roadmap authority

The authoritative AutoCAD-class product roadmap is:

`docs/cad/autocad-parity-roadmap.md`

The mandatory browser-agent phase gate protocol is:

`docs/cad/browser-agent-phase-gate.md`

These documents govern CAD parity sequencing, phase completion, benchmark score progression, successor selection and the required post-deployment black-box browser verification. Chat discussion is not authoritative.

## Current CAD state

- Latest verified CAD product revision carried forward from the predecessor track: `eb3406340df08d1ab39e771c40681d6248840d2e` (COMPAT-CAD-006).
- Benchmark baseline remains **18/100** from CAD-BENCH-RW-001; no score increase may be claimed without a benchmark rerun.
- Active work item: **COMPAT-CAD-007 — Core editing and deterministic object-selection workflows**.
- Canonical GitHub issue on this fork: **#1**.
- Governance record: `governance/work-items/COMPAT-CAD-007.json`.
- Current governance state: **ASSIGNED**.
- Implementation stop gate: **PR_OPEN/VERIFYING**.

## COMPAT-CAD-007 gate

This slice restores deterministic object-selection and core modify workflows over the verified shared geometry, precision and viewport foundations. Required evidence includes deterministic automated tests, negative no-mutation/false-success tests, Web/Electron semantic parity, COMPAT-CAD-005/006 regressions, exact-head CI, exact deployment, and independent browser-agent Golden G1/G2/G4/G10 plus targeted DEF-006/007/021 probes.

Non-goals include ARRAY materialization (COMPAT-CAD-008), durable SAVE/OPEN and serverless multi-instance persistence (COMPAT-CAD-011 / infrastructure), DXF (COMPAT-CAD-012), layout/sheet identity (COMPAT-CAD-013), unrelated BIM/documentation/interop work, architecture changes, and benchmark score changes without a rerun.

## CAD successor sequence

The repository roadmap defines:

`COMPAT-CAD-005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015 → 016 → 017 → 018 → 019 → 020 → 021 → CAD-CERT-001`

Do not release a successor merely because implementation or CI passes. The predecessor must be verified and the roadmap updated with revision-bound browser evidence.

## Mandatory browser validation rule

Every CAD work item must follow:

```text
IMPLEMENT
→ deterministic tests
→ CI
→ Architect review
→ MERGE
→ exact-head deployment
→ independent browser-agent black-box regression
→ evidence review
→ MERGED → VERIFIED
→ update roadmap
→ next repository-backed implementation prompt
```

The browser agent must operate through the visible application UI as a real user. It may inspect diagnostics as supporting evidence but must not use hidden APIs to perform the workflow under test.

## Fresh Architect takeover order

Read in this order before making a CAD decision:

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. `spec/architecture-lock.md`
4. `spec/development-workflow.md`
5. `docs/governance/architect-return-protocol.md`
6. `docs/cad/autocad-parity-roadmap.md`
7. `docs/cad/browser-agent-phase-gate.md`
8. `docs/cad/autocad-real-world-benchmark.md`
9. `docs/cad/autocad-benchmark-corpus.json`
10. active governance record under `governance/work-items/`
11. active GitHub issue/PR
12. exact-head CI, deployment and browser evidence

Reconcile any disagreement before authorizing work. The canonical work-item governance records and frozen architecture specifications remain authoritative for lifecycle and architecture rules.

## Broader ConstructionOS roadmap

CAD remains a product track inside Architecture v1.1 and must not create a separate canonical data authority. Project, Office, platform, Graph, collaboration, AI and intelligence tracks continue according to their own governed dependencies.

## Essential commands

```bash
npm install
npm run governance -- validate
npm run governance -- check-protected --base main
npm run governance -- check-verified-revisions
npm test
```

## Security

Never commit PATs, Vercel tokens, credentials, or environment secrets to the repository or documentation. Use environment-backed credentials only.
