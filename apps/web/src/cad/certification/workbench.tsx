"use client";

/**
 * Offisos Certification Workbench — Web host surface
 * (CAD-PARITY-019 / Issue #122; rev 2 — the architect review on PR #125).
 *
 * A REAL workflow, not a mockup: the version-pinned corpus catalog (the
 * certified AutoCAD professional workflow corpus — the certification
 * evidence basis, front and center — DERIVED LIVE through the governed App
 * API's certification.corpusCatalog query: the version pin, the auditable
 * version-pinned Autodesk reference manifest, the command bindings (the
 * Autodesk-documented invocations + the EXPLICIT semantic-analog map) and
 * the per-workflow phases/expectations counts are NEVER hard-coded in this
 * UI — the canonical corpus is the single source of truth, so the catalog
 * cannot drift); the LIVE interoperability
 * classification of the CURRENT document through the governed App API
 * (dxf.export's honest skip report + interop.roundtripReport's DRY field
 * classification + interop.toolsetsReport's concept × surface matrix —
 * every row EXACT/LOSSY/UNSUPPORTED, never fabricated); and the
 * deterministic sheet-export digest check. The CADDocument remains the
 * canonical system of record (LOCK-019) — the certification workbench is
 * a client of the governed semantic App API (read-only probes: nothing
 * here mutates the document).
 */

import * as React from "react";
import { BadgeCheck, BookOpen, FileSearch, RefreshCw, ShieldCheck, Table2, ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { send } from "@/cad/client/http-transport";

// ---------------------------------------------------------------------------
// The derived corpus catalog (rev 2 — fetched LIVE through the governed App
// API's certification.corpusCatalog query; the canonical corpus in
// app/src/certification/corpus.ts is the SINGLE SOURCE OF TRUTH: the pin,
// the version-pinned Autodesk reference manifest, the command bindings and
// the per-workflow counts are all derived there — NOTHING is hard-coded in
// this UI, so the catalog can never drift from the canonical corpus).
// ---------------------------------------------------------------------------

interface CatalogSource {
  readonly id: string;
  readonly product: string;
  readonly title: string;
  readonly locator: string;
  readonly docId: string;
  readonly scope: string;
}

interface CatalogCommand {
  readonly command?: string;
  readonly autodeskCommand?: string;
  readonly offisosSurface?: string;
  readonly surface?: string;
  readonly autodeskReference?: string;
  readonly source: string;
  readonly scope?: string;
}

interface CatalogWorkflow {
  readonly id: string;
  readonly title: string;
  readonly discipline: string;
  readonly phases: number;
  readonly expectations: number;
}

interface CorpusCatalog {
  readonly corpus: { readonly id: string; readonly version: string; readonly referenceProduct: string; readonly sha256: string };
  readonly sources: readonly CatalogSource[];
  readonly commandBindings: { readonly autodeskDocumented: readonly CatalogCommand[]; readonly semanticAnalogs: readonly CatalogCommand[] };
  readonly workflows: readonly CatalogWorkflow[];
  readonly totals: { readonly workflows: number; readonly phases: number; readonly expectations: number; readonly interop: number };
}

// CAD-PARITY-020 (additive): the derived ARCHICAD corpus catalog — the second
// version-pinned certification corpus (Graphisoft Archicad 27; the command
// bindings are ALL semantic analogs — Archicad documents no command line).
interface ArchicadCorpusCatalog {
  readonly corpus: { readonly id: string; readonly version: string; readonly referenceProduct: string; readonly sha256: string };
  readonly sources: readonly CatalogSource[];
  readonly commandBindings: { readonly semanticAnalogs: readonly (CatalogCommand & { readonly archicadReference?: string })[] };
  readonly workflows: readonly CatalogWorkflow[];
  readonly totals: { readonly workflows: number; readonly phases: number; readonly expectations: number; readonly interop: number };
}

type CorpusKind = "autocad" | "archicad";

const OUTCOME_STYLE: Record<string, string> = {
  exact: "bg-emerald-100 text-emerald-800 border-emerald-300",
  tolerance: "bg-emerald-100 text-emerald-800 border-emerald-300",
  lossy: "bg-amber-100 text-amber-800 border-amber-300",
  unsupported: "bg-rose-100 text-rose-800 border-rose-300",
};

function OutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${OUTCOME_STYLE[outcome] ?? "bg-gray-100 text-gray-700 border-gray-300"}`}>
      {outcome}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The live interop classification (read-only probes over the real App API).
// ---------------------------------------------------------------------------

interface DxfLiveState {
  skippedKinds: readonly string[];
  exported: number;
  skipped: number;
  aggregate: string;
  layerLossy: number;
}

interface ToolsetsRowView {
  concept: string;
  surface: string;
  classification: string;
  note: string;
}

export function CertificationWorkbench() {
  const [catalog, setCatalog] = React.useState<CorpusCatalog | null>(null);
  const [archicadCatalog, setArchicadCatalog] = React.useState<ArchicadCorpusCatalog | null>(null);
  const [corpusKind, setCorpusKind] = React.useState<CorpusKind>("autocad");
  const [dxf, setDxf] = React.useState<DxfLiveState | null>(null);
  const [rows, setRows] = React.useState<readonly ToolsetsRowView[] | null>(null);
  const [sheetDigest, setSheetDigest] = React.useState<{ format: string; stable: boolean; sha12: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // The canonical corpus catalog — fetched LIVE through the governed App API
  // (certification.corpusCatalog): the pin, the reference manifest, the
  // command bindings and the per-workflow counts are DERIVED from the
  // canonical version-pinned corpus, never hard-coded here (rev 2).
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await send({ type: "query", name: "certification.corpusCatalog", payload: {} });
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
        if (!cancelled) setCatalog(r.value as CorpusCatalog);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
      try {
        const r = await send({ type: "query", name: "certification.archicadCatalog", payload: {} });
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
        if (!cancelled) setArchicadCatalog(r.value as ArchicadCorpusCatalog);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The ACTIVE catalog (the selected corpus) — both derive live through the
  // governed App API; the selector only switches which canonical corpus is
  // rendered (nothing is hard-coded for either corpus).
  const active =
    corpusKind === "autocad"
      ? catalog === null
        ? null
        : { kind: "autocad" as const, data: catalog }
      : archicadCatalog === null
        ? null
        : { kind: "archicad" as const, data: archicadCatalog };

  const runDxf = React.useCallback(async () => {
    setBusy("dxf");
    setError(null);
    try {
      const exportOut = await send({ type: "query", name: "dxf.export", payload: {} });
      if (!exportOut.ok) throw new Error(`${exportOut.code}: ${exportOut.message}`);
      const rt = await send({ type: "query", name: "interop.roundtripReport", payload: { format: "dxf" } });
      if (!rt.ok) throw new Error(`${rt.code}: ${rt.message}`);
      const value = rt.value as {
        report: {
          source: { exported: number; skipped: number; skippedKinds?: string[] };
          layers: { lossy: number };
          elements: { fields: { classification: string }[] }[];
        };
      };
      const exportValue = exportOut.value as { skippedKinds?: string[] } | undefined;
      const fields = value.report.elements.flatMap((el) => el.fields.map((f) => f.classification));
      const worst = (c: string): number => (c === "exact" ? 0 : c === "tolerance" ? 1 : c === "lossy" ? 2 : 3);
      let aggregate = "exact";
      for (const c of fields) if (worst(c) > worst(aggregate)) aggregate = c;
      setDxf({
        skippedKinds: exportValue?.skippedKinds ?? value.report.source.skippedKinds ?? [],
        exported: value.report.source.exported,
        skipped: value.report.source.skipped,
        aggregate: fields.length === 0 ? "unsupported" : aggregate,
        layerLossy: value.report.layers.lossy,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const runToolsets = React.useCallback(async () => {
    setBusy("toolsets");
    setError(null);
    try {
      const rt = await send({ type: "query", name: "interop.toolsetsReport", payload: {} });
      if (!rt.ok) throw new Error(`${rt.code}: ${rt.message}`);
      const value = rt.value as { rows: ToolsetsRowView[] };
      setRows(value.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const runSheet = React.useCallback(async () => {
    setBusy("sheet");
    setError(null);
    try {
      const a = await send({ type: "query", name: "docs.exportSheet", payload: { sheetId: "sh-000001", format: "svg" } });
      if (!a.ok) throw new Error(`${a.code}: ${a.message}`);
      const b = await send({ type: "query", name: "docs.exportSheet", payload: { sheetId: "sh-000001", format: "svg" } });
      if (!b.ok) throw new Error(`${b.code}: ${b.message}`);
      const da = (a.value as { sha256?: string }).sha256 ?? "";
      const db = (b.value as { sha256?: string }).sha256 ?? "";
      setSheetDigest({ format: "svg", stable: da === db && da.length > 0, sha12: da.slice(0, 12) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" /> The version-pinned certification corpora
          </CardTitle>
          <CardDescription className="text-xs">
            {active === null ? (
              "Loading the canonical corpus catalogs through the governed App API…"
            ) : (
              <>
                {active.data.corpus.id}/{active.data.corpus.version} (sha256 {active.data.corpus.sha256.slice(0, 12)}…) — pinned against{" "}
                {active.data.corpus.referenceProduct}. Every expectation is bound to a version-pinned authoritative{" "}
                {active.kind === "autocad" ? "Autodesk" : "Graphisoft"} source (the reference manifest below, included in
                the corpus digest) — independently auditable, and every
                measurement is against THIS declared corpus.
                {active.kind === "archicad" && (
                  <>
                    {" "}
                    Graphisoft documents Archicad 27 with NO command-line interface — every Offisos surface the corpus
                    drives is an explicit semantic analog (never an "Archicad command").
                  </>
                )}
              </>
            )}
          </CardDescription>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-1 px-6 pb-1 text-xs">
          <span className="mr-1 text-muted-foreground">Corpus:</span>
          <button
            type="button"
            onClick={() => setCorpusKind("autocad")}
            className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
              corpusKind === "autocad"
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            AutoCAD (P019)
          </button>
          <button
            type="button"
            onClick={() => setCorpusKind("archicad")}
            className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
              corpusKind === "archicad"
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            Archicad (P020)
          </button>
        </div>
        <CardContent className="pb-2">
          {active === null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="h-3 w-3 animate-spin" /> Deriving the catalog from the canonical corpus…
            </div>
          ) : (
            <ScrollArea className="max-h-56">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Workflow</th>
                    <th className="py-1 pr-2 font-medium">Discipline</th>
                    <th className="py-1 pr-2 font-medium text-right">Phases</th>
                    <th className="py-1 text-right font-medium">Expectations</th>
                  </tr>
                </thead>
                <tbody>
                  {active.data.workflows.map((wf) => (
                    <tr key={wf.id} className="border-b last:border-0">
                      <td className="py-1 pr-2">
                        <span className="font-mono text-[10px] text-muted-foreground">{wf.id}</span>
                        <div>{wf.title}</div>
                      </td>
                      <td className="py-1 pr-2 text-muted-foreground">{wf.discipline}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{wf.phases}</td>
                      <td className="py-1 text-right tabular-nums">{wf.expectations}</td>
                    </tr>
                  ))}
                  <tr className="border-t font-medium">
                    <td className="py-1 pr-2">Total (derived from the canonical corpus)</td>
                    <td />
                    <td className="py-1 pr-2 text-right tabular-nums">{active.data.totals.phases}</td>
                    <td className="py-1 text-right tabular-nums">{active.data.totals.expectations}</td>
                  </tr>
                </tbody>
              </table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {active !== null && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <BookOpen className="h-4 w-4" /> The auditable {active.kind === "autocad" ? "Autodesk" : "Graphisoft Archicad 27"} reference manifest (version-pinned, digest-bound)
            </CardTitle>
            <CardDescription className="text-xs">
              The authoritative {active.kind === "autocad" ? "Autodesk" : "Graphisoft"} documentation sources every workflow/expectation cites (URL + document
              path + tool/topic scope) — included in the corpus sha256, so any reference change changes the corpus identity.
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-2">
            <ScrollArea className="max-h-40">
              <ul className="space-y-1 text-xs">
                {active.data.sources.map((s) => (
                  <li key={s.id} className="border-b pb-1 last:border-0">
                    <span className="font-mono text-[10px] text-muted-foreground">{s.id}</span>
                    <div>
                      <span className="font-medium">{s.product}</span> — {s.title}
                    </div>
                    <a href={s.locator} target="_blank" rel="noreferrer" className="block truncate font-mono text-[10px] text-primary underline">
                      {s.locator}
                    </a>
                    <div className="text-[10px] text-muted-foreground">docId {s.docId}</div>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {active !== null && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ArrowRightLeft className="h-4 w-4" />{" "}
              {active.kind === "autocad"
                ? "The command bindings (Autodesk-documented + the explicit semantic analogs)"
                : "The command-analog map (every Offisos surface bound to its Graphisoft-documented reference)"}
            </CardTitle>
            <CardDescription className="text-xs">
              {active.kind === "autocad" ? (
                <>
                  Every command-line surface the corpus drives is bound: the Autodesk-documented 2024 commands (direct references)
                  and the Offisos surfaces that are NOT Autodesk commands (semantic analogs of the documented behaviors — never
                  claimed Autodesk command names; the honest rev-2 disclosure).
                </>
              ) : (
                <>
                  Graphisoft documents Archicad 27 with NO command-line interface — every Offisos surface the corpus drives is
                  an EXPLICIT semantic analog of a documented Archicad 27 tool/workflow (never an "Archicad command"; the
                  closed partition is enforced by the app-suite invariant test).
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-2">
            <ScrollArea className="max-h-48">
              <div className="space-y-2 text-xs">
                {active.kind === "autocad" && "autodeskDocumented" in active.data.commandBindings && (
                  <div>
                    <div className="mb-1 font-medium">Autodesk-documented commands invoked ({active.data.commandBindings.autodeskDocumented.length}):</div>
                    <div className="flex flex-wrap gap-1">
                      {active.data.commandBindings.autodeskDocumented.map((c) => (
                        <span key={c.command} title={`${c.autodeskCommand} — source ${c.source}`} className="inline-flex items-center rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800">
                          {c.command}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <div className="mb-1 font-medium">
                    Offisos semantic analogs (bound to their {active.kind === "autocad" ? "Autodesk" : "Graphisoft Archicad 27"} references):
                  </div>
                  <table className="w-full">
                    <tbody>
                      {active.data.commandBindings.semanticAnalogs.map((a) => (
                        <tr key={a.offisosSurface} className="border-b last:border-0 align-top">
                          <td className="py-1 pr-2 font-mono text-[10px] whitespace-nowrap">{a.offisosSurface}</td>
                          <td className="py-1 pr-2 text-[10px] text-muted-foreground">{a.surface}</td>
                          <td className="py-1">{a.archicadReference ?? a.autodeskReference}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileSearch className="h-4 w-4" /> The live interoperability classification (this document)
          </CardTitle>
          <CardDescription className="text-xs">
            Read-only probes through the governed App API: the DXF writer&rsquo;s honest skip report, the DRY round-trip field classification and the specialized-toolsets concept × surface matrix — every row EXACT / LOSSY / UNSUPPORTED, never fabricated.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pb-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={runDxf} disabled={busy !== null}>
              <RefreshCw className={`mr-1 h-3 w-3 ${busy === "dxf" ? "animate-spin" : ""}`} /> DXF boundary
            </Button>
            <Button size="sm" variant="outline" onClick={runToolsets} disabled={busy !== null}>
              <Table2 className={`mr-1 h-3 w-3 ${busy === "toolsets" ? "animate-spin" : ""}`} /> Toolsets IFC/BCF/IDS matrix
            </Button>
            <Button size="sm" variant="outline" onClick={runSheet} disabled={busy !== null}>
              <BadgeCheck className={`mr-1 h-3 w-3 ${busy === "sheet" ? "animate-spin" : ""}`} /> Sheet digest determinism
            </Button>
          </div>
          {error !== null && (
            <div className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-800">
              Typed decline: {error}
            </div>
          )}
          {dxf !== null && (
            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">DXF round-trip aggregate:</span>
                <OutcomeBadge outcome={dxf.aggregate} />
                <span className="text-muted-foreground">
                  {dxf.exported} carried / {dxf.skipped} skipped{dxf.layerLossy > 0 ? ` / ${dxf.layerLossy} lossy layer rows` : ""}
                </span>
              </div>
              <div>
                <span className="font-medium">Skipped classes (counted, never silent):</span>{" "}
                {dxf.skippedKinds.length === 0 ? (
                  <span className="text-muted-foreground">none</span>
                ) : (
                  dxf.skippedKinds.map((k) => (
                    <span key={k} className="mr-1 inline-flex items-center rounded border border-rose-300 bg-rose-50 px-1 py-0.5 font-mono text-[10px] text-rose-800">
                      {k}
                    </span>
                  ))
                )}
              </div>
            </div>
          )}
          {rows !== null && (
            <ScrollArea className="max-h-64">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Concept</th>
                    <th className="py-1 pr-2 font-medium">Surface</th>
                    <th className="py-1 pr-2 font-medium">Outcome</th>
                    <th className="py-1 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.concept}-${r.surface}`} className="border-b last:border-0 align-top">
                      <td className="py-1 pr-2 font-mono text-[10px]">{r.concept}</td>
                      <td className="py-1 pr-2 uppercase">{r.surface}</td>
                      <td className="py-1 pr-2">
                        <OutcomeBadge outcome={r.classification} />
                      </td>
                      <td className="py-1 text-muted-foreground">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
          {sheetDigest !== null && (
            <div className="text-xs">
              <span className="font-medium">Sheet export ({sheetDigest.format}):</span>{" "}
              {sheetDigest.stable ? (
                <span className="text-emerald-700">deterministic — repeated exports byte-identical (sha256 {sheetDigest.sha12}…)</span>
              ) : (
                <span className="text-rose-700">NON-DETERMINISTIC (repeated exports differ)</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-auto rounded border bg-muted/40 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
        CAD-PARITY-019/P020: the certification program evaluates integrated professional workflows (the AutoCAD-class and the
        Archicad-class corpora) across semantics, persistence,
        real UI task completion, interoperability (explicit EXACT/LOSSY/UNSUPPORTED) and performance/robustness against the
        version-pinned corpus. The certification evidence is produced by the deterministic certification engine
        (app/src/certification) through the real command registry and the App API — pinned by the certification fixture and
        re-proven on every CI run. <span className="font-medium">Certification boundary (explicit):</span> the certification
        verdict is only ever produced by the deterministic engine with the pinned toolchain (the pinned fixture basis). A
        run of the same corpus against a deployed serverless environment (where the Python IfcOpenShell toolchain is
        unavailable and the ifc probes decline typed <span className="font-mono">ifc_unavailable</span>) is a{" "}
        <span className="font-medium">DIAGNOSTIC boundary observation only — never certification evidence</span>; the
        observed serverless result is not a certification reproduction.
      </div>
    </div>
  );
}
