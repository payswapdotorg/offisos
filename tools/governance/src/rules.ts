/**
 * Work-item record invariants.
 *
 * Every rule here is deterministic and derived from the canonical state
 * machine (governance/workflow-states.json). The rules exist to make the
 * governance claims of ARCH-WF-001 auditable:
 *
 *  - transitions must be legal, contiguous, authorized and time-ordered;
 *  - VERIFIED requires reproducible, revision-bound evidence and an Architect
 *    decision — never implementation status, screenshots or narrative claims;
 *  - rejections must be followed by a documented return to IMPLEMENTING
 *    before a later approval can take effect;
 *  - requirements, dependencies and architecture versions must resolve
 *    against repository-backed registries.
 */
import type {
  ArchitectureVersionsFile,
  CheckResult,
  DecisionRecord,
  EvidenceRecord,
  TransitionRecord,
  WorkItemRecord,
  WorkflowStates,
} from "./types.js";
import { executionStates, fail, findTransitionDef, pass } from "./state-machine.js";

export interface WorkItemContext {
  machine: WorkflowStates;
  architectureVersions: ArchitectureVersionsFile;
  requirementIds: Set<string>;
  /** Registry of non-demo records by id. */
  registry: Map<string, WorkItemRecord>;
}

function parseDate(value: string): number | undefined {
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** Evidence qualifies for VERIFIED when accepted, reproducible and revision-bound. */
export function isQualifyingEvidence(
  evidence: EvidenceRecord,
  policy: { accepted_types: string[]; must_be_revision_bound: boolean },
): boolean {
  if (!policy.accepted_types.includes(evidence.type)) return false;
  if (!evidence.reproducible) return false;
  if (policy.must_be_revision_bound) {
    const refs = evidence.references;
    const bound = refs !== undefined && (refs.pr !== undefined || refs.commit !== undefined || refs.workflow_run !== undefined);
    if (!bound) return false;
  }
  return true;
}

function referenceFieldPresent(
  references: TransitionRecord["references"],
  field: string,
): boolean {
  if (references === undefined) return false;
  const value = (references as Record<string, unknown>)[field];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Validates a single work-item record. Schema conformance is checked separately. */
export function validateWorkItem(record: WorkItemRecord, ctx: WorkItemContext): CheckResult[] {
  const { machine } = ctx;
  const id = record.id;
  const results: CheckResult[] = [];

  // ------------------------------------------------------------------
  // Current state is a defined state.
  // ------------------------------------------------------------------
  results.push(
    record.state in machine.states
      ? pass(`work-item/${id}/state-membership`, "Current state is defined in the state machine.")
      : fail(`work-item/${id}/state-membership`, "Current state is not defined in the state machine.", [
          `state '${record.state}' is not one of: ${Object.keys(machine.states).join(", ")}.`,
        ]),
  );

  // ------------------------------------------------------------------
  // Transition chain: contiguous, starts at initial state, ends at state.
  // ------------------------------------------------------------------
  const chainDetails: string[] = [];
  if (record.transitions.length === 0) {
    if (record.state !== machine.initial_state) {
      chainDetails.push(`no transitions recorded but state is '${record.state}'; expected '${machine.initial_state}'.`);
    }
  } else {
    const first = record.transitions[0]!;
    if (first.from !== machine.initial_state) {
      chainDetails.push(`first transition starts at '${first.from}' instead of initial state '${machine.initial_state}'.`);
    }
    for (let i = 1; i < record.transitions.length; i++) {
      const prev = record.transitions[i - 1]!;
      const curr = record.transitions[i]!;
      if (prev.to !== curr.from) {
        chainDetails.push(`transition #${i + 1} starts at '${curr.from}' but the previous transition ended at '${prev.to}'.`);
      }
    }
    const last = record.transitions[record.transitions.length - 1]!;
    if (last.to !== record.state) {
      chainDetails.push(`last transition ends at '${last.to}' but the record state is '${record.state}'.`);
    }
  }
  results.push(
    chainDetails.length === 0
      ? pass(`work-item/${id}/transition-chain`, "Transition history is contiguous and consistent with the current state.")
      : fail(`work-item/${id}/transition-chain`, "Transition history is broken or inconsistent.", chainDetails),
  );

  // ------------------------------------------------------------------
  // Transition legality, authorization and required fields/references.
  // ------------------------------------------------------------------
  const legalityDetails: string[] = [];
  for (const [index, transition] of record.transitions.entries()) {
    const label = `transition #${index + 1} (${transition.from} -> ${transition.to})`;
    const def = findTransitionDef(machine, transition.from, transition.to);
    if (def === undefined) {
      legalityDetails.push(`${label}: not a legal transition in the state machine.`);
      continue;
    }
    if (!def.actors.includes(transition.role)) {
      legalityDetails.push(
        `${label}: role '${transition.role}' is not authorized (allowed: ${def.actors.join(", ")}).`,
      );
    }
    for (const required of def.requires) {
      const value = (transition as unknown as Record<string, unknown>)[required];
      if (typeof value !== "string" || value.trim().length === 0) {
        legalityDetails.push(`${label}: missing required field '${required}'.`);
      }
    }
    const referenceFields = def.reference_fields ?? [];
    for (const field of referenceFields) {
      if (!referenceFieldPresent(transition.references, field)) {
        legalityDetails.push(`${label}: missing required reference '${field}'.`);
      }
    }
    // Reference integrity: evidence and decision ids must exist in this record.
    if (transition.references?.evidence !== undefined) {
      const evidenceIds = new Set((record.evidence ?? []).map((e) => e.id));
      for (const evidenceId of transition.references.evidence) {
        if (!evidenceIds.has(evidenceId)) {
          legalityDetails.push(`${label}: references unknown evidence '${evidenceId}'.`);
        }
      }
    }
    if (transition.references?.decision !== undefined) {
      const decision = (record.decisions ?? []).find((d) => d.id === transition.references!.decision);
      if (decision === undefined) {
        legalityDetails.push(`${label}: references unknown decision '${transition.references.decision}'.`);
      }
    }
    // State entry requirement: required reference on transitions entering a state.
    const entryReqs = machine.state_entry_requirements[transition.to];
    if (entryReqs?.requires_transition_reference !== undefined) {
      const field = entryReqs.requires_transition_reference;
      if (!referenceFieldPresent(transition.references, field)) {
        legalityDetails.push(`${label}: entering '${transition.to}' requires reference '${field}'.`);
      }
    }
  }
  results.push(
    legalityDetails.length === 0
      ? pass(`work-item/${id}/transition-legality`, "All transitions are legal, authorized and carry required references.")
      : fail(`work-item/${id}/transition-legality`, "One or more transitions are illegal, unauthorized or incomplete.", legalityDetails),
  );

  // ------------------------------------------------------------------
  // Temporal ordering: transitions must not travel back in time.
  // ------------------------------------------------------------------
  const temporalDetails: string[] = [];
  let previousAt: number | undefined;
  for (const [index, transition] of record.transitions.entries()) {
    const at = parseDate(transition.at);
    if (at === undefined) {
      temporalDetails.push(`transition #${index + 1}: '${transition.at}' is not a valid date-time.`);
      continue;
    }
    if (previousAt !== undefined && at < previousAt) {
      temporalDetails.push(`transition #${index + 1}: timestamp precedes the previous transition.`);
    }
    previousAt = at;
  }
  results.push(
    temporalDetails.length === 0
      ? pass(`work-item/${id}/temporal-ordering`, "Transition timestamps are valid and monotonically ordered.")
      : fail(`work-item/${id}/temporal-ordering`, "Transition timestamps are invalid or out of order.", temporalDetails),
  );

  // ------------------------------------------------------------------
  // Architecture version association.
  // ------------------------------------------------------------------
  const knownVersions = new Set(ctx.architectureVersions.versions.map((v) => v.version));
  results.push(
    knownVersions.has(record.architecture_version)
      ? pass(`work-item/${id}/architecture-version`, `Targets architecture version '${record.architecture_version}'.`)
      : fail(`work-item/${id}/architecture-version`, "Architecture version is not registered in governance/architecture-versions.json.", [
          `version '${record.architecture_version}' is not one of: ${[...knownVersions].join(", ")}.`,
        ]),
  );

  // ------------------------------------------------------------------
  // Requirements resolve against spec/requirements.md.
  // ------------------------------------------------------------------
  const unresolvedRequirements = record.requirements.filter((r) => !ctx.requirementIds.has(r));
  results.push(
    unresolvedRequirements.length === 0
      ? pass(`work-item/${id}/requirements`, `All ${record.requirements.length} requirement ID(s) resolve in spec/requirements.md.`)
      : fail(`work-item/${id}/requirements`, "Requirement IDs do not resolve in spec/requirements.md.", unresolvedRequirements.map((r) => `requirement '${r}' not found in spec/requirements.md.`)),
  );

  // ------------------------------------------------------------------
  // Dependencies resolve, and execution requires VERIFIED dependencies.
  // ------------------------------------------------------------------
  const dependencyDetails: string[] = [];
  for (const dep of record.dependencies) {
    const depRecord = ctx.registry.get(dep);
    if (depRecord === undefined) {
      dependencyDetails.push(`dependency '${dep}' does not resolve to a registered (non-demo) work item.`);
    } else if (executionStates(machine).has(record.state) && depRecord.state !== "VERIFIED") {
      dependencyDetails.push(
        `dependency '${dep}' is '${depRecord.state}'; execution states require all dependencies to be VERIFIED.`,
      );
    }
  }
  results.push(
    dependencyDetails.length === 0
      ? pass(`work-item/${id}/dependencies`, "Dependencies resolve and satisfy the execution gate.")
      : fail(`work-item/${id}/dependencies`, "Dependency rules violated (spec/dependency-graph.md invariants).", dependencyDetails),
  );

  // ------------------------------------------------------------------
  // Evidence integrity and VERIFIED gating.
  // ------------------------------------------------------------------
  const evidenceDetails: string[] = [];
  const evidence = record.evidence ?? [];
  const evidenceIds = new Set<string>();
  for (const e of evidence) {
    if (evidenceIds.has(e.id)) evidenceDetails.push(`duplicate evidence id '${e.id}'.`);
    evidenceIds.add(e.id);
  }
  const verifiedPolicy = machine.state_entry_requirements["VERIFIED"]?.evidence;
  if (record.state === "VERIFIED") {
    if (verifiedPolicy === undefined) {
      evidenceDetails.push("state machine defines no evidence policy for VERIFIED; cannot validate.");
    } else {
      const qualifying = evidence.filter((e) => isQualifyingEvidence(e, verifiedPolicy));
      if (qualifying.length < verifiedPolicy.minimum_accepted_evidence) {
        const present = evidence.map((e) => e.type);
        evidenceDetails.push(
          `VERIFIED requires at least ${verifiedPolicy.minimum_accepted_evidence} accepted evidence item(s) ` +
            `(types: ${verifiedPolicy.accepted_types.join(", ")}) that are reproducible and revision-bound; found ${qualifying.length}. ` +
            `Present evidence types: ${present.length > 0 ? present.join(", ") : "none"}. ` +
            `Implementation status, screenshots, demos and narrative claims never qualify (LOCK-004).`,
        );
      }
      // The transition that entered VERIFIED must cite qualifying evidence.
      const verifyTransition = [...record.transitions]
        .reverse()
        .find((t) => t.to === "VERIFIED");
      if (verifyTransition !== undefined) {
        const cited = verifyTransition.references?.evidence ?? [];
        for (const evidenceId of cited) {
          const item = evidence.find((e) => e.id === evidenceId);
          if (item === undefined) {
            evidenceDetails.push(`verify transition cites unknown evidence '${evidenceId}'.`);
          } else if (!isQualifyingEvidence(item, verifiedPolicy)) {
            evidenceDetails.push(
              `verify transition cites evidence '${evidenceId}' of type '${item.type}', which does not qualify (insufficient type, not reproducible, or not revision-bound).`,
            );
          }
        }
      }
    }
  }
  results.push(
    evidenceDetails.length === 0
      ? pass(`work-item/${id}/evidence`, "Evidence integrity holds and VERIFIED evidence gating is satisfied.")
      : fail(`work-item/${id}/evidence`, "Evidence rules violated.", evidenceDetails),
  );

  // ------------------------------------------------------------------
  // Decisions: integrity, remediation, linkage and re-verification policy.
  // ------------------------------------------------------------------
  const decisionDetails: string[] = [];
  const decisions = record.decisions ?? [];
  const decisionIds = new Set<string>();
  for (const d of decisions) {
    if (decisionIds.has(d.id)) decisionDetails.push(`duplicate decision id '${d.id}'.`);
    decisionIds.add(d.id);
    if (d.role !== machine.decision_rules.deciding_role) {
      decisionDetails.push(`decision '${d.id}' was issued by role '${d.role}'; only '${machine.decision_rules.deciding_role}' may decide.`);
    }
    if (machine.decision_rules.remediation_required_for.includes(d.status) && (d.remediation_required ?? "").trim().length === 0) {
      decisionDetails.push(`decision '${d.id}' (${d.status}) must record remediation_required.`);
    }
    for (const ref of d.evidence_refs ?? []) {
      if (!evidenceIds.has(ref)) decisionDetails.push(`decision '${d.id}' references unknown evidence '${ref}'.`);
    }
  }
  // Decision timestamps must be ordered.
  let previousDecisionAt: number | undefined;
  for (const d of decisions) {
    const at = parseDate(d.decided_at);
    if (at === undefined) {
      decisionDetails.push(`decision '${d.id}': invalid decided_at '${d.decided_at}'.`);
      continue;
    }
    if (previousDecisionAt !== undefined && at < previousDecisionAt) {
      decisionDetails.push(`decision '${d.id}': decided_at precedes the previous decision.`);
    }
    previousDecisionAt = at;
  }
  // Re-verification policy: non-approved decisions must be followed by a
  // return to IMPLEMENTING before a later approval takes effect.
  const transitionsToImplementing = record.transitions.filter((t) => t.to === "IMPLEMENTING");
  for (const [index, d] of decisions.entries()) {
    if (d.status === "approved") continue;
    const nextApproved = decisions.slice(index + 1).find((x) => x.status === "approved");
    const decidedAt = parseDate(d.decided_at);
    const windowEnd = nextApproved !== undefined ? parseDate(nextApproved.decided_at) : undefined;
    const returned = transitionsToImplementing.some((t) => {
      const at = parseDate(t.at);
      if (at === undefined || decidedAt === undefined) return false;
      if (at < decidedAt) return false;
      return windowEnd === undefined || at <= windowEnd;
    });
    if (!returned) {
      decisionDetails.push(
        `decision '${d.id}' (${d.status}) was not followed by a transition to IMPLEMENTING before the next approval; ` +
          "rejected work must return to IMPLEMENTING before re-approval (re-verification policy).",
      );
    }
  }
  // Decision-transition binding: approvals referenced by transitions into
  // APPROVED / VERIFIED must be approved decisions made no later than the
  // transition itself.
  for (const transition of record.transitions) {
    if ((transition.to === "APPROVED" || transition.to === "VERIFIED") && transition.references?.decision !== undefined) {
      const decision = decisions.find((d) => d.id === transition.references!.decision);
      const at = parseDate(transition.at);
      if (decision === undefined) {
        decisionDetails.push(`transition into ${transition.to} references unknown decision '${transition.references.decision}'.`);
      } else if (decision.status !== "approved") {
        decisionDetails.push(`transition into ${transition.to} references decision '${decision.id}' with status '${decision.status}'.`);
      } else if (at !== undefined && parseDate(decision.decided_at)! > at) {
        decisionDetails.push(`transition into ${transition.to} predates the approval decision '${decision.id}' it cites.`);
      }
    }
  }
  // State entry requirement: last decision before entering MERGED / VERIFIED
  // must be approved.
  for (const targetState of ["MERGED", "VERIFIED"]) {
    const requirement = machine.state_entry_requirements[targetState]?.requires_last_decision;
    if (requirement === undefined) continue;
    const entryTransition = [...record.transitions].reverse().find((t) => t.to === targetState);
    if (entryTransition === undefined) continue;
    const at = parseDate(entryTransition.at);
    if (at === undefined) continue;
    const priorDecisions = decisions.filter((d) => parseDate(d.decided_at)! <= at);
    const lastPrior = priorDecisions[priorDecisions.length - 1];
    if (lastPrior === undefined) {
      decisionDetails.push(`entering ${targetState} requires a prior recorded decision; none exists at or before that transition.`);
    } else if (lastPrior.status !== requirement) {
      decisionDetails.push(`entering ${targetState} requires the last prior decision to be '${requirement}'; found '${lastPrior.id}' (${lastPrior.status}).`);
    }
  }
  results.push(
    decisionDetails.length === 0
      ? pass(`work-item/${id}/decisions`, "Decisions are integral, remediable and consistent with the transition history.")
      : fail(`work-item/${id}/decisions`, "Decision rules violated.", decisionDetails),
  );

  // ------------------------------------------------------------------
  // Demo fixtures must be unmistakable.
  // ------------------------------------------------------------------
  const demoDetails: string[] = [];
  if (record.demo === true && (record.disclaimer ?? "").trim().length === 0) {
    demoDetails.push("demo records must carry a non-empty disclaimer.");
  }
  results.push(
    demoDetails.length === 0
      ? pass(`work-item/${id}/demo-marking`, record.demo === true ? "Demo fixture properly marked and disclaimed." : "Real (non-demo) record.")
      : fail(`work-item/${id}/demo-marking`, "Demo marking rules violated.", demoDetails),
  );

  return results;
}
