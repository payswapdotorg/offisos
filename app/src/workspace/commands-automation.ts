/**
 * CAD-PARITY-017 command registry extension (Issue #116) — the
 * automation/extension/API vocabulary: the versioned typed capability
 * discovery surface, the automation principal registration (the
 * authorization hook), the deterministic script execution, the scoped
 * event subscriptions and the automation report surfaces.
 *
 * Commands (all ribbonTab "Automation" — a new tab value the hosts map; the
 * registry is host-agnostic; ONE mutating app-api call per command):
 *  - AUTOAUTH (AU) — register a project-scoped automation principal with a
 *    closed role [VIEwer/COMmenter/EDitor] (the SAME P016 collaboration
 *    role vocabulary — no parallel identity subsystem). ONE
 *    automation.authenticate command.
 *  - AUTORUN (RUN) — execute a registered script deterministically: every
 *    step dispatches through the governed App API (the ONLY mutation
 *    route). ONE automation.runScript command.
 *  - AUTOSUB (ASUB) — register a bounded scoped event subscription
 *    [DOCument/PROject/JOBs]. ONE automation.subscribe command.
 *  - AUTOCAPS (CAP) — the capability discovery report surface
 *    (report.automation ui action — the host renders the REAL
 *    automation.capabilities query results).
 *  - AUTOLIST (LS) — the automation inventory report surface
 *    (report.automation — principals/scripts/runs/extensions).
 *  - AUTOEVENTS (EVT) — the derived scoped event feed report surface
 *    (report.automation — the bounded, ordered, explicitly scoped
 *    automation.events results).
 *
 * Echo discipline (the P013/P015/P016 convention): the prompt engine's echo
 * lines are BUILD-TIME static — the response-derived tails are appended by
 * the HOST from the command response. Every command is pure data + a pure
 * builder emitting App API commands; the dispatch lives in
 * app-api/contract.ts (server-side validation; the CADDocument is the
 * single canonical authority; automation is a client of the governed
 * semantic API — LOCK-019). The SAME registry drives ribbon, palette,
 * keyboard and command line on BOTH hosts (LOCK-004).
 */

import type {
  AppApiCommandPlanEntry,
  CommandPlan,
  PromptValue,
} from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import { optionValue } from "./prompt-options.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-collab.ts).
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

const AUTOMATION_ROLES: readonly string[] = ["viewer", "commenter", "editor"];

function automationRoleOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "role", "VIE") !== null) return "viewer";
  if (optionValue(values, "role", "COM") !== null) return "commenter";
  if (optionValue(values, "role", "ED") !== null) return "editor";
  const typed = (textValue(values, "role", "editor") ?? "").trim().toLowerCase();
  return AUTOMATION_ROLES.find((r) => r === typed) ?? null;
}

const AUTOMATION_SCOPES: readonly string[] = ["document", "project", "jobs"];

function automationScopeOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "scope", "DOC") !== null) return "document";
  if (optionValue(values, "scope", "PRO") !== null) return "project";
  if (optionValue(values, "scope", "JOB") !== null) return "jobs";
  const typed = (textValue(values, "scope", "document") ?? "").trim().toLowerCase();
  return AUTOMATION_SCOPES.find((s) => s === typed) ?? null;
}

// ---------------------------------------------------------------------------
// The registry extension.
// ---------------------------------------------------------------------------

export const COMMANDS_AUTOMATION: readonly WorkspaceCommand[] = [
  // --- AUTOAUTH — register an automation principal ---------------------------
  {
    id: "autoauth",
    name: "AUTOAUTH",
    aliases: ["AU"],
    label: "Automation principal",
    description:
      "Register a project-scoped automation principal with a closed role [VIEwer/COMmenter/EDitor] — the SAME P016 collaboration role vocabulary (the only permission table; server-side ability checks on every mutating automation request, typed automation_forbidden on violation).",
    category: "document",
    ribbonTab: "Automation",
    steps: [
      { id: "principalId", kind: "text", prompt: "Principal id (e.g. site-bot, qa-runner):" },
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
      const principalId = (textValue(values, "principalId") ?? "").trim();
      if (principalId.length === 0) {
        throw new Error("AUTOAUTH requires a non-empty principal id.");
      }
      const role = automationRoleOf(values);
      if (role === null) {
        const typed = (textValue(values, "role", "editor") ?? "").trim();
        throw new Error(`AUTOAUTH role '${typed}' is not in the vocabulary [viewer, commenter, editor].`);
      }
      return plan(
        [{ name: "automation.authenticate", payload: { principalId, role } }],
        [`AUTOAUTH: principal '${principalId}' registered as ${role}.`],
      );
    },
  },

  // --- AUTORUN — execute a registered script -----------------------------------
  {
    id: "autorun",
    name: "AUTORUN",
    aliases: ["RUN"],
    label: "Run automation script",
    description:
      "Execute a registered automation script deterministically (identify it by the minted script id, e.g. scr-000001). Every step dispatches through the governed App API — the ONLY mutation route; the run outcome digest is reproducible for identical canonical inputs + the declared profile.",
    category: "modify",
    ribbonTab: "Automation",
    steps: [
      { id: "principalId", kind: "text", prompt: "Principal id (the runner):" },
      { id: "scriptId", kind: "text", prompt: "Script id (e.g. scr-000001):" },
    ],
    build: (values) => {
      const principalId = (textValue(values, "principalId") ?? "").trim();
      if (principalId.length === 0) {
        throw new Error("AUTORUN requires a non-empty principal id.");
      }
      const scriptId = (textValue(values, "scriptId") ?? "").trim();
      if (scriptId.length === 0) {
        throw new Error("AUTORUN requires the script id.");
      }
      return plan(
        [{ name: "automation.runScript", payload: { principalId, scriptId } }],
        [`AUTORUN: '${principalId}' runs ${scriptId} (deterministic, governed steps).`],
      );
    },
  },

  // --- AUTOSUB — register a scoped event subscription ---------------------------
  {
    id: "autosub",
    name: "AUTOSUB",
    aliases: ["ASUB"],
    label: "Event subscription",
    description:
      "Register a bounded scoped event subscription [DOCument/PROject/JOBs] for an automation principal. The derived feed (AUTOEVENTS) is bounded, clock-ordered and explicitly scoped — a pure fold over the durable canonical records, never authority.",
    category: "view",
    ribbonTab: "Automation",
    steps: [
      { id: "principalId", kind: "text", prompt: "Principal id:" },
      {
        id: "scope",
        kind: "text",
        prompt: "Scope [DOCument/PROject/JOBs] <document>:",
        defaultValue: "document",
        options: [
          { keyword: "DOC", label: "document", flag: true },
          { keyword: "PRO", label: "project", flag: true },
          { keyword: "JOB", label: "jobs", flag: true },
        ],
      },
    ],
    build: (values) => {
      const principalId = (textValue(values, "principalId") ?? "").trim();
      if (principalId.length === 0) {
        throw new Error("AUTOSUB requires a non-empty principal id.");
      }
      const scope = automationScopeOf(values);
      if (scope === null) {
        const typed = (textValue(values, "scope", "document") ?? "").trim();
        throw new Error(`AUTOSUB scope '${typed}' is not in the vocabulary [document, project, jobs].`);
      }
      return plan(
        [{ name: "automation.subscribe", payload: { principalId, scope } }],
        [`AUTOSUB: '${principalId}' subscribed to the ${scope} scope.`],
      );
    },
  },

  // --- AUTOCAPS — the capability discovery report surface ------------------------
  {
    id: "autocaps",
    name: "AUTOCAPS",
    aliases: ["CAP"],
    label: "Automation capabilities",
    description:
      "The versioned typed capability discovery table: the closed automation capability registry (the governed App API requests scripts may reference), the declared profile and the bounds, bound to the current canonical revision. Renders through the report.automation action — the host renders the REAL automation.capabilities query results.",
    category: "view",
    ribbonTab: "Automation",
    steps: [],
    instant: () =>
      plan([], ["AUTOCAPS."], [{ action: "report.automation" }, { action: "palette.show", payload: { palette: "automation" } }]),
  },

  // --- AUTOLIST — the automation inventory report surface -------------------------
  {
    id: "autolist",
    name: "AUTOLIST",
    aliases: ["LS"],
    label: "Automation inventory",
    description:
      "The automation inventory: the registered principals, scripts (manifest step summaries), runs (revision-bound outcomes + the reproducible outcome digests) and extensions. Renders through the report.automation action.",
    category: "view",
    ribbonTab: "Automation",
    steps: [],
    instant: () =>
      plan([], ["AUTOLIST."], [{ action: "report.automation" }, { action: "palette.show", payload: { palette: "automation" } }]),
  },

  // --- AUTOEVENTS — the derived scoped event feed report surface --------------------
  {
    id: "autoevents",
    name: "AUTOEVENTS",
    aliases: ["EVT"],
    label: "Automation events",
    description:
      "The derived scoped event feed for a principal's subscriptions — bounded, clock-ordered, explicitly scoped, authoritative:false (a pure fold over the durable canonical records: transactions, checkpoints, jobs, the activity stream). Renders through the report.automation action.",
    category: "view",
    ribbonTab: "Automation",
    steps: [{ id: "principalId", kind: "text", prompt: "Principal id:" }],
    build: (values) => {
      const principalId = (textValue(values, "principalId") ?? "").trim();
      if (principalId.length === 0) {
        throw new Error("AUTOEVENTS requires a non-empty principal id.");
      }
      return plan(
        [],
        [`AUTOEVENTS: the scoped feed for '${principalId}'.`],
        [{ action: "report.automation", payload: { principalId } }, { action: "palette.show", payload: { palette: "automation" } }],
      );
    },
  },
];
