# ConstructionOS Repository Governance

**Architecture version:** 1.0 (FROZEN)
**Source of authority:** `spec/architecture-lock.md` (Section 2, Development workflow lock) and `spec/development-workflow.md`.
**Established by:** work item `ARCH-WF-001` (GitHub issue #11).

This directory contains the **repository-backed controls** for the ConstructionOS development workflow. The process is executable, not just documented: a deterministic validator enforces the state machine, evidence policy and traceability rules on every pull request.

## 1. What lives here

| Path | Purpose |
|---|---|
| `workflow-states.json` | Canonical, machine-readable work-item lifecycle: states, legal transitions, transition ownership, required references, evidence policy. **Architecture-controlled.** |
| `schemas/workflow-states.schema.json` | JSON Schema for the state machine definition itself. |
| `schemas/work-item.schema.json` | JSON Schema for every work-item governance record. |
| `architecture-versions.json` | Registry of architecture versions. Every work item declares the version it targets. **Architecture-controlled.** |
| `protected-paths.json` | Manifest of architecture-controlled paths. Changes require an Architecture Change Request. **Architecture-controlled.** |
| `work-items/*.json` | One governance record per work item: state, transition history, evidence, Architect decisions. |
| `../tools/governance/` | The validator CLI and its deterministic test suite. |
| `../.github/workflows/governance.yml` | CI: typecheck, tests, record validation, protected-path check, report artifact. |

## 2. Roles

| Role | Description | May do |
|---|---|---|
| `architect` | Project Architect / Technical Reviewer | Approve, reject, request changes, verify; decide architecture-change routing |
| `product-owner` | Product Owner / final authority | Declare work items ready, assign, merge, approve architecture-version changes |
| `implementer` | Implementation agent (e.g. Z.ai) | Implement, open PRs, submit for verification, record blocked state |
| `automation` | CI / deterministic bots | Record verification outcomes produced by repository checks |

The implementer **cannot** approve or verify its own work: transitions into `APPROVED` and `VERIFIED` are architect-only, and decisions are architect-role records. This is the enforcement backbone of *"VERIFIED must never be justified solely by implementation status"* (LOCK-004).

## 3. Work-item lifecycle

```text
DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED

Failure paths:
  VERIFYING → IMPLEMENTING            (verification_failed)
  ARCHITECT_REVIEW → IMPLEMENTING     (changes_requested)
  ARCHITECT_REVIEW → ARCHITECTURE_CHANGE_REQUEST
  ASSIGNED/IMPLEMENTING/VERIFYING → IMPLEMENTATION_BLOCKED → IMPLEMENTING
```

`workflow-states.json` is the canonical definition. In summary:

| Transition | Label | Allowed roles | Required references |
|---|---|---|---|
| DRAFT → READY | `declare_ready` | architect, product-owner | issue |
| READY → ASSIGNED | `assign` | architect, product-owner | issue, assignee |
| ASSIGNED → IMPLEMENTING | `start_implementation` | implementer | — |
| IMPLEMENTING → PR_OPEN | `open_pr` | implementer | pr |
| PR_OPEN → VERIFYING | `submit_for_verification` | implementer, automation | — |
| VERIFYING → ARCHITECT_REVIEW | `verification_evidence_complete` | architect, automation | evidence |
| VERIFYING → IMPLEMENTING | `verification_failed` | architect, automation, implementer | failure_reason |
| ARCHITECT_REVIEW → APPROVED | `architect_approves` | architect | decision |
| ARCHITECT_REVIEW → IMPLEMENTING | `changes_requested` | architect | failure_reason |
| ARCHITECT_REVIEW → ARCHITECTURE_CHANGE_REQUEST | `architecture_change_required` | architect | — |
| APPROVED → MERGED | `merge` | product-owner, implementer | merge_commit |
| MERGED → VERIFIED | `verify` | architect | decision, evidence |
| * → IMPLEMENTATION_BLOCKED | `block` | all roles | failure_reason |
| IMPLEMENTATION_BLOCKED → IMPLEMENTING | `unblock` | all roles | — |
| ARCHITECTURE_CHANGE_REQUEST → IMPLEMENTING | `acr_resolved` | architect, product-owner | acr |

Every recorded transition carries `at` (ISO 8601), `actor`, `role`, `reason` and, where required, `references` (issue, PR, commit, evidence ids, decision id, ACR id).

## 4. Work-item records

One JSON file per work item in `work-items/`, named `<ID>.json` (e.g. `ARCH-WF-001.json`). Required content (see `schemas/work-item.schema.json`):

- canonical `id`, `title`, GitHub `issue`;
- `objective`, `acceptance_criteria`, `non_goals`, `risk_assumptions`;
- `architecture_version` the item targets;
- `requirements` — IDs that must resolve in `spec/requirements.md`;
- `dependencies` — work-item IDs that must be `VERIFIED` before execution states are legal;
- `evidence_requirements` — what evidence this item must produce;
- `state` and the full `transitions` history;
- `evidence` entries and Architect `decisions` as they accumulate.

Records with `"demo": true` are demonstration fixtures: they are validated by the same rules but excluded from the real registry, must carry a `disclaimer`, and may not be depended on by real work items. `SAMPLE-001.json` is such a fixture — it demonstrates the **full traceability chain** (requirement → work item → PR/commit → evidence → Architect decision → VERIFIED) including one verification failure and one changes-requested recovery, using synthetic references.

## 5. Evidence policy

`VERIFIED` is the only state that may be cited as completed work, and it is gated deterministically:

1. **Accepted evidence types:** `automated-test-suite`, `ci-run`, `benchmark-artifact`, `reproducible-script`, `inspectable-artifact`.
2. **Insufficient types (never sufficient):** `screenshot`, `narrative-claim`, `demo`, `implementation-status` (LOCK-004).
3. Accepted evidence must be `reproducible: true` with a `reproduction` command, and **revision-bound**: it must reference the PR, commit SHA and/or CI workflow run it validates.
4. The transition into `VERIFIED` must cite the evidence ids, and cited evidence must qualify under rules 1–3.
5. An approved **Architect decision** referencing that evidence must exist and predate the verifying transition.
6. A rejected or changes-requested decision must record `remediation_required`, and the item must return to `IMPLEMENTING` before a later approval can take effect (re-verification).

**Binding convention:** evidence binds to the implementation revision it validates (the PR head commit that CI tested). Later commits that only amend governance metadata do not retroactively invalidate that binding; material changes to the implementation do. (Systematic revision-bound invalidation is owned by ARCH-WF-002.)

## 6. Architecture controls

- Every work item declares its `architecture_version`; unknown versions are rejected.
- `protected-paths.json` lists architecture-controlled artifacts (frozen architecture docs, ADRs, and the governance definitions themselves).
- `npm run governance -- check-protected` fails when a changed path touches a protected artifact, routing the author to the **Architecture Change Request** process instead of a silent change. Until ARCH-WF-002 lands the ACR template and lifecycle, *any* protected-path change in an implementation PR is rejected outright.
- The validator itself is the reference implementation of these controls and is subject to Architect review.

## 7. Repository integration

- **Issues:** each work item has a GitHub issue carrying its definition. The issue number is recorded in the governance record; one issue maps to at most one real record.
- **Labels:** issues carry `ready` when in READY state. State labels beyond that are optional mirrors; the governance record is canonical.
- **Naming:** work-item IDs are `PREFIX-NNN` (e.g. `ARCH-WF-001`, `RESEARCH-CAD-001`); records are `<ID>.json`; branches are `work/<id-slug>`; evidence ids are `EV-NNN`; decisions are `DEC-NNN`.
- **Pull requests:** must use `.github/PULL_REQUEST_TEMPLATE.md` (work-item ID, architecture version, protected-path attestation, evidence, reproduction commands, explicit not-verified section).
- **CI:** `.github/workflows/governance.yml` runs on every push and PR: typecheck, the deterministic test suite, `governance validate` over all records, the protected-path diff check, and uploads `governance-report.json` as an artifact.

## 8. Traceability chain

For any work item, the chain is reconstructable from the repository alone:

```text
spec/requirements.md (requirement ID)
  → governance/work-items/<ID>.json (requirements field)
    → transitions[].references (issue, PR, commits)
      → evidence[] (type, reproduction, revision binding)
        → decisions[] (Architect decision referencing evidence)
          → state: VERIFIED
```

To audit a work item:

```bash
npm ci
npm test                                   # deterministic enforcement tests
npm run governance -- validate             # validates every record, writes governance-report.json
npm run governance -- check-protected --base main   # flags protected-path changes vs main
```

## 9. Enforcement model (honest limits)

1. **Deterministic validation** — the validator and tests in `tools/governance/`.
2. **CI gating** — the governance workflow must pass on every PR.
3. **Branch protection** — *recommended, owned by the Product Owner:* require the `governance` status check and PR review on `main`. Until enabled, CI enforcement is advisory; the git history remains the audit trail either way.
4. **Architect review** — approval and verification decisions are role-restricted records; the Architect inspects evidence, not claims.

## 10. Known limitations / next steps

- The ACR template and lifecycle, revision-bound verification invalidation, and the full architecture lock manifest are **ARCH-WF-002** (issue #12) — not this work item.
- `spec/work-items.md` still carries the older ARCH-WF-001/ARCH-WF-002 definitions; GitHub issues #11/#12 are the current definitions. Reconciliation is flagged for the Architect (see the ARCH-WF-001 PR).
- The validator does not call the GitHub API (validation is offline and deterministic); issue/PR linkage is structural (recorded references), not live-verified.
