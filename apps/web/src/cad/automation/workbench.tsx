"use client";

/**
 * Offisos Automation / Extension / API Workbench — Web host surface
 * (CAD-PARITY-017 / Issue #116).
 *
 * A REAL workflow, not a mockup: the versioned typed capability discovery
 * table (the closed registry + the declared profile + the bounds, bound to
 * the current canonical revision); the automation principals with the
 * server-side authorization hook (the reused P016 role/ability table);
 * the bounded script inventory with manifest step summaries; the
 * deterministic governed script execution (every step through the SAME
 * App API command path — the only mutation route) with the reproducible
 * outcome digests and revision-bound step outcomes; the bounded, ordered,
 * explicitly scoped derived event feeds (a pure fold over the durable
 * canonical records — authoritative:false); and the capability-scoped
 * extension manifests (DATA ONLY — no executable code). The CADDocument
 * remains the canonical system of record (LOCK-019) — automation is a
 * client of the governed semantic API.
 */

import * as React from "react";
import {
  Bot,
  RefreshCw,
  Plug,
  ScrollText,
  Workflow,
  Radar,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import {
  automationAuthenticate,
  automationRegisterScript,
  automationRunScript,
  automationDeleteScript,
  automationSubscribe,
  automationUnsubscribe,
  automationRegisterExtension,
  automationCapabilities,
  automationPrincipals,
  automationScripts,
  automationRuns,
  automationEvents,
  automationExtensions,
  unwrapAutomationCapabilities,
  unwrapAutomationPrincipals,
  unwrapAutomationScripts,
  unwrapAutomationRuns,
  unwrapAutomationEvents,
  unwrapAutomationExtensions,
  unwrapAutomationRun,
  type AutomationCapabilitiesView,
  type AutomationPrincipalRow,
  type AutomationScriptRow,
  type AutomationRunRow,
  type AutomationEventsView,
  type AutomationExtensionRow,
} from "@/cad/client/http-transport";

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

const ROLE_BADGE: Record<string, string> = {
  viewer: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
  commenter: "rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300",
  editor: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

const ABILITY_BADGE: Record<string, string> = {
  read: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
  presence: "rounded border border-teal-300 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:border-teal-700 dark:bg-teal-950 dark:text-teal-300",
  comment: "rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300",
  transact: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  jobs: "rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

const SCOPE_BADGE: Record<string, string> = {
  document: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  project: "rounded border border-teal-300 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:border-teal-700 dark:bg-teal-950 dark:text-teal-300",
  jobs: "rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

const SECTIONS = ["capabilities", "principals", "scripts", "runs", "events", "extensions"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABEL: Record<Section, string> = {
  capabilities: "Capability Discovery",
  principals: "Principals & Authorization",
  scripts: "Scripts",
  runs: "Runs & Outcomes",
  events: "Events & Subscriptions",
  extensions: "Extensions",
};

/** The seed script the register form prefills (a governed three-step
 *  manifest: read → patch → read-back). */
const SEED_SCRIPT_JSON = `{
  "name": "fire-rating-patch",
  "profileId": "standard",
  "apiVersion": "1",
  "description": "Set the south wall fire rating through the governed App API",
  "steps": [
    { "stepId": "inspect", "kind": "appApi",
      "request": { "type": "query", "name": "document.getVersion", "payload": {} } },
    { "stepId": "patch", "kind": "appApi",
      "request": { "type": "command", "name": "document.applyEdit",
        "payload": { "edit": { "type": "setProps", "elementId": "wall-south", "patch": { "FireRating": 90 } } } } },
    { "stepId": "verify", "kind": "appApi",
      "request": { "type": "query", "name": "document.getVersion", "payload": {} } }
  ]
}`;

const SEED_EXTENSION_JSON = `{
  "extensionId": "qc-runner",
  "name": "QC Runner",
  "version": "1.0.0",
  "profileId": "standard",
  "apiVersion": "1",
  "capabilities": ["document.getVersion", "document.applyEdit"],
  "scripts": []
}`;

export function AutomationWorkbench(): React.JSX.Element {
  const [section, setSection] = React.useState<Section>("capabilities");

  // --- capabilities ------------------------------------------------------------
  const [capabilities, setCapabilities] = React.useState<AutomationCapabilitiesView | null>(null);
  const [capabilityFilter, setCapabilityFilter] = React.useState("");
  const [capabilityError, setCapabilityError] = React.useState<string | null>(null);
  const [capabilityBusy, setCapabilityBusy] = React.useState(false);

  // --- principals -----------------------------------------------------------------
  const [principals, setPrincipals] = React.useState<readonly AutomationPrincipalRow[] | null>(null);
  const [principalForm, setPrincipalForm] = React.useState({ principalId: "", role: "editor" });
  const [principalError, setPrincipalError] = React.useState<string | null>(null);
  const [principalBusy, setPrincipalBusy] = React.useState(false);

  // --- scripts ------------------------------------------------------------------------
  const [scripts, setScripts] = React.useState<readonly AutomationScriptRow[] | null>(null);
  const [scriptJson, setScriptJson] = React.useState(SEED_SCRIPT_JSON);
  const [scriptError, setScriptError] = React.useState<string | null>(null);
  const [scriptBusy, setScriptBusy] = React.useState(false);

  // --- runs ------------------------------------------------------------------------------
  const [runs, setRuns] = React.useState<readonly AutomationRunRow[] | null>(null);
  const [runForm, setRunForm] = React.useState({ principalId: "", scriptId: "" });
  const [runError, setRunError] = React.useState<string | null>(null);
  const [runBusy, setRunBusy] = React.useState(false);
  const [lastRun, setLastRun] = React.useState<AutomationRunRow | null>(null);

  // --- events + subscriptions ---------------------------------------------------------------
  const [events, setEvents] = React.useState<AutomationEventsView | null>(null);
  const [eventPrincipal, setEventPrincipal] = React.useState("");
  const [subScope, setSubScope] = React.useState<"document" | "project" | "jobs">("document");
  const [eventError, setEventError] = React.useState<string | null>(null);
  const [eventBusy, setEventBusy] = React.useState(false);

  // --- extensions --------------------------------------------------------------------------------
  const [extensions, setExtensions] = React.useState<readonly AutomationExtensionRow[] | null>(null);
  const [extensionJson, setExtensionJson] = React.useState(SEED_EXTENSION_JSON);
  const [extensionError, setExtensionError] = React.useState<string | null>(null);
  const [extensionBusy, setExtensionBusy] = React.useState(false);

  const describeFailure = (res: { ok: boolean; code?: string; message?: string }): string =>
    res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`;

  const refresh = React.useCallback(async (): Promise<void> => {
    const [capsRes, principalsRes, scriptsRes, runsRes, extRes] = await Promise.all([
      automationCapabilities(),
      automationPrincipals(),
      automationScripts(),
      automationRuns(),
      automationExtensions(),
    ]);
    setCapabilities(unwrapAutomationCapabilities(capsRes));
    setPrincipals(unwrapAutomationPrincipals(principalsRes));
    setScripts(unwrapAutomationScripts(scriptsRes));
    setRuns(unwrapAutomationRuns(runsRes));
    setExtensions(unwrapAutomationExtensions(extRes));
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      void cancelled;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // --- capability actions -------------------------------------------------------

  const onCapabilityRefresh = React.useCallback(async (): Promise<void> => {
    setCapabilityBusy(true);
    setCapabilityError(null);
    try {
      const res = await automationCapabilities();
      const caps = unwrapAutomationCapabilities(res);
      if (caps === null) setCapabilityError(describeFailure(res));
      else setCapabilities(caps);
    } finally {
      setCapabilityBusy(false);
    }
  }, []);

  // --- principal actions ---------------------------------------------------------------

  const onAuthenticate = React.useCallback(async (): Promise<void> => {
    setPrincipalBusy(true);
    setPrincipalError(null);
    try {
      const res = await automationAuthenticate(principalForm.principalId.trim(), principalForm.role as "viewer" | "commenter" | "editor");
      if (!res.ok) setPrincipalError(describeFailure(res));
      else await refresh();
    } finally {
      setPrincipalBusy(false);
    }
  }, [principalForm, refresh]);

  // --- script actions ------------------------------------------------------------------------

  const onRegisterScript = React.useCallback(async (): Promise<void> => {
    setScriptBusy(true);
    setScriptError(null);
    try {
      const parsed = JSON.parse(scriptJson) as Record<string, unknown>;
      const res = await automationRegisterScript(principalForm.principalId.trim(), parsed);
      if (!res.ok) setScriptError(describeFailure(res));
      else await refresh();
    } catch (e) {
      setScriptError(`invalid script JSON — ${(e as Error).message}`);
    } finally {
      setScriptBusy(false);
    }
  }, [scriptJson, principalForm.principalId, refresh]);

  const onDeleteScript = React.useCallback(async (scriptId: string): Promise<void> => {
    setScriptBusy(true);
    setScriptError(null);
    try {
      const res = await automationDeleteScript(principalForm.principalId.trim(), scriptId);
      if (!res.ok) setScriptError(describeFailure(res));
      else await refresh();
    } finally {
      setScriptBusy(false);
    }
  }, [principalForm.principalId, refresh]);

  // --- run actions ---------------------------------------------------------------------------

  const onRunScript = React.useCallback(async (): Promise<void> => {
    setRunBusy(true);
    setRunError(null);
    try {
      const res = await automationRunScript(runForm.principalId.trim(), runForm.scriptId.trim());
      if (!res.ok) {
        setRunError(describeFailure(res));
      } else {
        setLastRun(unwrapAutomationRun(res));
        await refresh();
      }
    } finally {
      setRunBusy(false);
    }
  }, [runForm, refresh]);

  // --- event/subscription actions -------------------------------------------------------------------

  const onEventRefresh = React.useCallback(async (): Promise<void> => {
    setEventBusy(true);
    setEventError(null);
    try {
      const res = await automationEvents(eventPrincipal.trim());
      const feed = unwrapAutomationEvents(res);
      if (feed === null) setEventError(describeFailure(res));
      else setEvents(feed);
    } finally {
      setEventBusy(false);
    }
  }, [eventPrincipal]);

  const onSubscribe = React.useCallback(async (): Promise<void> => {
    setEventBusy(true);
    setEventError(null);
    try {
      const res = await automationSubscribe(eventPrincipal.trim(), subScope);
      if (!res.ok) setEventError(describeFailure(res));
      else await onEventRefresh();
    } finally {
      setEventBusy(false);
    }
  }, [eventPrincipal, subScope, onEventRefresh]);

  const onUnsubscribe = React.useCallback(async (_subscriptionId: string): Promise<void> => {
    // (reserved — the table renders the current feed scope; removal goes
    // through the typed unsubscribe command below)
    setEventBusy(true);
    setEventError(null);
    try {
      const res = await automationUnsubscribe(eventPrincipal.trim(), _subscriptionId);
      if (!res.ok) setEventError(describeFailure(res));
      else await onEventRefresh();
    } finally {
      setEventBusy(false);
    }
  }, [eventPrincipal, onEventRefresh]);

  // --- extension actions -----------------------------------------------------------------------------

  const onRegisterExtension = React.useCallback(async (): Promise<void> => {
    setExtensionBusy(true);
    setExtensionError(null);
    try {
      const parsed = JSON.parse(extensionJson) as Record<string, unknown>;
      const res = await automationRegisterExtension(principalForm.principalId.trim(), parsed);
      if (!res.ok) setExtensionError(describeFailure(res));
      else await refresh();
    } catch (e) {
      setExtensionError(`invalid extension JSON — ${(e as Error).message}`);
    } finally {
      setExtensionBusy(false);
    }
  }, [extensionJson, principalForm.principalId, refresh]);

  const visibleCapabilities = React.useMemo(() => {
    if (capabilities === null) return [];
    const needle = capabilityFilter.trim().toLowerCase();
    if (needle === "") return [...capabilities.capabilities];
    return capabilities.capabilities.filter((c) => c.capabilityId.toLowerCase().includes(needle));
  }, [capabilities, capabilityFilter]);

  // --- render --------------------------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4" aria-hidden="true" />
              <CardTitle className="text-base">Automation / Extension / API</CardTitle>
              {capabilities !== null && (
                <Badge variant="outline" className="font-mono text-[10px]" aria-label={`automation API version ${capabilities.apiVersion}, profile ${capabilities.profile.profileId}`}>
                  api v{capabilities.apiVersion} · {capabilities.profile.profileId}
                </Badge>
              )}
              {capabilities !== null && (
                <Badge variant="outline" className="font-mono text-[10px]" aria-label={`${capabilities.capabilities.length} capabilities in the closed registry`}>
                  {capabilities.capabilities.length} capabilities
                </Badge>
              )}
              {capabilities !== null && (
                <Badge variant="outline" className="font-mono text-[10px]" aria-label={`the automation surface is bound to document version ${capabilities.documentVersion}`}>
                  doc v{capabilities.documentVersion}
                </Badge>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh()} aria-label="Refresh the automation surfaces">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
            </Button>
          </div>
          <CardDescription className="text-xs">
            The bounded, deterministic automation surface: scripts dispatch through the governed App API (the only mutation route);
            extensions are capability-scoped manifests (data only); the event feed is a derived non-authoritative fold. The CADDocument
            stays the canonical system of record.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Automation workbench sections">
            {SECTIONS.map((s) => (
              <Button
                key={s}
                variant={section === s ? "default" : "outline"}
                size="sm"
                onClick={() => setSection(s)}
                role="tab"
                aria-selected={section === s}
              >
                {SECTION_LABEL[s]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {section === "capabilities" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Radar className="h-4 w-4" aria-hidden="true" /> Capability discovery (automation.capabilities)</CardTitle>
            <CardDescription className="text-xs">
              {capabilities !== null
                ? `The closed v${capabilities.apiVersion} registry (${capabilities.profile.profileId}) — anything not listed is the typed automation_capability_unsupported decline, never a fabricated semantic. Bound to doc v${capabilities.documentVersion} (sha ${capabilities.contentHash.slice(0, 12)}…).`
                : "loading…"}
            </CardDescription>
            <div className="flex items-center gap-2 pt-1">
              <input
                className={INP + " max-w-72"}
                placeholder="filter by capability id…"
                value={capabilityFilter}
                onChange={(e) => setCapabilityFilter(e.target.value)}
                aria-label="Filter capabilities by id"
              />
              <Button variant="outline" size="sm" onClick={() => void onCapabilityRefresh()} disabled={capabilityBusy} aria-label="Refresh the capability table">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> reload
              </Button>
            </div>
            {capabilityError !== null && <p className="text-xs text-rose-600">{capabilityError}</p>}
          </CardHeader>
          <CardContent>
            {capabilities !== null && (
              <div className="flex flex-wrap gap-2 pb-2 text-[11px] text-stone-600 dark:text-stone-400">
                {Object.entries(capabilities.bounds).map(([k, v]) => (
                  <span key={k} className="rounded border border-stone-200 px-1.5 py-0.5 font-mono dark:border-stone-800">{k}: {v}</span>
                ))}
              </div>
            )}
            <ScrollArea className="max-h-72 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left font-mono">capability</th>
                    <th className="px-2 py-1 text-left">type</th>
                    <th className="px-2 py-1 text-left">ability</th>
                    <th className="px-2 py-1 text-left">description</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCapabilities.map((c) => (
                    <tr key={c.capabilityId} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1 font-mono">{c.capabilityId}</td>
                      <td className="px-2 py-1">
                        <span className={c.mutating ? RUN_STATUS_BADGE.completed : ABILITY_BADGE.read}>{c.requestType}</span>
                      </td>
                      <td className="px-2 py-1"><span className={ABILITY_BADGE[c.requiredAbility]}>{c.requiredAbility}</span></td>
                      <td className="px-2 py-1 text-stone-600 dark:text-stone-400">{c.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "principals" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><KeyRound className="h-4 w-4" aria-hidden="true" /> Principals & authorization (automation.authenticate)</CardTitle>
            <CardDescription className="text-xs">
              The authorization hook at the API boundary: principals register with a closed role drawn from the P016 collaboration
              vocabulary (viewer/commenter/editor) — the only permission table; every mutating automation request is checked
              server-side, typed on violation.
            </CardDescription>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input className={INP + " max-w-48"} placeholder="principal id (e.g. site-bot)" value={principalForm.principalId} onChange={(e) => setPrincipalForm({ ...principalForm, principalId: e.target.value })} aria-label="Principal id" />
              <select className={INP + " max-w-36"} value={principalForm.role} onChange={(e) => setPrincipalForm({ ...principalForm, role: e.target.value })} aria-label="Principal role">
                <option value="viewer">viewer</option>
                <option value="commenter">commenter</option>
                <option value="editor">editor</option>
              </select>
              <Button size="sm" onClick={() => void onAuthenticate()} disabled={principalBusy || principalForm.principalId.trim() === ""} aria-label="Register the automation principal">
                authenticate
              </Button>
            </div>
            {principalError !== null && <p className="text-xs text-rose-600">{principalError}</p>}
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-56 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left">principal</th>
                    <th className="px-2 py-1 text-left">role</th>
                    <th className="px-2 py-1 text-left">registered t=</th>
                    <th className="px-2 py-1 text-left">last run</th>
                  </tr>
                </thead>
                <tbody>
                  {(principals ?? []).map((p) => (
                    <tr key={p.principalId} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1 font-mono">{p.principalId}</td>
                      <td className="px-2 py-1"><span className={ROLE_BADGE[p.role]}>{p.role}</span></td>
                      <td className="px-2 py-1 font-mono">{p.registeredAt}</td>
                      <td className="px-2 py-1 font-mono">{p.lastRunAt !== null ? `t=${p.lastRunAt}` : "—"}</td>
                    </tr>
                  ))}
                  {principals !== null && principals.length === 0 && (
                    <tr><td colSpan={4} className="px-2 py-2 text-stone-500">No principals registered for this project.</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "scripts" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Workflow className="h-4 w-4" aria-hidden="true" /> Scripts (automation.registerScript)</CardTitle>
            <CardDescription className="text-xs">
              Bounded typed manifests — steps reference governed App API capabilities only (kind "appApi"); any other capability,
              kind or version is the typed unsupported decline. Manifests are data; there is no executable code.
            </CardDescription>
            <div className="flex flex-col gap-2 pt-1">
              <textarea
                className={INP + " max-h-48 min-h-32 font-mono text-[11px]"}
                value={scriptJson}
                onChange={(e) => setScriptJson(e.target.value)}
                aria-label="The script manifest JSON (registering principal: the principal form above)"
                spellCheck={false}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void onRegisterScript()} disabled={scriptBusy || principalForm.principalId.trim() === ""} aria-label="Register the script manifest for the principal above">
                  register script
                </Button>
                <span className="text-[11px] text-stone-500">registers as principal “{principalForm.principalId.trim() || "—"}”</span>
              </div>
            </div>
            {scriptError !== null && <p className="text-xs text-rose-600">{scriptError}</p>}
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left font-mono">id</th>
                    <th className="px-2 py-1 text-left">name</th>
                    <th className="px-2 py-1 text-left">principal</th>
                    <th className="px-2 py-1 text-left">steps</th>
                    <th className="px-2 py-1 text-left">extension</th>
                    <th className="px-2 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {(scripts ?? []).map((s) => (
                    <tr key={s.id} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1 font-mono">{s.id}</td>
                      <td className="px-2 py-1">{s.name}</td>
                      <td className="px-2 py-1 font-mono">{s.principalId}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-stone-600 dark:text-stone-400">{s.stepSummary.join(" → ")}</td>
                      <td className="px-2 py-1 font-mono">{s.extensionId ?? "—"}</td>
                      <td className="px-2 py-1 text-right">
                        <Button variant="outline" size="sm" onClick={() => void onDeleteScript(s.id)} disabled={scriptBusy || principalForm.principalId.trim() === ""} aria-label={`Delete script ${s.id}`}>
                          delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {scripts !== null && scripts.length === 0 && (
                    <tr><td colSpan={6} className="px-2 py-2 text-stone-500">No scripts registered for this project.</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "runs" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><ScrollText className="h-4 w-4" aria-hidden="true" /> Runs & outcomes (automation.runScript)</CardTitle>
            <CardDescription className="text-xs">
              Deterministic governed execution: every step dispatches through the SAME App API command path (validation,
              idempotency, durable appends, the autosave policy). The outcome digest is reproducible for identical canonical
              inputs + the declared profile.
            </CardDescription>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input className={INP + " max-w-48"} placeholder="principal id (the runner)" value={runForm.principalId} onChange={(e) => setRunForm({ ...runForm, principalId: e.target.value })} aria-label="Runner principal id" />
              <input className={INP + " max-w-44"} placeholder="script id (e.g. scr-000001)" value={runForm.scriptId} onChange={(e) => setRunForm({ ...runForm, scriptId: e.target.value })} aria-label="Script id to run" />
              <Button size="sm" onClick={() => void onRunScript()} disabled={runBusy || runForm.principalId.trim() === "" || runForm.scriptId.trim() === ""} aria-label="Run the script">
                run
              </Button>
            </div>
            {runError !== null && <p className="text-xs text-rose-600">{runError}</p>}
          </CardHeader>
          <CardContent className="space-y-2">
            {lastRun !== null && (
              <div className="rounded border bg-stone-50 p-2 text-xs dark:border-stone-800 dark:bg-stone-900">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={RUN_STATUS_BADGE[lastRun.status]}>{lastRun.status}</span>
                  <span className="font-mono">{lastRun.id}</span>
                  <span className="text-stone-600 dark:text-stone-400">{lastRun.scriptName} by {lastRun.principalId}</span>
                  <span className="font-mono text-[10px]">v{lastRun.startVersion} → v{lastRun.endVersion}</span>
                </div>
                <div className="pt-1 font-mono text-[10px] text-stone-600 dark:text-stone-400">digest {lastRun.outcomeDigest.slice(0, 24)}… (reproducible)</div>
                <Separator className="my-1.5" />
                <div className="space-y-0.5 font-mono text-[10px]">
                  {lastRun.steps.map((st) => (
                    <div key={st.stepId} className="flex flex-wrap gap-2">
                      <span className="min-w-20">{st.stepId}</span>
                      <span className="min-w-44">{st.requestName}</span>
                      <span className={st.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{st.ok ? "ok" : `${st.code}`}</span>
                      <span>v{st.documentVersion}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <ScrollArea className="max-h-72 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left font-mono">run</th>
                    <th className="px-2 py-1 text-left">script</th>
                    <th className="px-2 py-1 text-left">principal</th>
                    <th className="px-2 py-1 text-left">status</th>
                    <th className="px-2 py-1 text-left">versions</th>
                    <th className="px-2 py-1 text-left">digest</th>
                  </tr>
                </thead>
                <tbody>
                  {(runs ?? []).map((r) => (
                    <tr key={r.id} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1 font-mono">{r.id}</td>
                      <td className="px-2 py-1">{r.scriptName}</td>
                      <td className="px-2 py-1 font-mono">{r.principalId}</td>
                      <td className="px-2 py-1"><span className={RUN_STATUS_BADGE[r.status]}>{r.status}</span></td>
                      <td className="px-2 py-1 font-mono">v{r.startVersion} → v{r.endVersion}</td>
                      <td className="px-2 py-1 font-mono text-[10px]">{r.outcomeDigest.slice(0, 16)}…</td>
                    </tr>
                  ))}
                  {runs !== null && runs.length === 0 && (
                    <tr><td colSpan={6} className="px-2 py-2 text-stone-500">No runs recorded for this project yet.</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "events" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Radar className="h-4 w-4" aria-hidden="true" /> Events & subscriptions (automation.events / subscribe)</CardTitle>
            <CardDescription className="text-xs">
              Bounded (≤100), clock-ordered, explicitly scoped derived feeds — a pure fold over the durable canonical records
              (transactions, checkpoints, jobs, the activity stream). authoritative: false — never a background authority.
            </CardDescription>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input className={INP + " max-w-48"} placeholder="principal id" value={eventPrincipal} onChange={(e) => setEventPrincipal(e.target.value)} aria-label="Principal id for the event feed" />
              <select className={INP + " max-w-32"} value={subScope} onChange={(e) => setSubScope(e.target.value as "document" | "project" | "jobs")} aria-label="Subscription scope">
                <option value="document">document</option>
                <option value="project">project</option>
                <option value="jobs">jobs</option>
              </select>
              <Button size="sm" variant="outline" onClick={() => void onSubscribe()} disabled={eventBusy || eventPrincipal.trim() === ""} aria-label="Subscribe the principal to the scope">
                subscribe
              </Button>
              <Button size="sm" variant="outline" onClick={() => void onEventRefresh()} disabled={eventBusy || eventPrincipal.trim() === ""} aria-label="Refresh the scoped event feed">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> feed
              </Button>
            </div>
            {eventError !== null && <p className="text-xs text-rose-600">{eventError}</p>}
          </CardHeader>
          <CardContent className="space-y-2">
            {events !== null && (
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <Badge variant="outline" className="font-mono" aria-label={`${events.subscriptions} active subscriptions`}>{events.subscriptions} subscription(s)</Badge>
                <Badge variant="outline" className="font-mono" aria-label="the feed is bounded to 100 deliveries and non-authoritative">authoritative: {String(events.authoritative)} · bounded</Badge>
                <span className="font-mono text-stone-500">clock t={events.clock}</span>
              </div>
            )}
            <ScrollArea className="max-h-72 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left font-mono">t=</th>
                    <th className="px-2 py-1 text-left">scope</th>
                    <th className="px-2 py-1 text-left">kind</th>
                    <th className="px-2 py-1 text-left">binding</th>
                    <th className="px-2 py-1 text-left">detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(events?.events ?? []).map((e) => (
                    <tr key={e.eventId} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1 font-mono">{e.clock}</td>
                      <td className="px-2 py-1"><span className={SCOPE_BADGE[e.scope]}>{e.scope}</span></td>
                      <td className="px-2 py-1 font-mono">{e.kind}</td>
                      <td className="px-2 py-1 font-mono text-[10px]">{e.revisionBinding.recordKind}:{e.revisionBinding.recordId}</td>
                      <td className="px-2 py-1 text-stone-600 dark:text-stone-400">{e.detail}</td>
                    </tr>
                  ))}
                  {events !== null && events.events.length === 0 && (
                    <tr><td colSpan={5} className="px-2 py-2 text-stone-500">No subscribed events derived from the canonical records yet.</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "extensions" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Plug className="h-4 w-4" aria-hidden="true" /> Extensions (automation.registerExtension)</CardTitle>
            <CardDescription className="text-xs">
              Capability-scoped MANIFESTS — data only. Manifests carrying code/entry/url fields are rejected typed; v1 extensions
              cannot import or bypass protected engine/renderer/domain boundaries by construction. Registration requires the
              transact ability.
            </CardDescription>
            <div className="flex flex-col gap-2 pt-1">
              <textarea
                className={INP + " max-h-40 min-h-28 font-mono text-[11px]"}
                value={extensionJson}
                onChange={(e) => setExtensionJson(e.target.value)}
                aria-label="The extension manifest JSON (registering principal: the principal form above)"
                spellCheck={false}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void onRegisterExtension()} disabled={extensionBusy || principalForm.principalId.trim() === ""} aria-label="Register the extension manifest for the principal above">
                  register extension
                </Button>
                <span className="text-[11px] text-stone-500">registers as principal “{principalForm.principalId.trim() || "—"}”</span>
              </div>
            </div>
            {extensionError !== null && <p className="text-xs text-rose-600">{extensionError}</p>}
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-64 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left font-mono">extension</th>
                    <th className="px-2 py-1 text-left">version</th>
                    <th className="px-2 py-1 text-left">capabilities</th>
                    <th className="px-2 py-1 text-left">scripts</th>
                    <th className="px-2 py-1 text-left">registered by</th>
                  </tr>
                </thead>
                <tbody>
                  {(extensions ?? []).map((x) => (
                    <tr key={x.extensionId} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1">{x.name} <span className="font-mono text-[10px] text-stone-500">({x.extensionId})</span></td>
                      <td className="px-2 py-1 font-mono">{x.version}</td>
                      <td className="px-2 py-1 font-mono text-[10px]">{x.capabilities.join(", ")}</td>
                      <td className="px-2 py-1 font-mono text-[10px]">{x.scriptIds.length === 0 ? "—" : x.scriptIds.join(", ")}</td>
                      <td className="px-2 py-1 font-mono">{x.registeredBy}</td>
                    </tr>
                  ))}
                  {extensions !== null && extensions.length === 0 && (
                    <tr><td colSpan={5} className="px-2 py-2 text-stone-500">No extensions registered for this project.</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
