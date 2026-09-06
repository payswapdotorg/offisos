# ConstructionOS / Offisos — AI Continuation

This is the first stop for a new LLM Architect, reviewer, or implementation agent taking over without chat history. Chat history is non-authoritative.

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

## Autonomous governance operating rule

The Architect is the execution authority for routine governance and must run the complete legal return-to-successor loop without waiting for `next`, `go`, `continue`, or equivalent user messages.

A normal successful work item is one coherent autonomous cycle:

`worker return → reconciliation → evidence/review → approval → merge → exact post-merge verification → roadmap update → legal successor creation/release`.

Before writing successor state, the Architect determines the canonical next work item and dependency state, creates/reconciles the GitHub issue so its number is fixed, creates/reconciles the governance record from legal `DRAFT`, creates/reconciles the worker prompt, updates this continuation file and the authoritative roadmap, then runs the required governance validation after the state settles. Existing artifacts are reconciled rather than duplicate-created; temporary tracked staging files are not used merely to test write paths.

The Architect stops only for a recorded changes-required/remediation decision, an ACR/architecture change, an external hard blocker, or a Product Owner decision outside existing authorization. This rule is defined in `AGENTS.md` and `docs/governance/architect-return-protocol.md`.

## Current CAD execution

- Latest fully **VERIFIED** CAD product revision: `3854f5391fe58475b50bec9b33e695c33dabc467`
- Verified work item: **COMPAT-CAD-008** — Issue **#5** — VERIFIED.
- Current physical CC009 product merge: `066be5fc098443e21263ed57d21788849a875195` — PR **#14**.
- CC009 product verification evidence is complete: exact post-merge CI run `34032178301` is terminal-successful and exact-SHA browser gate `34032178294` is terminal-successful with artifact `9989550776`.
- CC009 governance closure is blocked by a validator defect, not by product evidence: `collectReconcilableViolations()` does not emit the stable `decisions/entry:<STATE>/no-prior-approved-decision` waiver key when the last prior decision exists but is non-approved, even though the decision validator correctly rejects that state.
- Historical CC009 ledger facts are preserved unchanged. `ACR-006` and `REC-COMPAT-CAD-009` explicitly reconcile only the historical temporal-ordering/decision-order defect; no evidence or revision-binding requirement is waived.
- **GOV-001** — Issue **#16** — is the current legally assigned governance remediation. Its governance record is `governance/work-items/GOV-001.json`; its implementation prompt is `docs/work-items/GOV-001-ZAI-PROMPT.md`.
- GOV-001 state: **ASSIGNED**. The implementation agent must own the correction and return at `PR_OPEN / VERIFYING`; the Architect must then run the full downstream review/merge/verification loop.
- **COMPAT-CAD-010 remains planned and is NOT legally released** until CC009 governance validation is clean.
- Permanent benchmark baseline: **18/100**. No score increase is authoritative without a full benchmark rerun.

## CC008 verification evidence

- Product merge: `3854f5391fe58475b50bec9b33e695c33dabc467`.
- Exact post-merge CI: `cad-parity-018` run `34009858133` — terminal success across workspace, Electron and Web.
- Exact-target independent browser gate: run `34017125800`, artifact `9984273561` — terminal success; production build checked out exact product merge and all recorded browser checks passed.
- Post-merge governance validation: run `34017125782`, artifact `9984247961` — terminal success; governance validation 588/588, deterministic governance suite 200/200, and verified-revision drift audit passed.
- CC008 governance record is **VERIFIED** and Issue #5 is closed as completed.

## Current CC009 state

CC009 implements blocks, inserts, attributes and symbols under frozen Architecture v1.1. The Architect approved the remediated implementation at exact PR head `463344ba095bd700fb96f46f4164f333977a85cc`; the approved implementation was then physically merged as `066be5fc098443e21263ed57d21788849a875195`.

Post-merge product evidence is green. The remaining gate is the repository governance validator because of the historical merge/approval recording-order defect and the validator's incomplete reconciliation-key handling for a prior non-approved decision. Historical facts are not rewritten.

## GOV-001 worker contract

GOV-001 repairs only `tools/governance/src/rules.ts` reconciliation-key generation. The worker must preserve the exact stable waiver key, keep the decision validator strict, add deterministic tests for zero-prior/prior-non-approved/prior-approved/reconciled cases, and avoid changing lifecycle roles, evidence rules, Architecture v1.1, or product behavior. The worker stops after PR_OPEN/VERIFYING.

## Broader roadmap

`CAD-BENCH-RW-001 → COMPAT-CAD-005 → COMPAT-CAD-006 → COMPAT-CAD-007 → COMPAT-CAD-008 → COMPAT-CAD-009 → COMPAT-CAD-010 → COMPAT-CAD-011 → COMPAT-CAD-012 → COMPAT-CAD-013 → COMPAT-CAD-014 → COMPAT-CAD-015 → COMPAT-CAD-016 → COMPAT-CAD-017 → COMPAT-CAD-018 → COMPAT-CAD-019 → COMPAT-CAD-020 → COMPAT-CAD-021 → CAD-CERT-001`

Successor selection is governed by `docs/cad/autocad-parity-roadmap.md` and the governance records, not chat agreement.

## Architect role boundary

The Architect is responsible only for governance, architecture/specification review, evidence/acceptance review, lifecycle decisions, work-order assignment, merge authorization, verification and roadmap progression. **All implementation changes — including application code, tests, fixtures, CI workflows, browser-agent harnesses and implementation tooling — belong to `z-ai-implementation-agent` and must arrive as worker-owned work for Architect review.**

Architecture v1.1 remains frozen. No implementation work may bypass the ACR boundary.
