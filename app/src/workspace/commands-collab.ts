/**
 * CAD-PARITY-016 command registry extension (Issue #112) — the
 * collaboration/recovery/scale vocabulary: durable versioned recovery
 * checkpoints + deterministic crash/session recovery, project-scoped
 * members/presence/comments/activity, versioned transactional changes with
 * explicit conflict + merge lineage, the durable background-regeneration
 * jobs, the fresh external-reference status surfaces and the observable
 * performance budgets.
 *
 * Commands (all ribbonTab "Collab" — a new tab value the hosts map; the
 * registry is host-agnostic; ONE mutating app-api call per command):
 *  - CKPT (CP) — capture a durable versioned checkpoint of the CURRENT
 *    canonical revision (cause manual; the bounded autosave policy also
 *    runs automatically). ONE recovery.checkpoint command.
 *  - RECOVER (REC) — deterministic crash/session recovery: restore the
 *    latest VALID checkpoint (or the given id — corrupt candidates are
 *    skipped with typed reasons, never silently repaired). ONE
 *    recovery.restore command.
 *  - COLLABJOIN (CJ) — register a project-scoped member with a closed role
 *    [VIEwer/COMmenter/EDitor]. ONE collab.join command.
 *  - PRESENCE (PRE) — the member heartbeat (liveness + the revision being
 *    viewed). ONE collab.presence command.
 *  - COMMENT — add a comment linked to a canonical target (the document,
 *    an element id, or a model revision) — bound to the document version at
 *    creation. ONE collab.comment command.
 *  - TXN — commit a versioned transactional change (one bounded setProps
 *    patch authored against a declared base version; ONE atomic versioned
 *    revision when the base is current, the explicit reproducible conflict
 *    record when the head moved). ONE collab.commit command.
 *  - MERGE — resolve an open conflict through the closed rebase/discard
 *    vocabulary (merge/resolution lineage is recorded). ONE collab.merge
 *    command.
 *  - JOB — queue + advance a durable background-regeneration job
 *    [DOCRegenerate/QTYRecalculate/STRMwarm]; each JOB invocation ticks ONE
 *    deterministic step of the named job (the serverless-honest durable
 *    execution model — no hidden background thread). jobs.create then
 *    jobs.tick.
 *  - CKPTLIST (CKL) — the recovery report surface (report.recovery ui
 *    action — the host renders the REAL recovery.list results).
 *  - COLLABSTATE (CSTAT) — the collaboration report surface (report.collab
 *    ui action — members/presence/activity through collab.state +
 *    collab.activity).
 *  - TXNLIST (TXNL) — the transaction/conflict lineage report surface
 *    (report.collab — the transactions are part of the same surface).
 *  - XREFSTATUS (XST) — the fresh external-reference status report surface
 *    (report.xrefs ui action — the explicit available/unavailable/
 *    unsupported outcomes + the canonical revision binding).
 *  - BUDGETS — the observable performance-budget report surface
 *    (report.budgets ui action — the deterministic P016 counters bound to
 *    the current canonical revision).
 *
 * Echo discipline (the P013/P015 convention): the prompt engine's echo
 * lines are BUILD-TIME static — the response-derived tails are appended by
 * the HOST from the command response. Every command is pure data + a pure
 * builder emitting App API commands; the dispatch lives in
 * app-api/contract.ts (server-side validation; the CADDocument is the
 * single canonical authority; the collab/recovery/job stores are
 * session-side support mechanisms — LOCK-019). The SAME registry drives
 * ribbon, palette, keyboard and command line on BOTH hosts (LOCK-004).
 */

import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  PromptStep,
  PromptValue,
} from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import { optionValue } from "./prompt-options.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-documentation.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, echo, ui };
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: string): string | null {
  const v = values[id];
  if (v === undefined) return fallback !== undefined ? fallback : null;
  if (v.kind !== "text") return fallback !== undefined ? fallback : null;
  return v.text;
}

const COLLAB_ROLES: readonly string[] = ["viewer", "commenter", "editor"];

function collabRoleOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "role", "viewer") !== null) return "viewer";
  if (optionValue(values, "role", "commenter") !== null) return "commenter";
  if (optionValue(values, "role", "editor") !== null) return "editor";
  const typed = (textValue(values, "role", "editor") ?? "").trim().toLowerCase();
  return COLLAB_ROLES.find((r) => r === typed) ?? null;
}

const COMMENT_TARGET_KINDS: readonly string[] = ["document", "element", "revision"];

function commentTargetKindOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "targetKind", "document") !== null) return "document";
  if (optionValue(values, "targetKind", "element") !== null) return "element";
  if (optionValue(values, "targetKind", "revision") !== null) return "revision";
  const typed = (textValue(values, "targetKind", "document") ?? "").trim().toLowerCase();
  return COMMENT_TARGET_KINDS.find((k) => k === typed) ?? null;
}

const JOB_KINDS_PROMPT: readonly string[] = ["docs.regenerate", "quantity.recalculate", "model.stream.warm"];

function jobKindOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "kind", "docs.regenerate") !== null) return "docs.regenerate";
  if (optionValue(values, "kind", "quantity.recalculate") !== null) return "quantity.recalculate";
  if (optionValue(values, "kind", "model.stream.warm") !== null) return "model.stream.warm";
  const typed = (textValue(values, "kind", "docs.regenerate") ?? "").trim().toLowerCase();
  return JOB_KINDS_PROMPT.find((k) => k === typed) ?? null;
}

// ---------------------------------------------------------------------------
// The registry extension.
// ---------------------------------------------------------------------------

export const COMMANDS_COLLAB: readonly WorkspaceCommand[] = [
  // --- CKPT — capture a durable versioned recovery checkpoint ---------------
  {
    id: "ckpt",
    name: "CKPT",
    aliases: ["CKP"],
    label: "Recovery checkpoint",
    description:
      "Capture a durable versioned checkpoint of the CURRENT canonical document revision (cause manual — the bounded autosave policy also runs automatically on every 5th version-changing command). The checkpoint records the document version, the content hash, the model revision head and the element count; recovery restores deterministically from it.",
    category: "document",
    ribbonTab: "Collab",
    steps: [],
    instant: () =>
      plan(
        [{ name: "recovery.checkpoint", payload: {} }],
        ["CKPT: durable versioned checkpoint of the current canonical revision."],
      ),
  },

  // --- RECOVER — deterministic crash/session recovery ------------------------
  {
    id: "recover",
    name: "RECOVER",
    aliases: ["RCV"],
    label: "Crash/session recovery",
    description:
      "Deterministically restore the latest VALID checkpoint (Enter) or the given checkpoint id. A pre-restore safety checkpoint of the current state is minted first; corrupt candidates are skipped with typed reasons — never a silent repair. The restored document IS the canonical document (rebuilt through the canonical open path).",
    category: "document",
    ribbonTab: "Collab",
    steps: [
      { id: "checkpointId", kind: "text", prompt: "Checkpoint id (Enter = latest valid):", optional: true },
    ],
    build: (values) => {
      const id = (textValue(values, "checkpointId", "") ?? "").trim();
      const payload: Record<string, unknown> = {};
      if (id.length > 0) payload.checkpointId = id;
      return plan(
        [{ name: "recovery.restore", payload }],
        [
          `RECOVER: deterministic recovery${id.length > 0 ? ` from ${id}` : " (latest valid checkpoint)"}.`,
        ],
      );
    },
  },

  // --- JOIN — register a project-scoped member -------------------------------
  {
    id: "collabjoin",
    name: "COLLABJOIN",
    aliases: ["CJ"],
    label: "Join project",
    description:
      "Register a project-scoped collaboration member with a closed role [VIEwer/COMmenter/EDitor]. Permissions are checked server-side on every collab action (typed collab_forbidden on violation).",
    category: "document",
    ribbonTab: "Collab",
    steps: [
      { id: "userId", kind: "text", prompt: "Member id (e.g. ekon, zai):" },
      {
        id: "role",
        kind: "text",
        prompt: "Role [VIEwer/COMmenter/EDitor] <editor>:",
        defaultValue: "editor",
        options: [
          { keyword: "VIE", label: "viewer", flag: true },
          { keyword: "COM", label: "commenter", flag: true },
          { keyword: "ED", label: "editor", flag: true },
        ],
      },
    ],
    build: (values) => {
      const userId = (textValue(values, "userId") ?? "").trim();
      if (userId.length === 0) {
        throw new Error("JOIN requires a non-empty member id.");
      }
      const role = collabRoleOf(values);
      if (role === null) {
        const typed = (textValue(values, "role", "editor") ?? "").trim();
        throw new Error(`JOIN role '${typed}' is not in the vocabulary [viewer, commenter, editor].`);
      }
      return plan(
        [{ name: "collab.join", payload: { userId, role } }],
        [`JOIN: member '${userId}' joined as ${role}.`],
      );
    },
  },

  // --- PRESENCE — the member heartbeat ----------------------------------------
  {
    id: "presence",
    name: "PRESENCE",
    aliases: ["PRE"],
    label: "Presence heartbeat",
    description:
      "The member presence heartbeat (liveness + the document revision the member is viewing — deterministic session-clock semantics; a member is active within 30 dispatched commands of their last heartbeat).",
    category: "view",
    ribbonTab: "Collab",
    steps: [{ id: "userId", kind: "text", prompt: "Member id:" }],
    build: (values) => {
      const userId = (textValue(values, "userId") ?? "").trim();
      if (userId.length === 0) {
        throw new Error("PRESENCE requires a non-empty member id.");
      }
      return plan(
        [{ name: "collab.presence", payload: { userId } }],
        [`PRESENCE: heartbeat for '${userId}'.`],
      );
    },
  },

  // --- COMMENT — add a comment linked to a canonical target -------------------
  {
    id: "comment",
    name: "COMMENT",
    aliases: ["CM"],
    label: "Add comment",
    description:
      "Add a project-scoped comment linked to a canonical target — the document, an element id, or a model revision — bound to the document version at creation. Requires the commenter role or above (typed collab_forbidden otherwise).",
    category: "document",
    ribbonTab: "Collab",
    steps: [
      { id: "userId", kind: "text", prompt: "Member id:" },
      { id: "body", kind: "text", prompt: "Comment body (1..500 chars):" },
      {
        id: "targetKind",
        kind: "text",
        prompt: "Target [Document/ELement/REVision] <document>:",
        defaultValue: "document",
        options: [
          { keyword: "D", label: "document", flag: true },
          { keyword: "EL", label: "element", flag: true },
          { keyword: "REV", label: "revision", flag: true },
        ],
      },
      { id: "targetRef", kind: "text", prompt: "Target element id / revision id (Enter = the document):", optional: true },
    ],
    build: (values) => {
      const userId = (textValue(values, "userId") ?? "").trim();
      if (userId.length === 0) {
        throw new Error("COMMENT requires a non-empty member id.");
      }
      const body = (textValue(values, "body") ?? "").trim();
      if (body.length === 0) {
        throw new Error("COMMENT requires a non-empty body.");
      }
      if (body.length > 500) {
        throw new Error("COMMENT body is bounded to 500 chars.");
      }
      const kind = commentTargetKindOf(values);
      if (kind === null) {
        const typed = (textValue(values, "targetKind", "document") ?? "").trim();
        throw new Error(
          `COMMENT target '${typed}' is not in the vocabulary [document, element, revision].`,
        );
      }
      const ref = (textValue(values, "targetRef", "") ?? "").trim();
      const payload: Record<string, unknown> = { userId, body };
      if (kind === "element") {
        if (ref.length === 0) {
          throw new Error("COMMENT element target requires the element id.");
        }
        payload.target = { kind, id: ref };
      } else if (kind === "revision") {
        if (ref.length === 0) {
          throw new Error("COMMENT revision target requires the revision id.");
        }
        payload.target = { kind, revisionRef: ref };
      } else {
        if (ref.length > 0) {
          throw new Error("COMMENT document target carries no id (leave the target ref empty).");
        }
        payload.target = { kind };
      }
      return plan(
        [{ name: "collab.comment", payload }],
        [`COMMENT: '${userId}' on ${kind}${ref.length > 0 ? ` ${ref}` : ""}.`],
      );
    },
  },

  // --- TXN — commit a versioned transactional change ---------------------------
  {
    id: "txn",
    name: "TXN",
    aliases: ["TX"],
    label: "Versioned transaction",
    description:
      "Commit a versioned transactional change: one bounded setProps patch authored against a declared base version. When the base is current the patch applies as ONE atomic versioned revision; when the head moved, the explicit reproducible conflict record is returned (intervening transactions + the overlapping canonical element ids) — resolve it through MERGE.",
    category: "modify",
    ribbonTab: "Collab",
    steps: [
      { id: "userId", kind: "text", prompt: "Member id (the author):" },
      { id: "elementId", kind: "text", prompt: "Element id to patch (e.g. el-000001):" },
      { id: "baseVersion", kind: "text", prompt: "Base document version (the version authored against):" },
      { id: "key", kind: "text", prompt: "Property key (e.g. FireRating):" },
      { id: "value", kind: "text", prompt: "Property value (a number or text):" },
    ],
    build: (values) => {
      const userId = (textValue(values, "userId") ?? "").trim();
      if (userId.length === 0) {
        throw new Error("TXN requires a non-empty member id.");
      }
      const elementId = (textValue(values, "elementId") ?? "").trim();
      if (elementId.length === 0) {
        throw new Error("TXN requires the element id.");
      }
      const baseText = (textValue(values, "baseVersion") ?? "").trim();
      const baseVersion = Number(baseText);
      if (!Number.isInteger(baseVersion) || baseVersion < 0) {
        throw new Error(`TXN base version '${baseText}' is not a non-negative integer.`);
      }
      const key = (textValue(values, "key") ?? "").trim();
      if (key.length === 0) {
        throw new Error("TXN requires a non-empty property key.");
      }
      const valueText = (textValue(values, "value") ?? "").trim();
      if (valueText.length === 0) {
        throw new Error("TXN requires a non-empty property value.");
      }
      const num = Number(valueText);
      const value: string | number = valueText !== "" && !Number.isNaN(num) ? num : valueText;
      return plan(
        [
          {
            name: "collab.commit",
            payload: {
              userId,
              baseVersion,
              edits: [{ type: "setProps", elementId, patch: { [key]: value } }],
            },
          },
        ],
        [
          `TXN: '${userId}' patches ${elementId} ${key}=${String(value)} at base v${baseVersion}.`,
        ],
      );
    },
  },

  // --- MERGE — resolve an open conflict ----------------------------------------
  {
    id: "merge",
    name: "MERGE",
    aliases: ["MG"],
    label: "Resolve conflict",
    description:
      "Resolve an open transaction conflict through the closed strategy vocabulary: REBase (non-overlapping edits re-apply onto the current head as ONE atomic versioned revision — the merge/resolution lineage records both parents) or DIScard (the transaction is abandoned with its lineage recorded). An overlapping rebase is refused typed (edit the transaction or discard — never a silent overwrite).",
    category: "modify",
    ribbonTab: "Collab",
    steps: [
      { id: "userId", kind: "text", prompt: "Member id (the resolver):" },
      { id: "transactionId", kind: "text", prompt: "Conflicted transaction id (e.g. txn-000002):" },
      {
        id: "strategy",
        kind: "text",
        prompt: "Strategy [REBase/DIScard]:",
        options: [
          { keyword: "RE", label: "rebase", flag: true },
          { keyword: "DIS", label: "discard", flag: true },
        ],
      },
    ],
    build: (values) => {
      const userId = (textValue(values, "userId") ?? "").trim();
      if (userId.length === 0) {
        throw new Error("MERGE requires a non-empty member id.");
      }
      const transactionId = (textValue(values, "transactionId") ?? "").trim();
      if (transactionId.length === 0) {
        throw new Error("MERGE requires the conflicted transaction id.");
      }
      let strategy: "rebase" | "discard";
      if (optionValue(values, "strategy", "rebase") !== null) {
        strategy = "rebase";
      } else if (optionValue(values, "strategy", "discard") !== null) {
        strategy = "discard";
      } else {
        const typed = (textValue(values, "strategy") ?? "").trim().toLowerCase();
        if (typed === "rebase" || typed === "discard") {
          strategy = typed;
        } else {
          throw new Error(`MERGE strategy '${typed}' is not in the vocabulary [rebase, discard].`);
        }
      }
      return plan(
        [{ name: "collab.merge", payload: { transactionId, userId, strategy } }],
        [`MERGE: ${strategy} ${transactionId} by '${userId}'.`],
      );
    },
  },

  // --- JOB — queue + tick a durable background-regeneration job ----------------
  {
    id: "job",
    name: "JOB",
    aliases: ["JB"],
    label: "Background job",
    description:
      "Queue a durable background-regeneration job [DOCRegenerate/QTYRecalculate/STRMwarm] and advance it ONE deterministic step per JOB invocation (the serverless-honest durable execution model — no hidden background thread). The job output is a report only — canonical persistence requires an explicit document command (worker output is never authority).",
    category: "document",
    ribbonTab: "Collab",
    steps: [
      {
        id: "kind",
        kind: "text",
        prompt: "Job kind [DOCRegenerate/QTYRecalculate/STRMwarm] <docs.regenerate>:",
        defaultValue: "docs.regenerate",
        options: [
          { keyword: "DOC", label: "docs.regenerate", flag: true },
          { keyword: "QTY", label: "quantity.recalculate", flag: true },
          { keyword: "STRM", label: "model.stream.warm", flag: true },
        ],
      },
      { id: "jobId", kind: "text", prompt: "Job id to tick (Enter = queue a new job):", optional: true },
    ],
    build: (values) => {
      const kind = jobKindOf(values);
      if (kind === null) {
        const typed = (textValue(values, "kind", "docs.regenerate") ?? "").trim();
        throw new Error(
          `JOB kind '${typed}' is not in the vocabulary [docs.regenerate, quantity.recalculate, model.stream.warm].`,
        );
      }
      const jobId = (textValue(values, "jobId", "") ?? "").trim();
      if (jobId.length > 0) {
        return plan(
          [{ name: "jobs.tick", payload: { jobId } }],
          [`JOB: tick ${jobId} (one deterministic step).`],
        );
      }
      return plan(
        [{ name: "jobs.create", payload: { kind } }],
        [`JOB: queue a ${kind} job.`],
      );
    },
  },

  // --- CKPTLIST — the recovery report surface ------------------------------------
  {
    id: "ckptlist",
    name: "CKPTLIST",
    aliases: ["CKL"],
    label: "Checkpoint list",
    description:
      "List the retained recovery checkpoints with the autosave policy and the recovery counters (retention, autosaves, restores). Renders through the report.recovery action — the host renders the REAL recovery.list query results.",
    category: "view",
    ribbonTab: "Collab",
    steps: [],
    instant: () =>
      plan([], ["CKPTLIST."], [{ action: "report.recovery" }, { action: "palette.show", payload: { palette: "collab" } }]),
  },

  // --- COLLABSTATE — the collaboration report surface -----------------------------
  {
    id: "collabstate",
    name: "COLLABSTATE",
    aliases: ["CSTAT"],
    label: "Collaboration state",
    description:
      "The project-scoped collaboration state: the member roster with computed presence liveness, the comment count and the bounded activity stream. Renders through the report.collab action — the host renders the REAL collab.state + collab.activity query results.",
    category: "view",
    ribbonTab: "Collab",
    steps: [],
    instant: () =>
      plan([], ["COLLABSTATE."], [{ action: "report.collab" }, { action: "palette.show", payload: { palette: "collab" } }]),
  },

  // --- TXNLIST — the transaction/conflict lineage report surface -------------------
  {
    id: "txnlist",
    name: "TXNLIST",
    aliases: ["TXNL"],
    label: "Transaction list",
    description:
      "The versioned transaction inventory with the conflict records and the merge/resolution lineage (base versions, resulting versions, parents, strategies). Renders through the report.collab action.",
    category: "view",
    ribbonTab: "Collab",
    steps: [],
    instant: () => plan([], ["TXNLIST."], [{ action: "report.collab" }, { action: "palette.show", payload: { palette: "collab" } }]),
  },

  // --- XREFSTATUS — the fresh external-reference status surface --------------------
  {
    id: "xrefstatus",
    name: "XREFSTATUS",
    aliases: ["XST"],
    label: "External reference status",
    description:
      "The fresh external-reference status: the explicit available/unavailable/unsupported outcomes (unresolved sources are unavailable; proprietary declared formats are unsupported), the source lineage (path + sha) and the canonical revision binding. Renders through the report.xrefs action — the host renders the REAL xrefs.status query results.",
    category: "view",
    ribbonTab: "Collab",
    steps: [],
    instant: () => plan([], ["XREFSTATUS."], [{ action: "report.xrefs" }, { action: "palette.show", payload: { palette: "collab" } }]),
  },

  // --- BUDGETS — the observable performance-budget report surface ------------------
  {
    id: "budgets",
    name: "BUDGETS",
    aliases: ["BUD"],
    label: "Performance budgets",
    description:
      "The declared observable performance-budget thresholds for the representative recovery/collaboration/large-model workflows + the deterministic P016 counters, bound to the current canonical revision. Renders through the report.budgets action — the host renders the REAL perf.budgets query results.",
    category: "view",
    ribbonTab: "Collab",
    steps: [],
    instant: () => plan([], ["BUDGETS."], [{ action: "report.budgets" }, { action: "palette.show", payload: { palette: "collab" } }]),
  },
];
