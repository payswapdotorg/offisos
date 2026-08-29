"use client";

/**
 * CAD-PARITY-008 plot preview surface (Web host) — Issue #88.
 *
 * The deterministic plot preview of the ACTIVE layout: the canonical Plot IR
 * (queried through plot.preview — the same representation the export writers
 * consume) painted through the SHARED paper painter, with the IR hash, the
 * page-setup summary and the SVG/PDF export buttons. The preview IS the
 * plot — the exact semantic transforms of the final export path.
 */

import * as React from "react";
import { X, Download, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import { paintPlotIR, paintSheetBackdrop, type PlotIR, type PaperPt } from "@offisos/cad-app-shell/workspace/layouts";
import { plotPreview, plotExport } from "@/cad/client/http-transport";

export interface PlotPreviewProps {
  readonly snapshot: CADDocumentSnapshot | null;
  readonly onClose: () => void;
  readonly onEcho: (line: string) => void;
}

interface PreviewData {
  readonly ir: PlotIR;
  readonly hash: string;
  readonly layoutName: string;
}

export function PlotPreview(props: PlotPreviewProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = React.useState<PreviewData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const layouts = props.snapshot?.layouts ?? [];
  const activeLayoutId = props.snapshot?.draftingSettings?.activeLayout ?? layouts[0]?.id ?? null;
  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? layouts[0] ?? null;

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (activeLayout === null) {
        setError("No layouts exist yet — LAYOUTNEW creates one.");
        return;
      }
      const res = await plotPreview({ name: activeLayout.name });
      if (cancelled) return;
      if (!res.ok) {
        setError(`[plot.preview] ${res.code}: ${res.message}`);
        return;
      }
      const value = res.value as { ir: PlotIR; hash: string; layoutName: string };
      setData({ ir: value.ir, hash: value.hash, layoutName: value.layoutName });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeLayout?.name]);

  // Paint the IR (fit into the preview canvas).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || data === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(0, 0, w, h);
    const margin = 16;
    const zoom = Math.min((w - margin * 2) / data.ir.sheet.widthMm, (h - margin * 2) / data.ir.sheet.heightMm);
    const ox = (w - data.ir.sheet.widthMm * zoom) / 2;
    const oy = (h + data.ir.sheet.heightMm * zoom) / 2;
    const toScreen = (p: PaperPt): [number, number] => [ox + p.x * zoom, oy - p.y * zoom];
    paintSheetBackdrop(ctx, data.ir, { toScreen, pxPerMm: zoom });
    paintPlotIR(ctx, data.ir, { toScreen, pxPerMm: zoom });
  }, [data]);

  const download = (format: "svg" | "pdf"): void => {
    if (activeLayout === null) return;
    setBusy(true);
    void (async () => {
      try {
        const res = await plotExport({ name: activeLayout.name }, format);
        if (!res.ok) {
          setError(`[plot.export] ${res.code}: ${res.message}`);
          return;
        }
        const value = res.value as { text?: string; bytesBase64?: string; sha256: string; layoutName: string };
        const bytes: Uint8Array =
          format === "svg"
            ? new TextEncoder().encode(value.text ?? "")
            : Uint8Array.from(atob(value.bytesBase64 ?? ""), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes as unknown as BlobPart], { type: format === "svg" ? "image/svg+xml" : "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `offisos-${value.layoutName.replace(/\s+/g, "-").toLowerCase()}.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        props.onEcho(`PLOT: ${value.layoutName} exported as ${format.toUpperCase()} (sha256 ${value.sha256.slice(0, 12)}…).`);
      } finally {
        setBusy(false);
      }
    })();
  };

  const setup = activeLayout?.pageSetup;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Plot preview" onClick={props.onClose}>
      <div
        className="flex h-[min(88vh,760px)] w-[min(1000px,94vw)] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="plot-preview"
      >
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <FileText className="h-4 w-4" aria-hidden />
          <h2 className="flex-1 text-sm font-semibold">Plot preview — {data?.layoutName ?? activeLayout?.name ?? "…"}</h2>
          {data !== null && (
            <span className="font-mono text-[10px] text-muted-foreground" data-testid="plot-preview-hash">
              IR sha256 {data.hash.slice(0, 16)}… · {data.ir.primitiveCount} primitives
            </span>
          )}
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="close plot preview" onClick={props.onClose}>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        {error !== null && (
          <div role="alert" className="border-b bg-red-50 px-4 py-2 text-xs text-red-800">
            {error}
          </div>
        )}
        {setup !== undefined && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground" data-testid="plot-preview-setup">
            <span className="font-medium text-foreground">{setup.paperSize}</span>
            <span>{setup.orientation}</span>
            <span>·</span>
            <span>margins {setup.marginsMm.top}/{setup.marginsMm.right}/{setup.marginsMm.bottom}/{setup.marginsMm.left} mm</span>
            <span>·</span>
            <span>plot scale {setup.plotScale}</span>
            <span>·</span>
            <span>plot style {setup.plotStyleKind === "none" ? "none (as displayed)" : `${setup.plotStyleTable} (${setup.plotStyleKind.toUpperCase()} — typed decline)`}</span>
            <span>·</span>
            <span>borders {setup.plotViewports !== false ? "plotted" : "off"}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 bg-slate-200 p-2">
          <canvas ref={canvasRef} className="h-full w-full" data-testid="plot-preview-canvas" aria-label="plot preview canvas" />
        </div>
        <div className="flex items-center gap-2 border-t px-4 py-2">
          <Button size="sm" className="h-7 gap-1 text-xs" disabled={busy || data === null} onClick={() => download("svg")} data-testid="plot-preview-export-svg">
            <Download className="h-3.5 w-3.5" aria-hidden /> Export SVG
          </Button>
          <Button size="sm" className="h-7 gap-1 text-xs" disabled={busy || data === null} onClick={() => download("pdf")} data-testid="plot-preview-export-pdf">
            <Download className="h-3.5 w-3.5" aria-hidden /> Export PDF
          </Button>
          <span className="ml-auto text-[10px] text-muted-foreground">
            The preview uses the exact semantic transforms of the export path — repeated exports are byte-identical.
          </span>
        </div>
      </div>
    </div>
  );
}
