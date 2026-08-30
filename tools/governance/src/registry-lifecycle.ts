/**
 * Registry lifecycle-transition authorization (ARCH-WF-002 remediation, Issue #12).
 *
 * The Architect ruling on PR #101 (CHANGES REQUESTED — circular ACR
 * authorization): the protected-path model protects existing records under
 * governance/acr/** and governance/reconciliations/** while allowing only
 * additions, yet an ACR's own lifecycle (PROPOSED → ENDORSED → APPROVED →
 * IMPLEMENTED, or → REJECTED) and a reconciliation's decision (STAGED →
 * DECIDED) are modifications of existing records — and no ACR's
 * authorized_paths covers its own record, so every registry lifecycle
 * advancement after creation would require another approved ACR,
 * recursively. The mechanism could never complete its own lifecycle.
 *
 * The follow-up ruling (CHANGES REQUESTED again — lifecycle bypass at record
 * creation): allowing registry additions is correct for creating proposals
 * and staged reconciliations, but nothing required a newly created REAL
 * record to begin at its initial lifecycle state, so a PR could birth an
 * already-APPROVED (or already-IMPLEMENTED) ACR — or an already-DECIDED
 * reconciliation — as an "allowed addition" the transition guard never
 * inspects (no before/after pair exists for a creation). This module
 * therefore owns TWO rules:
 *
 *   the creation invariant  — a newly created real (non-demo) record must be
 *                             born at its INITIAL status (ACR → PROPOSED,
 *                             reconciliation → STAGED); demo fixtures
 *                             (demo: true) are exempt because they are
 *                             inert (they can never route protected-path
 *                             changes, sanction real reconciliations or be
 *                             referenced by real records — enforced on both
 *                             sides of every reference elsewhere);
 *   the transition rule     — a modification of an existing record is waived
 *                             only when it is a narrowly content-checked
 *                             legal lifecycle transition (below).
 *
 * Together:
 *
 *   New ACR proposal creation       → allowed, born PROPOSED
 *   New reconciliation staging      → allowed, born STAGED
 *   New real ACR born mid-lifecycle → BLOCKED (APPROVED, IMPLEMENTED, …)
 *   New real reconciliation DECIDED → BLOCKED
 *   ACR lifecycle transition        → narrowly authorized HERE
 *   Reconciliation decision         → narrowly authorized HERE
 *   Arbitrary existing-record edit  → still protected (violation)
 *   Protected implementation change → still requires an approved ACR
 *   Normal VERIFIED gate            → unchanged
 *
 * "Narrowly authorized" is content-checked, not name-checked: a modified
 * record passes ONLY when
 *   1. before/after are both JSON record objects with the same identity
 *      (id, and work_item for reconciliations) and parseable statuses;
 *   2. the status edge is one of the enumerated legal edges below (no
 *      skipping, no backwards moves, no invented states);
 *   3. the set of changed top-level keys is EXACTLY {status} plus the edge's
 *      required gate instruments — every instrument newly added (undefined
 *      before, present after), every other field byte-stable (deep-equal);
 *   4. each instrument carries its authorizing role (architect review,
 *      product-owner approval, architect decision) and the verdict/decision
 *      the edge requires.
 *
 * Anything else — prose amendments, authorized_paths edits, evidence or
 * citation changes, instrument replacement, key removal, id changes, status
 * jumps — is an ordinary modification and stays a violation. The full
 * registry coherence (ordering, references, version binding, evidence,
 * sanction, tamper-evidence) remains the validate step's job; this gate is
 * the path-level authorization, and it is deliberately stricter than
 * validate about what a single change may carry.
 */

export type RegistryLifecycleKind = "acr" | "reconciliation";

export interface LifecycleTransitionOutcome {
  ok: boolean;
  /** Present when ok: the legal edge taken, e.g. "PROPOSED → APPROVED". */
  edge?: string;
  /** Present when ok: the gate instruments the transition added. */
  instruments?: string[];
  /** Present when !ok: why this modification is not a legal transition. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// The creation invariant (the round-3 ruling: lifecycle bypass at record
// creation).
// ---------------------------------------------------------------------------

/** The status a newly created real record of each kind must be born at. */
export const INITIAL_REGISTRY_STATUS: Record<RegistryLifecycleKind, string> = {
  acr: "PROPOSED",
  reconciliation: "STAGED",
};

export interface RegistryCreationOutcome {
  ok: boolean;
  /** Present when ok: true when the record is a demo fixture (exempt). */
  demo?: boolean;
  /** Present when ok and real: the initial status the record was born at. */
  initialStatus?: string;
  /** Present when !ok: why this creation is not lawful. */
  reason?: string;
}

/**
 * Checks the creation invariant for a newly created registry record.
 *
 * A REAL (non-demo) record must be born at its INITIAL lifecycle status —
 * PROPOSED for an ACR, STAGED for a reconciliation — so no record can enter
 * the registry mid-lifecycle (already APPROVED / IMPLEMENTED / DECIDED) and
 * thereby bypass the review/approval gates the transitions enforce. Demo
 * fixtures (the record's own `demo: true` marking) are exempt: they exist to
 * demonstrate the mechanisms end-to-end (e.g. ACR-901 is born IMPLEMENTED)
 * and are inert — they can never route protected-path changes, sanction real
 * reconciliations or be referenced by real records (demo marking is enforced
 * on both sides of every reference; demo ACRs must use the reserved ACR-9xx
 * id range — both in the validate step).
 *
 * Unreadable content (not JSON, deleted at HEAD, no reader available) fails
 * closed: an unverifiable creation is not an authorized creation.
 */
export function checkRegistryRecordCreation(
  kind: RegistryLifecycleKind,
  created: unknown,
): RegistryCreationOutcome {
  const initial = INITIAL_REGISTRY_STATUS[kind];
  const kindName = kind === "acr" ? "ACR" : "reconciliation";
  if (!isRecord(created)) {
    return {
      ok: false,
      reason: `the newly created ${kindName} record could not be read as a JSON record object (unreadable, deleted at HEAD, or not JSON) — the creation invariant cannot be verified and fails closed`,
    };
  }
  if (created.demo === true) {
    return { ok: true, demo: true };
  }
  const status = created.status;
  if (typeof status !== "string" || status.trim().length === 0) {
    return {
      ok: false,
      reason: `a newly created real (non-demo) ${kindName} record must be born at its initial lifecycle status '${initial}'; this record carries no readable 'status' field`,
    };
  }
  if (status !== initial) {
    return {
      ok: false,
      reason: `a newly created real (non-demo) ${kindName} record must be born at its initial lifecycle status '${initial}' (found '${status}'): later states are reachable only through the narrowly content-checked legal lifecycle transitions — creating a record mid-lifecycle bypasses the review/approval gates`,
    };
  }
  return { ok: true, initialStatus: initial };
}

// ---------------------------------------------------------------------------
// The addition traversal: a creation PLUS every subsequent change the same
// PR makes to the new record.
//
// Why a full traversal and not a single content check: a record introduced
// born-at-initial and then modified later within the SAME change (the
// documented review-time acts flow — e.g. ACR-003 is created PROPOSED on the
// PR branch and advanced to APPROVED by the Architect's acts commit before
// merge) is lawful ONLY if every intra-change step is itself a legal
// lifecycle transition. Checking just the end state would either block the
// acts flow (end state APPROVED on a file that does not exist on the base)
// or let a tampered traversal through (born PROPOSED at commit 1, gates
// recorded at commit 2, an instrument quietly edited at commit 3). The
// traversal closes both: the record must ACTUALLY traverse the lifecycle —
// creation at the initial status, then nothing but legal edges.
// ---------------------------------------------------------------------------

/** One commit's effect on a registry record within the checked range. */
export interface RegistryRecordHistoryStep {
  commit: string;
  /** The record content before the commit (undefined: the file did not exist). */
  before?: unknown;
  /** The record content after the commit (undefined: the file was deleted). */
  after?: unknown;
}

export interface RegistryAdditionTraversalOutcome {
  ok: boolean;
  /** Present when ok: true when the record is a demo fixture (exempt). */
  demo?: boolean;
  /** Present when ok and real: the initial status the record was born at. */
  initialStatus?: string;
  /** Present when ok: the legal transitions made after the creation (oldest-first). */
  steps?: { edge: string; instruments: string[] }[];
  /** Present when !ok: why this addition is not lawful. */
  reason?: string;
}

/**
 * Checks the full creation traversal for a registry record ADDED within the
 * checked range (the path does not exist on the base branch).
 *
 * The history lists, oldest-first, every commit in the range that touched
 * the path with the record content before and after that commit. The first
 * step (file absent before) must satisfy the creation invariant; EVERY later
 * step must be a narrowly content-checked legal lifecycle transition. A
 * deletion mid-range is not a transition and is blocked. Unreadable or empty
 * history fails closed.
 */
export function checkRegistryAdditionTraversal(
  kind: RegistryLifecycleKind,
  history: RegistryRecordHistoryStep[] | undefined,
): RegistryAdditionTraversalOutcome {
  const kindName = kind === "acr" ? "ACR" : "reconciliation";
  if (history === undefined || history.length === 0) {
    return {
      ok: false,
      reason: `the newly created ${kindName} record's commit history could not be read within the checked range — the creation traversal cannot be verified and fails closed`,
    };
  }
  let creation: RegistryCreationOutcome | undefined;
  const steps: { edge: string; instruments: string[] }[] = [];
  for (const step of history) {
    if (step.before === undefined) {
      // Creation step: the file did not exist before this commit.
      const outcome = checkRegistryRecordCreation(kind, step.after);
      if (!outcome.ok) {
        return { ok: false, reason: `${outcome.reason} (introduced at commit ${step.commit})` };
      }
      creation = outcome;
      continue;
    }
    // A later change to the same new record within the same change: must
    // itself be a legal lifecycle transition (this is what makes the
    // documented review-time acts flow lawful while a born-mid-lifecycle
    // creation or an intra-change tamper stays blocked).
    const outcome = isLegalRegistryLifecycleTransition(kind, step.before, step.after);
    if (!outcome.ok) {
      return {
        ok: false,
        reason: `the record's modification at commit ${step.commit} (within the same change) is not a legal lifecycle transition: ${outcome.reason}`,
      };
    }
    steps.push({ edge: outcome.edge!, instruments: outcome.instruments! });
  }
  if (creation === undefined) {
    // Every step had a "before": the file existed before the range — not an
    // addition. Fail closed (additions and modifications use different rules).
    return {
      ok: false,
      reason: `the ${kindName} record already existed before the checked range — this is not a registry addition; it must be checked as a modification`,
    };
  }
  return creation.demo === true
    ? { ok: true, demo: true, steps }
    : { ok: true, initialStatus: creation.initialStatus, steps };
}

// ---------------------------------------------------------------------------
// Deep equality with stable object-key ordering (JSON records from git may
// serialize keys in any order; content equality must not depend on it).
// ---------------------------------------------------------------------------

function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => stableEqual(item, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    stableEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Top-level keys whose value differs between before and after (added, removed or changed). */
function changedTopLevelKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => !stableEqual(before[k], after[k]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const WORK_ITEM_ID = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-[0-9]{3}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// ACR lifecycle edges.
// ---------------------------------------------------------------------------

interface AcrEdgeVariant {
  /** The newly added gate instruments this edge must carry. */
  instruments: { key: string; check: (value: unknown) => boolean; describe: string }[];
}

/** Legal ACR status edges and the exact instrument sets each may add. */
const ACR_EDGES: Record<string, AcrEdgeVariant[]> = {
  // Single-gate edges.
  "PROPOSED→ENDORSED": [
    {
      instruments: [
        {
          key: "review",
          describe: "architect review (verdict: endorsed)",
          check: (v) => isRecord(v) && v.role === "architect" && v.verdict === "endorsed",
        },
      ],
    },
  ],
  // Architect rejects at review.
  "PROPOSED→REJECTED": [
    {
      instruments: [
        {
          key: "review",
          describe: "architect review (verdict: rejected)",
          check: (v) => isRecord(v) && v.role === "architect" && v.verdict === "rejected",
        },
      ],
    },
    // Composed PROPOSED → ENDORSED → REJECTED in one change.
    {
      instruments: [
        {
          key: "review",
          describe: "architect review (verdict: endorsed)",
          check: (v) => isRecord(v) && v.role === "architect" && v.verdict === "endorsed",
        },
        {
          key: "approval",
          describe: "product-owner approval (decision: rejected)",
          check: (v) => isRecord(v) && v.role === "product-owner" && v.decision === "rejected",
        },
      ],
    },
  ],
  "ENDORSED→APPROVED": [
    {
      instruments: [
        {
          key: "approval",
          describe: "product-owner approval (decision: approved)",
          check: (v) => isRecord(v) && v.role === "product-owner" && v.decision === "approved",
        },
      ],
    },
  ],
  // Product Owner rejects at approval.
  "ENDORSED→REJECTED": [
    {
      instruments: [
        {
          key: "approval",
          describe: "product-owner approval (decision: rejected)",
          check: (v) => isRecord(v) && v.role === "product-owner" && v.decision === "rejected",
        },
      ],
    },
  ],
  "APPROVED→IMPLEMENTED": [
    {
      instruments: [
        {
          key: "implementation",
          describe: "implementation linkage (work_item + references)",
          check: (v) =>
            isRecord(v) &&
            typeof v.work_item === "string" &&
            WORK_ITEM_ID.test(v.work_item) &&
            isRecord(v.references) &&
            (typeof v.references.pr === "number" || typeof v.references.commit === "string"),
        },
      ],
    },
  ],
  // Composed multi-gate edges (the gates collapse into one change; every
  // instrument of every crossed gate must be present, each with its own
  // authorizing role — the two-gate separation lives in the instruments).
  "PROPOSED→APPROVED": [
    {
      instruments: [
        {
          key: "review",
          describe: "architect review (verdict: endorsed)",
          check: (v) => isRecord(v) && v.role === "architect" && v.verdict === "endorsed",
        },
        {
          key: "approval",
          describe: "product-owner approval (decision: approved)",
          check: (v) => isRecord(v) && v.role === "product-owner" && v.decision === "approved",
        },
      ],
    },
  ],
  "PROPOSED→IMPLEMENTED": [
    {
      instruments: [
        {
          key: "review",
          describe: "architect review (verdict: endorsed)",
          check: (v) => isRecord(v) && v.role === "architect" && v.verdict === "endorsed",
        },
        {
          key: "approval",
          describe: "product-owner approval (decision: approved)",
          check: (v) => isRecord(v) && v.role === "product-owner" && v.decision === "approved",
        },
        {
          key: "implementation",
          describe: "implementation linkage (work_item + references)",
          check: (v) =>
            isRecord(v) &&
            typeof v.work_item === "string" &&
            WORK_ITEM_ID.test(v.work_item) &&
            isRecord(v.references) &&
            (typeof v.references.pr === "number" || typeof v.references.commit === "string"),
        },
      ],
    },
  ],
  "ENDORSED→IMPLEMENTED": [
    {
      instruments: [
        {
          key: "approval",
          describe: "product-owner approval (decision: approved)",
          check: (v) => isRecord(v) && v.role === "product-owner" && v.decision === "approved",
        },
        {
          key: "implementation",
          describe: "implementation linkage (work_item + references)",
          check: (v) =>
            isRecord(v) &&
            typeof v.work_item === "string" &&
            WORK_ITEM_ID.test(v.work_item) &&
            isRecord(v.references) &&
            (typeof v.references.pr === "number" || typeof v.references.commit === "string"),
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Reconciliation lifecycle edges.
// ---------------------------------------------------------------------------

const RECONCILIATION_DECISION_INSTRUMENTS = [
  {
    key: "decided_by",
    describe: "the deciding Architect",
    check: nonEmptyString,
  },
  {
    key: "role",
    describe: "the architect role",
    check: (v: unknown) => v === "architect",
  },
  {
    key: "decided_at",
    describe: "the decision timestamp",
    check: (v: unknown) => typeof v === "string" && DATE_TIME.test(v),
  },
  {
    key: "rationale",
    describe: "the decision rationale",
    check: nonEmptyString,
  },
  {
    key: "remediation",
    describe: "the remediation conclusion",
    check: nonEmptyString,
  },
] as const;

// ---------------------------------------------------------------------------
// The authorization predicate.
// ---------------------------------------------------------------------------

export function isLegalRegistryLifecycleTransition(
  kind: RegistryLifecycleKind,
  before: unknown,
  after: unknown,
): LifecycleTransitionOutcome {
  if (!isRecord(before) || !isRecord(after)) {
    return { ok: false, reason: "the changed file is not a JSON record object on both sides of the change" };
  }
  if (!nonEmptyString(before.id) || before.id !== after.id) {
    return { ok: false, reason: "record identity ('id') is missing or was changed by the edit" };
  }
  if (kind === "reconciliation" && before.work_item !== after.work_item) {
    return { ok: false, reason: "record identity ('work_item') was changed by the edit" };
  }
  if (!nonEmptyString(before.status) || !nonEmptyString(after.status)) {
    return { ok: false, reason: "record 'status' is missing on one side of the change" };
  }
  const from = before.status;
  const to = after.status;
  const changed = changedTopLevelKeys(before, after).sort();
  const extraFields = () => changed.filter((k) => k !== "status");

  if (from === to) {
    // No lifecycle transition at all: a pure content edit of an existing record.
    return {
      ok: false,
      reason:
        extraFields().length > 0
          ? `an ordinary modification of an existing registry record (no lifecycle transition; status unchanged): fields changed (${extraFields().join(", ")}) — route substantive amendments through an approved ACR`
          : "an ordinary modification of an existing registry record with no field changes detected",
    };
  }

  if (kind === "acr") {
    const variants = ACR_EDGES[`${from}→${to}`];
    if (variants === undefined) {
      return {
        ok: false,
        reason: `'${from} → ${to}' is not a legal ACR lifecycle edge (legal edges: PROPOSED→ENDORSED/REJECTED, ENDORSED→APPROVED/REJECTED, APPROVED→IMPLEMENTED, and their monotone compositions)`,
      };
    }
    for (const variant of variants) {
      const instrumentKeys = variant.instruments.map((i) => i.key).sort();
      const allowed = ["status", ...instrumentKeys].sort();
      const matchesShape =
        changed.length === allowed.length && changed.every((k, i) => k === allowed[i]) &&
        variant.instruments.every((i) => before[i.key] === undefined && i.check(after[i.key]));
      if (matchesShape) {
        return { ok: true, edge: `${from} → ${to}`, instruments: instrumentKeys };
      }
    }
    const instrumentNames = variants[0]!.instruments.map((i) => i.key).join(", ");
    const extra = changed.filter((k) => k !== "status" && !instrumentNames.includes(k));
    if (extra.length > 0) {
      return {
        ok: false,
        reason: `an ordinary modification of an existing ACR record: fields outside the lifecycle instruments changed (${extra.join(", ")}) — only 'status' plus the gate instruments (${instrumentNames}) may change in a lifecycle transition; route substantive amendments through an approved ACR`,
      };
    }
    return {
      ok: false,
      reason: `not a well-formed '${from} → ${to}' transition: the changed fields must be exactly 'status' plus newly added, role-correct gate instruments (${instrumentNames})`,
    };
  }

  // Reconciliation: the single decision edge.
  if (from !== "STAGED" || to !== "DECIDED") {
    return {
      ok: false,
      reason: `'${from} → ${to}' is not a legal reconciliation lifecycle edge (the only legal edge is STAGED → DECIDED)`,
    };
  }
  const instrumentKeys: string[] = RECONCILIATION_DECISION_INSTRUMENTS.map((i) => i.key).sort();
  const allowed = ["status", ...instrumentKeys].sort();
  const matchesShape =
    changed.length === allowed.length &&
    changed.every((k, i) => k === allowed[i]) &&
    RECONCILIATION_DECISION_INSTRUMENTS.every(
      (i) => before[i.key] === undefined && i.check(after[i.key]),
    );
  if (matchesShape) {
    return { ok: true, edge: "STAGED → DECIDED", instruments: instrumentKeys };
  }
  const extra = changed.filter((k) => k !== "status" && !instrumentKeys.includes(k));
  if (extra.length > 0) {
    return {
      ok: false,
      reason: `an ordinary modification of an existing reconciliation record: fields outside the decision instruments changed (${extra.join(", ")}) — only 'status' plus the decision fields (${instrumentKeys.join(", ")}) may change in a decision; route substantive amendments through an approved ACR`,
    };
  }
  return {
    ok: false,
    reason: `not a well-formed 'STAGED → DECIDED' decision: the changed fields must be exactly 'status' plus newly added, architect-role decision fields (${instrumentKeys.join(", ")})`,
  };
}
