/**
 * Historical governance reconciliation semantics (ARCH-WF-002, Issue #12).
 *
 * governance/reconciliations/<WORK-ITEM-ID>.json holds Architect-owned,
 * ACR-sanctioned reconciliation overlays for already-merged work items whose
 * immutable historical ledger contains a specific, enumerated governance
 * defect (the canonical case: CAD-PARITY-011, Issue #100 — merged before its
 * approval was recorded in the ledger).
 *
 * Design invariants:
 *
 *  1. The original work-item record is NEVER modified. The reconciliation
 *     cites the original transition facts verbatim; if the historical record
 *     is ever edited, the citations stop matching and validation fails
 *     (tamper evidence).
 *  2. Only three narrow violation classes can ever be waived — an
 *     unauthorized-role on a specific transition, a specific transition
 *     timestamp preceding its predecessor, and the missing-prior-approved-
 *     decision entry gate for a specific state. Nothing else is waivable:
 *     not evidence gating, not missing references, not unknown decisions.
 *  3. STAGED reconciliations never waive anything: the underlying ledger
 *     failures remain visible until the Architect records the decision.
 *  4. A DECIDED reconciliation requires: an APPROVED-or-IMPLEMENTED ACR that
 *     lists the work item as affected, an architect-role decision dated after
 *     every cited historical event and after the ACR approval, and at least
 *     one qualifying revision-bound evidence item.
 *  5. Reconciliation never verifies anything: a reconciled item reaches
 *     VERIFIED only through the normal architect-owned path.
 */
import type {
  ActiveReconciliation,
  AcrRecord,
  CheckResult,
  EvidenceRecord,
  EvidencePolicy,
  ReconciliationDefectCitation,
  ReconciliationRecord,
  TransitionRecord,
  WorkItemRecord,
  WorkflowStates,
} from "./types.js";
import { fail, pass } from "./state-machine.js";
import { isQualifyingEvidence, collectReconcilableViolations } from "./rules.js";
import type { LoadedReconciliation } from "./loaders.js";

function parseDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** The deterministic key identifying one reconcilable violation instance. */
export function reconciliationViolationKey(citation: {
  rule: string;
  violation: string;
  transition?: number;
  state_entry?: string;
}): string {
  if (citation.rule === "decisions") {
    return `decisions/entry:${citation.state_entry}/no-prior-approved-decision`;
  }
  return `${citation.rule}/t${citation.transition}/${citation.violation}`;
}

export type { ActiveReconciliation };

export interface ReconciliationRegistryContext {
  machine: WorkflowStates;
  /** All loaded work-item records (demo included) by id. */
  workItems: Map<string, WorkItemRecord>;
  /** All ACR records (demo included) by id. */
  acrRecords: Map<string, AcrRecord>;
}

export interface ReconciliationValidationOutcome {
  checks: CheckResult[];
  /** DECIDED reconciliations that passed every check, by work item id. */
  active: Map<string, ActiveReconciliation>;
}

function originalMatches(
  original: ReconciliationDefectCitation["original"],
  transition: TransitionRecord,
): boolean {
  return (
    original.from === transition.from &&
    original.to === transition.to &&
    original.at === transition.at &&
    original.actor === transition.actor &&
    original.role === transition.role
  );
}

/** The transition a decisions-rule citation refers to (the entry transition into the state). */
function entryTransition(record: WorkItemRecord, state: string): TransitionRecord | undefined {
  return [...record.transitions].reverse().find((t) => t.to === state);
}

/**
 * Citation integrity: every cited defect must reference a real transition with
 * verbatim original facts, and the cited violation must actually exist in the
 * raw record. Citations are checked against the RAW ledger (waivers are not
 * applied), so this is state-independent and tamper-evident.
 */
function citationIntegrity(
  record: ReconciliationRecord,
  workItem: WorkItemRecord,
  machine: WorkflowStates,
): { details: string[]; keys: Set<string> } {
  const details: string[] = [];
  const keys = new Set<string>();
  const seen = new Set<string>();

  for (const [index, citation] of record.defects.entries()) {
    const label = `defect #${index + 1} (${citation.rule}/${citation.violation})`;
    const key = reconciliationViolationKey(citation);

    if (citation.rule === "decisions") {
      const entry = citation.state_entry === undefined ? undefined : entryTransition(workItem, citation.state_entry);
      if (entry === undefined) {
        details.push(`${label}: the record has no transition entering state '${citation.state_entry}'.`);
        continue;
      }
      if (!originalMatches(citation.original, entry)) {
        details.push(
          `${label}: the cited original transition facts do not match the record's transition entering '${citation.state_entry}' verbatim (tamper evidence mismatch).`,
        );
        continue;
      }
    } else {
      const transitionIndex = citation.transition;
      if (transitionIndex === undefined || transitionIndex < 1 || transitionIndex > workItem.transitions.length) {
        details.push(`${label}: transition index ${String(transitionIndex)} is out of range (1..${workItem.transitions.length}).`);
        continue;
      }
      const transition = workItem.transitions[transitionIndex - 1]!;
      if (!originalMatches(citation.original, transition)) {
        details.push(
          `${label}: the cited original transition facts do not match transition #${transitionIndex} verbatim (tamper evidence mismatch).`,
        );
        continue;
      }
    }

    if (seen.has(key)) details.push(`${label}: duplicate citation for violation '${key}'.`);
    seen.add(key);

    // The cited violation must actually exist in the raw ledger.
    const rawViolations = collectReconcilableViolations(workItem, machine);
    if (!rawViolations.has(key)) {
      details.push(
        `${label}: the cited violation '${key}' does not exist in the current ledger; citations must reference a real, present violation (stale citations are rejected).`,
      );
      continue;
    }
    keys.add(key);
  }

  return { details, keys };
}

/**
 * Validates the reconciliation registry and computes the active waiver map.
 * Records that fail any check never activate waivers.
 */
export function validateReconciliationRegistry(
  loaded: LoadedReconciliation[],
  ctx: ReconciliationRegistryContext,
): ReconciliationValidationOutcome {
  const checks: CheckResult[] = [];
  const active = new Map<string, ActiveReconciliation>();

  const duplicateWorkItems: string[] = [];
  const filenameMismatches: string[] = [];
  const seenWorkItems = new Set<string>();
  const perRecordValid = new Map<string, boolean>();

  for (const { file, record } of loaded) {
    if (seenWorkItems.has(record.work_item)) duplicateWorkItems.push(record.work_item);
    seenWorkItems.add(record.work_item);
    if (file !== `${record.work_item}.json`) {
      filenameMismatches.push(`'${file}' reconciles '${record.work_item}'; expected file name '${record.work_item}.json'.`);
    }
    if (record.id !== `REC-${record.work_item}`) {
      filenameMismatches.push(`reconciliation id '${record.id}' must be 'REC-${record.work_item}'.`);
    }
  }
  checks.push(
    duplicateWorkItems.length === 0
      ? pass("reconciliation/registry-unique-work-items", "At most one reconciliation record per work item.")
      : fail("reconciliation/registry-unique-work-items", "Multiple reconciliation records for the same work item.", duplicateWorkItems),
  );
  checks.push(
    filenameMismatches.length === 0
      ? pass("reconciliation/registry-naming", "Reconciliation files and ids are named after the reconciled work item.")
      : fail("reconciliation/registry-naming", "Reconciliation file/id naming violated.", filenameMismatches),
  );

  for (const { record } of loaded) {
    const recordDetails: string[] = [];
    const workItem = ctx.workItems.get(record.work_item);

    // Linkage.
    if (workItem === undefined) {
      recordDetails.push(`work item '${record.work_item}' does not resolve to a registered work-item record.`);
      checks.push(
        fail(`reconciliation/${record.work_item}/record`, "Reconciliation record rules violated.", recordDetails),
      );
      checks.push(
        fail(`reconciliation/${record.work_item}/citations`, "Citations cannot be verified against an unknown work item.", []),
      );
      perRecordValid.set(record.id, false);
      continue;
    }
    if (workItem.state !== "MERGED" && workItem.state !== "VERIFIED") {
      recordDetails.push(
        `work item '${record.work_item}' is in state '${workItem.state}'; reconciliation applies only to already-merged historical records (MERGED or VERIFIED).`,
      );
    }
    if ((record.demo === true) !== (workItem.demo === true)) {
      recordDetails.push(
        `demo marking mismatch: the reconciliation is ${record.demo === true ? "demo" : "real"} but the work item is ${workItem.demo === true ? "demo" : "real"}.`,
      );
    }

    const acr = ctx.acrRecords.get(record.acr);
    if (acr === undefined) {
      recordDetails.push(`sanctioning ACR '${record.acr}' does not resolve in the ACR registry (legacy markdown ACRs cannot sanction reconciliations).`);
    } else {
      if ((record.demo === true) !== (acr.demo === true)) {
        recordDetails.push(
          `demo marking mismatch: the reconciliation is ${record.demo === true ? "demo" : "real"} but the ACR is ${acr.demo === true ? "demo" : "real"}.`,
        );
      }
      if (!acr.affected_work_items.includes(record.work_item)) {
        recordDetails.push(
          `sanctioning ACR '${record.acr}' does not list '${record.work_item}' in affected_work_items; the ACR must sanction this specific reconciliation.`,
        );
      }
      if (record.status === "DECIDED") {
        if (acr.status !== "APPROVED" && acr.status !== "IMPLEMENTED") {
          recordDetails.push(
            `sanctioning ACR '${record.acr}' is ${acr.status}; a reconciliation can only be DECIDED under an APPROVED or IMPLEMENTED ACR.`,
          );
        } else if (acr.approval !== undefined && parseDate(record.decided_at)! < parseDate(acr.approval.approved_at)!) {
          recordDetails.push(
            `decided_at ${record.decided_at} predates the sanctioning ACR approval (${acr.approval.approved_at}).`,
          );
        }
      }
    }

    // Decision coherence (DECIDED only).
    if (record.status === "DECIDED") {
      if (record.role !== "architect") {
        recordDetails.push(`the reconciliation was decided by role '${record.role}'; only the architect may decide a reconciliation.`);
      }
      const decidedAt = parseDate(record.decided_at);
      if (decidedAt === undefined) {
        recordDetails.push(`decided_at '${String(record.decided_at)}' is not a valid date-time.`);
      } else {
        for (const [index, citation] of record.defects.entries()) {
          const at = parseDate(citation.original.at);
          if (at !== undefined && decidedAt < at) {
            recordDetails.push(
              `decided_at ${record.decided_at} predates defect #${index + 1}'s cited original event (${citation.original.at}); a reconciliation is an after-the-fact remediation and must postdate every event it reconciles.`,
            );
          }
        }
      }
      // Evidence: at least one qualifying, revision-bound item.
      const policy = ctx.machine.state_entry_requirements["VERIFIED"]?.evidence as EvidencePolicy | undefined;
      const evidence: EvidenceRecord[] = record.evidence ?? [];
      const qualifying = policy === undefined ? [] : evidence.filter((e) => isQualifyingEvidence(e, policy));
      if (policy === undefined || qualifying.length < 1) {
        recordDetails.push(
          "a DECIDED reconciliation must rest on at least one reproducible, revision-bound evidence item of an accepted type (the physical git topology, the ledger facts, or the post-merge verification).",
        );
      }
    } else if (record.status === "STAGED") {
      if (
        record.decided_by !== undefined ||
        record.decided_at !== undefined ||
        record.rationale !== undefined ||
        record.remediation !== undefined
      ) {
        recordDetails.push("status STAGED must not carry decision fields; record the architect decision by advancing to DECIDED.");
      }
    }

    checks.push(
      recordDetails.length === 0
        ? pass(
            `reconciliation/${record.work_item}/record`,
            `Reconciliation ${record.id} is ${record.status}${record.demo === true ? " (demo fixture)" : ""} and structurally coherent.`,
          )
        : fail(`reconciliation/${record.work_item}/record`, "Reconciliation record rules violated.", recordDetails),
    );

    // Citation integrity.
    const { details: citationDetails, keys } = citationIntegrity(record, workItem, ctx.machine);
    checks.push(
      citationDetails.length === 0
        ? pass(
            `reconciliation/${record.work_item}/citations`,
            `All ${record.defects.length} defect citation(s) match the immutable ledger verbatim and reference present violations.`,
          )
        : fail(`reconciliation/${record.work_item}/citations`, "Defect citation integrity violated.", citationDetails),
    );

    const valid = recordDetails.length === 0 && citationDetails.length === 0;
    perRecordValid.set(record.id, valid);

    if (valid && record.status === "DECIDED") {
      active.set(record.work_item, {
        id: record.id,
        workItem: record.work_item,
        acr: record.acr,
        decidedBy: record.decided_by!,
        decidedAt: record.decided_at!,
        waivedKeys: keys,
      });
    }
  }

  return { checks, active };
}
