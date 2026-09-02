"use client";

/**
 * Offisos Schedules / Properties / Quantities Workbench — Web host surface
 * (CAD-PARITY-015 / Issue #110).
 *
 * A REAL workflow, not a mockup: the document-owned property-definition
 * registry with live lineage statistics (values counted from the canonical
 * element property-set overlay — there is no parallel source of truth);
 * the schedules/indexes surface with the P015 engine powers (pd: columns,
 * property-driven conditions, deterministic sort, calculated fields,
 * grouping with subtotals + grand totals, presentation format); and the
 * revision-bound quantity takeoff over the closed canonical rule table
 * (the material BOM with density-derived mass, the honest skipped list,
 * the RevisionRef binding of the model head).
 */

import * as React from "react";
import { Calculator, Database, Layers3, ListOrdered, RefreshCw, Sigma, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import {
  propertyDefCreate,
  propertyDefRemove,
  propertiesList,
  quantitiesRun,
  quantitiesRules,
  scheduleCreate,
  schedulesList,
  schedulesRun,
  unwrapPropertiesList,
  unwrapQuantityReport,
  unwrapQuantityRules,
  unwrapSchedulesList,
  unwrapScheduleRun,
  type PropertyDefRow,
  type QuantityReport,
  type QuantityRulesReport,
  type ScheduleColumn,
  type ScheduleGroupRow,
  type SchedulesListRow,
} from "@/cad/client/http-transport";

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

// --- the local run state (the schedules.run response mirror) -------------------

interface ScheduleRunView {
  readonly schedule: { id: string; name: string; source: string; grouping?: readonly string[] };
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly sha256: string;
  readonly groups?: readonly ScheduleGroupRow[];
  readonly totals?: readonly (number | null)[];
}

function cellOf(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return String(value);
}

const TYPE_BADGE: Record<string, string> = {
  text: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
  number: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  boolean: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

export function SchedulesWorkbench(): React.JSX.Element {
  // --- the property-definition registry --------------------------------------
  const [propertyDefs, setPropertyDefs] = React.useState<readonly PropertyDefRow[] | null>(null);
  const [pdForm, setPdForm] = React.useState({ name: "", set: "PSetA", key: "", type: "number", unit: "", appliesTo: "" });
  const [pdError, setPdError] = React.useState<string | null>(null);
  const [pdBusy, setPdBusy] = React.useState(false);

  // --- the schedules/indexes surface -------------------------------------------
  const [schedules, setSchedules] = React.useState<readonly SchedulesListRow[] | null>(null);
  const [scheduleRun, setScheduleRun] = React.useState<ScheduleRunView | null>(null);
  const [schError, setSchError] = React.useState<string | null>(null);
  const [schBusy, setSchBusy] = React.useState(false);
  const [schForm, setSchForm] = React.useState({ name: "", source: "elements", grouping: "", conditionSet: "PSetA", conditionKey: "", conditionOp: "gt", conditionValue: "0" });

  // --- the quantities surface ----------------------------------------------------
  const [quantityReport, setQuantityReport] = React.useState<QuantityReport | null>(null);
  const [rulesReport, setRulesReport] = React.useState<QuantityRulesReport | null>(null);
  const [qtyError, setQtyError] = React.useState<string | null>(null);
  const [qtyBusy, setQtyBusy] = React.useState(false);
  const [qtyForm, setQtyForm] = React.useState<{ source: "elements" | "components" | "materials"; groupBy: "none" | "type" | "story" | "material" }>(
    { source: "elements", groupBy: "type" },
  );

  const describeFailure = (res: { ok: boolean; code?: string; message?: string }): string =>
    res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`;

  const refresh = React.useCallback(async (): Promise<void> => {
    const [pdRes, schRes, rulesRes] = await Promise.all([propertiesList(), schedulesList(), quantitiesRules()]);
    const pdRows = unwrapPropertiesList(pdRes);
    if (pdRows !== null) setPropertyDefs(pdRows);
    else if (!pdRes.ok) setPdError(`[properties.list] ${describeFailure(pdRes)}`);
    const schRows = unwrapSchedulesList(schRes);
    if (schRows !== null) setSchedules(schRows);
    else if (!schRes.ok) setSchError(`[schedules.list] ${describeFailure(schRes)}`);
    const rules = unwrapQuantityRules(rulesRes);
    if (rules !== null) setRulesReport(rules);
    else if (!rulesRes.ok) setQtyError(`[quantities.rules] ${describeFailure(rulesRes)}`);
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

  // --- property-definition actions -----------------------------------------------

  const onCreatePropertyDef = React.useCallback(async (): Promise<void> => {
    const name = pdForm.name.trim();
    const set = pdForm.set.trim();
    const key = pdForm.key.trim();
    if (name.length === 0 || set.length === 0 || key.length === 0) {
      setPdError("PROPDEF: name, set and key are required.");
      return;
    }
    setPdBusy(true);
    setPdError(null);
    try {
      const res = await propertyDefCreate({
        name,
        set,
        key,
        type: pdForm.type as "text" | "number" | "boolean",
        ...(pdForm.type === "number" && pdForm.unit.trim().length > 0 ? { unit: pdForm.unit.trim() } : {}),
        ...(pdForm.appliesTo.trim().length > 0
          ? { appliesTo: pdForm.appliesTo.split(",").map((s) => s.trim()).filter((s) => s.length > 0) }
          : {}),
      });
      if (!res.ok) {
        setPdError(`[property.create] ${res.code} — ${res.message}`);
      } else {
        setPdForm((f) => ({ ...f, name: "", key: "", unit: "" }));
        await refresh();
      }
    } finally {
      setPdBusy(false);
    }
  }, [pdForm, refresh]);

  const onRemovePropertyDef = React.useCallback(async (id: string): Promise<void> => {
    setPdBusy(true);
    setPdError(null);
    try {
      const res = await propertyDefRemove(id);
      if (!res.ok) {
        setPdError(`[property.remove] ${res.code} — ${res.message}`);
      } else {
        await refresh();
      }
    } finally {
      setPdBusy(false);
    }
  }, [refresh]);

  // --- schedule actions -------------------------------------------------------------

  const onCreateSchedule = React.useCallback(async (): Promise<void> => {
    const name = schForm.name.trim();
    if (name.length === 0) {
      setSchError("SCHEDULE: a name is required.");
      return;
    }
    setSchBusy(true);
    setSchError(null);
    try {
      const columns: ScheduleColumn[] = [
        { key: "id", label: "Id" },
        { key: "type", label: "Type" },
        { key: "material", label: "Material" },
      ];
      // The pd: column of the FIRST property definition (elements/components
      // sources only — the registry-driven property field).
      const firstDef = (propertyDefs ?? [])[0];
      const dynamic = schForm.source === "elements" || schForm.source === "components";
      if (firstDef !== undefined && dynamic) {
        columns.push({ key: `pd:${firstDef.id}`, label: firstDef.name });
      }
      // A calculated field over the pd: column (the bounded formula grammar).
      if (firstDef !== undefined && firstDef.type === "number" && dynamic) {
        columns.push({
          key: "calc:score",
          label: `${firstDef.name} × 2`,
          formula: { op: "mul", left: { column: `pd:${firstDef.id}` }, right: { value: 2 } },
        });
      }
      const payload: Parameters<typeof scheduleCreate>[0] = {
        name,
        source: schForm.source as Parameters<typeof scheduleCreate>[0]["source"],
        columns,
      };
      const grouping = schForm.grouping.trim();
      if (grouping.length > 0) payload.grouping = [grouping];
      const condKey = schForm.conditionKey.trim();
      if (condKey.length > 0 && dynamic) {
        const raw = Number(schForm.conditionValue);
        const value = schForm.conditionValue !== "" && Number.isFinite(raw) ? raw : schForm.conditionValue;
        payload.conditions = [
          {
            set: schForm.conditionSet.trim(),
            key: condKey,
            op: schForm.conditionOp as "eq" | "ne" | "gt" | "lt" | "contains",
            value,
          },
        ];
        if (firstDef !== undefined) payload.sort = [{ key: `pd:${firstDef.id}`, direction: "desc" }];
      }
      const res = await scheduleCreate(payload);
      if (!res.ok) {
        setSchError(`[schedule.create] ${res.code} — ${res.message}`);
      } else {
        setSchForm((f) => ({ ...f, name: "" }));
        await refresh();
      }
    } finally {
      setSchBusy(false);
    }
  }, [schForm, propertyDefs, refresh]);

  const onRunSchedule = React.useCallback(async (id: string): Promise<void> => {
    setSchBusy(true);
    setSchError(null);
    try {
      const res = await schedulesRun(id);
      const run = unwrapScheduleRun(res);
      if (run === null) {
        setSchError(`[schedules.run] ${describeFailure(res)}`);
      } else {
        setScheduleRun(run as ScheduleRunView);
      }
    } finally {
      setSchBusy(false);
    }
  }, []);

  // --- quantity actions ---------------------------------------------------------------

  const onRunQuantities = React.useCallback(async (): Promise<void> => {
    setQtyBusy(true);
    setQtyError(null);
    try {
      const res = await quantitiesRun({ source: qtyForm.source, groupBy: qtyForm.groupBy });
      const report = unwrapQuantityReport(res);
      if (report === null) {
        setQtyError(`[quantities.run] ${describeFailure(res)}`);
      } else {
        setQuantityReport(report);
      }
    } finally {
      setQtyBusy(false);
    }
  }, [qtyForm]);

  // --- the schedule run table with group segments -------------------------------------

  const runView = React.useMemo(() => {
    if (scheduleRun === null) return null;
    const rows = scheduleRun.rows;
    const groups = scheduleRun.groups;
    const lines: { kind: "header" | "row" | "subtotal" | "total"; cells: readonly string[]; label?: string }[] = [];
    if (groups === undefined) {
      for (const row of rows) lines.push({ kind: "row", cells: row });
    } else {
      for (const group of groups) {
        lines.push({ kind: "header", cells: [], label: group.key.join(" / ") === "" ? "-" : group.key.join(" / ") });
        for (let i = group.firstRowIndex; i < group.firstRowIndex + group.rowCount; i++) {
          const row = rows[i];
          if (row !== undefined) lines.push({ kind: "row", cells: row });
        }
        lines.push({
          kind: "subtotal",
          cells: group.subtotals.map((s) => (s === null ? "" : `Σ ${s}`)),
          label: `Subtotal (${group.rowCount})`,
        });
      }
      if (scheduleRun.totals !== undefined) {
        lines.push({
          kind: "total",
          cells: scheduleRun.totals.map((s) => (s === null ? "" : `Σ ${s}`)),
          label: `Grand total (${rows.length})`,
        });
      }
    }
    return lines;
  }, [scheduleRun]);

  const columnLabels = React.useMemo(() => {
    if (scheduleRun === null) return [] as string[];
    const columns = (scheduleRun.schedule as unknown as { columns?: { label: string }[] }).columns ?? [];
    return columns.map((c) => c.label);
  }, [scheduleRun]);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="schedules-workbench">
      <ScrollArea className="h-full">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 pb-16">
          <header className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Schedules, Properties &amp; Quantities</h2>
              <p className="text-xs text-muted-foreground">
                CAD-PARITY-015 — document-owned definitions; values resolve from the canonical Construction Graph semantics; revision-bound takeoffs.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={pdBusy || schBusy || qtyBusy} data-testid="schedules-refresh">
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
            </Button>
          </header>

          {/* --- Property definitions ------------------------------------------ */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4" /> Property Definitions
                <Badge variant="secondary">{propertyDefs?.length ?? 0}</Badge>
              </CardTitle>
              <CardDescription>
                Document-owned declarations (prd-NNNNNN). The VALUES live on the elements&apos; property-set overlay — properties.list counts them from
                that single source (type mismatches reported, never coerced).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="propdef-form">
                <div className="space-y-1">
                  <label htmlFor="pd-name" className="text-xs font-medium">Name</label>
                  <input id="pd-name" aria-label="Property definition name" className={INP} value={pdForm.name} onChange={(e) => setPdForm((f) => ({ ...f, name: e.target.value }))} placeholder="Fire rating" data-testid="propdef-name" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="pd-set" className="text-xs font-medium">Set</label>
                  <input id="pd-set" aria-label="Property set name" className={INP} value={pdForm.set} onChange={(e) => setPdForm((f) => ({ ...f, set: e.target.value }))} placeholder="PSetA" data-testid="propdef-set" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="pd-key" className="text-xs font-medium">Key</label>
                  <input id="pd-key" aria-label="Property key" className={INP} value={pdForm.key} onChange={(e) => setPdForm((f) => ({ ...f, key: e.target.value }))} placeholder="FireRating" data-testid="propdef-key" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="pd-type" className="text-xs font-medium">Type</label>
                  <select
                    id="pd-type"
                    aria-label="Property type"
                    className={INP}
                    value={pdForm.type}
                    onChange={(e) => setPdForm((f) => ({ ...f, type: e.target.value }))}
                    data-testid="propdef-type"
                  >
                    <option value="text">text</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="pd-unit" className="text-xs font-medium">Unit (number)</label>
                  <input id="pd-unit" aria-label="Unit" className={INP} value={pdForm.unit} onChange={(e) => setPdForm((f) => ({ ...f, unit: e.target.value }))} placeholder="min" data-testid="propdef-unit" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="pd-applies" className="text-xs font-medium">Applies to</label>
                  <input id="pd-applies" aria-label="Applies to types" className={INP} value={pdForm.appliesTo} onChange={(e) => setPdForm((f) => ({ ...f, appliesTo: e.target.value }))} placeholder="bim.wall,bim.slab" data-testid="propdef-applies" />
                </div>
              </div>
              <Button size="sm" onClick={() => void onCreatePropertyDef()} disabled={pdBusy} data-testid="propdef-create">
                <Sigma className="mr-1 h-3.5 w-3.5" /> Create definition
              </Button>
              {pdError !== null && (
                <p className="text-xs text-red-600 dark:text-red-400" data-testid="propdef-error">{pdError}</p>
              )}
              <div className="max-h-64 overflow-y-auto rounded border" data-testid="propdef-table">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr>
                      <th className="p-1.5 text-left font-medium">Id</th>
                      <th className="p-1.5 text-left font-medium">Name</th>
                      <th className="p-1.5 text-left font-medium">Address</th>
                      <th className="p-1.5 text-left font-medium">Type</th>
                      <th className="p-1.5 text-right font-medium">Values</th>
                      <th className="p-1.5 text-right font-medium">Match</th>
                      <th className="p-1.5 text-right font-medium">Mismatch</th>
                      <th className="p-1.5 text-left font-medium" aria-label="Remove" />
                    </tr>
                  </thead>
                  <tbody>
                    {(propertyDefs ?? []).map((d) => (
                      <tr key={d.id} className="border-t" data-testid={`propdef-row-${d.id}`}>
                        <td className="p-1.5 font-mono">{d.id}</td>
                        <td className="p-1.5">{d.name}</td>
                        <td className="p-1.5 font-mono">{d.set}.{d.key}</td>
                        <td className="p-1.5"><span className={TYPE_BADGE[d.type] ?? ""}>{d.type}{d.unit !== undefined ? ` ${d.unit}` : ""}</span></td>
                        <td className="p-1.5 text-right font-mono">{d.elementsWithValue}</td>
                        <td className="p-1.5 text-right font-mono">{d.typeMatches}</td>
                        <td className="p-1.5 text-right font-mono">{d.typeMismatches}</td>
                        <td className="p-1.5 text-right">
                          <Button size="sm" variant="ghost" onClick={() => void onRemovePropertyDef(d.id)} disabled={pdBusy} data-testid={`propdef-remove-${d.id}`} aria-label={`Remove ${d.name}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {propertyDefs !== null && propertyDefs.length === 0 && (
                      <tr><td colSpan={8} className="p-2 text-center text-muted-foreground" data-testid="propdef-empty">No property definitions — the form above (or the PROPDEF command) creates one.</td></tr>
                    )}
                    {propertyDefs === null && (
                      <tr><td colSpan={8} className="p-2 text-center text-muted-foreground">Loading property definitions…</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* --- Schedules / indexes -------------------------------------------- */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ListOrdered className="h-4 w-4" /> Schedules &amp; Indexes
                <Badge variant="secondary">{schedules?.length ?? 0}</Badge>
              </CardTitle>
              <CardDescription>
                Document-owned definitions (sch-NNNNNN); rows are ALWAYS derived fresh (schedules.run — the same state yields the same rows + sha256).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7" data-testid="schedule-form">
                <div className="space-y-1 lg:col-span-2">
                  <label htmlFor="sch-name" className="text-xs font-medium">Name</label>
                  <input id="sch-name" aria-label="Schedule name" className={INP} value={schForm.name} onChange={(e) => setSchForm((f) => ({ ...f, name: e.target.value }))} placeholder="Walls — fire rating" data-testid="schedule-name" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="sch-source" className="text-xs font-medium">Source</label>
                  <select
                    id="sch-source"
                    aria-label="Schedule source"
                    className={INP}
                    value={schForm.source}
                    onChange={(e) => setSchForm((f) => ({ ...f, source: e.target.value }))}
                    data-testid="schedule-source"
                  >
                    <option value="elements">elements</option>
                    <option value="components">components</option>
                    <option value="materials">materials</option>
                    <option value="views">views</option>
                    <option value="layouts">layouts</option>
                    <option value="sheets">sheets</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="sch-group" className="text-xs font-medium">Group by</label>
                  <input id="sch-group" aria-label="Group by column key" className={INP} value={schForm.grouping} onChange={(e) => setSchForm((f) => ({ ...f, grouping: e.target.value }))} placeholder="material" data-testid="schedule-grouping" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="sch-condkey" className="text-xs font-medium">Condition key</label>
                  <input id="sch-condkey" aria-label="Condition property key" className={INP} value={schForm.conditionKey} onChange={(e) => setSchForm((f) => ({ ...f, conditionKey: e.target.value }))} placeholder="FireRating" data-testid="schedule-condkey" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="sch-condop" className="text-xs font-medium">Op</label>
                  <select
                    id="sch-condop"
                    aria-label="Condition operator"
                    className={INP}
                    value={schForm.conditionOp}
                    onChange={(e) => setSchForm((f) => ({ ...f, conditionOp: e.target.value }))}
                    data-testid="schedule-condop"
                  >
                    <option value="gt">gt</option>
                    <option value="lt">lt</option>
                    <option value="eq">eq</option>
                    <option value="ne">ne</option>
                    <option value="contains">contains</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="sch-condvalue" className="text-xs font-medium">Value</label>
                  <input id="sch-condvalue" aria-label="Condition value" className={INP} value={schForm.conditionValue} onChange={(e) => setSchForm((f) => ({ ...f, conditionValue: e.target.value }))} placeholder="0" data-testid="schedule-condvalue" />
                </div>
              </div>
              <Button size="sm" onClick={() => void onCreateSchedule()} disabled={schBusy} data-testid="schedule-create">
                <Layers3 className="mr-1 h-3.5 w-3.5" /> Create schedule
              </Button>
              {schError !== null && (
                <p className="text-xs text-red-600 dark:text-red-400" data-testid="schedule-error">{schError}</p>
              )}
              <ul className="flex flex-wrap gap-2" aria-label="schedules">
                {(schedules ?? []).map((s) => (
                  <li key={s.id}>
                    <Button size="sm" variant="outline" onClick={() => void onRunSchedule(s.id)} disabled={schBusy} data-testid={`schedule-run-${s.id}`} title={`schedules.run ${s.id}`}>
                      <Calculator className="mr-1 h-3.5 w-3.5" /> {s.name} ({s.columnCount})
                    </Button>
                  </li>
                ))}
                {schedules !== null && schedules.length === 0 && (
                  <li className="text-xs text-muted-foreground" data-testid="schedule-empty">No schedules — the form above (or the SCHEDULE command) creates one.</li>
                )}
                {schedules === null && <li className="text-xs text-muted-foreground">Loading schedules…</li>}
              </ul>
              {scheduleRun !== null && (
                <div className="space-y-2" data-testid="schedule-run-result">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" data-testid="schedule-run-name">{scheduleRun.schedule.name}</Badge>
                    <Badge variant="outline" className="font-mono text-[10px]" title="the canonical rows sha256" data-testid="schedule-run-sha">{scheduleRun.sha256.slice(0, 12)}…</Badge>
                    <span className="text-xs text-muted-foreground">{scheduleRun.rowCount} row(s)</span>
                    {scheduleRun.groups !== undefined && <span className="text-xs text-muted-foreground">· {scheduleRun.groups.length} group(s)</span>}
                  </div>
                  <div className="max-h-72 overflow-auto rounded border" data-testid="schedule-run-table">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                        <tr>
                          {columnLabels.map((label, i) => (
                            <th key={i} className="p-1.5 text-left font-medium">{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(runView ?? []).map((line, i) => {
                          if (line.kind === "header") {
                            return (
                              <tr key={i} className="bg-muted/40 font-medium" data-testid={`schedule-group-${i}`}>
                                <td className="p-1.5" colSpan={Math.max(columnLabels.length, 1)}>{line.label}</td>
                              </tr>
                            );
                          }
                          if (line.kind === "subtotal" || line.kind === "total") {
                            return (
                              <tr key={i} className={line.kind === "total" ? "border-t-2 bg-muted/30 font-medium" : "bg-muted/20"} data-testid={`schedule-${line.kind}-${i}`}>
                                <td className="p-1.5 font-mono">{line.label}</td>
                                {line.cells.map((cell, j) => (
                                  <td key={j} className="p-1.5 text-right font-mono">{cell}</td>
                                ))}
                              </tr>
                            );
                          }
                          return (
                            <tr key={i} className="border-t" data-testid={`schedule-row-${i}`}>
                              {line.cells.map((cell, j) => (
                                <td key={j} className="p-1.5 font-mono">{cell}</td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* --- Quantities ------------------------------------------------------ */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Calculator className="h-4 w-4" /> Quantity Takeoff
              </CardTitle>
              <CardDescription>
                The closed canonical rule table (bim/geometry closed forms); the report is REVISION-BOUND — the RevisionRef names the exact model head it
                was computed over (nothing is stored, every run is fresh).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3" data-testid="qto-form">
                <div className="space-y-1">
                  <label htmlFor="qty-source" className="text-xs font-medium">Source</label>
                  <select
                    id="qty-source"
                    aria-label="Quantity source"
                    className={INP}
                    value={qtyForm.source}
                    onChange={(e) => setQtyForm((f) => ({ ...f, source: e.target.value as typeof f.source }))}
                    data-testid="qto-source"
                  >
                    <option value="elements">elements</option>
                    <option value="components">components</option>
                    <option value="materials">materials</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="qty-group" className="text-xs font-medium">Group by</label>
                  <select
                    id="qty-group"
                    aria-label="Quantity group by"
                    className={INP}
                    value={qtyForm.groupBy}
                    onChange={(e) => setQtyForm((f) => ({ ...f, groupBy: e.target.value as typeof f.groupBy }))}
                    data-testid="qto-group"
                  >
                    <option value="none">none</option>
                    <option value="type">type</option>
                    <option value="story">story</option>
                    <option value="material">material</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <Button size="sm" onClick={() => void onRunQuantities()} disabled={qtyBusy} data-testid="qto-run">
                    <Calculator className="mr-1 h-3.5 w-3.5" /> Run takeoff
                  </Button>
                </div>
              </div>
              {qtyError !== null && (
                <p className="text-xs text-red-600 dark:text-red-400" data-testid="qto-error">{qtyError}</p>
              )}
              {quantityReport !== null && (
                <div className="space-y-2" data-testid="qto-result">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" data-testid="qto-revision">rev {quantityReport.revision.revision_number}</Badge>
                    <Badge variant="outline" className="font-mono text-[10px]" title={quantityReport.revision.content_hash} data-testid="qto-contenthash">
                      {quantityReport.revision.content_hash.slice(0, 12)}…
                    </Badge>
                    <Badge variant="outline" className="font-mono text-[10px]" title="the canonical report sha256" data-testid="qto-sha">
                      {quantityReport.reportSha256.slice(0, 12)}…
                    </Badge>
                  </div>
                  {quantityReport.source === "materials" ? (
                    <div className="max-h-72 overflow-auto rounded border" data-testid="qto-bom-table">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                          <tr>
                            <th className="p-1.5 text-left font-medium">Material</th>
                            <th className="p-1.5 text-left font-medium">Category</th>
                            <th className="p-1.5 text-right font-medium">Count</th>
                            <th className="p-1.5 text-right font-medium">Volume (mm³)</th>
                            <th className="p-1.5 text-right font-medium">Mass (kg)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {quantityReport.bom.map((row) => (
                            <tr key={row.materialId} className="border-t" data-testid="qto-bom-row">
                              <td className="p-1.5">{row.materialName}</td>
                              <td className="p-1.5">{row.category}</td>
                              <td className="p-1.5 text-right font-mono">{row.count}</td>
                              <td className="p-1.5 text-right font-mono">{cellOf(row.volume)}</td>
                              <td className="p-1.5 text-right font-mono">{cellOf(row.mass)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-auto rounded border" data-testid="qto-rows-table">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                          <tr>
                            <th className="p-1.5 text-left font-medium">Element</th>
                            <th className="p-1.5 text-left font-medium">Type</th>
                            <th className="p-1.5 text-left font-medium">Story</th>
                            <th className="p-1.5 text-left font-medium">Material</th>
                            <th className="p-1.5 text-right font-medium">Length (mm)</th>
                            <th className="p-1.5 text-right font-medium">Area (mm²)</th>
                            <th className="p-1.5 text-right font-medium">Volume (mm³)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {quantityReport.groups.length > 0
                            ? quantityReport.groups.map((g, i) => (
                              <React.Fragment key={i}>
                                <tr className="bg-muted/40 font-medium" data-testid={`qto-group-${i}`}>
                                  <td className="p-1.5" colSpan={7}>{g.key.join(" / ")} — {g.count} element(s)</td>
                                </tr>
                                {quantityReport.rows
                                  .slice(
                                    quantityReport.groups.slice(0, i).reduce((sum, x) => sum + x.rowCount, 0),
                                    quantityReport.groups.slice(0, i + 1).reduce((sum, x) => sum + x.rowCount, 0),
                                  )
                                  .map((row) => (
                                    <tr key={row.elementId} className="border-t" data-testid={`qto-row-${row.elementId}`}>
                                      <td className="p-1.5 font-mono">{row.elementId}</td>
                                      <td className="p-1.5 font-mono">{row.type}</td>
                                      <td className="p-1.5">{row.story}</td>
                                      <td className="p-1.5">{row.material}</td>
                                      <td className="p-1.5 text-right font-mono">{cellOf(row.length)}</td>
                                      <td className="p-1.5 text-right font-mono">{cellOf(row.area)}</td>
                                      <td className="p-1.5 text-right font-mono">{cellOf(row.volume)}</td>
                                    </tr>
                                  ))}
                                <tr className="bg-muted/20 font-mono" data-testid={`qto-subtotal-${i}`}>
                                  <td className="p-1.5">Σ {g.key.join(" / ")}</td>
                                  <td /><td /><td />
                                  <td className="p-1.5 text-right">{cellOf(g.length)}</td>
                                  <td className="p-1.5 text-right">{cellOf(g.area)}</td>
                                  <td className="p-1.5 text-right">{cellOf(g.volume)}</td>
                                </tr>
                              </React.Fragment>
                            ))
                            : quantityReport.rows.map((row) => (
                              <tr key={row.elementId} className="border-t" data-testid={`qto-row-${row.elementId}`}>
                                <td className="p-1.5 font-mono">{row.elementId}</td>
                                <td className="p-1.5 font-mono">{row.type}</td>
                                <td className="p-1.5">{row.story}</td>
                                <td className="p-1.5">{row.material}</td>
                                <td className="p-1.5 text-right font-mono">{cellOf(row.length)}</td>
                                <td className="p-1.5 text-right font-mono">{cellOf(row.area)}</td>
                                <td className="p-1.5 text-right font-mono">{cellOf(row.volume)}</td>
                              </tr>
                            ))}
                          {quantityReport.totals !== null && quantityReport.source !== "materials" && (
                            <tr className="border-t-2 bg-muted/30 font-medium" data-testid="qto-totals">
                              <td className="p-1.5">Grand total ({quantityReport.totals.count})</td>
                              <td /><td /><td />
                              <td className="p-1.5 text-right font-mono">{cellOf(quantityReport.totals.length)}</td>
                              <td className="p-1.5 text-right font-mono">{cellOf(quantityReport.totals.area)}</td>
                              <td className="p-1.5 text-right font-mono">{cellOf(quantityReport.totals.volume)}</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {quantityReport.skipped.length > 0 && (
                    <p className="text-xs text-muted-foreground" data-testid="qto-skipped">
                      {quantityReport.skipped.length} element(s) outside the closed rule table (count only — {quantityReport.skipped
                        .slice(0, 4)
                        .map((s) => s.elementId)
                        .join(", ")}
                      {quantityReport.skipped.length > 4 ? ", …" : ""}).
                    </p>
                  )}
                </div>
              )}
              {rulesReport !== null && (
                <>
                  <Separator />
                  <div className="max-h-48 overflow-auto rounded border" data-testid="qto-rules-table">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                        <tr>
                          <th className="p-1.5 text-left font-medium">Type</th>
                          <th className="p-1.5 text-center font-medium">length</th>
                          <th className="p-1.5 text-center font-medium">area</th>
                          <th className="p-1.5 text-center font-medium">volume</th>
                          <th className="p-1.5 text-right font-medium">live</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rulesReport.rules.map((r) => {
                          const live = rulesReport.liveCounts.find((c) => c.type === r.type)?.count ?? 0;
                          return (
                            <tr key={r.type} className="border-t" data-testid={`qto-rule-${r.type}`}>
                              <td className="p-1.5 font-mono">{r.type}</td>
                              <td className="p-1.5 text-center">{r.length !== null ? "✓" : "—"}</td>
                              <td className="p-1.5 text-center">{r.area !== null ? "✓" : "—"}</td>
                              <td className="p-1.5 text-center">{r.volume !== null ? "✓" : "—"}</td>
                              <td className="p-1.5 text-right font-mono">{live}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
