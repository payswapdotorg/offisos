"use client";

/**
 * CAD-PARITY-008 paper-space canvas (Web host) — Issue #88.
 *
 * The Layout view: the oriented sheet on a desk backdrop, the printable-area
 * framing, the viewport borders (locked state visibly distinct) and every
 * viewport's projected model content — painted through the SHARED paper
 * painter from the SHARED Plot IR (the exact plot semantics — LOCK-004
 * parity by construction: the same ir.ts/paint.ts the Electron host and the
 * export writers consume).
 *
 * Interactions (bounded, host-local — LOCK-015):
 *  - wheel zoom + middle-drag pan of the sheet view;
 *  - clicking a viewport FRAME selects it (border-band hit test); corner
 *    grips resize and the frame drag moves (committed as viewport.update
 *    corner patches — versioned, undoable; the LOCKED view still moves);
 *  - while MVIEW runs, canvas picks deliver paper-space points to the
 *    prompt engine (the two viewport corners);
 *  - the paper cursor readout feeds the status bar (sheet mm).
 */

import * as React from "react";

import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import type { PromptEngineState } from "@offisos/cad-app-shell/workspace/prompt-engine";
import { effectiveStep } from "@offisos/cad-app-shell/workspace/prompt-engine";
import {
  buildPlotIR,
  paintPlotIR,
  paintSheetBackdrop,
  viewportRect,
  distanceToRectEdges,
  formatViewportScale,
  type PlotIR,
  type PaperPt,
} from "@offisos/cad-app-shell/workspace/layouts";
import type { ViewportRecord } from "@offisos/cad-app-shell/contracts/caddocument";

export interface LayoutCanvasProps {
  readonly snapshot: CADDocumentSnapshot | null;
  readonly engineState: PromptEngineState;
  readonly busy: boolean;
  readonly selectedViewportId: string | null;
  readonly onSelectedViewport: (id: string | null) => void;
  readonly onCursor: (paper: Vec2 | null) => void;
  readonly onPickPoint: (paper: Vec2) => void;
  readonly onViewportUpdate: (id: string, patch: Record<string, unknown>) => void;
  readonly onCommandStart: (commandId: string) => void;
}

const DESK_COLOR = "#e2e8f0";
const GRIP_HIT_PX = 10;
const FRAME_HIT_PX = 7;

type DragState =
  | { readonly kind: "pan"; readonly startX: number; readonly startY: number; readonly ox: number; readonly oy: number }
  | { readonly kind: "move"; readonly id: string; readonly grabX: number; readonly grabY: number; readonly corners: [number, number][] }
  | { readonly kind: "corner"; readonly id: string; readonly corner: 0 | 1; readonly other: readonly [number, number] };

export function LayoutCanvas(props: LayoutCanvasProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [view, setView] = React.useState<{ ox: number; oy: number; zoom: number } | null>(null);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [hoverPaper, setHoverPaper] = React.useState<PaperPt | null>(null);
  const [liveCorners, setLiveCorners] = React.useState<{ id: string; c1: [number, number]; c2: [number, number] } | null>(null);

  const layouts = props.snapshot?.layouts ?? [];
  const activeLayoutId = props.snapshot?.draftingSettings?.activeLayout ?? layouts[0]?.id ?? null;
  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? layouts[0] ?? null;
  const viewports: readonly ViewportRecord[] = (props.snapshot?.viewports ?? []).filter((v) => v.layoutId === activeLayout?.id);

  // The Plot IR — built LOCALLY through the SAME shared core the server and
  // the Electron host use (the preview IS the plot).
  const ir: PlotIR | null = React.useMemo(() => {
    if (activeLayout === null) return null;
    const s = props.snapshot;
    if (s === null) return null;
    return buildPlotIR({
      layout: activeLayout,
      viewports: s.viewports ?? [],
      elements: s.elements,
      layers: s.layers ?? [],
      ltypes: s.ltypes ?? [],
      textStyles: s.textStyles ?? [],
      dimStyles: s.dimStyles ?? [],
      ...(s.draftingSettings?.standards !== undefined ? { standards: s.draftingSettings.standards } : {}),
    });
  }, [props.snapshot, activeLayout]);

  // --- the sheet view transform (fit + manual pan/zoom) ----------------------

  const canvasSize = React.useCallback((): { w: number; h: number } => {
    const el = canvasRef.current;
    if (el === null) return { w: 0, h: 0 };
    return { w: el.clientWidth, h: el.clientHeight };
  }, []);

  const fitView = React.useCallback((): { ox: number; oy: number; zoom: number } => {
    const { w, h } = canvasSize();
    if (ir === null || w <= 0 || h <= 0) return { ox: 0, oy: h, zoom: 1 };
    const margin = 24;
    const zoom = Math.min((w - margin * 2) / ir.sheet.widthMm, (h - margin * 2) / ir.sheet.heightMm);
    return {
      ox: (w - ir.sheet.widthMm * zoom) / 2,
      oy: (h + ir.sheet.heightMm * zoom) / 2,
      zoom,
    };
  }, [ir, canvasSize]);

  React.useEffect(() => {
    // Fit the sheet whenever the ACTIVE LAYOUT changes (async — the state
    // update happens after the await boundary, the model-canvas restore
    // precedent).
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) setView(fitView());
    })();
    return () => {
      cancelled = true;
    };
  }, [fitView, activeLayout?.id]);

  const toScreen = React.useCallback(
    (p: PaperPt): [number, number] => {
      const v = view ?? { ox: 0, oy: 0, zoom: 1 };
      return [v.ox + p.x * v.zoom, v.oy - p.y * v.zoom];
    },
    [view],
  );

  const toPaper = React.useCallback(
    (sx: number, sy: number): PaperPt => {
      const v = view ?? { ox: 0, oy: 0, zoom: 1 };
      return { x: (sx - v.ox) / v.zoom, y: (v.oy - sy) / v.zoom };
    },
    [view],
  );

  // --- painting ----------------------------------------------------------------

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = DESK_COLOR;
    ctx.fillRect(0, 0, w, h);
    if (ir === null || view === null) return;
    const effective: PlotIR = liveCorners === null
      ? ir
      : {
          ...ir,
          viewports: ir.viewports.map((entry) =>
            entry.id === liveCorners.id
              ? { ...entry, rect: { x1: Math.min(liveCorners.c1[0], liveCorners.c2[0]), y1: Math.min(liveCorners.c1[1], liveCorners.c2[1]), x2: Math.max(liveCorners.c1[0], liveCorners.c2[0]), y2: Math.max(liveCorners.c1[1], liveCorners.c2[1]) } }
              : entry,
          ),
        };
    paintSheetBackdrop(ctx, effective, { toScreen, pxPerMm: view.zoom });
    paintPlotIR(ctx, effective, { toScreen, pxPerMm: view.zoom, selectedViewportId: props.selectedViewportId });
    // Corner grips on the selected viewport.
    if (props.selectedViewportId !== null) {
      const selected = viewports.find((v) => v.id === props.selectedViewportId);
      if (selected !== undefined) {
        const rect = viewportRect(selected);
        const corners: readonly PaperPt[] = [
          { x: rect.x1, y: rect.y1 },
          { x: rect.x2, y: rect.y1 },
          { x: rect.x2, y: rect.y2 },
          { x: rect.x1, y: rect.y2 },
        ];
        for (const c of corners) {
          const [sx, sy] = toScreen(c);
          ctx.beginPath();
          ctx.rect(sx - 4, sy - 4, 8, 8);
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#0f766e";
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }, [ir, view, props.selectedViewportId, viewports, toScreen, liveCorners]);

  // --- pointer interactions ------------------------------------------------------

  const hitViewport = React.useCallback(
    (paper: PaperPt): ViewportRecord | null => {
      if (view === null) return null;
      const tol = FRAME_HIT_PX / view.zoom;
      let best: ViewportRecord | null = null;
      let bestArea = Infinity;
      // Topmost (later table entries) win; smallest frame wins ties.
      for (let i = viewports.length - 1; i >= 0; i -= 1) {
        const vp = viewports[i]!;
        const rect = viewportRect(vp);
        const d = distanceToRectEdges(rect, paper);
        const inside = paper.x >= rect.x1 && paper.x <= rect.x2 && paper.y >= rect.y1 && paper.y <= rect.y2;
        if (d <= tol || (inside && d <= tol * 2)) {
          const area = (rect.x2 - rect.x1) * (rect.y2 - rect.y1);
          if (area < bestArea) {
            best = vp;
            bestArea = area;
          }
        }
      }
      return best;
    },
    [viewports, view],
  );

  const hitGrip = React.useCallback(
    (paper: PaperPt): { id: string; corner: 0 | 1 } | null => {
      if (props.selectedViewportId === null || view === null) return null;
      const selected = viewports.find((v) => v.id === props.selectedViewportId);
      if (selected === undefined) return null;
      const tol = GRIP_HIT_PX / view.zoom;
      const corners: readonly ((readonly [number, number]) & { x: number; y: number })[] = [
        Object.assign([...selected.corner1] as [number, number], { x: selected.corner1[0], y: selected.corner1[1] }),
        Object.assign([...selected.corner2] as [number, number], { x: selected.corner2[0], y: selected.corner2[1] }),
      ];
      for (let i = 0; i < corners.length; i += 1) {
        const c = corners[i]!;
        if (Math.abs(paper.x - c.x) <= tol && Math.abs(paper.y - c.y) <= tol) {
          return { id: selected.id, corner: i as 0 | 1 };
        }
      }
      return null;
    },
    [props.selectedViewportId, viewports, view],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null || view === null) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const paper = toPaper(sx, sy);
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1) {
      setDrag({ kind: "pan", startX: sx, startY: sy, ox: view.ox, oy: view.oy });
      return;
    }
    if (e.button !== 0) return;
    // MVIEW picks: the running command's point steps receive paper points.
    const step = effectiveStep(props.engineState);
    if (props.engineState.commandId === "mview" && step !== null && step.kind === "point") {
      props.onPickPoint([paper.x, paper.y]);
      return;
    }
    const grip = hitGrip(paper);
    if (grip !== null) {
      const vp = viewports.find((v) => v.id === grip.id)!;
      const other = grip.corner === 0 ? vp.corner2 : vp.corner1;
      setDrag({ kind: "corner", id: grip.id, corner: grip.corner, other: [other[0], other[1]] });
      return;
    }
    const hit = hitViewport(paper);
    if (hit !== null) {
      props.onSelectedViewport(hit.id);
      setDrag({ kind: "move", id: hit.id, grabX: paper.x, grabY: paper.y, corners: [[hit.corner1[0], hit.corner1[1]], [hit.corner2[0], hit.corner2[1]]] });
      return;
    }
    props.onSelectedViewport(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null || view === null) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const paper = toPaper(sx, sy);
    setHoverPaper(paper);
    props.onCursor([paper.x, paper.y]);
    if (drag === null) return;
    if (drag.kind === "pan") {
      setView({ ...view, ox: drag.ox + (sx - drag.startX), oy: drag.oy + (sy - drag.startY) });
      return;
    }
    if (drag.kind === "move") {
      const dx = paper.x - drag.grabX;
      const dy = paper.y - drag.grabY;
      setLiveCorners({
        id: drag.id,
        c1: [drag.corners[0]![0] + dx, drag.corners[0]![1] + dy],
        c2: [drag.corners[1]![0] + dx, drag.corners[1]![1] + dy],
      });
      return;
    }
    if (drag.kind === "corner") {
      setLiveCorners(
        drag.corner === 0
          ? { id: drag.id, c1: [paper.x, paper.y], c2: [drag.other[0], drag.other[1]] }
          : { id: drag.id, c1: [drag.other[0], drag.other[1]], c2: [paper.x, paper.y] },
      );
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    if (drag !== null && liveCorners !== null && (drag.kind === "move" || drag.kind === "corner")) {
      // Degenerate rects reject server-side (typed) — the drag simply
      // snaps back when the update fails.
      props.onViewportUpdate(liveCorners.id, { corner1: liveCorners.c1, corner2: liveCorners.c2 });
    }
    setDrag(null);
    setLiveCorners(null);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    if (view === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const zoom = Math.max(0.2, Math.min(20, view.zoom * factor));
    // Zoom about the cursor.
    const paperUnder = toPaper(sx, sy);
    setView({ zoom, ox: sx - paperUnder.x * zoom, oy: sy + paperUnder.y * zoom });
  };

  const selectedVp = viewports.find((v) => v.id === props.selectedViewportId) ?? null;
  const mviewRunning = props.engineState.commandId === "mview";
  const readoutScale = selectedVp !== null ? formatViewportScale(selectedVp) : null;


  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-slate-200" data-testid="layout-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        style={{ cursor: mviewRunning ? "crosshair" : drag !== null ? "grabbing" : "default" }}
        data-testid="layout-canvas"
        aria-label="paper space canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHoverPaper(null);
          props.onCursor(null);
        }}
        onWheel={onWheel}
      />
      {/* The paper-space overlay readout (sheet mm + the active layout). */}
      <div className="pointer-events-none absolute left-2 top-2 rounded bg-background/85 px-2 py-1 text-[10px] font-mono text-muted-foreground shadow" data-testid="layout-canvas-readout">
        {activeLayout !== null ? (
          <>
            <span className="font-semibold text-foreground">{activeLayout.name}</span>
            {" · "}
            {activeLayout.pageSetup.paperSize} {activeLayout.pageSetup.orientation} · {viewports.length} viewport{viewports.length === 1 ? "" : "s"}
            {selectedVp !== null ? ` · ${selectedVp.id} ${readoutScale}${selectedVp.locked === true ? " (locked)" : ""}` : ""}
          </>
        ) : (
          "No layouts — LAYOUTNEW creates one"
        )}
        {hoverPaper !== null ? ` · ${hoverPaper.x.toFixed(1)},${hoverPaper.y.toFixed(1)} mm` : ""}
      </div>
      {activeLayout !== null && viewports.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
          <div className="rounded border border-dashed border-muted-foreground/50 bg-background/90 px-4 py-3 text-xs text-muted-foreground">
            No viewports on this layout — run <span className="font-mono font-semibold text-foreground">MVIEW</span> (two paper corners + Fit/Scale/Window) or use the Layouts palette.
          </div>
        </div>
      )}
      {activeLayout === null && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="max-w-sm rounded border bg-background p-4 text-center shadow" data-testid="layout-empty-state">
            <p className="mb-2 text-sm font-semibold">No paper-space layouts yet</p>
            <p className="mb-3 text-xs text-muted-foreground">
              LAYOUTNEW creates a layout with the canonical A3 landscape page setup; MVIEW places viewports onto the model.
            </p>
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-accent"
              onClick={() => props.onCommandStart("layoutnew")}
              data-testid="layout-empty-new"
            >
              New Layout (LAYOUTNEW)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
