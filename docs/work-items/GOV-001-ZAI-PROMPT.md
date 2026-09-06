# GOV-001 — Z-AI Implementation Prompt

You are the implementation agent for **GOV-001** in `payswapdotorg/offisos`.

## Mission
Repair the governance reconciliation engine so ARCH-WF-002 correctly recognizes a reconcilable decision-entry violation when a state transition is preceded by a recorded decision whose status is not the required approved status.

## Exact defect
`tools/governance/src/rules.ts::collectReconcilableViolations()` currently emits `decisions/entry:<STATE>/no-prior-approved-decision` only when there are zero prior decisions. The decision validator later correctly fails when a prior decision exists but has a non-approved status. That leaves no stable waiver key for an explicitly sanctioned reconciliation such as CC009's historical `changes_requested` → merge ordering defect.

## Required implementation
1. Preserve the exact stable key `decisions/entry:<STATE>/no-prior-approved-decision`.
2. In the raw reconcilable-violation collector, compare the last prior decision's status with the state's `requires_last_decision` requirement; emit the stable key whenever no qualifying prior approved decision exists, including when a prior non-approved decision exists.
3. Keep the normal decision validator strict: without an active reconciliation, a non-approved last prior decision remains a failure.
4. Ensure the reconciliation engine waives only the exact cited key and still reports every unrelated decision violation.
5. Add deterministic tests for: no prior decisions; prior `changes_requested`; prior approved; and a real reconciliation over a prior non-approved decision.
6. Run the existing governance tests and prove all existing reconciliation fixtures remain green.
7. Do not modify `governance/workflow-states.json`, architecture definitions, lifecycle roles, evidence requirements, or revision-binding policy.
8. Do not alter CC009 timestamps or decisions to make the current defect disappear.
9. No CAD product changes and no benchmark score claim.

## Return contract
Implement only this frozen scope. Return at `PR_OPEN / VERIFYING` with revision-bound evidence including:
- exact implementation commit;
- deterministic governance test results;
- full governance validation;
- `npm test` or equivalent relevant test result;
- protected-path / architecture-scope proof;
- explicit confirmation that no historical governance facts were rewritten.

Stop after opening/submitting the PR for Architect review. Do not approve, merge, or verify the work item.