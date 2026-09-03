"use client";

/**
 * Offisos Certification Workbench — Web host surface
 * (CAD-PARITY-019 / Issue #122).
 *
 * A REAL workflow, not a mockup: the version-pinned corpus catalog (the
 * certified AutoCAD professional workflow corpus — the certification
 * evidence basis, front and center); the LIVE interoperability
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
import { BadgeCheck, FileSearch, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { send } from "@/cad/client/http-transport";

// ---------------------------------------------------------------------------
// The certified corpus catalog (the P019 certification evidence basis —
// the version pin + the representative workflow inventory; the full corpus
// is the pinned artifact app/src/certification/corpus.ts).
// ---------------------------------------------------------------------------

const CORPUS_PIN = {
  corpusId: "autocad-p019-corpus",
  version: "1",
  reference: "AutoCAD 2024 (base) + AutoCAD Architecture 2024 (AEC) + AutoCAD MEP 2024 (MEP)",
  basis: "Autodesk AutoCAD 2024 Help / Command Reference (documented command behavior, declared per workflow)",
};

const CORPUS_CATALOG: readonly {
  id: string;
  title: string;
  discipline: string;
  phases: number;
  expectations: number;
}[] = [
  { id: "wf-plan-drafting", title: "Architectural floor-plan drafting", discipline: "drafting", phases: 5, expectations: 15 },
  { id: "wf-annotation-docs", title: "Dimensioned annotated drawing documentation", discipline: "annotation", phases: 4, expectations: 11 },
  { id: "wf-symbol-blocks", title: "Reusable symbol library and placement", discipline: "blocks", phases: 6, expectations: 13 },
  { id: "wf-sheet-publication", title: "Sheet set assembly and deterministic publication", discipline: "sheet", phases: 4, expectations: 8 },
  { id: "wf-model3d-mass", title: "3D massing model with exact sections", discipline: "model3d", phases: 3, expectations: 12 },
  { id: "wf-bim-quantities", title: "Building model with schedules and quantities", discipline: "bim", phases: 3, expectations: 11 },
  { id: "wf-specialized-toolsets", title: "Architecture/MEP/mechanical specialized toolset workflows", discipline: "toolsets", phases: 3, expectations: 11 },
  { id: "wf-collab-automation", title: "Collaborative recoverable automated document workflow", discipline: "collab", phases: 4, expectations: 10 },
];

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
  const [dxf, setDxf] = React.useState<DxfLiveState | null>(null);
  const [rows, setRows] = React.useState<readonly ToolsetsRowView[] | null>(null);
  const [sheetDigest, setSheetDigest] = React.useState<{ format: string; stable: boolean; sha12: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
            <ShieldCheck className="h-4 w-4" /> The version-pinned AutoCAD certification corpus
          </CardTitle>
          <CardDescription className="text-xs">
            {CORPUS_PIN.corpusId}/{CORPUS_PIN.version} — pinned against {CORPUS_PIN.reference}. {CORPUS_PIN.basis}.
            Every certification claim is measured against this declared corpus (feature checklists alone are never sufficient).
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-2">
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
                {CORPUS_CATALOG.map((wf) => (
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
              </tbody>
            </table>
          </ScrollArea>
        </CardContent>
      </Card>

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
        CAD-PARITY-019: the certification program evaluates integrated professional workflows across semantics, persistence,
        real UI task completion, interoperability (explicit EXACT/LOSSY/UNSUPPORTED) and performance/robustness against the
        version-pinned corpus. The certification evidence is produced by the deterministic certification engine
        (app/src/certification) through the real command registry and the App API — pinned by the certification fixture and
        re-proven on every CI run.
      </div>
    </div>
  );
}
