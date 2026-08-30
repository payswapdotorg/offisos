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
 *
 * ARCH-WF-002 additions:
 *  - an Architect-owned, ACR-sanctioned reconciliation may waive exactly
 *    three narrow historical violation classes on an already-merged record
 *    (unauthorized-role, precedes-previous, missing prior approved decision
 *    at a state entry) — never anything else, and never silently: waived
 *    violations are annotated in the report;
 *  - ACR references (record.acr, transition references.acr) must resolve and
 *    transitions operating under an ACR require it approved beforehand;
 *  - the transition into VERIFIED must be revision-bound (cite the exact
 *    implementation commit it verified).
 */
import type {
  ActiveReconciliation,
  ArchitectureVersionsFile,
  AcrRecord,
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
  /** All ACR records (demo included) by id; used for ACR reference integrity (ARCH-WF-002). */
  acrRegistry?: Map<string, AcrRecord>;
  /** Legacy markdown ACR ids (ACR-001, ACR-002) that resolve without a registry record. */
  legacyAcrIds?: Set<string>;
  /** Validated DECIDED reconciliations by work-item id; only these activate waivers (ARCH-WF-002). */
  activeReconciliations?: Map<string, ActiveReconciliation>;
}

/** A single rule violation, optionally carrying its reconcilable-violation key. */
interface ViolationEntry {
  key?: string;
  message: string;
}

/**
 * Emits a check result after applying any active reconciliation waivers.
 * Waived violations are removed from the failure set but explicitly annotated
 * in the details — the reconciliation is auditable, never silent.
 */
function emitWithWaivers(
  recordId: string,
  checkId: string,
  passDescription: string,
  failDescription: string,
  entries: ViolationEntry[],
  ctx: WorkItemContext,
): CheckResult {
  const active = ctx.activeReconciliations?.get(recordId);
  const waived =
    active === undefined
      ? []
      : entries.filter((e) => e.key !== undefined && active.waivedKeys.has(e.key));
  const remaining =
    active === undefined || waived.length === 0
      ? entries
      : entries.filter((e) => e.key === undefined || !active.waivedKeys.has(e.key));

  if (remaining.length > 0) {
    const details = remaining.map((e) => e.message);
    for (const e of waived) {
      details.push(
        `[RECONCILED] ${e.message} — waived by ${active!.id} (architect decision by ${active!.decidedBy} at ${active!.decidedAt}, sanctioned by ${active!.acr}).`,
      );
    }
    return fail(checkId, failDescription, details);
  }
  if (waived.length > 0) {
    const details = waived.map(
      (e) =>
        `[RECONCILED] ${e.message} — waived by ${active!.id} (architect decision by ${active!.decidedBy} at ${active!.decidedAt}, sanctioned by ${active!.acr}).`,
    );
    return {
      id: checkId,
      description: `${passDescription} (${waived.length} historical violation(s) reconciled by ${active!.id}.)`,
      status: "pass",
      details,
    };
  }
  return pass(checkId, passDescription);
}

/**
 * Collects the raw reconcilable violations of a record: the three narrow
 * classes a reconciliation may waive. Keys are stable:
 *
 *   transition-legality/t<N>/unauthorized-role
 *   temporal-ordering/t<N>/precedes-previous
 *   decisions/entry:<STATE>/no-prior-approved-decision
 *
 * Computed against the RAW ledger (no waivers applied) so reconciliation
 * citation checks are state-independent.
 */
export function collectReconcilableViolations(
  record: WorkItemRecord,
  machine: WorkflowStates,
): Map<string, string> {
  const violations = new Map<string, string>();

  for (const [index, transition] of record.transitions.entries()) {
    const label = `transition #${index + 1} (${transition.from} -> ${transition.to})`;
    const def = findTransitionDef(machine, transition.from, transition.to);
    if (def !== undefined && !def.actors.includes(transition.role)) {
      violations.set(
        `transition-legality/t${index + 1}/unauthorized-role`,
        `${label}: role '${transition.role}' is not authorized (allowed: ${def.actors.join(", ")}).`,
      );
    }
  }

  let previousAt: number | undefined;
  for (const [index, transition] of record.transitions.entries()) {
    const at = parseDate(transition.at);
    if (at === undefined) continue;
    if (previousAt !== undefined && at < previousAt) {
      violations.set(
        `temporal-ordering/t${index + 1}/precedes-previous`,
        `transition #${index + 1}: timestamp precedes the previous transition.`,
      );
    }
    previousAt = at;
  }

  const decisions = record.decisions ?? [];
  for (const targetState of ["MERGED", "VERIFIED"]) {
    const requirement = machine.state_entry_requirements[targetState]?.requires_last_decision;
    if (requirement === undefined) continue;
    const entryTransition = [...record.transitions].reverse().find((t) => t.to === targetState);
    if (entryTransition === undefined) continue;
    const at = parseDate(entryTransition.at);
    if (at === undefined) continue;
    const priorDecisions = decisions.filter((d) => parseDate(d.decided_at)! <= at);
    if (priorDecisions.length === 0) {
      violations.set(
        `decisions/entry:${targetState}/no-prior-approved-decision`,
        `entering ${targetState} requires a prior recorded decision; none exists at or before that transition.`,
      );
    }
  }

  return violations;
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
  // Reconcilable: unauthorized-role on a specific transition (ARCH-WF-002).
  // ------------------------------------------------------------------
  const legalityEntries: ViolationEntry[] = [];
  for (const [index, transition] of record.transitions.entries()) {
    const label = `transition #${index + 1} (${transition.from} -> ${transition.to})`;
    const def = findTransitionDef(machine, transition.from, transition.to);
    if (def === undefined) {
      legalityEntries.push({ message: `${label}: not a legal transition in the state machine.` });
      continue;
    }
    if (!def.actors.includes(transition.role)) {
      legalityEntries.push({
        key: `transition-legality/t${index + 1}/unauthorized-role`,
        message: `${label}: role '${transition.role}' is not authorized (allowed: ${def.actors.join(", ")}).`,
      });
    }
    for (const required of def.requires) {
      const value = (transition as unknown as Record<string, unknown>)[required];
      if (typeof value !== "string" || value.trim().length === 0) {
        legalityEntries.push({ message: `${label}: missing required field '${required}'.` });
      }
    }
    const referenceFields = def.reference_fields ?? [];
    for (const field of referenceFields) {
      if (!referenceFieldPresent(transition.references, field)) {
        legalityEntries.push({ message: `${label}: missing required reference '${field}'.` });
      }
    }
    // Reference integrity: evidence and decision ids must exist in this record.
    if (transition.references?.evidence !== undefined) {
      const evidenceIds = new Set((record.evidence ?? []).map((e) => e.id));
      for (const evidenceId of transition.references.evidence) {
        if (!evidenceIds.has(evidenceId)) {
          legalityEntries.push({ message: `${label}: references unknown evidence '${evidenceId}'.` });
        }
      }
    }
    if (transition.references?.decision !== undefined) {
      const decision = (record.decisions ?? []).find((d) => d.id === transition.references!.decision);
      if (decision === undefined) {
        legalityEntries.push({ message: `${label}: references unknown decision '${transition.references.decision}'.` });
      }
    }
    // State entry requirement: required reference on transitions entering a state.
    const entryReqs = machine.state_entry_requirements[transition.to];
    if (entryReqs?.requires_transition_reference !== undefined) {
      const field = entryReqs.requires_transition_reference;
      if (!referenceFieldPresent(transition.references, field)) {
        legalityEntries.push({ message: `${label}: entering '${transition.to}' requires reference '${field}'.` });
      }
    }
  }
  results.push(
    emitWithWaivers(
      id,
      `work-item/${id}/transition-legality`,
      "All transitions are legal, authorized and carry required references.",
      "One or more transitions are illegal, unauthorized or incomplete.",
      legalityEntries,
      ctx,
    ),
  );

  // ------------------------------------------------------------------
  // Temporal ordering: transitions must not travel back in time.
  // Reconcilable: a specific transition preceding its predecessor (ARCH-WF-002).
  // ------------------------------------------------------------------
  const temporalEntries: ViolationEntry[] = [];
  let previousAt: number | undefined;
  for (const [index, transition] of record.transitions.entries()) {
    const at = parseDate(transition.at);
    if (at === undefined) {
      temporalEntries.push({ message: `transition #${index + 1}: '${transition.at}' is not a valid date-time.` });
      continue;
    }
    if (previousAt !== undefined && at < previousAt) {
      temporalEntries.push({
        key: `temporal-ordering/t${index + 1}/precedes-previous`,
        message: `transition #${index + 1}: timestamp precedes the previous transition.`,
      });
    }
    previousAt = at;
  }
  results.push(
    emitWithWaivers(
      id,
      `work-item/${id}/temporal-ordering`,
      "Transition timestamps are valid and monotonically ordered.",
      "Transition timestamps are invalid or out of order.",
      temporalEntries,
      ctx,
    ),
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
  // Reconcilable: the missing-prior-approved-decision entry gate for a
  // specific state (ARCH-WF-002). Everything else is never waivable.
  // ------------------------------------------------------------------
  const decisionEntries: ViolationEntry[] = [];
  const decisions = record.decisions ?? [];
  const decisionIds = new Set<string>();
  for (const d of decisions) {
    if (decisionIds.has(d.id)) decisionEntries.push({ message: `duplicate decision id '${d.id}'.` });
    decisionIds.add(d.id);
    if (d.role !== machine.decision_rules.deciding_role) {
      decisionEntries.push({ message: `decision '${d.id}' was issued by role '${d.role}'; only '${machine.decision_rules.deciding_role}' may decide.` });
    }
    if (machine.decision_rules.remediation_required_for.includes(d.status) && (d.remediation_required ?? "").trim().length === 0) {
      decisionEntries.push({ message: `decision '${d.id}' (${d.status}) must record remediation_required.` });
    }
    for (const ref of d.evidence_refs ?? []) {
      if (!evidenceIds.has(ref)) decisionEntries.push({ message: `decision '${d.id}' references unknown evidence '${ref}'.` });
    }
  }
  // Decision timestamps must be ordered.
  let previousDecisionAt: number | undefined;
  for (const d of decisions) {
    const at = parseDate(d.decided_at);
    if (at === undefined) {
      decisionEntries.push({ message: `decision '${d.id}': invalid decided_at '${d.decided_at}'.` });
      continue;
    }
    if (previousDecisionAt !== undefined && at < previousDecisionAt) {
      decisionEntries.push({ message: `decision '${d.id}': decided_at precedes the previous decision.` });
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
      decisionEntries.push({
        message:
          `decision '${d.id}' (${d.status}) was not followed by a transition to IMPLEMENTING before the next approval; ` +
          "rejected work must return to IMPLEMENTING before re-approval (re-verification policy).",
      });
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
        decisionEntries.push({ message: `transition into ${transition.to} references unknown decision '${transition.references.decision}'.` });
      } else if (decision.status !== "approved") {
        decisionEntries.push({ message: `transition into ${transition.to} references decision '${decision.id}' with status '${decision.status}'.` });
      } else if (at !== undefined && parseDate(decision.decided_at)! > at) {
        decisionEntries.push({ message: `transition into ${transition.to} predates the approval decision '${decision.id}' it cites.` });
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
      decisionEntries.push({
        key: `decisions/entry:${targetState}/no-prior-approved-decision`,
        message: `entering ${targetState} requires a prior recorded decision; none exists at or before that transition.`,
      });
    } else if (lastPrior.status !== requirement) {
      decisionEntries.push({ message: `entering ${targetState} requires the last prior decision to be '${requirement}'; found '${lastPrior.id}' (${lastPrior.status}).` });
    }
  }
  results.push(
    emitWithWaivers(
      id,
      `work-item/${id}/decisions`,
      "Decisions are integral, remediable and consistent with the transition history.",
      "Decision rules violated.",
      decisionEntries,
      ctx,
    ),
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

  // ------------------------------------------------------------------
  // ACR references (ARCH-WF-002): record.acr and transition references.acr
  // must resolve against the ACR registry (or the legacy markdown ACRs), demo
  // marking must be consistent, and a transition operating under an ACR
  // (e.g. acr_resolved) requires that ACR approved no later than the
  // transition itself.
  // ------------------------------------------------------------------
  const acrRefs: Array<{ source: string; acr: string; transitionAt?: string }> = [];
  if (record.acr !== undefined) {
    acrRefs.push({ source: "record acr field", acr: record.acr });
  }
  for (const [index, transition] of record.transitions.entries()) {
    const acr = transition.references?.acr;
    if (acr !== undefined) {
      acrRefs.push({
        source: `transition #${index + 1} (${transition.from} -> ${transition.to})`,
        acr,
        transitionAt: transition.at,
      });
    }
  }
  if (acrRefs.length > 0) {
    const acrDetails: string[] = [];
    const acrRegistry = ctx.acrRegistry ?? new Map<string, AcrRecord>();
    const legacyAcrIds = ctx.legacyAcrIds ?? new Set<string>();
    for (const ref of acrRefs) {
      const acrRecord = acrRegistry.get(ref.acr);
      if (acrRecord === undefined && !legacyAcrIds.has(ref.acr)) {
        acrDetails.push(
          `${ref.source} references ACR '${ref.acr}' which resolves neither in governance/acr/ nor in the legacy markdown ACRs.`,
        );
        continue;
      }
      if (record.demo === true) {
        if (acrRecord !== undefined && acrRecord.demo !== true) {
          acrDetails.push(`demo record '${id}' references real ACR '${ref.acr}'; demo fixtures may not consume real authorization.`);
        }
      } else if (acrRecord !== undefined && acrRecord.demo === true) {
        acrDetails.push(`real record '${id}' references demo ACR '${ref.acr}'.`);
      }
      if (ref.transitionAt !== undefined && acrRecord !== undefined) {
        const transitionAt = parseDate(ref.transitionAt);
        if (acrRecord.status !== "APPROVED" && acrRecord.status !== "IMPLEMENTED") {
          acrDetails.push(
            `${ref.source} cites ACR '${ref.acr}' which is ${acrRecord.status}; a work item may only resume under an APPROVED or IMPLEMENTED ACR.`,
          );
        } else if (acrRecord.approval !== undefined && transitionAt !== undefined && parseDate(acrRecord.approval.approved_at)! > transitionAt) {
          acrDetails.push(
            `${ref.source} cites ACR '${ref.acr}' at ${ref.transitionAt}, before its product-owner approval (${acrRecord.approval.approved_at}).`,
          );
        }
      }
    }
    results.push(
      acrDetails.length === 0
        ? pass(`work-item/${id}/acr-references`, `All ${acrRefs.length} ACR reference(s) resolve and satisfy their gates.`)
        : fail(`work-item/${id}/acr-references`, "ACR reference rules violated.", acrDetails),
    );
  }

  // ------------------------------------------------------------------
  // Revision-bound verification (ARCH-WF-002): the transition into VERIFIED
  // must bind to the exact implementation revision it verified — either the
  // transition references the commit, or it cites at least one evidence item
  // carrying a commit reference. Verification can then be invalidated by
  // later material changes (see the check-verified-revisions command).
  // ------------------------------------------------------------------
  const lastVerifyTransition = [...record.transitions].reverse().find((t) => t.to === "VERIFIED");
  if (lastVerifyTransition !== undefined) {
    const transitionCommit = lastVerifyTransition.references?.commit;
    const cited = lastVerifyTransition.references?.evidence ?? [];
    const commitBoundCitations = cited.filter((evidenceId) => {
      const item = evidence.find((e) => e.id === evidenceId);
      return item !== undefined && item.references?.commit !== undefined;
    });
    const bound = transitionCommit !== undefined || commitBoundCitations.length > 0;
    const binding = transitionCommit ?? commitBoundCitations.join(", ");
    results.push(
      bound
        ? pass(`work-item/${id}/revision-binding`, `The verification is bound to an exact implementation revision (${binding}).`)
        : fail(
            `work-item/${id}/revision-binding`,
            "The transition into VERIFIED is not revision-bound.",
            [
              "The verify transition must reference the implementation commit (references.commit) or cite at least one evidence item carrying a commit reference (LOCK-004 revision binding); verification of one revision never justifies a different revision.",
            ],
          ),
    );
  }

  return results;
}
