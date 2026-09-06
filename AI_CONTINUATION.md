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

- Latest fully **VERIFIED** CAD product revision: `066be5fc098443e21263ed57d21788849a875195` — COMPAT-CAD-009.
- Verified work item: **COMPAT-CAD-009** — Issue **#13** — VERIFIED; Issue #13 is closed completed.
- GOV-001 — Issue **#16** — is VERIFIED; Issue #16 is closed completed.
- GOV-001 PR: **#17**.
- GOV-001 physical governance merge: `8931341c8e7ef6fc9da6eac5174a11764b1c0f3f`.
- GOV-001 settled-main governance bookkeeping revision: `60c4b98ed98bb87e9cbdc0ebd641282a8cee0525`.
- Settled-main governance workflow: run `34045452013` — terminal success, including deterministic tests, canonical record validation and VERIFIED revision-binding audit.
- The GOV-001 reconciliation-rule defect was fixed without weakening strict decision validation and without rewriting CC009 historical facts.
- **COMPAT-CAD-010** — Issue **#18** — is now the legally assigned successor to `z-ai-implementation-agent`.
- CC010 governance record: `governance/work-items/COMPAT-CAD-010.json`.
- CC010 implementation prompt: `docs/work-items/COMPAT-CAD-010-ZAI-PROMPT.md`.
- CC010 state: **ASSIGNED**. The worker must implement only the frozen hatch/annotation/dimension/inspection scope and return at `PR_OPEN / VERIFYING`; Architect owns review, approval, merge and verification.
- CC010 dependency: COMPAT-CAD-009 — VERIFIED at physical product merge `066be5fc098443e21263ed57d21788849a875195`.
- CC010 browser gates: **G1/G4/G6/G8**.
- Permanent benchmark baseline remains **18/100**; no increase is authoritative without a full CAD-BENCH-RW-001 rerun.

## CC008 verification evidence

- Product merge: `3854f5391fe58475b50bec9b33e695c33dabc467`.
- Exact post-merge CI: `cad-parity-018` run `34009858133` — terminal success across workspace, Electron and Web.
- Exact-target independent browser gate: run `34017125800`, artifact `9984273561` — terminal success; production build checked out exact product merge and all recorded browser checks passed.
- Post-merge governance validation: run `34017125782`, artifact `9984247961` — terminal success; governance validation 588/588, deterministic governance suite 200/200, and verified-revision drift audit passed.
- CC008 governance record is **VERIFIED** and Issue #5 is closed as completed.

## CC009 verified state

CC009 implements blocks, inserts, attributes and symbols under frozen Architecture v1.1. The Architect approved the remediated implementation at exact PR head `463344ba095bd700fb96f46f4164f333977a85cc`; the approved implementation was physically merged as `066be5fc098443e21263ed57d21788849a875195`.

Product verification was complete at the exact physical merge, including post-merge deterministic/host CI and the exact-SHA independent G5/G7/G8 browser gate. Historical governance ordering defects were reconciled under ACR-006 without waiving evidence requirements. GOV-001 then repaired the reconciliation-key generation for prior non-approved decisions and was independently verified on main.

CC009 governance record is **VERIFIED**, and GitHub Issue #13 is closed completed.

## GOV-001 verified state

GOV-001 repaired only `tools/governance/src/rules.ts` reconciliation-key generation plus deterministic governance tests. The exact PR #17 implementation head passed the required governance evidence and was merged at `8931341c8e7ef6fc9da6eac5174a11764b1c0f3f`.

The post-merge governance record was corrected to use the canonical `product-owner` role on the `APPROVED → MERGED` transition; the settled-main workflow then passed completely at run `34045452013`. GOV-001 is therefore **VERIFIED** and Issue #16 is closed completed.

## Active successor contract — COMPAT-CAD-010

CC010 is the authoritative successor after CC009. Its frozen scope is:

- Hatch entities/patterns with deterministic canonical identity, ownership/provenance, boundary semantics, serialization, rendering/selectability, deletion and undo-safe mutation.
- Annotation/text semantics needed by G1/G4/G6/G8.
- Dimension creation/editing/measurement presentation needed by those workflows, with validation-before-mutation and typed invalid/unsupported behavior.
- Inspection behavior needed by those workflows, bounded so it does not absorb the later OSNAP/OTRACK/tracking program.
- Shared engine-free Web/Electron semantic execution and parity.

Mandatory invariants remain Construction Graph authority, CADDocument working semantics, deterministic domain-owned IDs, engine GlobalIds as provenance only, typed unsupported failures, commit-time canonical state and existing revision/history rules.

Explicit non-goals include CC011 persistence/recovery, CC012 DXF, CC013 layouts/plot, CC014 broad command language, CC015 generalized history/long-session work, CC016 BIM completion, and CC018 broad OSNAP/OTRACK/tracking/measurement expansion. Architecture v1.1 remains frozen; any architecture-controlled change requires an approved ACR.

Worker return evidence must include deterministic tests, identity/provenance/serialization fixtures, Web/Electron parity, regression against verified predecessors, exact-head CI, exact-target deployment, independent black-box browser evidence for G1/G4/G6/G8 including negative/error paths, and revision-bound governance evidence. Worker stops at PR_OPEN/VERIFYING.

## Broader roadmap

`CAD-BENCH-RW-001 → COMPAT-CAD-005 → COMPAT-CAD-006 → COMPAT-CAD-007 → COMPAT-CAD-008 → COMPAT-CAD-009 → COMPAT-CAD-010 → COMPAT-CAD-011 → COMPAT-CAD-012 → COMPAT-CAD-013 → COMPAT-CAD-014 → COMPAT-CAD-015 → COMPAT-CAD-016 → COMPAT-CAD-017 → COMPAT-CAD-018 → COMPAT-CAD-019 → COMPAT-CAD-020 → COMPAT-CAD-021 → CAD-CERT-001`

Successor selection is governed by `docs/cad/autocad-parity-roadmap.md` and the governance records, not chat agreement.

## Architect role boundary

The Architect is responsible only for governance, architecture/specification review, evidence/acceptance review, lifecycle decisions, work-order assignment, merge authorization, verification and roadmap progression. **All implementation changes — including application code, tests, fixtures, CI workflows, browser-agent harnesses and implementation tooling — belong to `z-ai-implementation-agent` and must arrive as worker-owned work for Architect review.**

Architecture v1.1 remains frozen. No implementation work may bypass the ACR boundary.
