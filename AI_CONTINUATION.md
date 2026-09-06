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
- Current physical product merge under verification: **COMPAT-CAD-009** — PR **#14** — merge `066be5fc098443e21263ed57d21788849a875195`.
- CC009 governance record is legally **MERGED** and must not be advanced to VERIFIED until the exact merge reaches terminal post-merge CI plus the independent exact-SHA browser gate.
- Current governance bookkeeping commit: `28c3acabd3f47d6a9e233e8dc6f3348c97caabd6`.
- Permanent benchmark baseline: **18/100**. No score increase is authoritative without a full benchmark rerun.

## CC008 verification evidence

- Product merge: `3854f5391fe58475b50bec9b33e695c33dabc467`.
- Exact post-merge CI: `cad-parity-018` run `34009858133` — terminal success across workspace, Electron and Web.
- Exact-target independent browser gate: run `34017125800`, artifact `9984273561` — terminal success; production build checked out exact product merge and all recorded browser checks passed.
- Post-merge governance validation: run `34017125782`, artifact `9984247961` — terminal success; governance validation 588/588, deterministic governance suite 200/200, and verified-revision drift audit passed.
- CC008 governance record is **VERIFIED** and Issue #5 is closed as completed.

## Current CC009 state

CC009 implements blocks, inserts, attributes and symbols under frozen Architecture v1.1. The Architect approved the remediated implementation at exact PR head `463344ba095bd700fb96f46f4164f333977a85cc`; the approved implementation was then physically merged as `066be5fc098443e21263ed57d21788849a875195`.

Pre-merge exact-head evidence was terminal-successful, including the independent G5/G7/G8 browser gate at run `34028079173` with artifact `9987844059`. The required physical post-merge verification is still executing on the merge SHA. Browser run `34032178294` and the merge-triggered CI are currently queued/in progress; therefore CC009 remains **MERGED**, not VERIFIED.

No CC010 successor is legally released while CC009 is in this state. The benchmark remains **18/100**.

## Broader roadmap

`CAD-BENCH-RW-001 → COMPAT-CAD-005 → COMPAT-CAD-006 → COMPAT-CAD-007 → COMPAT-CAD-008 → COMPAT-CAD-009 → COMPAT-CAD-010 → COMPAT-CAD-011 → COMPAT-CAD-012 → COMPAT-CAD-013 → COMPAT-CAD-014 → COMPAT-CAD-015 → COMPAT-CAD-016 → COMPAT-CAD-017 → COMPAT-CAD-018 → COMPAT-CAD-019 → COMPAT-CAD-020 → COMPAT-CAD-021 → CAD-CERT-001`

Successor selection is governed by `docs/cad/autocad-parity-roadmap.md` and the governance records, not chat agreement.

## Architect role boundary

The Architect is responsible only for governance, architecture/specification review, evidence/acceptance review, lifecycle decisions, work-order assignment, merge authorization, verification and roadmap progression. **All implementation changes — including application code, tests, fixtures, CI workflows, browser-agent harnesses and implementation tooling — belong to `z-ai-implementation-agent` and must arrive as worker-owned work for Architect review.**

Architecture v1.1 remains frozen. No implementation work may bypass the ACR boundary.
