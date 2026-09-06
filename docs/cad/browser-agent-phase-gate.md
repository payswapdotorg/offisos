# AutoCAD Browser-Agent Phase Gate

This protocol is subordinate to `docs/cad/autocad-parity-roadmap.md` and makes browser-driven validation mandatory after every CAD roadmap work item.

## Gate rule

No CAD roadmap work item may reach `VERIFIED` without exact-revision browser-agent evidence proving the changed user workflows work in the deployed application and that prior fixed workflows have not regressed.

## Required sequence

```text
implementation
  → deterministic tests
  → CI
  → Architect review
  → merge
  → exact-head deployment
  → browser-agent test
  → evidence review
  → MERGED → VERIFIED
  → roadmap update
  → next work item authorization
```

Once the implementation worker has returned the PR, the Architect executes this sequence autonomously. There is no intermediate user prompt between the governance steps.

## Deployment boundary

The deployment under test must be revision-exact. A production/preview provider deployment is preferred, but it is not a mandatory dependency of the repository.

When no authorized external hosting project is linked to the repository, an **ephemeral CI deployment** is a valid deployment boundary when all of the following are true:

1. the application source is checked out at the exact target implementation SHA;
2. the CI job starts the actual deployable application host from that SHA;
3. the browser agent reaches that running host over HTTP rather than hidden application APIs;
4. the evidence records both the target commit SHA and a unique deployment identifier such as the CI run ID;
5. the ephemeral deployment is destroyed with the CI job.

This is an execution-boundary rule only. It does not change Construction Graph authority, CAD semantics, engine isolation, canonical identity, or any frozen Architecture v1.1 rule.

## Browser-agent behavior

The agent uses the visible application as a real user: command line, ribbon, palettes, canvas clicks and keyboard input. It must not use hidden APIs to perform the workflow being validated.

Supporting diagnostics may include console/network/runtime inspection, but diagnostic access must never substitute for the user-visible workflow.

## Test package for each phase

Every phase gate contains four layers:

1. **Changed-path probes** — direct reproduction of each requirement and each defect assigned to the phase.
2. **Golden regression** — all Golden 10 workflows affected by the phase.
3. **No-regression sweep** — previously verified golden workflows and defects that could plausibly be affected by the change.
4. **Stress/recovery** — reload, NEW/reset, cancellation, failure recovery or long-session probes where relevant.

## Evidence package

The browser agent records:

- tested commit SHA;
- deployed revision/deployment identifier;
- browser/application version or URL;
- exact workflow inputs;
- expected result;
- actual result;
- screenshots or pixel/render evidence where useful;
- command transcript where applicable;
- pass/fail result per probe;
- prior-defect regression status;
- observed new defects;
- measured score/category delta.

The evidence is stored in the repository under a deterministic path associated with the work item/verification revision.

## Autonomous Architect continuation

When the browser gate finishes, the Architect does not stop to request `next`, `go`, or equivalent input.

On **PASS**, the Architect continues immediately to evidence reconciliation, governance verification, `MERGED → VERIFIED`, authoritative roadmap update, and creation/release of the next legal work item and repository implementation prompt as required by `docs/governance/architect-return-protocol.md`.

On **FAIL**, the Architect records the finding, classifies the failure, performs the legal remediation transition, updates the issue/work item, and writes the exact remediation implementation prompt into the repository before stopping.

## Failure handling

A failed browser gate blocks the work item from `VERIFIED`.

The Architect must classify the failure as one of:

- implementation defect in the current work item;
- regression of an earlier verified capability;
- environment/deployment defect;
- benchmark/evidence defect;
- intentionally unsupported capability, where the application exposes an explicit typed outcome consistent with the architecture.

A known implementation failure cannot be converted to a pass by weakening the test or changing the benchmark score.

## Release gate output

The final gate report must state exactly one of:

`PASS — successor may be released`

or

`FAIL — remediation required; successor remains blocked`

The Architect then updates `docs/cad/autocad-parity-roadmap.md` and the relevant governance record. This repository update is the durable handoff state for the next Architect.