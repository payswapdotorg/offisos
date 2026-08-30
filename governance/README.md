# ConstructionOS Repository Governance

**Architecture version:** 1.1 (FROZEN)  
**Source of authority:** `spec/architecture-lock.md` (Section 2, Development workflow lock; Section 3, Architecture changes) and `spec/development-workflow.md`.  
**Current roadmap:** [`spec/roadmap-v1.1.md`](../spec/roadmap-v1.1.md).  
**Historical backlog:** `spec/work-items.md` is retained as the v1.0 historical backlog; it is not the current roadmap authority.  
**Established by:** work item `ARCH-WF-001` (GitHub issue #11). **Extended by:** `ARCH-WF-002` (GitHub issue #12) — the ACR lifecycle, ACR-routed protected paths, revision-bound verification and historical reconciliation.

This directory contains the **repository-backed controls** for the ConstructionOS development workflow. The process is executable, not just documented: a deterministic validator enforces the state machine, evidence policy, ACR lifecycle, reconciliation rules and traceability rules on every pull request.

## 1. What lives here

| Path | Purpose |
|---|---|
| `workflow-states.json` | Canonical, machine-readable work-item lifecycle: states, legal transitions, transition ownership, required references, evidence policy. **Architecture-controlled.** |
| `schemas/workflow-states.schema.json` | JSON Schema for the state machine definition itself. |
| `schemas/work-item.schema.json` | JSON Schema for every work-item governance record. **Architecture-controlled** (control contracts). |
| `schemas/acr.schema.json` | JSON Schema for Architecture Change Request records. **Architecture-controlled.** |
| `schemas/reconciliation.schema.json` | JSON Schema for historical reconciliation records. **Architecture-controlled.** |
| `architecture-versions.json` | Registry of architecture versions. Every work item declares the version it targets. **Architecture-controlled.** |
| `protected-paths.json` | Manifest of architecture-controlled paths; changes require an approved ACR and explicit routing. **Architecture-controlled.** |
| `acr/*.json` | The machine-readable ACR registry (`ACR-NNN.json`; `TEMPLATE.json` is the canonical template). Registry additions (new proposals) are the normal flow; modifications of existing records are protected. |
| `reconciliations/*.json` | Historical governance reconciliation records — one per reconciled work item, named `<WORK-ITEM-ID>.json`. Staging a new reconciliation is the normal flow; modifications of existing records are protected. |
| `architecture-changes/` | The legacy markdown ACRs (ACR-001, ACR-002) that predate the machine-readable registry; they remain resolvable historical records. |
| `work-items/*.json` | One governance record per work item: state, transition history, evidence, Architect decisions. |
| `../tools/governance/` | The validator CLI and its deterministic test suite. |
| `../.github/workflows/governance.yml` | CI: typecheck, tests, record validation, ACR-routed protected-path check, VERIFIED-revision drift audit, report artifact. |

## 2. Roles

| Role | Description | May do |
|---|---|---|
| `architect` | Project Architect / Technical Reviewer | Approve, reject, request changes, verify; review ACRs; decide historical reconciliations |
| `product-owner` | Product Owner / final authority | Declare work items ready, assign, merge, **approve ACRs** (after Architect endorsement) |
| `implementer` | Implementation agent (e.g. Z.ai) | Implement, open PRs, submit for verification, record blocked state, **propose ACRs** |
| `automation` | CI / deterministic bots | Record verification outcomes produced by repository checks |

The implementer **cannot** approve or verify its own work: transitions into `APPROVED` and `VERIFIED` are architect-only, decisions are architect-role records, ACR approval requires architect endorsement followed by Product Owner approval, and reconciliation decisions are architect-only. This is the enforcement backbone of *"VERIFIED must never be justified solely by implementation status"* (LOCK-004).

## 3. Work-item lifecycle

```text
DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED

Failure paths:
  VERIFYING → IMPLEMENTING            (verification_failed)
  ARCHITECT_REVIEW → IMPLEMENTING     (changes_requested)
  ARCHITECT_REVIEW → ARCHITECTURE_CHANGE_REQUEST → IMPLEMENTING (acr_resolved, citing an approved ACR)
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

Every recorded transition carries `at` (ISO 8601), `actor`, `role`, `reason` and, where required, `references` (issue, PR, commit, evidence ids, decision id, ACR id). **ACR reference integrity (ARCH-WF-002):** the record's `acr` field and any transition `references.acr` must resolve against the ACR registry (or the legacy markdown ACRs), demo marking must be consistent, and a work item may only resume (`acr_resolved`) under an ACR that was approved **before** the transition.

## 4. Work-item records

One JSON file per work item in `work-items/`, named `<ID>.json` (e.g. `ARCH-WF-001.json`). Required content (see `schemas/work-item.schema.json`):

- canonical `id`, `title`, GitHub `issue`;
- `objective`, `acceptance_criteria`, `non_goals`, `risk_assumptions`;
- `architecture_version` the item targets;
- `requirements` — IDs that must resolve in `spec/requirements.md` (or a subordinate product registry);
- `dependencies` — work-item IDs that must be `VERIFIED` before execution states are legal;
- `evidence_requirements` — what evidence this item must produce;
- `state` and the full `transitions` history;
- `evidence` entries and Architect `decisions` as they accumulate;
- `acr` — the ACR this item's implementation routes through, when it required one.

Records with `"demo": true` are demonstration fixtures: they are validated by the same rules but excluded from the real registry, must carry a `disclaimer`, and may not be depended on by real work items. `SAMPLE-001.json` demonstrates the **full traceability chain** (requirement → work item → PR/commit → evidence → Architect decision → VERIFIED) including one verification failure and one changes-requested recovery, using synthetic references. `SAMPLE-002.json` demonstrates **ACR routing plus a historical merged-record reconciliation** (see §6b), with an intentionally defective merged ledger reconciled by a decided demo reconciliation.

## 5. Evidence policy

`VERIFIED` is the only state that may be cited as completed work, and it is gated deterministically:

1. **Accepted evidence types:** `automated-test-suite`, `ci-run`, `benchmark-artifact`, `reproducible-script`, `inspectable-artifact`.
2. **Insufficient types (never sufficient):** `screenshot`, `narrative-claim`, `demo`, `implementation-status` (LOCK-004).
3. Accepted evidence must be `reproducible: true` with a `reproduction` command, and **revision-bound**: it must reference the PR, commit SHA and/or CI workflow run it validates.
4. The transition into `VERIFIED` must cite the evidence ids, and cited evidence must qualify under rules 1–3.
5. An approved **Architect decision** referencing that evidence must exist and predate the verifying transition.
6. A rejected or changes-requested decision must record `remediation_required`, and the item must return to `IMPLEMENTING` before a later approval can take effect (re-verification).

**Revision-bound verification (ARCH-WF-002):** the transition into `VERIFIED` must additionally cite the **exact implementation revision it verified** — a `commit` reference on the verify transition, or at least one cited evidence item carrying a `commit` reference (rule `work-item/<ID>/revision-binding`). Evidence produced for a different revision never justifies a verification.

**Drift invalidation (ARCH-WF-002):** `npm run governance -- check-verified-revisions` audits every VERIFIED item against the current tree: if a file declared as a bound path (`references.path` / `references.artifact_path` on verify-cited evidence) changed after the binding revision, the verification is **stale** and the audit fails — later material implementation changes invalidate prior verification. Drift outside declared bound paths is reported informationally (the per-item byte-identical fixture discipline covers it in CI); governance-only, docs, spec and research changes are never material.

## 6. Architecture controls: protected paths and ACR routing

- Every work item declares its `architecture_version`; unknown versions are rejected.
- `protected-paths.json` lists architecture-controlled artifacts (frozen architecture docs, ADRs, the governance definitions, the ACR and reconciliation registries, and the governance schemas).
- `npm run governance -- check-protected --base <ref>` fails when a changed path touches a protected artifact — **unless the change is explicitly routed through an approved ACR** (ARCH-WF-002):
  - the PR body carries a single routing line: `ACR-Routing: ACR-003` (comma-separated for several). The governance CI parses it with the shared, tested helper `tools/governance/src/parse-acr-routing.ts` and invokes `check-protected --base <base> --acr ACR-003`: the label is case-insensitive and tolerates the markdown decorations a PR body carries (a leading list bullet and/or bold emphasis), HTML comments are stripped fail-closed before extraction (an unfilled template comment can never leak example ids into a citation), only the word-bounded `ACR-NNN` token pattern is extracted (injection-safe), and the last routing line wins;
  - a cited ACR routes a changed path only when it is real (non-demo), **APPROVED or IMPLEMENTED**, and enumerates the **exact path** in its `authorized_paths`;
  - everything else — uncited ACRs, PROPOSED/ENDORSED ones, demo fixtures, paths the ACR does not enumerate — remains a violation, with an explicit refusal reason.
- **Bootstrap semantics:** protection applies to modifications/deletions/renames of paths that exist on the base branch, and to additions inside protected directory trees that already exist on the base branch. Creating a brand-new protected file where nothing existed before is the documented bootstrap case and is not a violation. **Registry trees** (`governance/acr/**`, `governance/reconciliations/**`) are marked `additions: allowed`: registering a new ACR proposal or staging a new reconciliation is the normal flow and never needs an ACR, while modifying or deleting existing records is protected.
- The validator itself is the reference implementation of these controls and is subject to Architect review.

## 6a. The ACR lifecycle (ARCH-WF-002)

Architecture Change Requests are repository-backed records in `governance/acr/` (`ACR-NNN.json`, sequential from `ACR-003`; `ACR-9xx` is reserved for demo fixtures; ACR-001/ACR-002 are the legacy markdown ACRs):

```text
PROPOSED → ENDORSED (Architect review, verdict "endorsed") → APPROVED (Product Owner approval) → IMPLEMENTED
PROPOSED/ENDORSED → REJECTED (either gate may reject; terminal)
```

- **Machine-checkable gates:** only the Architect records `review` (role `architect`), only the Product Owner records `approval` (role `product-owner`), and the review must precede the approval; the validator enforces status coherence, ordering and reference resolution for every record.
- **Content contract** (spec/architecture-lock.md Section 3): problem/evidence, impact, alternatives, recommendation, migration plan, compatibility, security impact, affected requirements/work items — all must resolve.
- **Version binding:** an ACR whose `architecture_version_to` differs from `_from` creates a new immutable architecture version; once APPROVED, that version must already be registered in `architecture-versions.json` and must list the ACR in its `change_requests`. Same-version ACRs (control changes like ACR-003) change no version.
- **Routing authority:** `authorized_paths` enumerates the exact paths the ACR authorizes changing while APPROVED or IMPLEMENTED (see §6).
- **Implementation tracking:** IMPLEMENTED requires a bidirectional link — the ACR's `implementation.work_item` must reference a registered work item whose own `acr` field cites the ACR back, with the landing PR/commit.
- **Work-item linkage:** a work item that requires an architecture change records it (`acr` field; `ARCHITECTURE_CHANGE_REQUEST` state and the `acr_resolved` transition cite the ACR id), and the validator rejects resuming under an ACR that is not yet approved.

Start from `governance/acr/TEMPLATE.json`.

## 6b. Historical governance reconciliation (ARCH-WF-002, Issue #100)

An already-merged work item whose **immutable historical ledger** contains a specific governance defect can be reconciled — without rewriting a single recorded event — by a reconciliation record in `governance/reconciliations/<WORK-ITEM-ID>.json`:

- **Two states:** `STAGED` — the facts, verbatim original-event citations and evidence are complete, the Architect decision is pending, and **no waivers are active** (the ledger failures stay fully visible); `DECIDED` — the Architect has recorded the decision and the enumerated waivers activate.
- **Architect-only, ACR-sanctioned:** the decision must be role `architect`, must postdate every event it reconciles and the sanctioning ACR's approval, and the ACR (APPROVED or IMPLEMENTED) must list the work item in `affected_work_items`.
- **Exactly three reconcilable violation classes** — nothing else can ever be waived:
  1. `transition-legality/t<N>/unauthorized-role` — a transition recorded under a role its actor was also entitled to hold;
  2. `temporal-ordering/t<N>/precedes-previous` — a recorded timestamp preceding its predecessor;
  3. `decisions/entry:<STATE>/no-prior-approved-decision` — the state-entry decision gate finding no prior approved decision.
- **Tamper evidence:** every citation embeds the original transition facts (`from`/`to`/`at`/`actor`/`role`) verbatim; if the historical record is ever edited, the citations stop matching and validation fails.
- **Explicit, never silent:** waived violations are annotated `[RECONCILED] … waived by REC-…` in the report; the pass descriptions name the reconciliation.
- **Never an alternate route to VERIFIED:** reconciliation waives nothing in the evidence policy; a reconciled item still reaches VERIFIED only through the normal architect-owned `MERGED → VERIFIED` transition with its own decision and qualifying revision-bound evidence.

The canonical real case is `REC-CAD-PARITY-011` (Issue #100): PR #99's GitHub merge (17:10:16Z) preceded the ledger's recorded approval timestamps (17:12:30Z) although the approval record commit physically predates the merge; the three resulting failures are reconciled without touching the recorded events. `REC-SAMPLE-002` is the always-green demo of the same mechanics.

## 7. Repository integration

- **Issues:** each work item has a GitHub issue carrying its definition. The issue number is recorded in the governance record; one issue maps to at most one real record.
- **Labels:** issues carry `ready` when in READY state. State labels beyond that are optional mirrors; the governance record is canonical.
- **Naming:** work-item IDs are `PREFIX-NNN` (e.g. `ARCH-WF-001`, `RESEARCH-CAD-001`); records are `<ID>.json`; branches are `work/<id-slug>`; evidence ids are `EV-NNN`; decisions are `DEC-NNN`; ACRs are `ACR-NNN` (demo fixtures `ACR-9xx`); reconciliations are `REC-<work-item-id>`.
- **Pull requests:** must use `.github/PULL_REQUEST_TEMPLATE.md` (work-item ID, architecture version, protected-path attestation, **ACR-Routing line when architecture-controlled paths change**, evidence, reproduction commands, explicit not-verified section).
- **CI:** `.github/workflows/governance.yml` runs on every push and PR: typecheck, the deterministic test suite, `governance validate` over all records, the ACR-routed protected-path diff check, the VERIFIED-revision drift audit, and uploads `governance-report.json` as an artifact.

## 8. Traceability chain

For any work item, the chain is reconstructable from the repository alone:

```text
spec/requirements.md (requirement ID)
  → governance/work-items/<ID>.json (requirements field)
    → transitions[].references (issue, PR, commits, acr)
      → evidence[] (type, reproduction, revision binding)
        → decisions[] (Architect decision referencing evidence)
          → state: VERIFIED
          → reconciliation (when an immutable historical defect was reconciled:
             governance/reconciliations/<ID>.json citing the original events verbatim,
             sanctioned by an approved governance/acr/<ACR>.json)
```

To audit a work item:

```bash
npm ci
npm test                                          # deterministic enforcement tests
npm run governance -- validate                    # validates every record, writes governance-report.json
npm run governance -- check-protected --base main # flags protected-path changes vs main
npm run governance -- check-verified-revisions    # flags stale VERIFIED revision bindings
```

## 9. Enforcement model (honest limits)

1. **Deterministic validation** — the validator and tests in `tools/governance/`.
2. **CI gating** — the governance workflow must pass on every PR.
3. **Branch protection** — recommended and owned by the Product Owner; require the `governance` status check and PR review on `main`. Until enabled, CI enforcement is advisory; the git history remains the audit trail either way.
4. **Architect review** — approval, verification, ACR endorsement and reconciliation decisions are role-restricted records; the Architect inspects evidence, not claims.

## 10. Known limitations / next steps

- ARCH-WF-002 landed the ACR registry and lifecycle, ACR-routed protected paths, revision-bound verification invalidation, and the historical reconciliation mechanism (including the staged CAD-PARITY-011 reconciliation for Issue #100).
- `spec/work-items.md` is a **historical v1.0 backlog**, not the current roadmap. The current Architecture v1.1 roadmap is `spec/roadmap-v1.1.md`.
- The validator does not call the GitHub API (validation is offline and deterministic); issue/PR linkage is structural (recorded references), not live-verified. The drift audit uses local git history only.
- ACR-001's Product-Owner merge-gate simplification remains a recorded governance intent, not an implemented state-machine change; implementing it would be a new ACR.
