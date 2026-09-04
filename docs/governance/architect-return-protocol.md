# Architect Return Protocol — Autonomous Post-Worker Governance

**Status:** ACTIVE
**Authority:** Subordinate to the frozen architecture, `governance/workflow-states.json`, and the relevant work-item governance record. Operationally mandatory for every returned implementation/research work item.

## 1. Trigger

When an implementation worker returns a work item at `PR_OPEN/VERIFYING`, the Architect treats that return as an execution trigger.

The Architect does **not** wait for another Product Owner or user message such as `next`, `go`, `continue`, or an equivalent instruction before performing routine downstream governance.

## 2. Autonomous completion loop

For the returned work item, the Architect continues through every legal downstream step in one execution cycle:

```text
WORKER RETURNS
  ↓
Reconcile issue + PR + governance record + exact head
  ↓
Complete/check deterministic evidence and required CI
  ↓
VERIFYING → ARCHITECT_REVIEW
  ↓
Independent requirements / architecture / engineering / evidence review
  ↓
PASS
  ↓
APPROVED → MERGED → exact merge binding → post-merge CI to terminal
  ↓
merged-tree reconciliation → exact-head deployment → browser-agent gate
  ↓
evidence reconciliation → MERGED → VERIFIED
  ↓
update governance record → update authoritative roadmap
  ↓
create next legal work item + repository implementation prompt
  ↓
assign/release next worker → STOP with next handoff persisted

FAIL / CHANGES REQUIRED
  ↓
record Architect finding / decision
  ↓
legal return to IMPLEMENTING
  ↓
write exact remediation scope + repository implementation prompt
  ↓
STOP
```

## 3. No intermediate user prompts

Routine governance steps must not be surfaced as separate approval requests to the Product Owner.

The Architect stops and returns control only when one of these conditions is true:

1. **Changes required:** the implementation cannot be approved or verified. A precise remediation directive and repository-backed implementation prompt must be created.
2. **Architecture change required:** the frozen architecture must change. Route to the existing ACR process and stop.
3. **External hard blocker:** an unavailable deployment, credential boundary, CI service, toolchain, or other external dependency prevents lawful evidence collection. Record the blocker, exact impact, and unblock condition.
4. **Product-owner decision required:** the next action changes product scope, priority, legal posture, or architecture beyond existing authorization. Record the decision request explicitly.

A missing `next/go/continue` message is never a reason to stop.

## 4. Architect review checklist

Before approval, the Architect independently reconciles:

- requirement coverage;
- architecture and protected-path compliance;
- exact PR head and changed-file scope;
- deterministic tests and CI;
- evidence quality and revision binding;
- known limitations and typed unsupported outcomes;
- regression safety against previously verified work;
- deployment identity;
- required browser-agent black-box behavior;
- governance record legality.

A green CI result alone is not sufficient.

## 5. Post-merge verification

Approval is not verification.

After merge, the Architect must:

1. bind the exact merge commit in the governance record;
2. poll required post-merge workflows to terminal and classify failures/cancellations/queue blocks;
3. verify the merged tree corresponds to the reviewed implementation except for explicitly recorded governance-only deltas;
4. deploy the exact revision where required;
5. execute the required browser/black-box gate through the visible product UI;
6. compare with the predecessor baseline and permanent regression set;
7. bind qualifying evidence to the exact revision;
8. perform `MERGED → VERIFIED` only when all requirements are satisfied.

## 6. CAD-specific rule

For every CAD roadmap work item, `docs/cad/browser-agent-phase-gate.md` is a mandatory part of this autonomous loop.

After a passing CAD gate, the Architect updates `docs/cad/autocad-parity-roadmap.md` with the verified revision, deployment/evidence bindings, measured score and category delta, retired/new defects, next work item and next browser gate. Only then is the next CAD implementation prompt released.

## 7. Next-work-item release

A successful work item ends with a persisted successor handoff, not a chat instruction.

The Architect must:

- select the successor from the authoritative roadmap;
- confirm dependencies are `VERIFIED`;
- create the successor governance record in legal `DRAFT` state;
- transition `DRAFT → READY → ASSIGNED` only when authorized and complete;
- create the repository implementation prompt with exact scope, requirements, dependencies, acceptance, evidence and stop gate;
- link the prompt from the GitHub issue/work-item record;
- assign the authorized implementation agent;
- leave the repository as the complete source of truth.

No successor may be released solely through chat agreement.

## 8. Remediation release

When changes are required, the Architect must not merely say “please fix”. The repository must contain:

- failed acceptance criteria;
- exact reproduction/evidence;
- reason for failure;
- exact remediation;
- required regression coverage;
- required post-fix browser gate;
- legal governance transition back to `IMPLEMENTING`.

The updated implementation prompt is the worker's next deterministic instruction set.

## 9. Fresh-Architect rule

A fresh Architect must discover the complete next action without chat history:

```text
AGENTS.md
→ AI_CONTINUATION.md
→ spec/development-workflow.md
→ authoritative roadmap
→ browser gate (CAD)
→ active governance record
→ active issue / PR
→ exact revision evidence
```

Any disagreement is a handoff defect and must be reconciled before approval or successor release.
