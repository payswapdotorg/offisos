/**
 * CAD-PARITY-017 (Issue #116) — the bounded automation/extension core:
 * the versioned capability registry (API-001), the typed principal/
 * script/extension/subscription records, the deterministic run bookkeeping
 * and the derived scoped event feed (additive, engine-free, Architecture
 * v1.1 FROZEN).
 *
 * Governing boundaries honored here (LOCK-003/018/019, the P016 precedents):
 *  - This module is pure TypeScript: no engine imports, no host imports, no
 *    environment reads, no wall-clock, no random, no crypto (the handler
 *    owns digest minting; this store stays data-pure).
 *  - Automation NEVER mutates the document directly: script steps are
 *    references to governed App API requests, dispatched by the handler
 *    through the SAME command path every direct caller uses. This module
 *    only records what was requested and what came back.
 *  - Extensions are capability-scoped MANIFESTS (data). There is no
 *    executable extension surface in v1, so extension code cannot import or
 *    bypass protected engine/renderer/domain boundaries by construction;
 *    manifest fields that would carry code ("code", "entry", "url",
 *    "module", "script") are rejected typed.
 *  - The event feed is a PURE FOLD over the durable canonical records
 *    (transactions / checkpoints / jobs / the activity stream): bounded,
 *    clock-ordered, explicitly scoped, authoritative:false — no hidden
 *    background authority, no new write path, zero impact on any pre-P017
 *    flow (byte-identical baselines preserved).
 *
 * Determinism: every record carries session-clock units; the store is a
 * pure function of the command sequence (fixture-pinnable across hosts,
 * backends and the wire — the P016 discipline, unchanged).
 */

import type { CommandName, QueryName } from "../contracts/app-api.js";
import {
  AUTOMATION_API_VERSION,
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_ID_MAX,
  AUTOMATION_MAX_EXTENSION_SCRIPTS,
  AUTOMATION_MAX_EVENTS,
  AUTOMATION_MAX_EXTENSIONS,
  AUTOMATION_MAX_PRINCIPALS,
  AUTOMATION_MAX_RUNS,
  AUTOMATION_MAX_SCRIPTS,
  AUTOMATION_MAX_STEPS,
  AUTOMATION_MAX_SUBSCRIPTIONS_PER_PRINCIPAL,
  AUTOMATION_MESSAGE_MAX,
  AUTOMATION_PROFILE,
  type AutomationAbility,
  type AutomationCapabilityView,
  type AutomationEventKind,
  type AutomationEventScope,
  type AutomationEventView,
  type AutomationExtensionManifest,
  type AutomationExtensionRecord,
  type AutomationExtensionView,
  type AutomationPersistedState,
  type AutomationPrincipalRecord,
  type AutomationPrincipalView,
  type AutomationRole,
  type AutomationRunRecord,
  type AutomationRunView,
  type AutomationScriptManifest,
  type AutomationScriptRecord,
  type AutomationScriptView,
  type AutomationStepManifest,
  type AutomationStepOutcome,
  type AutomationSubscriptionRecord,
  type AutomationSubscriptionView,
} from "../contracts/automation.js";
import {
  emptyAutomationPersistedState,
  type AutomationEventsView,
} from "../contracts/automation.js";
import { COLLAB_ROLE_ABILITIES, type SessionClock } from "../contracts/collab.js";
import type {
  ActivityView,
  CheckpointView,
  JobView,
  TransactionView,
} from "../contracts/collab.js";

// ---------------------------------------------------------------------------
// The typed failure (surfaces as an app-api typed err).
// ---------------------------------------------------------------------------

export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The capability registry (API-001 — the versioned public automation
// surface). The closed list of governed App API requests scripts may
// reference. Anything outside the list is the typed
// automation_capability_unsupported decline — never a fabricated semantic.
//
// Deliberately EXCLUDED (documented, honest):
//  - every automation.* request (no nested automation — bounded blast
//    radius; a script cannot register scripts or spawn runs);
//  - document.create/open/deserialize/serialize/save (document swaps and
//    file I/O stay interactive/governed-session operations in v1);
//  - engine-bound commands (geometry.prepare) and every host/UI surface;
//  - the interop/export writers (file exchange stays explicit).
// ---------------------------------------------------------------------------

interface AutomationCapabilityDef {
  readonly capabilityId: string;
  readonly requestName: CommandName | QueryName;
  readonly requestType: "command" | "query";
  readonly requiredAbility: AutomationAbility;
  readonly description: string;
}

function commandCapability(name: CommandName, requiredAbility: AutomationAbility, description: string): AutomationCapabilityDef {
  return { capabilityId: name, requestName: name, requestType: "command", requiredAbility, description };
}

function queryCapability(name: QueryName, requiredAbility: AutomationAbility, description: string): AutomationCapabilityDef {
  return { capabilityId: name, requestName: name, requestType: "query", requiredAbility, description };
}

export const AUTOMATION_CAPABILITIES: readonly AutomationCapabilityDef[] = [
  // --- read capabilities (ability "read") ---
  queryCapability("document.getState", "read", "The canonical document snapshot (version, elements, settings)."),
  queryCapability("document.getVersion", "read", "The canonical document version."),
  queryCapability("document.canUndo", "read", "Whether the editor undo stack is non-empty."),
  queryCapability("document.canRedo", "read", "Whether the editor redo stack is non-empty."),
  queryCapability("document.getSelection", "read", "The ephemeral editor selection (non-versioned)."),
  queryCapability("model.getHistory", "read", "The immutable canonical model revision log."),
  queryCapability("model.getGraphEvents", "read", "The deterministic Construction Graph event stream."),
  queryCapability("bim.getBuilding", "read", "The BIM building structure."),
  queryCapability("bim.getComponents", "read", "The component inventory with derived parametric state."),
  queryCapability("bim.getSemantics", "read", "The BIM semantics inventory."),
  queryCapability("components.list", "read", "The block-system component inventory."),
  queryCapability("materials.list", "read", "The material table."),
  queryCapability("materials.bom", "read", "The deterministic bill of materials."),
  queryCapability("grids.list", "read", "The grid entities with derived labels."),
  queryCapability("quantities.run", "read", "The deterministic revision-bound quantity takeoff."),
  queryCapability("quantities.rules", "read", "The closed canonical quantity rule table."),
  queryCapability("properties.list", "read", "The property-definition registry with lineage stats."),
  queryCapability("model.stream", "read", "One canonical id-sorted element page (bounded large-model access)."),
  queryCapability("model.streamStats", "read", "The bounded stream cache counters (non-authority)."),
  queryCapability("collab.state", "read", "The shared member roster with presence liveness."),
  queryCapability("collab.comments", "read", "The shared comment list."),
  queryCapability("collab.activity", "read", "The bounded shared activity stream."),
  queryCapability("collab.transactions", "read", "The shared versioned transaction lineage."),
  queryCapability("recovery.list", "read", "The retained durable checkpoint inventory."),
  queryCapability("jobs.list", "read", "The durable job inventory."),
  queryCapability("jobs.get", "read", "One durable job's state (bounded result retrieval)."),
  queryCapability("xrefs.status", "read", "The fresh external-reference status table."),
  queryCapability("perf.budgets", "read", "The declared performance budgets + deterministic counters."),
  // --- mutating capabilities (dispatched through the governed App API
  //     command path — the ONLY mutation route; abilities map onto the P016
  //     role table) ---
  commandCapability("collab.join", "presence", "Register a project-scoped collaboration member."),
  commandCapability("collab.presence", "presence", "The member presence heartbeat."),
  commandCapability("collab.comment", "comment", "Add a comment linked to a canonical target."),
  commandCapability("collab.resolveComment", "comment", "Record the resolving member of a comment."),
  commandCapability("document.applyEdit", "transact", "Apply one canonical document edit batch (the governed mutation path)."),
  commandCapability("document.setSelection", "transact", "Set the ephemeral editor selection."),
  commandCapability("document.undo", "transact", "Undo the last versioned change."),
  commandCapability("document.redo", "transact", "Redo the last undone change."),
  commandCapability("collab.commit", "transact", "Commit a versioned transactional change (explicit conflict semantics)."),
  commandCapability("collab.merge", "transact", "Resolve an open transaction conflict (rebase/discard lineage)."),
  commandCapability("jobs.create", "jobs", "Queue a durable background-regeneration job (the bounded job boundary)."),
  commandCapability("jobs.tick", "jobs", "Advance ONE job by ONE deterministic step (the bounded job boundary)."),
];

const AUTOMATION_CAPABILITY_INDEX: ReadonlyMap<string, AutomationCapabilityDef> = new Map(
  AUTOMATION_CAPABILITIES.map((c) => [c.capabilityId, c]),
);

/** The registry lookup (typed decline when the name is not a capability). */
export function automationCapabilityOf(name: string): AutomationCapabilityDef {
  const cap = AUTOMATION_CAPABILITY_INDEX.get(name);
  if (cap === undefined) {
    if (name.startsWith("automation.")) {
      throw new AutomationError(
        "automation_capability_unsupported",
        `automation requests are not scriptable capabilities (no nested automation in v1): '${name}'`,
      );
    }
    throw new AutomationError(
      "automation_capability_unsupported",
      `'${name}' is not an automation capability (v${AUTOMATION_API_VERSION}, profile '${AUTOMATION_PROFILE.profileId}' — see automation.capabilities for the closed list)`,
    );
  }
  return cap;
}

/** The registry view rows (the discovery surface). */
export function automationCapabilityViews(): readonly AutomationCapabilityView[] {
  return AUTOMATION_CAPABILITIES.map((c) => ({
    capabilityId: c.capabilityId,
    requestType: c.requestType,
    mutating: c.requestType === "command",
    requiredAbility: c.requiredAbility,
    description: c.description,
  }));
}

// ---------------------------------------------------------------------------
// The roles (the P016 vocabulary, reused — no parallel identity subsystem).
// ---------------------------------------------------------------------------

const AUTOMATION_ROLES: readonly AutomationRole[] = ["viewer", "commenter", "editor"];

/** The ability a role carries (the COLLAB_ROLE_ABILITIES table, unchanged). */
export function roleHasAbility(role: AutomationRole, ability: AutomationAbility): boolean {
  return COLLAB_ROLE_ABILITIES[role].has(ability);
}

// ---------------------------------------------------------------------------
// Manifest validation (typed declines; no fabricated semantics).
// ---------------------------------------------------------------------------

/** Manifest fields that would carry executable code — structurally rejected
 *  (the v1 extension is DATA ONLY; there is no code path from a manifest to
 *  an engine/renderer/domain boundary). */
const FORBIDDEN_CODE_FIELDS: readonly string[] = ["code", "entry", "entrypoint", "url", "module", "script", "main", "binary"];

function requireIdString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > AUTOMATION_ID_MAX) {
    throw new AutomationError("automation_bad_payload", `${what} must be a string of 1..${AUTOMATION_ID_MAX} chars`);
  }
  return value;
}

function requireDescription(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > AUTOMATION_DESCRIPTION_MAX) {
    throw new AutomationError("automation_bad_payload", `${what} must be a string of at most ${AUTOMATION_DESCRIPTION_MAX} chars`);
  }
  return value;
}

/** Minimal structural alias for a step request read from a payload. */
interface AutomationStepRequestShape {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly payload?: unknown;
}

/** Validate a script manifest (closed vocabularies, bounds, capability
 *  references, profile/version binding) and check the principal's role
 *  holds the ability every step requires (fail at registration, re-checked
 *  at run). Returns the normalized steps. */
export function validateScriptManifest(
  manifest: unknown,
  principalId: string,
  role: AutomationRole,
): { name: string; description: string | null; steps: readonly AutomationStepManifest[] } {
  const m = manifest as Partial<AutomationScriptManifest> | null;
  if (m === null || typeof m !== "object") {
    throw new AutomationError("automation_bad_payload", "script manifest must be an object");
  }
  const name = requireIdString(m.name, "script name");
  const description = requireDescription(m.description, "script description");
  if (m.profileId !== AUTOMATION_PROFILE.profileId) {
    throw new AutomationError(
      "automation_version_unsupported",
      `script profile '${String(m.profileId)}' is not in the v${AUTOMATION_API_VERSION} profile vocabulary ['${AUTOMATION_PROFILE.profileId}']`,
    );
  }
  if (m.apiVersion !== AUTOMATION_API_VERSION) {
    throw new AutomationError(
      "automation_version_unsupported",
      `script apiVersion '${String(m.apiVersion)}' does not match the automation API version '${AUTOMATION_API_VERSION}' (additive-only versioning — re-author the manifest)`,
    );
  }
  if (!Array.isArray(m.steps) || m.steps.length === 0 || m.steps.length > AUTOMATION_MAX_STEPS) {
    throw new AutomationError(
      "automation_script_invalid",
      `script steps must be an array of 1..${AUTOMATION_MAX_STEPS} entries (got ${Array.isArray(m.steps) ? m.steps.length : "non-array"})`,
    );
  }
  const seenStepIds = new Set<string>();
  const steps: AutomationStepManifest[] = [];
  for (const raw of m.steps) {
    const s = raw as Partial<AutomationStepManifest> | null;
    if (s === null || typeof s !== "object") {
      throw new AutomationError("automation_step_invalid", "each script step must be an object");
    }
    const stepId = requireIdString(s.stepId, "step stepId");
    if (seenStepIds.has(stepId)) {
      throw new AutomationError("automation_step_invalid", `duplicate stepId '${stepId}' (step ids are unique within a script)`);
    }
    seenStepIds.add(stepId);
    if (s.kind !== "appApi") {
      throw new AutomationError(
        "automation_step_invalid",
        `step kind '${String(s.kind)}' is outside the v${AUTOMATION_API_VERSION} step vocabulary ['appApi'] (no native code, no http, no eval — typed data only)`,
      );
    }
    const r = s.request as AutomationStepRequestShape | null | undefined;
    if (r === null || r === undefined || typeof r !== "object" || typeof r.name !== "string") {
      throw new AutomationError("automation_step_invalid", `step '${stepId}' requires request { type, name, payload }`);
    }
    if (r.type !== "command" && r.type !== "query") {
      throw new AutomationError(
        "automation_step_invalid",
        `step '${stepId}' request type must be 'command' or 'query' (got '${String(r.type)}')`,
      );
    }
    const cap = automationCapabilityOf(r.name);
    if (cap.requestType !== r.type) {
      throw new AutomationError(
        "automation_step_invalid",
        `step '${stepId}' declares request type '${r.type}' but capability '${cap.capabilityId}' is a ${cap.requestType}`,
      );
    }
    if (!roleHasAbility(role, cap.requiredAbility)) {
      throw new AutomationError(
        "automation_forbidden",
        `step '${stepId}' requires the '${cap.requiredAbility}' ability (principal '${principalId}' has role '${role}' — re-register with an adequate role or drop the step)`,
      );
    }
    const onError = s.onError === undefined ? "abort" : s.onError;
    if (onError !== "abort" && onError !== "continue") {
      throw new AutomationError(
        "automation_step_invalid",
        `step '${stepId}' onError must be 'abort' or 'continue' (got '${String(s.onError)}')`,
      );
    }
    steps.push({ stepId, kind: "appApi", request: { type: r.type, name: r.name, payload: r.payload }, onError });
  }
  return { name, description, steps };
}

/** Validate an extension manifest: the declared capabilities must exist in
 *  the registry, the manifest must carry NO executable-code fields, and
 *  every script must be valid AND stay within the declared capability set. */
export function validateExtensionManifest(
  manifest: unknown,
  principalId: string,
  role: AutomationRole,
): {
  extensionId: string;
  name: string;
  version: string;
  capabilities: readonly string[];
  scripts: readonly { name: string; description: string | null; steps: readonly AutomationStepManifest[] }[];
} {
  const m = manifest as Record<string, unknown> | null;
  if (m === null || typeof m !== "object") {
    throw new AutomationError("automation_bad_payload", "extension manifest must be an object");
  }
  for (const field of FORBIDDEN_CODE_FIELDS) {
    if (field in m) {
      throw new AutomationError(
        "automation_extension_invalid",
        `extension manifest carries a '${field}' field — v${AUTOMATION_API_VERSION} extensions are capability-scoped DATA ONLY (no executable code, no entry points, no URLs; scripts reference governed App API capabilities)`,
      );
    }
  }
  const extensionId = requireIdString(m.extensionId, "extension extensionId");
  const name = requireIdString(m.name, "extension name");
  if (typeof m.version !== "string" || m.version.length === 0 || m.version.length > 16) {
    throw new AutomationError("automation_bad_payload", "extension version must be a string of 1..16 chars");
  }
  if (m.profileId !== AUTOMATION_PROFILE.profileId) {
    throw new AutomationError(
      "automation_version_unsupported",
      `extension profile '${String(m.profileId)}' is not in the v${AUTOMATION_API_VERSION} profile vocabulary ['${AUTOMATION_PROFILE.profileId}']`,
    );
  }
  if (m.apiVersion !== AUTOMATION_API_VERSION) {
    throw new AutomationError(
      "automation_version_unsupported",
      `extension apiVersion '${String(m.apiVersion)}' does not match the automation API version '${AUTOMATION_API_VERSION}'`,
    );
  }
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
    throw new AutomationError("automation_extension_invalid", "extension capabilities must be a non-empty array");
  }
  const declared = new Set<string>();
  for (const raw of m.capabilities) {
    if (typeof raw !== "string") {
      throw new AutomationError("automation_extension_invalid", "extension capability entries must be strings");
    }
    const cap = automationCapabilityOf(raw); // typed automation_capability_unsupported
    declared.add(cap.capabilityId);
  }
  if (!Array.isArray(m.scripts) || m.scripts.length > AUTOMATION_MAX_EXTENSION_SCRIPTS) {
    throw new AutomationError(
      "automation_extension_invalid",
      `extension scripts must be an array of at most ${AUTOMATION_MAX_EXTENSION_SCRIPTS} entries`,
    );
  }
  const scripts: { name: string; description: string | null; steps: readonly AutomationStepManifest[] }[] = [];
  for (const raw of m.scripts) {
    const validated = validateScriptManifest(raw, principalId, role);
    for (const step of validated.steps) {
      if (!declared.has(step.request.name)) {
        throw new AutomationError(
          "automation_extension_invalid",
          `extension script '${validated.name}' step '${step.stepId}' uses capability '${step.request.name}' which is NOT in the extension's declared capability set (manifests are capability-scoped — declare it or drop the step)`,
        );
      }
    }
    scripts.push(validated);
  }
  return { extensionId, name, version: m.version, capabilities: [...declared], scripts };
}

// ---------------------------------------------------------------------------
// The persisted-state structural validation (LOCK-007: malformed records
// are rejected typed, never guessed or silently repaired).
// ---------------------------------------------------------------------------

export function validateAutomationPersistedState(value: unknown): AutomationPersistedState {
  const state = value as AutomationPersistedState;
  if (typeof state !== "object" || state === null) {
    throw new AutomationError("automation_bad_payload", "automation persisted section is not an object");
  }
  const problems: string[] = [];
  if (!Array.isArray(state.principals) || !Array.isArray(state.scripts) || !Array.isArray(state.runs) ||
      !Array.isArray(state.subscriptions) || !Array.isArray(state.extensions)) {
    problems.push("principals/scripts/runs/subscriptions/extensions arrays are all required");
  }
  const seq = state.seq as Record<string, unknown> | undefined;
  if (
    seq === undefined || typeof seq !== "object" ||
    typeof seq.principal !== "number" || typeof seq.script !== "number" ||
    typeof seq.run !== "number" || typeof seq.subscription !== "number" ||
    typeof seq.extension !== "number"
  ) {
    problems.push("seq counters malformed");
  }
  if (problems.length > 0) {
    throw new AutomationError("automation_bad_payload", `automation persisted section failed validation: ${problems.join("; ")}`);
  }
  return state;
}

// ---------------------------------------------------------------------------
// The bounded project-scoped automation store.
// ---------------------------------------------------------------------------

export class AutomationStore {
  private readonly principals = new Map<string, AutomationPrincipalRecord>();
  private readonly scripts: AutomationScriptRecord[] = [];
  private readonly runs: AutomationRunRecord[] = [];
  private readonly subscriptions: AutomationSubscriptionRecord[] = [];
  private readonly extensions: AutomationExtensionRecord[] = [];
  private seq = { principal: 0, script: 0, run: 0, subscription: 0, extension: 0 };

  // --- principals (the authorization hook) ---------------------------------

  /** Register an automation principal with a closed role (the P016
   *  vocabulary — the only permission table). One record per principalId;
   *  a duplicate is the typed automation_principal_exists decline. */
  authenticate(principalId: string, role: AutomationRole, clock: SessionClock): AutomationPrincipalView {
    if (typeof principalId !== "string" || principalId.length === 0 || principalId.length > AUTOMATION_ID_MAX) {
      throw new AutomationError("automation_bad_payload", `automation.authenticate requires a principalId (1..${AUTOMATION_ID_MAX} chars)`);
    }
    if (!AUTOMATION_ROLES.includes(role)) {
      throw new AutomationError(
        "automation_bad_payload",
        `automation.authenticate role must be one of ${AUTOMATION_ROLES.join(" | ")} (the P016 collaboration role vocabulary — reused, no parallel identity subsystem)`,
      );
    }
    if (this.principals.has(principalId)) {
      throw new AutomationError("automation_principal_exists", `principal '${principalId}' is already registered for this project`);
    }
    if (this.principals.size >= AUTOMATION_MAX_PRINCIPALS) {
      throw new AutomationError(
        "automation_principal_limit",
        `the project automation principal registry is bounded to ${AUTOMATION_MAX_PRINCIPALS}`,
      );
    }
    this.seq.principal += 1;
    const record: AutomationPrincipalRecord = {
      principalId,
      role,
      registeredAt: clock,
      lastRunAt: null,
    };
    this.principals.set(principalId, record);
    return { ...record };
  }

  /** The registered-principal roster. */
  principalList(): readonly AutomationPrincipalView[] {
    return [...this.principals.values()].map((p) => ({ ...p }));
  }

  /** The server-side ability check (typed declines — the authorization hook
   *  every mutating automation request passes through). */
  requireAbility(principalId: string, ability: AutomationAbility): AutomationPrincipalRecord {
    const record = this.principals.get(principalId);
    if (record === undefined) {
      throw new AutomationError(
        "automation_not_authenticated",
        `principal '${principalId}' is not registered for this project (automation.authenticate first)`,
      );
    }
    if (!roleHasAbility(record.role, ability)) {
      throw new AutomationError(
        "automation_forbidden",
        `principal '${principalId}' (role ${record.role}) may not '${ability}' (requires a role carrying that ability)`,
      );
    }
    return record;
  }

  /** The per-step check the run engine performs before dispatching: the
   *  capability must exist AND the principal's role must carry its
   *  required ability (defense in depth — registration pre-validated the
   *  same constraint, the run re-checks it). */
  requireStepAbility(principalId: string, step: AutomationStepManifest): AutomationCapabilityDef {
    const cap = automationCapabilityOf(step.request.name);
    if (cap.requestType !== step.request.type) {
      throw new AutomationError(
        "automation_step_invalid",
        `step '${step.stepId}' declares request type '${step.request.type}' but capability '${cap.capabilityId}' is a ${cap.requestType}`,
      );
    }
    this.requireAbility(principalId, cap.requiredAbility);
    return cap;
  }

  principalById(principalId: string): AutomationPrincipalRecord | null {
    return this.principals.get(principalId) ?? null;
  }

  // --- scripts --------------------------------------------------------------

  /** Register a script (the manifest is validated + permission-checked
   *  against the principal's role; typed declines name the offending
   *  step). */
  registerScript(
    principalId: string,
    manifest: unknown,
    clock: SessionClock,
    extensionId: string | null = null,
  ): AutomationScriptView {
    const principal = this.principals.get(principalId);
    if (principal === undefined) {
      throw new AutomationError(
        "automation_not_authenticated",
        `principal '${principalId}' is not registered for this project (automation.authenticate first)`,
      );
    }
    const validated = validateScriptManifest(manifest, principalId, principal.role);
    if (this.scripts.length >= AUTOMATION_MAX_SCRIPTS) {
      throw new AutomationError("automation_script_limit", `the project script registry is bounded to ${AUTOMATION_MAX_SCRIPTS}`);
    }
    this.seq.script += 1;
    const record: AutomationScriptRecord = {
      id: `scr-${String(this.seq.script).padStart(6, "0")}`,
      name: validated.name,
      description: validated.description,
      profileId: AUTOMATION_PROFILE.profileId,
      apiVersion: AUTOMATION_API_VERSION,
      principalId,
      extensionId,
      steps: validated.steps,
      registeredAt: clock,
    };
    this.scripts.push(record);
    return this.scriptView(record);
  }

  scriptList(): readonly AutomationScriptView[] {
    return this.scripts.map((s) => this.scriptView(s));
  }

  scriptById(scriptId: string): AutomationScriptRecord {
    const record = this.scripts.find((s) => s.id === scriptId);
    if (record === undefined) {
      throw new AutomationError("automation_script_not_found", `script '${scriptId}' does not exist in this project`);
    }
    return record;
  }

  /** Remove a script (the owning principal, or any principal holding the
   *  transact ability — the editor-level control). */
  deleteScript(principalId: string, scriptId: string): AutomationScriptView {
    const record = this.scriptById(scriptId);
    const principal = this.principals.get(principalId);
    if (principal === undefined) {
      throw new AutomationError(
        "automation_not_authenticated",
        `principal '${principalId}' is not registered for this project (automation.authenticate first)`,
      );
    }
    const owns = record.principalId === principalId;
    const editor = roleHasAbility(principal.role, "transact");
    if (!owns && !editor) {
      throw new AutomationError(
        "automation_forbidden",
        `script '${scriptId}' may only be removed by its owner '${record.principalId}' or a principal holding the 'transact' ability (got '${principalId}', role ${principal.role})`,
      );
    }
    this.scripts.splice(this.scripts.indexOf(record), 1);
    return this.scriptView(record);
  }

  // --- extensions (capability-scoped DATA only) ------------------------------

  /** Register an extension manifest (typed declines on unknown
   *  capabilities, code fields, or scripts escaping the declared set) and
   *  install its scripts. Requires the transact ability (the controlled
   *  third-party surface). */
  registerExtension(principalId: string, manifest: unknown, clock: SessionClock): {
    extension: AutomationExtensionView;
    scripts: readonly AutomationScriptView[];
  } {
    const principal = this.requireAbility(principalId, "transact");
    const extensionIdRaw = (manifest as { extensionId?: unknown } | null)?.extensionId;
    if (typeof extensionIdRaw === "string" && this.extensions.some((e) => e.extensionId === extensionIdRaw)) {
      throw new AutomationError(
        "automation_extension_exists",
        `extension '${extensionIdRaw}' is already registered for this project`,
      );
    }
    if (this.extensions.length >= AUTOMATION_MAX_EXTENSIONS) {
      throw new AutomationError("automation_extension_limit", `the project extension registry is bounded to ${AUTOMATION_MAX_EXTENSIONS}`);
    }
    const validated = validateExtensionManifest(manifest, principalId, principal.role);
    if (this.scripts.length + validated.scripts.length > AUTOMATION_MAX_SCRIPTS) {
      throw new AutomationError("automation_script_limit", `registering this extension would exceed the project script bound (${AUTOMATION_MAX_SCRIPTS})`);
    }
    this.seq.extension += 1;
    const scriptIds: string[] = [];
    const scriptViews: AutomationScriptView[] = [];
    for (const script of validated.scripts) {
      const view = this.registerScript(
        principalId,
        {
          name: script.name,
          profileId: AUTOMATION_PROFILE.profileId,
          apiVersion: AUTOMATION_API_VERSION,
          ...(script.description !== null ? { description: script.description } : {}),
          steps: script.steps,
        },
        clock,
        validated.extensionId,
      );
      scriptIds.push(view.id);
      scriptViews.push(view);
    }
    const record: AutomationExtensionRecord = {
      extensionId: validated.extensionId,
      name: validated.name,
      version: validated.version,
      profileId: AUTOMATION_PROFILE.profileId,
      apiVersion: AUTOMATION_API_VERSION,
      capabilities: validated.capabilities,
      scriptIds,
      registeredAt: clock,
      registeredBy: principalId,
    };
    this.extensions.push(record);
    return { extension: this.extensionView(record), scripts: scriptViews };
  }

  extensionList(): readonly AutomationExtensionView[] {
    return this.extensions.map((e) => this.extensionView(e));
  }

  // --- runs (the deterministic execution record) -------------------------------

  /** Record a completed/failed run (the outcome data is computed by the
   *  handler; this mints the run id, marks the principal's lastRunAt and
   *  trims the bounded history — oldest first). */
  recordRun(input: {
    scriptId: string;
    scriptName: string;
    principalId: string;
    status: "completed" | "failed";
    steps: readonly AutomationStepOutcome[];
    startedAt: SessionClock;
    startVersion: number;
    endVersion: number;
    outcomeDigest: string;
  }, clock: SessionClock): AutomationRunView {
    const principal = this.principals.get(input.principalId);
    if (principal !== undefined) principal.lastRunAt = clock;
    for (const step of input.steps) {
      if (step.message !== undefined && step.message.length > AUTOMATION_MESSAGE_MAX) {
        throw new AutomationError("automation_bad_payload", "run step messages are pre-truncated by the handler");
      }
    }
    this.seq.run += 1;
    const record: AutomationRunRecord = {
      id: `run-${String(this.seq.run).padStart(6, "0")}`,
      scriptId: input.scriptId,
      scriptName: input.scriptName,
      principalId: input.principalId,
      status: input.status,
      steps: input.steps,
      startedAt: input.startedAt,
      finishedAt: clock,
      startVersion: input.startVersion,
      endVersion: input.endVersion,
      outcomeDigest: input.outcomeDigest,
    };
    this.runs.push(record);
    while (this.runs.length > AUTOMATION_MAX_RUNS) this.runs.shift();
    return this.runView(record);
  }

  runList(): readonly AutomationRunView[] {
    return this.runs.map((r) => this.runView(r));
  }

  // --- subscriptions (the scoped event delivery declarations) -------------------

  /** Register a subscription (bounded per principal; the closed scope
   *  vocabulary; the optional kind filter validated against the activity
   *  vocabulary). */
  subscribe(principalId: string, scope: AutomationEventScope, kinds: readonly string[] | null, clock: SessionClock): AutomationSubscriptionView {
    const principal = this.principals.get(principalId);
    if (principal === undefined) {
      throw new AutomationError(
        "automation_not_authenticated",
        `principal '${principalId}' is not registered for this project (automation.authenticate first)`,
      );
    }
    if (scope !== "document" && scope !== "project" && scope !== "jobs") {
      throw new AutomationError(
        "automation_bad_payload",
        `subscription scope must be one of document | project | jobs (got '${String(scope)}')`,
      );
    }
    let normalizedKinds: readonly string[] | null = null;
    if (kinds !== null && kinds !== undefined) {
      if (!Array.isArray(kinds) || kinds.length === 0) {
        throw new AutomationError("automation_bad_payload", "subscription kinds must be a non-empty array or null");
      }
      for (const k of kinds) {
        if (typeof k !== "string" || !AUTOMATION_EVENT_KINDS.includes(k)) {
          throw new AutomationError(
            "automation_bad_payload",
            `subscription kind '${String(k)}' is not in the activity vocabulary ${AUTOMATION_EVENT_KINDS.join(" | ")}`,
          );
        }
      }
      normalizedKinds = [...kinds];
    }
    const mine = this.subscriptions.filter((s) => s.principalId === principalId);
    if (mine.length >= AUTOMATION_MAX_SUBSCRIPTIONS_PER_PRINCIPAL) {
      throw new AutomationError(
        "automation_subscription_limit",
        `principal '${principalId}' already holds the subscription bound (${AUTOMATION_MAX_SUBSCRIPTIONS_PER_PRINCIPAL})`,
      );
    }
    this.seq.subscription += 1;
    const record: AutomationSubscriptionRecord = {
      id: `sub-${String(this.seq.subscription).padStart(6, "0")}`,
      principalId,
      scope,
      kinds: normalizedKinds,
      createdAt: clock,
    };
    this.subscriptions.push(record);
    return this.subscriptionView(record);
  }

  unsubscribe(principalId: string, subscriptionId: string): AutomationSubscriptionView {
    const record = this.subscriptions.find(
      (s) => s.id === subscriptionId && s.principalId === principalId,
    );
    if (record === undefined) {
      throw new AutomationError(
        "automation_bad_payload",
        `subscription '${subscriptionId}' of principal '${principalId}' does not exist`,
      );
    }
    this.subscriptions.splice(this.subscriptions.indexOf(record), 1);
    return this.subscriptionView(record);
  }

  subscriptionList(): readonly AutomationSubscriptionView[] {
    return this.subscriptions.map((s) => this.subscriptionView(s));
  }

  // --- views --------------------------------------------------------------------

  private scriptView(s: AutomationScriptRecord): AutomationScriptView {
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      profileId: s.profileId,
      apiVersion: s.apiVersion,
      principalId: s.principalId,
      extensionId: s.extensionId,
      stepCount: s.steps.length,
      stepSummary: s.steps.map((step) => `${step.stepId}:${step.request.type}:${step.request.name}`),
      registeredAt: s.registeredAt,
    };
  }

  private runView(r: AutomationRunRecord): AutomationRunView {
    return {
      id: r.id,
      scriptId: r.scriptId,
      scriptName: r.scriptName,
      principalId: r.principalId,
      status: r.status,
      steps: r.steps,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      startVersion: r.startVersion,
      endVersion: r.endVersion,
      outcomeDigest: r.outcomeDigest,
      reproducible: true,
    };
  }

  private subscriptionView(s: AutomationSubscriptionRecord): AutomationSubscriptionView {
    return {
      id: s.id,
      principalId: s.principalId,
      scope: s.scope,
      kinds: s.kinds,
      createdAt: s.createdAt,
    };
  }

  private extensionView(e: AutomationExtensionRecord): AutomationExtensionView {
    return {
      extensionId: e.extensionId,
      name: e.name,
      version: e.version,
      profileId: e.profileId,
      apiVersion: e.apiVersion,
      capabilities: e.capabilities,
      scriptIds: e.scriptIds,
      registeredAt: e.registeredAt,
      registeredBy: e.registeredBy,
    };
  }

  // --- the durable/shared persistence boundary (the P016 port, extended) ------

  /** Rehydrate from the durable project record's automation section
   *  (absent for every pre-P017 record — the empty store; deep-copied into
   *  mutable session-side records). */
  static rehydrate(persisted: AutomationPersistedState | undefined): AutomationStore {
    const store = new AutomationStore();
    if (persisted === undefined) return store;
    for (const p of persisted.principals) {
      store.principals.set(p.principalId, {
        principalId: p.principalId,
        role: p.role,
        registeredAt: p.registeredAt,
        lastRunAt: p.lastRunAt,
      });
    }
    store.scripts.push(
      ...persisted.scripts.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        profileId: s.profileId,
        apiVersion: s.apiVersion,
        principalId: s.principalId,
        extensionId: s.extensionId,
        steps: s.steps.map((step) => ({ ...step, request: { ...step.request } })),
        registeredAt: s.registeredAt,
      })),
    );
    store.runs.push(
      ...persisted.runs.map((r) => ({
        id: r.id,
        scriptId: r.scriptId,
        scriptName: r.scriptName,
        principalId: r.principalId,
        status: r.status,
        steps: r.steps.map((s) => ({ ...s })),
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        startVersion: r.startVersion,
        endVersion: r.endVersion,
        outcomeDigest: r.outcomeDigest,
      })),
    );
    store.subscriptions.push(
      ...persisted.subscriptions.map((s) => ({
        id: s.id,
        principalId: s.principalId,
        scope: s.scope,
        kinds: s.kinds === null ? null : [...s.kinds],
        createdAt: s.createdAt,
      })),
    );
    store.extensions.push(
      ...persisted.extensions.map((e) => ({
        extensionId: e.extensionId,
        name: e.name,
        version: e.version,
        profileId: e.profileId,
        apiVersion: e.apiVersion,
        capabilities: [...e.capabilities],
        scriptIds: [...e.scriptIds],
        registeredAt: e.registeredAt,
        registeredBy: e.registeredBy,
      })),
    );
    store.seq = { ...persisted.seq };
    return store;
  }

  /** Dehydrate into the serializable durable record section. */
  dehydrate(): AutomationPersistedState {
    return {
      principals: [...this.principals.values()].map((p) => ({
        principalId: p.principalId,
        role: p.role,
        registeredAt: p.registeredAt,
        lastRunAt: p.lastRunAt,
      })),
      scripts: this.scripts.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        profileId: s.profileId,
        apiVersion: s.apiVersion,
        principalId: s.principalId,
        extensionId: s.extensionId,
        steps: s.steps.map((step) => ({ ...step, request: { ...step.request } })),
        registeredAt: s.registeredAt,
      })),
      runs: this.runs.map((r) => ({
        id: r.id,
        scriptId: r.scriptId,
        scriptName: r.scriptName,
        principalId: r.principalId,
        status: r.status,
        steps: r.steps.map((s) => ({ ...s })),
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        startVersion: r.startVersion,
        endVersion: r.endVersion,
        outcomeDigest: r.outcomeDigest,
      })),
      subscriptions: this.subscriptions.map((s) => ({
        id: s.id,
        principalId: s.principalId,
        scope: s.scope,
        kinds: s.kinds === null ? null : [...s.kinds],
        createdAt: s.createdAt,
      })),
      extensions: this.extensions.map((e) => ({
        extensionId: e.extensionId,
        name: e.name,
        version: e.version,
        profileId: e.profileId,
        apiVersion: e.apiVersion,
        capabilities: [...e.capabilities],
        scriptIds: [...e.scriptIds],
        registeredAt: e.registeredAt,
        registeredBy: e.registeredBy,
      })),
      seq: { ...this.seq },
    };
  }
}

// ---------------------------------------------------------------------------
// The derived scoped event feed (a PURE FOLD over the durable canonical
// records — bounded, clock-ordered, explicitly scoped, authoritative:false;
// no new write path, no background authority, zero impact on pre-P017
// flows).
// ---------------------------------------------------------------------------

/** The full activity vocabulary (the event-kind filter domain). */
export const AUTOMATION_EVENT_KINDS: readonly string[] = [
  "member.joined",
  "comment.added",
  "comment.resolved",
  "transaction.committed",
  "transaction.conflict",
  "transaction.merged",
  "transaction.discarded",
  "checkpoint.saved",
  "recovery.restored",
  "job.created",
  "job.succeeded",
  "job.failed",
];

/** The fixed source precedence for clock ties (a single serialized project
 *  event can mint several records at the same clock — the order stays
 *  deterministic). */
const SOURCE_PRECEDENCE: Record<"transaction" | "checkpoint" | "job" | "activity", number> = {
  transaction: 0,
  checkpoint: 1,
  job: 2,
  activity: 3,
};

/** Derive the bounded, ordered, scoped event feed for a principal's
 *  subscriptions from the durable project record sections. Pure: the same
 *  persisted state + the same subscriptions → the same feed. */
export function deriveAutomationEvents(
  sources: {
    readonly transactions: readonly TransactionView[];
    readonly checkpoints: readonly CheckpointView[];
    readonly jobs: readonly JobView[];
    readonly activity: readonly ActivityView[];
  },
  subscriptions: readonly {
    readonly id: string;
    readonly principalId: string;
    readonly scope: AutomationEventScope;
    readonly kinds: readonly string[] | null;
  }[],
  principalId: string,
  clock: SessionClock,
): AutomationEventsView {
  const all: AutomationEventView[] = [];
  // --- document scope: versioned transactions + checkpoints (revision-bound) ---
  for (const t of sources.transactions) {
    const kind: AutomationEventKind =
      t.status === "applied" ? "transaction.committed"
        : t.status === "merged" ? "transaction.merged"
          : t.status === "conflict" ? "transaction.conflict"
            : "transaction.discarded";
    all.push({
      eventId: `evt:transaction:${t.id}`,
      kind,
      scope: "document",
      clock: t.recordedAt,
      detail: `transaction ${t.id} ${t.status} (base v${t.baseVersion}${t.resultingVersion !== null ? ` → v${t.resultingVersion}` : ""}, ${t.editCount} edit(s), author ${t.author})`,
      revisionBinding: {
        recordKind: "transaction",
        recordId: t.id,
        documentVersion: t.resultingVersion,
      },
    });
  }
  for (const c of sources.checkpoints) {
    all.push({
      eventId: `evt:checkpoint:${c.id}`,
      kind: "checkpoint.saved",
      scope: "document",
      clock: c.at,
      detail: `checkpoint ${c.id} saved (cause ${c.cause}, v${c.documentVersionNumber}, ${c.elementCount} element(s))`,
      revisionBinding: {
        recordKind: "checkpoint",
        recordId: c.id,
        documentVersion: c.documentVersionNumber,
      },
    });
  }
  // --- jobs scope: the durable job records ----------------------------------
  for (const j of sources.jobs) {
    const kind: AutomationEventKind = j.status === "succeeded" ? "job.succeeded" : j.status === "failed" ? "job.failed" : "job.created";
    all.push({
      eventId: `evt:job:${j.id}`,
      kind,
      scope: "jobs",
      clock: j.status === "succeeded" || j.status === "failed" ? (j.finishedAt ?? j.createdAt) : j.createdAt,
      detail: `job ${j.id} ${j.status} (${j.kind}, step ${j.step}/${j.totalSteps})`,
      revisionBinding: {
        recordKind: "job",
        recordId: j.id,
        documentVersion: null,
      },
    });
  }
  // --- project scope: the shared activity stream ----------------------------
  for (const a of sources.activity) {
    all.push({
      eventId: `evt:activity:${a.seq}`,
      kind: a.kind,
      scope: "project",
      clock: a.at,
      detail: a.detail,
      revisionBinding: {
        recordKind: "activity",
        recordId: String(a.seq),
        documentVersion: null,
      },
    });
  }
  // --- the deterministic order: clock asc → source precedence → record id ---
  all.sort((x, y) => {
    if (x.clock !== y.clock) return x.clock - y.clock;
    const px = SOURCE_PRECEDENCE[x.revisionBinding.recordKind];
    const py = SOURCE_PRECEDENCE[y.revisionBinding.recordKind];
    if (px !== py) return px - py;
    return x.eventId < y.eventId ? -1 : x.eventId > y.eventId ? 1 : 0;
  });
  // --- the scoped, bounded delivery (per subscription filter, last N) --------
  const scoped = all.filter((e) =>
    subscriptions.some(
      (s) => s.scope === e.scope && (s.kinds === null || s.kinds.includes(e.kind)),
    ),
  );
  const delivered = scoped.slice(-AUTOMATION_MAX_EVENTS);
  return {
    principalId,
    events: delivered,
    authoritative: false,
    bounded: true,
    subscriptions: subscriptions.length,
    clock,
  };
}

// Re-export the empty-state helper for the persistence boundary.
export { emptyAutomationPersistedState };
