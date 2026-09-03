"use client";

/**
 * Offisos Parametrics Workbench — Web host surface
 * (COMPAT-CAD-004 / Issue #121).
 *
 * A REAL workflow, not a mockup: the versioned typed capability discovery
 * table (the closed 20-entry registry with honest origin provenance, bound
 * to the current canonical revision); the constraint workflow through the
 * VERIFIED CAD-PARITY-007 commands (declare, re-solve, the typed
 * diagnostics); the consolidated associative report with typed
 * ok/dangling/source_loss/missing/stale outcomes and the ONE-revision
 * atomic refresh; the symbol inventory through the verified block
 * commands; and the bounded pattern operations (the mirror over drafting
 * geometry AND symbol instances through the reflected placement; the
 * rectangular array through the verified entity.modify arm). The
 * CADDocument remains the canonical system of record (LOCK-019) — the
 * parametrics workbench is a client of the governed semantic App API.
 */

import * as React from "react";
import {
  Compass,
  RefreshCw,
  Link2,
  Boxes,
  Grid3x3,
  Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  annotationCreate,
  assocRefresh,
  assocReport,
  blockCreate,
  blockInsert,
  blocksList,
  constraintCreate,
  constraintsDiagnostics,
  constraintSolve,
  entityCreate,
  entityModify,
  parametricsCapabilities,
  patternMirror,
  unwrapAssocRefresh,
  unwrapAssocReport,
  unwrapParametricsCapabilities,
  unwrapPatternMirror,
  type AssocRefreshOutcomeView,
  type ParametricsCapabilitiesView,
  type PatternMirrorOutcomeView,
} from "@/cad/client/http-transport";
import type { AssocReportView } from "@offisos/cad-app-shell/contracts/parametrics";

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

const KIND_BADGE: Record<string, string> = {
  command: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  query: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
};

const AREA_BADGE: Record<string, string> = {
  constraints: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  associations: "rounded border border-teal-300 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:border-teal-700 dark:bg-teal-950 dark:text-teal-300",
  symbols: "rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
  patterns: "rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

const OUTCOME_BADGE: Record<string, string> = {
  ok: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  dangling: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  source_loss: "rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
  missing: "rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
  stale: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

const ORIGIN_BADGE: Record<string, string> = {
  "compat-cad-004": "rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
  "verified-baseline": "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
};

const SECTIONS = ["capabilities", "constraints", "associations", "symbols", "patterns"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABEL: Record<Section, string> = {
  capabilities: "Capability Discovery",
  constraints: "Constraints",
  associations: "Associations",
  symbols: "Symbols",
  patterns: "Patterns",
};

/** The seed drafting + symbol workflow (through the REAL governed
 *  commands — never fabricated state): a source line + a second line, a
 *  symbol definition (converted from the second line, then composed with
 *  content) and one inserted instance, plus an associative dimension over
 *  the source line. Deterministic ids: el-000001 (line), el-000002 (the
 *  definition source), el-000003 (the inserted symbol instance) — the
 *  forms prefill these. */
const SEED_ENTITIES = `[
  { "type": "line", "layer": "0", "x1": 0, "y1": 0, "x2": 4000, "y2": 0 },
  { "type": "line", "layer": "0", "x1": 0, "y1": 0, "x2": 4000, "y2": 600 }
]`;

const SEED_SYMBOL_ENTITIES = `[
  { "type": "line", "x1": 0, "y1": 0, "x2": 600, "y2": 0, "layer": "0" },
  { "type": "circle", "cx": 300, "cy": 150, "r": 60, "layer": "0" },
  { "type": "attdef", "tag": "TITLE", "default": "Untitled", "layer": "0", "x": 0, "y": 320, "height": 40, "rotation": 0 }
]`;

const SEED_DIMENSION = `{
  "type": "dim-linear", "layer": "0",
  "p1": { "x": 0, "y": 0 }, "p2": { "x": 4000, "y": 0 },
  "placement": { "x": 2000, "y": -400 }, "mode": "horizontal",
  "refs": [
    { "id": "el-000001", "anchor": "start", "to": "p1" },
    { "id": "el-000001", "anchor": "end", "to": "p2" }
  ]
}`;

function describeFailure(res: { ok: boolean; code?: string; message?: string }): string {
  return res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`;
}

function num(text: string): number | null {
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

function summarize(res: unknown): string {
  const r = res as { ok: boolean; value?: unknown };
  return JSON.stringify(r.value ?? r).slice(0, 400);
}

export function ParametricsWorkbench(): React.JSX.Element {
  const [section, setSection] = React.useState<Section>("capabilities");

  // --- the discovery table -------------------------------------------------------
  const [capabilities, setCapabilities] = React.useState<ParametricsCapabilitiesView | null>(null);
  const [capabilityFilter, setCapabilityFilter] = React.useState("");
  const [capabilityError, setCapabilityError] = React.useState<string | null>(null);
  const [capabilityBusy, setCapabilityBusy] = React.useState(false);

  // --- the constraints surface ---------------------------------------------------
  const [constraintForm, setConstraintForm] = React.useState({ kind: "horizontal", targets: "el-000001", value: "2500" });
  const [constraintResult, setConstraintResult] = React.useState<string | null>(null);
  const [constraintError, setConstraintError] = React.useState<string | null>(null);
  const [constraintBusy, setConstraintBusy] = React.useState(false);
  const [diagnostics, setDiagnostics] = React.useState<string | null>(null);

  // --- the associations surface ---------------------------------------------------
  const [report, setReport] = React.useState<AssocReportView | null>(null);
  const [refreshOutcome, setRefreshOutcome] = React.useState<AssocRefreshOutcomeView | null>(null);
  const [assocError, setAssocError] = React.useState<string | null>(null);
  const [assocBusy, setAssocBusy] = React.useState(false);

  // --- the symbols surface ---------------------------------------------------------
  const [symbolInventory, setSymbolInventory] = React.useState<string | null>(null);
  const [symbolInsertForm, setSymbolInsertForm] = React.useState({ name: "SYMBOL", x: "5000", y: "500", scale: "1", rotation: "0" });
  const [symbolError, setSymbolError] = React.useState<string | null>(null);
  const [symbolBusy, setSymbolBusy] = React.useState(false);

  // --- the patterns surface ----------------------------------------------------------
  const [mirrorForm, setMirrorForm] = React.useState({ ids: "el-000001", p1: "0,0", p2: "0,1000", eraseSource: "N" });
  const [mirrorOutcome, setMirrorOutcome] = React.useState<PatternMirrorOutcomeView | null>(null);
  const [arrayForm, setArrayForm] = React.useState({ ids: "el-000001", rows: "2", columns: "2", rowSpacing: "500", columnSpacing: "500" });
  const [patternError, setPatternError] = React.useState<string | null>(null);
  const [patternBusy, setPatternBusy] = React.useState(false);
  const [patternResult, setPatternResult] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    const [capsRes, reportRes, blocksRes] = await Promise.all([
      parametricsCapabilities(),
      assocReport(),
      blocksList(),
    ]);
    setCapabilities(unwrapParametricsCapabilities(capsRes));
    setReport(unwrapAssocReport(reportRes));
    setSymbolInventory(summarize(blocksRes));
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

  // --- the seed workflow (the REAL governed commands) ------------------------------

  const onSeed = React.useCallback(async (): Promise<void> => {
    setPatternBusy(true);
    setPatternError(null);
    try {
      const entities = JSON.parse(SEED_ENTITIES);
      const created = await entityCreate(entities);
      if (!created.ok) {
        setPatternError(describeFailure(created));
        return;
      }
      const createdIds = (created.value as { created: string[] }).created;
      const def = await blockCreate({ name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: [createdIds[1]!] });
      if (!def.ok) {
        setPatternError(describeFailure(def));
        return;
      }
      const upd = await (await import("@/cad/client/http-transport")).blockUpdate("SYMBOL", { entities: JSON.parse(SEED_SYMBOL_ENTITIES) });
      if (!upd.ok) {
        setPatternError(describeFailure(upd));
        return;
      }
      const dim = await annotationCreate({ entities: [JSON.parse(SEED_DIMENSION)] });
      if (!dim.ok) {
        setPatternError(describeFailure(dim));
        return;
      }
      setPatternResult(`seeded: line ${createdIds[0]!}, the symbol definition, the associative dim over ${createdIds[0]!} (insert an instance in Symbols)`);
      await refresh();
    } catch (e) {
      setPatternError((e as Error).message);
    } finally {
      setPatternBusy(false);
    }
  }, [refresh]);

  // --- the constraint actions ------------------------------------------------------

  const onConstraintCreate = React.useCallback(async (): Promise<void> => {
    setConstraintBusy(true);
    setConstraintError(null);
    try {
      const ids = constraintForm.targets.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (ids.length === 0) {
        setConstraintError("constraint targets: one or two comma-separated element ids");
        return;
      }
      const payload: Record<string, unknown> = {
        kind: constraintForm.kind,
        targets: ids.map((id) => ({ id })),
      };
      if (constraintForm.kind === "distance" || constraintForm.kind === "angle" || constraintForm.kind === "radius") {
        const value = num(constraintForm.value);
        if (value === null) {
          setConstraintError("the dimensional value must be numeric");
          return;
        }
        payload.value = value;
      }
      const res = await constraintCreate(payload as never);
      if (!res.ok) setConstraintError(describeFailure(res));
      else {
        setConstraintResult(summarize(res));
        const diag = await constraintsDiagnostics();
        setDiagnostics(diag.ok ? summarize(diag) : describeFailure(diag));
      }
    } finally {
      setConstraintBusy(false);
    }
  }, [constraintForm]);

  const onConstraintSolve = React.useCallback(async (): Promise<void> => {
    setConstraintBusy(true);
    setConstraintError(null);
    try {
      const res = await constraintSolve();
      if (!res.ok) setConstraintError(describeFailure(res));
      else setConstraintResult(summarize(res));
      const diag = await constraintsDiagnostics();
      setDiagnostics(diag.ok ? summarize(diag) : describeFailure(diag));
    } finally {
      setConstraintBusy(false);
    }
  }, []);

  // --- the association actions -----------------------------------------------------

  const onAssocRefresh = React.useCallback(async (): Promise<void> => {
    setAssocBusy(true);
    setAssocError(null);
    try {
      const res = await assocRefresh();
      const view = unwrapAssocRefresh(res);
      if (view === null) setAssocError(describeFailure(res));
      else setRefreshOutcome(view);
      const reportRes = await assocReport();
      setReport(unwrapAssocReport(reportRes));
    } finally {
      setAssocBusy(false);
    }
  }, []);

  // --- the symbol actions ------------------------------------------------------------

  const onSymbolInsert = React.useCallback(async (): Promise<void> => {
    setSymbolBusy(true);
    setSymbolError(null);
    try {
      const x = num(symbolInsertForm.x);
      const y = num(symbolInsertForm.y);
      const scale = num(symbolInsertForm.scale ?? "1") ?? 1;
      const rotation = num(symbolInsertForm.rotation ?? "0") ?? 0;
      if (x === null || y === null) {
        setSymbolError("insertion x/y must be numeric");
        return;
      }
      const res = await blockInsert({ name: symbolInsertForm.name, x, y, scale, rotation });
      if (!res.ok) setSymbolError(describeFailure(res));
      else {
        const blocks = await blocksList();
        setSymbolInventory(summarize(blocks));
      }
    } finally {
      setSymbolBusy(false);
    }
  }, [symbolInsertForm]);

  // --- the pattern actions -------------------------------------------------------------

  const onMirror = React.useCallback(async (): Promise<void> => {
    setPatternBusy(true);
    setPatternError(null);
    try {
      const ids = mirrorForm.ids.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const pp1 = mirrorForm.p1.split(",").map((s) => Number(s.trim()));
      const pp2 = mirrorForm.p2.split(",").map((s) => Number(s.trim()));
      if (ids.length === 0 || pp1.length !== 2 || pp2.length !== 2 || !pp1.every(Number.isFinite) || !pp2.every(Number.isFinite)) {
        setPatternError("mirror requires ids and two 'x,y' axis points");
        return;
      }
      const eraseSource = mirrorForm.eraseSource.toUpperCase() === "Y" || mirrorForm.eraseSource.toUpperCase() === "YES";
      const res = await patternMirror({ ids, p1: { x: pp1[0]!, y: pp1[1]! }, p2: { x: pp2[0]!, y: pp2[1]! }, eraseSource });
      const view = unwrapPatternMirror(res);
      if (view === null) setPatternError(describeFailure(res));
      else setMirrorOutcome(view);
      await refresh();
    } finally {
      setPatternBusy(false);
    }
  }, [mirrorForm, refresh]);

  const onArray = React.useCallback(async (): Promise<void> => {
    setPatternBusy(true);
    setPatternError(null);
    try {
      const ids = arrayForm.ids.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const rows = num(arrayForm.rows);
      const columns = num(arrayForm.columns);
      const rowSpacing = num(arrayForm.rowSpacing);
      const columnSpacing = num(arrayForm.columnSpacing);
      if (ids.length === 0 || rows === null || columns === null || rowSpacing === null || columnSpacing === null) {
        setPatternError("array requires ids and numeric rows/columns/spacings");
        return;
      }
      const res = await entityModify({
        op: "array", mode: "rectangular", ids, rows, columns, rowSpacing, columnSpacing,
      });
      if (!res.ok) setPatternError(describeFailure(res));
      else setPatternResult(summarize(res));
      await refresh();
    } finally {
      setPatternBusy(false);
    }
  }, [arrayForm, refresh]);

  const filteredCapabilities = React.useMemo(() => {
    if (capabilities === null) return [];
    const f = capabilityFilter.trim().toLowerCase();
    if (f.length === 0) return capabilities.capabilities;
    return capabilities.capabilities.filter(
      (c) => c.name.toLowerCase().includes(f) || c.area.includes(f) || c.origin.includes(f),
    );
  }, [capabilities, capabilityFilter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <Compass className="size-4" />
        <h2 className="text-sm font-semibold">Parametrics</h2>
        <span className="font-mono text-[10px] text-stone-500">
          api v{capabilities?.apiVersion ?? "—"} · {capabilities?.capabilities.length ?? "—"} capabilities · doc v{capabilities?.documentVersion ?? "—"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={capabilityBusy}>
            <RefreshCw className="mr-1 size-3" /> Refresh
          </Button>
        </div>
      </header>
      <nav className="flex flex-wrap gap-1 border-b px-3 py-1.5">
        {SECTIONS.map((s) => (
          <Button key={s} variant={section === s ? "default" : "ghost"} size="sm" onClick={() => setSection(s)}>
            {SECTION_LABEL[s]}
          </Button>
        ))}
      </nav>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-5xl space-y-4 p-4">
          {section === "capabilities" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><Table2 className="size-4" /> Capability discovery</CardTitle>
                <CardDescription>
                  The closed 20-entry registry (14 commands + 6 queries) with honest origin provenance — the COMPAT-CAD-004 additions and the verified baselines the family consolidates. Bound to the canonical revision (content {capabilities?.contentHash.slice(0, 12) ?? "—"}).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <input
                  className={INP}
                  placeholder="filter by name / area / origin…"
                  value={capabilityFilter}
                  onChange={(e) => setCapabilityFilter(e.target.value)}
                />
                {capabilityError !== null && <p className="text-xs text-red-600">{capabilityError}</p>}
                <div className="max-h-96 overflow-y-auto font-mono text-[11px]">
                  {filteredCapabilities.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 border-b py-1">
                      <span className={KIND_BADGE[c.kind] ?? KIND_BADGE.query}>{c.kind}</span>
                      <span className={AREA_BADGE[c.area] ?? AREA_BADGE.constraints}>{c.area}</span>
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className={ORIGIN_BADGE[c.origin] ?? ORIGIN_BADGE["verified-baseline"]}>{c.origin}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {section === "constraints" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><Link2 className="size-4" /> Constraint workflow (the verified CAD-PARITY-007 surface)</CardTitle>
                <CardDescription>
                  Declare a geometric/dimensional constraint through the REAL constraint.create command (the over-constraint gate + the deterministic solve + the associative cascade in ONE atomic revision), then re-solve and inspect the typed diagnostics.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">kind</span>
                    <select className={INP} value={constraintForm.kind} onChange={(e) => setConstraintForm((f) => ({ ...f, kind: e.target.value }))}>
                      {["horizontal", "vertical", "coincident", "parallel", "perpendicular", "equal", "tangent", "fixed", "distance", "angle", "radius"].map((k) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">targets (comma ids)</span>
                    <input className={INP} value={constraintForm.targets} onChange={(e) => setConstraintForm((f) => ({ ...f, targets: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">value (dimensional)</span>
                    <input className={INP} value={constraintForm.value} onChange={(e) => setConstraintForm((f) => ({ ...f, value: e.target.value }))} />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void onConstraintCreate()} disabled={constraintBusy}>constraint.create</Button>
                  <Button size="sm" variant="outline" onClick={() => void onConstraintSolve()} disabled={constraintBusy}>constraint.solve</Button>
                  <Button size="sm" variant="outline" onClick={() => void onSeed()} disabled={patternBusy}>Seed the workflow</Button>
                </div>
                {constraintError !== null && <p className="text-xs text-red-600">{constraintError}</p>}
                {constraintResult !== null && <pre className="max-h-48 overflow-auto rounded bg-stone-100 p-2 font-mono text-[10px] dark:bg-stone-900">{constraintResult}</pre>}
                {diagnostics !== null && <pre className="max-h-48 overflow-auto rounded bg-stone-100 p-2 font-mono text-[10px] dark:bg-stone-900">{diagnostics}</pre>}
              </CardContent>
            </Card>
          )}

          {section === "associations" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><RefreshCw className="size-4" /> The consolidated associative report + the ONE-revision refresh</CardTitle>
                <CardDescription>
                  Every association (annotations, symbol relationships, external references, raster underlays, docs annotations) with its TYPED outcome — computed fresh, never stored. The refresh re-measures every associative annotation and regenerates the documentation values in ONE atomic revision; dangling references disassociate honestly, never a silent re-target.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => void onAssocRefresh()} disabled={assocBusy}>assoc.refresh</Button>
                  <span className="font-mono text-[10px] text-stone-500">
                    {report !== null ? `${report.counts.total} rows · ${report.counts.ok} ok · ${report.counts.notOk} not ok · ${report.reportSha256.slice(0, 12)}` : "—"}
                  </span>
                </div>
                {assocError !== null && <p className="text-xs text-red-600">{assocError}</p>}
                {refreshOutcome !== null && (
                  <div className="rounded border p-2 text-[11px]">
                    <p className="font-mono">{refreshOutcome.summary}</p>
                    {refreshOutcome.notes.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 font-mono text-[10px] text-stone-600 dark:text-stone-400">
                        {refreshOutcome.notes.map((n) => <li key={n}>{n}</li>)}
                      </ul>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-stone-500">
                      docs: {refreshOutcome.docs.updated} updated · {refreshOutcome.docs.dangling} dangling · {refreshOutcome.docs.sourceLoss} source-loss
                    </p>
                  </div>
                )}
                <div className="max-h-96 overflow-y-auto font-mono text-[11px]">
                  {(report?.rows ?? []).map((row) => (
                    <div key={`${row.kind}:${row.id}`} className="border-b py-1">
                      <div className="flex items-center gap-2">
                        <span className={AREA_BADGE[row.kind === "annotation" ? "constraints" : row.kind === "symbol" ? "symbols" : row.kind === "xref" ? "symbols" : row.kind === "raster" ? "patterns" : "associations"]}>{row.kind}</span>
                        <span className="min-w-0 flex-1 truncate">{row.id}</span>
                        <span className={OUTCOME_BADGE[row.outcome] ?? OUTCOME_BADGE.ok}>{row.outcome}</span>
                      </div>
                      <p className="pl-2 text-[10px] text-stone-600 dark:text-stone-400">{row.reason}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {section === "symbols" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><Boxes className="size-4" /> Symbol inventory + insertion (the verified CAD-PARITY-006 surface)</CardTitle>
                <CardDescription>
                  The block-definition inventory (blocks.list) and the insertion workflow through the REAL block.insert command (validated placement + attribute values; document-minted ids).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-5 gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">name</span>
                    <input className={INP} value={symbolInsertForm.name} onChange={(e) => setSymbolInsertForm((f) => ({ ...f, name: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">x</span>
                    <input className={INP} value={symbolInsertForm.x} onChange={(e) => setSymbolInsertForm((f) => ({ ...f, x: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">y</span>
                    <input className={INP} value={symbolInsertForm.y} onChange={(e) => setSymbolInsertForm((f) => ({ ...f, y: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">scale</span>
                    <input className={INP} value={symbolInsertForm.scale} onChange={(e) => setSymbolInsertForm((f) => ({ ...f, scale: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">rotation</span>
                    <input className={INP} value={symbolInsertForm.rotation} onChange={(e) => setSymbolInsertForm((f) => ({ ...f, rotation: e.target.value }))} />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void onSymbolInsert()} disabled={symbolBusy}>block.insert</Button>
                </div>
                {symbolError !== null && <p className="text-xs text-red-600">{symbolError}</p>}
                {symbolInventory !== null && <pre className="max-h-48 overflow-auto rounded bg-stone-100 p-2 font-mono text-[10px] dark:bg-stone-900">{symbolInventory}</pre>}
              </CardContent>
            </Card>
          )}

          {section === "patterns" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><Grid3x3 className="size-4" /> The bounded pattern operations</CardTitle>
                <CardDescription>
                  The mirror over drafting geometry AND symbol instances (ONE atomic revision — geometry through the verified cascade-aware kernel, instances through the deterministic reflected placement; xref instances decline typed) and the rectangular array through the verified entity.modify arm. Seed the workflow first (a line, a symbol and an associative dimension).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void onSeed()} disabled={patternBusy}>Seed the workflow</Button>
                  {patternResult !== null && <span className="font-mono text-[10px] text-stone-500">{patternResult}</span>}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">ids (comma)</span>
                    <input className={INP} value={mirrorForm.ids} onChange={(e) => setMirrorForm((f) => ({ ...f, ids: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">axis p1 (x,y)</span>
                    <input className={INP} value={mirrorForm.p1} onChange={(e) => setMirrorForm((f) => ({ ...f, p1: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">axis p2 (x,y)</span>
                    <input className={INP} value={mirrorForm.p2} onChange={(e) => setMirrorForm((f) => ({ ...f, p2: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">erase source (Y/N)</span>
                    <input className={INP} value={mirrorForm.eraseSource} onChange={(e) => setMirrorForm((f) => ({ ...f, eraseSource: e.target.value }))} />
                  </label>
                </div>
                <Button size="sm" onClick={() => void onMirror()} disabled={patternBusy}>pattern.mirror</Button>
                {mirrorOutcome !== null && (
                  <div className="rounded border p-2 text-[11px]">
                    <p className="font-mono">{mirrorOutcome.summary}</p>
                    <p className="font-mono text-[10px] text-stone-500">created {mirrorOutcome.created} · modified {mirrorOutcome.modified}</p>
                    <div className="mt-1 max-h-40 overflow-y-auto font-mono text-[10px]">
                      {mirrorOutcome.rows.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 border-b py-0.5">
                          <span className="min-w-0 flex-1 truncate">{r.id} → {r.resultId}</span>
                          <span>{r.kind}</span>
                          <span className={OUTCOME_BADGE[r.mirrored ? "ok" : "stale"]}>{r.mirrored ? "mirrored" : "unreflected"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-5 gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">ids (comma)</span>
                    <input className={INP} value={arrayForm.ids} onChange={(e) => setArrayForm((f) => ({ ...f, ids: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">rows</span>
                    <input className={INP} value={arrayForm.rows} onChange={(e) => setArrayForm((f) => ({ ...f, rows: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">columns</span>
                    <input className={INP} value={arrayForm.columns} onChange={(e) => setArrayForm((f) => ({ ...f, columns: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">row spacing</span>
                    <input className={INP} value={arrayForm.rowSpacing} onChange={(e) => setArrayForm((f) => ({ ...f, rowSpacing: e.target.value }))} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-stone-500">column spacing</span>
                    <input className={INP} value={arrayForm.columnSpacing} onChange={(e) => setArrayForm((f) => ({ ...f, columnSpacing: e.target.value }))} />
                  </label>
                </div>
                <Button size="sm" onClick={() => void onArray()} disabled={patternBusy}>entity.modify array (rectangular)</Button>
                {patternError !== null && <p className="text-xs text-red-600">{patternError}</p>}
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
