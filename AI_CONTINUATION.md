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

- Latest verified CAD product revision: `3854f5391fe58475b50bec9b33e695c33dabc467`
- Verified work item: **COMPAT-CAD-008** — Issue **#5** — VERIFIED.
- Permanent benchmark baseline: **18/100**. No score increase is authoritative without a full benchmark rerun.
- Browser-gate tooling merge: `c2ef91811cfc7d9369c639dd9233b50bc0b49c11`.
- Current legal successor: **COMPAT-CAD-009** — Issue **#13** — ASSIGNED to `z-ai-implementation-agent`.
- Successor governance record: `governance/work-items/COMPAT-CAD-009.json`.
- Successor implementation prompt: `docs/work-items/COMPAT-CAD-009-ZAI-PROMPT.md`.
- Worker stop gate: **PR_OPEN / VERIFYING**.

## CC008 verification evidence

- Product merge: `3854f5391fe58475b50bec9b33e695c33dabc467`.
- Exact post-merge CI: `cad-parity-018` run `34009858133` — terminal success across workspace, Electron and Web.
- Exact-target independent browser gate: run `34017125800`, artifact `9984273561` — terminal success; production build checked out exact product merge and all recorded browser checks passed.
- Post-merge governance validation: run `34017125782`, artifact `9984247961` — terminal success; governance validation 588/588, deterministic governance suite 200/200, and verified-revision drift audit passed.
- CC008 governance record is **VERIFIED** and Issue #5 is closed as completed.

## Current worker assignment

CC009 is the next authorized implementation work order. Its bounded scope is blocks, inserts, attributes and symbols, with canonical ownership/provenance, deterministic identity/order/serialization, rendering/selectability, atomic revision semantics, undo/redo, deletion/orphan policy, typed invalid/unsupported behavior and Web/Electron parity.

The worker must preserve Architecture v1.1 and must not expand into CC010+ scope. It must not claim a benchmark score increase. It must return only at **PR_OPEN / VERIFYING** with revision-bound tests, CI, deployment and browser evidence.

## Broader roadmap

`CAD-BENCH-RW-001 → COMPAT-CAD-005 → COMPAT-CAD-006 → COMPAT-CAD-007 → COMPAT-CAD-008 → COMPAT-CAD-009 → COMPAT-CAD-010 → COMPAT-CAD-011 → COMPAT-CAD-012 → COMPAT-CAD-013 → COMPAT-CAD-014 → COMPAT-CAD-015 → COMPAT-CAD-016 → COMPAT-CAD-017 → COMPAT-CAD-018 → COMPAT-CAD-019 → COMPAT-CAD-020 → COMPAT-CAD-021 → CAD-CERT-001`

Successor selection is governed by `docs/cad/autocad-parity-roadmap.md` and the governance records, not chat agreement.

## Architect role boundary

The Architect is responsible only for governance, architecture/specification review, evidence/acceptance review, lifecycle decisions, work-order assignment, merge authorization, verification and roadmap progression. **All implementation changes — including application code, tests, fixtures, CI workflows, browser-agent harnesses and implementation tooling — belong to `z-ai-implementation-agent` and must arrive as worker-owned work for Architect review.**

Architecture v1.1 remains frozen. No implementation work may bypass the ACR boundary.
