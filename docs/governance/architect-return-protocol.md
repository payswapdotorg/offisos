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
┌────────────────────────────────────────────────────────────┐
│ ACCEPT                                                     │
│  ↓                                                         │
│ APPROVED                                                   │
│  ↓                                                         │
│ MERGE                                                      │
│  ↓                                                         │
│ bind exact merge revision                                  │
│  ↓                                                         │
│ poll post-merge checks to terminal                          │
│  ↓                                                         │
│ verify merged tree                                         │
│  ↓                                                         │
│ exact-head deployment                                      │
│  ↓                                                         │
│ required browser / black-box gate                          │
│  ↓                                                         │
│ evidence reconciliation                                    │
│  ↓                                                         │
│ MERGED → VERIFIED                                          │
│  ↓                                                         │
│ update governance record                                   │
│  ↓                                                         │
│ update authoritative roadmap                               │
│  ↓                                                         │
│ create next legal work item                                │
│  ↓                                                         │
│ create repository-backed implementation prompt             │
│  ↓                                                         │
│ release/assign next worker through legal lifecycle          │
│  ↓                                                         │
│ STOP only after next implementation handoff is persisted    │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ REJECT / CHANGES REQUIRED                                  │
│  ↓                                                         │
│ record Architect finding / decision                        │
│  ↓                                                         │
│ legal return to IMPLEMENTING                               │
│  ↓                                                         │
│ write exact remediation scope                               │
│  ↓                                                         │
│ update issue/PR + repository implementation prompt          │
│  ↓                                                         │
│ STOP                                                       │
└────────────────────────────────────────────────────────────┘
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

- relevant requirement coverage;
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

1. record the exact merge commit;
2. wait for required post-merge workflows to reach terminal states and classify any failures/cancellations/queue blocks;
3. verify the merged tree corresponds to the reviewed implementation except for explicitly recorded governance-only deltas;
4. deploy the exact revision where the work item requires deployment evidence;
5. execute the required black-box/browser gate through the visible product UI;
6. compare the result with the predecessor benchmark/golden baseline;
7. bind qualifying evidence to the exact revision;
8. record the Architect decision and `MERGED → VERIFIED` transition only when all governance requirements are satisfied.

## 6. CAD-specific rule

For CAD roadmap work, the browser-agent protocol in `docs/cad/browser-agent-phase-gate.md` is part of the autonomous loop, not an optional later activity.

After a passing CAD gate, the Architect must update `docs/cad/autocad-parity-roadmap.md` with:

- verified work item and exact revision;
- exact deployment/evidence bindings;
- measured score and category deltas;
- defects retired;
- new defects discovered;
- next authorized work item;
- next browser gate.

Only then may the next CAD implementation prompt be released.

## 7. Next-work-item release

A successful work item ends with a persisted handoff for its successor, not with a chat instruction.

The Architect must:

- select the successor from the authoritative roadmap;
- confirm all declared dependencies are `VERIFIED`;
- create the next governance record in legal initial state `DRAFT`;
- move it through `READY → ASSIGNED` only when its scope is actually ready and authorization exists;
- create the repository implementation prompt containing exact scope, requirements, dependencies, acceptance, evidence and stop gate;
- link the prompt from the GitHub issue/work-item record;
- assign the authorized implementation agent;
- leave the repository as the complete source of truth for the next worker and next Architect.

No successor may be released solely through chat agreement.

## 8. Remediation release

When changes are required, the Architect must not merely say “please fix”. The repository must contain:

- the specific failed acceptance criteria;
- exact reproduction/evidence;
- architectural or semantic reason for failure;
- exact required remediation;
- required regression coverage;
- required post-fix browser gate;
- the legal governance state transition back to `IMPLEMENTING`.

The updated implementation prompt is the worker's next deterministic instruction set.

## 9. Fresh-Architect rule

A fresh Architect must be able to discover the complete next action from repository state without reading chat history. The minimum source chain is:

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

If those sources disagree, the Architect reconciles them before making a governance decision.
