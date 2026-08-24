# ConstructionOS Architecture Lock

**Architecture version:** 1.0
**Status:** FROZEN
**Authority:** This document and `architecture.md` are the authoritative architectural rules until a new architecture version is approved.

## 1. Immutable architecture rules

### LOCK-001 — Construction Graph authority

Authoritative project/asset state belongs to the domain services and Construction Graph. UI applications, agents and extensions must not create competing canonical stores.

### LOCK-002 — Provider independence

No domain module may directly depend on an AI/LLM/model provider. All model access passes through the AI Gateway.

### LOCK-003 — Engine independence

CAD/BIM, Project, office and other external engines are behind adapter contracts. A replacement engine must not require domain redesign.

### LOCK-004 — Evidence over claims

A completed work item requires evidence tied to acceptance criteria. “Implemented” is not evidence.

### LOCK-005 — Versioned authority

Authoritative project/domain changes are versioned and traceable.

### LOCK-006 — Historical replay integrity

Time Machine replay may only use information whose availability timestamp is at or before replay time T.

### LOCK-007 — Epistemic honesty

The system must never present an inferred, extrapolated or guessed value as observed fact.

### LOCK-008 — Workflow authority

Workflow state transitions are deterministic, authorized and backend-owned. AI agents may recommend actions but may not directly mutate workflow state.

### LOCK-009 — Tenant isolation

Tenant/project/resource access is enforced server-side. UI filtering is never the only access boundary.

### LOCK-010 — Secret isolation

Provider credentials and secrets are never ordinary application data and are never included in model prompts unless explicitly authorized and necessary.

### LOCK-011 — Extension isolation

Extensions access domain capabilities via scoped contracts. Direct database access is prohibited.

### LOCK-012 — Source preservation

Imported source artifacts retain provenance. Compatibility transformations must not silently destroy source information.

### LOCK-013 — Compatibility proof

A compatibility app is not “done” because a sample file opens. Representative workflows, round trips, semantics and performance must meet the corresponding benchmark.

### LOCK-014 — Human approval boundary

High-consequence engineering certification, regulated submissions, irreversible commercial commitments and final contract approvals require the configured human approval path.

### LOCK-015 — No hidden future knowledge

Predictions, benchmarks and historical backtests must record the data snapshot used.

### LOCK-016 — Shared domain APIs

Native applications, AI agents, extensions and public API consumers use the same domain contracts.

## 2. Development workflow lock

A work item may have multiple PRs over its lifetime but only one active implementation PR at a time.

Canonical workflow:

`DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING`

From VERIFYING:

- `VERIFICATION_FAILED → IMPLEMENTING`
- `ARCHITECT_REVIEW`

From ARCHITECT_REVIEW:

- `CHANGES_REQUESTED → IMPLEMENTING`
- `ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUEST`
- `APPROVED → MERGED → VERIFIED`

`IMPLEMENTATION_BLOCKED` may occur during ASSIGNED, IMPLEMENTING or VERIFYING and returns to IMPLEMENTING once resolved.

## 3. Architecture changes

Frozen architecture cannot be modified by an implementation work item.

Architecture Change Requests must contain:

- problem/evidence;
- affected requirements/work items;
- current architecture impact;
- alternatives considered;
- recommended change;
- migration plan;
- compatibility/backward-impact analysis;
- security impact;
- approval.

An approved change creates a new immutable architecture version. Existing work items retain the version against which they were created.

## 4. Module ownership

The initial frozen module ownership is:

`/auth`
`/users`
`/organizations`
`/projects`
`/workspace`
`/documents`
`/spreadsheets`
`/cad`
`/bim`
`/project-management`
`/construction-graph`
`/quantities`
`/cost`
`/rfq`
`/subcontractors`
`/suppliers`
`/schedule`
`/inspection`
`/maintenance`
`/design-intelligence`
`/construction-intelligence`
`/asset-intelligence`
`/tool-intelligence`
`/knowledge`
`/evidence`
`/unknown-resolution`
`/temporal`
`/lab`
`/ai`
`/agents`
`/extensions`
`/api`
`/workflows`
`/verification`
`/reviews`
`/audit`

Modules communicate through explicit interfaces/events rather than reaching into another module's internal persistence.

## 5. Architecture status

FROZEN.

The architecture intentionally freezes contracts and invariants while leaving engine implementations replaceable until feasibility gates are completed.
