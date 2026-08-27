"use client";

/**
 * CAD-PARITY-002 professional Model canvas (Web host).
 *
 * The 2D drafting/BIM-plan viewport of the professional workspace: pan/zoom,
 * grid, crosshair + live coordinate readout, deterministic snapping with
 * markers, ortho/polar/otrack-constrained rubber bands, window/crossing
 * selection, stacked-hit cycling, entity grips with drag editing and a
 * contextual mini-toolbar. ALL command input flows through the shared
 * prompt engine (the shell dispatches the events) so the canvas, the
 * command line, the ribbon and the palette produce IDENTICAL semantic
 * commands (LOCK-004 parity; §5.3 — mutations only through the App API).
 *
 * The engine-free pure core (selection/grips/feedback) is imported from
 * @offisos/cad-app-shell/workspace — the SAME code the Electron renderer
 * uses. No engine ever loads in the browser (LOCK-003/018).
 */

import * as React from "react";
import type { CADDocumentSnapshot, Element, LayerRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import { resolveSnap } from "@offisos/cad-app-shell/drafting/snap";
import { commandById } from "@offisos/cad-app-shell/workspace/commands";
import type { PromptEngineState } from "@offisos/cad-app-shell/workspace/prompt-engine";
import {
  applyPickModifier,
  cyclePick,
  gripDrag,
  gripsFor,
  hitTest,
  selectionRectangle,
  windowSelect,
  type EntityPick,
  type GripEditResult,
} from "@offisos/cad-app-shell/workspace";
import { constrainCursor, type DraftingAids } from "@offisos/cad-app-shell/workspace/feedback";
import { Eraser, Move, Copy, MousePointerSquareDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  drawBimPlanElement,
  drawCrosshair,
  drawEntity,
  drawGrid,
  drawGrips,
  drawPendingPolyline,
  drawRubberBand,
  drawSelectionRect,
  drawSnapMarker,
  parseDraftEntity,
} from "@/cad/workspace/draw";

export interface ModelCanvasProps {
  readonly snapshot: CADDocumentSnapshot | null;
  readonly selection: readonly string[];
  readonly aids: DraftingAids;
  readonly engineState: PromptEngineState;
  readonly busy: boolean;
  readonly onCursor: (world: Vec2 | null) => void;
  readonly onPickPoint: (world: Vec2) => void;
  readonly onPickEntity: (pick: EntityPick) => void;
  readonly onSelectionChange: (ids: readonly string[]) => void;
  readonly onGripEdit: (result: GripEditResult) => void;
  readonly onCommandStart: (commandId: string) => void;
  /** Increments when ZOOMEXTENTS runs — the canvas fits the visible model. */
  readonly zoomExtentsSignal: number;
}

interface DragState {
  readonly kind: "pan" | "selection" | "grip";
  readonly startX: number;
  readonly startY: number;
  readonly panX: number;
  readonly panY: number;
  readonly gripId: string;
  readonly gripElement: Element | null;
}

function toEntityPick(el: Element): EntityPick {
  return { id: el.id, kind: el.kind, props: el.props as Record<string, unknown> };
}

export function ModelCanvas(props: ModelCanvasProps): React.JSX.Element {
  const { snapshot, selection, aids, engineState, busy } = props;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const lastClickRef = React.useRef<{ screen: [number, number]; at: number; index: number } | null>(null);

  const [pan, setPan] = React.useState({ x: -20, y: -20 });
  const [zoom, setZoom] = React.useState(6);
  const [canvasH, setCanvasH] = React.useState(480);
  const [panning, setPanning] = React.useState(false);
  const [cursor, setCursor] = React.useState<Vec2 | null>(null);
  const [selectionRect, setSelectionRect] = React.useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const [hotGrip, setHotGrip] = React.useState<string | null>(null);

  const layers = snapshot?.layers ?? [];
  const settings = snapshot?.draftingSettings;

  // Restore the persisted view once the first snapshot arrives (async —
  // state updates happen after the await boundary).
  const restoredRef = React.useRef(false);
  React.useEffect(() => {
    if (restoredRef.current || snapshot === null) return;
    restoredRef.current = true;
    const view = snapshot.draftingSettings?.view;
    if (view !== undefined) {
      void (async () => {
        await Promise.resolve();
        setPan({ x: view.pan[0], y: view.pan[1] });
        setZoom(view.zoom);
      })();
    }
  }, [snapshot]);

  // Track the canvas size (pure transforms below read state, not refs).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const update = () => setCanvasH(canvas.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const toScreen = React.useCallback(
    (p: Vec2): [number, number] => [(p[0] - pan.x) * zoom, canvasH - (p[1] - pan.y) * zoom],
    [pan, zoom, canvasH],
  );

  const toWorld = React.useCallback(
    (sx: number, sy: number): Vec2 => [sx / zoom + pan.x, (canvasH - sy) / zoom],
    [pan, zoom, canvasH],
  );

  const persistView = React.useCallback((p: { x: number; y: number }, z: number) => {
    if (viewTimer.current !== null) clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      void fetch("/api/cad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api: "1",
          body: { type: "command", name: "drafting.setSettings", payload: { view: { pan: [p.x, p.y], zoom: z } } },
        }),
      }).catch(() => undefined);
    }, 400);
  }, []);

  // --- visible (pickable/snappable) entities ----------------------------------

  const visibleEntities = React.useMemo(() => {
    const visible = new Set(layers.filter((l) => l.visible).map((l) => l.id));
    return (snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      const layer = props.layer;
      return typeof layer === "string" && visible.has(layer);
    });
  }, [snapshot, layers]);

  // --- engine-aware interaction -------------------------------------------------

  const command = engineState.commandId === null ? null : commandById(engineState.commandId);
  const activeStep =
    command !== null && command.steps.length > 0 ? (command.steps[engineState.stepIndex] ?? null) : null;
  const stepBase = React.useMemo<Vec2 | null>(() => {
    if (activeStep === null) return engineState.lastPoint;
    if (activeStep.baseStep !== undefined) {
      const v = engineState.values[activeStep.baseStep];
      if (v !== undefined && v.kind === "point") return v.point;
    }
    return engineState.lastPoint;
  }, [activeStep, engineState]);

  // ZOOMEXTENTS: fit every visible entity in the viewport (deterministic
  // bounds + padding; stories are excluded — they have no plan geometry).
  React.useEffect(() => {
    if (props.zoomExtentsSignal === 0) return;
    const elements = visibleEntities;
    if (elements.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of elements) {
      const entity = parseDraftEntity(el);
      const p = el.props as Record<string, unknown>;
      const points: Vec2[] = [];
      if (entity !== null) {
        if (entity.type === "line") points.push(entity.from, entity.to);
        else if (entity.type === "polyline") points.push(...entity.points);
        else if (entity.type === "circle") {
          points.push([entity.center[0] - entity.radius, entity.center[1] - entity.radius], [entity.center[0] + entity.radius, entity.center[1] + entity.radius]);
        } else if (entity.type === "rectangle") points.push(entity.corner1, entity.corner2);
      } else if (p.type === "bim.wall" && Array.isArray(p.start) && Array.isArray(p.end)) {
        points.push(p.start as unknown as Vec2, p.end as unknown as Vec2);
      } else if (p.type === "bim.slab" && Array.isArray(p.corner1) && Array.isArray(p.corner2)) {
        points.push(p.corner1 as unknown as Vec2, p.corner2 as unknown as Vec2);
      } else {
        continue;
      }
      for (const pt of points) {
        minX = Math.min(minX, pt[0]);
        minY = Math.min(minY, pt[1]);
        maxX = Math.max(maxX, pt[0]);
        maxY = Math.max(maxY, pt[1]);
      }
    }
    if (!Number.isFinite(minX)) return;
    const w = canvasRef.current?.clientWidth ?? 900;
    const pad = 600;
    const spanX = Math.max(maxX - minX + pad * 2, 1);
    const spanY = Math.max(maxY - minY + pad * 2, 1);
    const z = Math.min(w / spanX, canvasH / spanY);
    setZoom(z);
    setPan({ x: minX - pad - (w / z - spanX) / 2, y: minY - pad - (canvasH / z - spanY) / 2 });
    persistView({ x: minX - pad - (w / z - spanX) / 2, y: minY - pad - (canvasH / z - spanY) / 2 }, z);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.zoomExtentsSignal]);

  /** Constrain (aids) → snap (osnap) — the canonical composition order. */
  const constrainedSnapped = React.useCallback(
    (world: Vec2, shiftHeld: boolean): { point: Vec2; snapped: boolean } => {
      const effectiveAids: DraftingAids = shiftHeld ? { ...aids, ortho: true } : aids;
      const constrained = constrainCursor(stepBase, world, effectiveAids).point;
      if (settings?.snap.enabled !== true) return { point: constrained, snapped: false };
      const r = resolveSnap({
        point: constrained,
        tolerance: settings.snap.tolerance,
        kinds: settings.snap.kinds,
        gridSize: settings.grid.size,
        entities: visibleEntities,
      });
      if (r.best === null) return { point: constrained, snapped: false };
      return { point: [r.best.point[0], r.best.point[1]], snapped: true };
    },
    [aids, stepBase, settings, visibleEntities],
  );

  const selectedSet = React.useMemo(() => new Set(selection), [selection]);
  const singleSelected = React.useMemo(() => {
    if (selection.length !== 1) return null;
    return (snapshot?.elements ?? []).find((el) => el.id === selection[0]) ?? null;
  }, [selection, snapshot]);
  const grips = React.useMemo(() => (singleSelected !== null ? gripsFor(singleSelected) : []), [singleSelected]);

  // --- pointer handlers -----------------------------------------------------------

  const pointerScreen = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = pointerScreen(e);
    canvasRef.current?.focus();

    // Middle button or space+left → pan.
    if (e.button === 1) {
      dragRef.current = { kind: "pan", startX: sx, startY: sy, panX: pan.x, panY: pan.y, gripId: "", gripElement: null };
      setPanning(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    // Grip drag start (single selection, engine idle).
    if (activeStep === null && singleSelected !== null) {
      for (const grip of grips) {
        const gs = toScreen(grip.point);
        if (Math.hypot(gs[0] - sx, gs[1] - sy) <= 7) {
          dragRef.current = { kind: "grip", startX: sx, startY: sy, panX: pan.x, panY: pan.y, gripId: grip.id, gripElement: singleSelected };
          e.currentTarget.setPointerCapture(e.pointerId);
          setHotGrip(grip.id);
          return;
        }
      }
    }

    const world = toWorld(sx, sy);

    if (activeStep !== null) {
      // Command input.
      if (activeStep.kind === "entity") {
        const hits = hitTest(world, 8 / zoom, visibleEntities);
        const hit = hits.length > 0 ? (snapshot?.elements ?? []).find((el) => el.id === hits[0]!.id) : undefined;
        if (hit !== undefined) props.onPickEntity(toEntityPick(hit));
        return; // miss: the prompt stays (the command line shows guidance)
      }
      const { point } = constrainedSnapped(world, e.shiftKey);
      if (activeStep.kind === "point") props.onPickPoint(point);
      else if (activeStep.kind === "distance" || activeStep.kind === "displacement") props.onPickPoint(point);
      return;
    }

    // Selection mode.
    const hits = hitTest(world, 8 / zoom, visibleEntities);
    if (hits.length > 0) {
      // Cycling: repeated clicks at the same spot advance through stacked hits.
      const last = lastClickRef.current;
      const now = Date.now();
      let chosen = hits[0]!.id;
      let index = 0;
      if (last !== null && now - last.at < 700 && Math.hypot(last.screen[0] - sx, last.screen[1] - sy) < 6) {
        const cycled = cyclePick(world, 8 / zoom, visibleEntities, last.index);
        if (cycled !== null) {
          chosen = cycled.id;
          index = cycled.index;
        }
      }
      lastClickRef.current = { screen: [sx, sy], at: now, index };
      props.onSelectionChange(applyPickModifier(selection, chosen, e.shiftKey ? "toggle" : "replace"));
      return;
    }
    lastClickRef.current = null;
    // Empty-space drag → window/crossing selection rect.
    dragRef.current = { kind: "selection", startX: sx, startY: sy, panX: pan.x, panY: pan.y, gripId: "", gripElement: null };
    setSelectionRect({ a: [sx, sy], b: [sx, sy] });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = pointerScreen(e);
    const drag = dragRef.current;

    if (drag !== null && drag.kind === "pan") {
      setPan({ x: drag.panX - (sx - drag.startX) / zoom, y: drag.panY + (sy - drag.startY) / zoom });
      return;
    }
    if (drag !== null && drag.kind === "selection") {
      setSelectionRect({ a: [drag.startX, drag.startY], b: [sx, sy] });
      return;
    }
    if (drag !== null && drag.kind === "grip") {
      const world = toWorld(sx, sy);
      const snapped = settings?.snap.enabled === true ? constrainedSnapped(world, e.shiftKey).point : world;
      setCursor(snapped);
      return;
    }

    const world = toWorld(sx, sy);
    setCursor(world);
    props.onCursor(world);

    // Hover highlight of grips.
    if (activeStep === null && singleSelected !== null) {
      let hot: string | null = null;
      for (const grip of grips) {
        const gs = toScreen(grip.point);
        if (Math.hypot(gs[0] - sx, gs[1] - sy) <= 7) {
          hot = grip.id;
          break;
        }
      }
      setHotGrip(hot);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;

    if (drag.kind === "pan") {
      setPanning(false);
      persistView(pan, zoom);
      return;
    }
    if (drag.kind === "selection") {
      setSelectionRect(null);
      const [sx, sy] = pointerScreen(e);
      const a = toWorld(drag.startX, drag.startY);
      const b = toWorld(sx, sy);
      if (Math.hypot(sx - drag.startX, sy - drag.startY) < 4) {
        // A click on empty space clears the selection.
        if (!e.shiftKey && selection.length > 0) props.onSelectionChange([]);
        return;
      }
      const rect = selectionRectangle(a, b);
      const ids = windowSelect(rect, visibleEntities);
      props.onSelectionChange(e.shiftKey ? Array.from(new Set([...selection, ...ids])) : ids);
      return;
    }
    if (drag.kind === "grip" && drag.gripElement !== null) {
      setHotGrip(null);
      const [sx, sy] = pointerScreen(e);
      const world = toWorld(sx, sy);
      const snapped = constrainedSnapped(world, e.shiftKey).point;
      const result = gripDrag(drag.gripElement, drag.gripId, snapped);
      if (result !== null && result.appApi.length > 0) props.onGripEdit(result);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const z = Math.min(400, Math.max(0.5, zoom * factor));
    setZoom(z);
    persistView(pan, z);
  };

  // --- rendering -----------------------------------------------------------------

  const snapPreview = React.useMemo(() => {
    if (cursor === null || activeStep === null) return null;
    const { point, snapped } = constrainedSnapped(cursor, false);
    return snapped ? point : null;
  }, [cursor, activeStep, constrainedSnapped]);

  const polylinePending = React.useMemo(() => {
    if (command === null || command.id !== "polyline") return [];
    const start = engineState.values.start;
    const next = engineState.values.next;
    const points: Vec2[] = [];
    if (start !== undefined && start.kind === "point") points.push(start.point);
    if (next !== undefined && next.kind === "points") points.push(...next.points);
    return points;
  }, [command, engineState]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = window.devicePixelRatio ?? 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    if (settings?.grid.enabled) {
      drawGrid(ctx, { size: settings.grid.size, pan, zoom, w, h, toScreen });
    }

    const layerById = new Map<string, LayerRecord>(layers.map((l) => [l.id, l] as const));
    for (const el of visibleEntities) {
      const entity = parseDraftEntity(el);
      if (entity !== null) {
        const layer = layerById.get(entity.layer);
        if (layer !== undefined && !layer.visible) continue;
        drawEntity(ctx, entity, {
          color: layer?.color ?? "#111827",
          selected: selectedSet.has(el.id),
          toScreen,
          zoom,
        });
        continue;
      }
      drawBimPlanElement(ctx, el, { selected: selectedSet.has(el.id), toScreen, zoom });
    }

    // Pending polyline preview.
    if (polylinePending.length > 0) {
      const previewCursor = cursor !== null ? constrainedSnapped(cursor, false).point : null;
      drawPendingPolyline(ctx, polylinePending, previewCursor, toScreen);
    }

    // Rubber band for the active point/distance/displacement step.
    if (activeStep !== null && stepBase !== null && cursor !== null && (activeStep.kind === "point" || activeStep.kind === "distance" || activeStep.kind === "displacement")) {
      const constrained = constrainedSnapped(cursor, false).point;
      drawRubberBand(ctx, stepBase, constrained, toScreen);
    }

    // Selection rectangle (window/crossing).
    if (selectionRect !== null) {
      const mode = selectionRect.b[0] >= selectionRect.a[0] ? "window" : "crossing";
      drawSelectionRect(ctx, selectionRect.a, selectionRect.b, mode);
    }

    // Grips for the single selection.
    if (activeStep === null && singleSelected !== null) {
      drawGrips(ctx, grips, toScreen, hotGrip);
    }

    // Snap marker.
    if (snapPreview !== null) {
      drawSnapMarker(ctx, toScreen(snapPreview));
    }

    // Crosshair (always in this professional viewport).
    if (cursor !== null) {
      drawCrosshair(ctx, toScreen(cursor), w, h);
    }
  }, [settings, layers, visibleEntities, selectedSet, toScreen, pan, zoom, cursor, selectionRect, snapPreview, polylinePending, activeStep, stepBase, singleSelected, grips, hotGrip, constrainedSnapped]);

  // --- mini-toolbar position -------------------------------------------------------------

  const miniToolbar = React.useMemo(() => {
    if (activeStep !== null || selection.length === 0 || selectionRect !== null) return null;
    const selected = (snapshot?.elements ?? []).filter((el) => selectedSet.has(el.id));
    if (selected.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of selected) {
      const entity = parseDraftEntity(el);
      const props = el.props as Record<string, unknown>;
      const points: Vec2[] = [];
      if (entity !== null) {
        if (entity.type === "line") points.push(entity.from, entity.to);
        else if (entity.type === "polyline") points.push(...entity.points);
        else if (entity.type === "circle") {
          points.push([entity.center[0] - entity.radius, entity.center[1] - entity.radius], [entity.center[0] + entity.radius, entity.center[1] + entity.radius]);
        } else if (entity.type === "rectangle") points.push(entity.corner1, entity.corner2);
      } else if (props.type === "bim.wall") {
        points.push(props.start as unknown as Vec2, props.end as unknown as Vec2);
      } else if (props.type === "bim.slab") {
        points.push(props.corner1 as unknown as Vec2, props.corner2 as unknown as Vec2);
      }
      for (const p of points) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return null;
    const top = toScreen([minX, maxY]);
    return { left: top[0], top: Math.max(8, top[1] - 44) };
  }, [activeStep, selection, selectionRect, snapshot, selectedSet, toScreen]);

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="Offisos Model viewport — 2D drafting and BIM plan canvas"
        className="h-full min-h-[420px] w-full touch-none rounded border bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ cursor: panning ? "grabbing" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={() => {
          // Double-click = Enter (finishes polyline-style steps).
          const ev = new KeyboardEvent("keydown", { key: "Enter" });
          window.dispatchEvent(ev);
        }}
      />
      {busy && (
        <div className="pointer-events-none absolute right-3 top-3 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow" role="status">
          working…
        </div>
      )}
      {miniToolbar !== null && (
        <div
          className="absolute z-10 flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-md"
          style={{ left: Math.max(4, miniToolbar.left), top: miniToolbar.top }}
          role="toolbar"
          aria-label="selection actions"
        >
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Move selection (MOVE)" onClick={() => props.onCommandStart("move")}>
            <Move className="mr-1 h-3.5 w-3.5" aria-hidden /> Move
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Copy selection (COPY)" onClick={() => props.onCommandStart("copy")}>
            <Copy className="mr-1 h-3.5 w-3.5" aria-hidden /> Copy
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Erase selection (ERASE / Del)" onClick={() => props.onCommandStart("erase")}>
            <Eraser className="mr-1 h-3.5 w-3.5" aria-hidden /> Erase
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Deselect all (Esc)" onClick={() => props.onSelectionChange([])}>
            <MousePointerSquareDashed className="mr-1 h-3.5 w-3.5" aria-hidden /> Deselect
          </Button>
        </div>
      )}
    </div>
  );
}
