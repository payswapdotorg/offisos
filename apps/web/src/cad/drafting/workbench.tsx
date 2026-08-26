"use client";

/**
 * Offisos 2D Drafting Workbench — Web host surface (COMPAT-CAD-001 /
 * Issue #37, Architecture v1.1 FROZEN).
 *
 * A REAL drafting workflow, not a mockup: canvas viewport with grid, pan/
 * zoom; persistent layers; line/polyline/circle/arc/rectangle/dimensions;
 * deterministic snapping (the SAME pure drafting core the server runs —
 * imported here for interaction-time preview; every MUTATION goes through
 * the shared App API over fetch("/api/cad") exactly like the Electron host);
 * select/move/copy/delete; trim/extend with pick semantics; undo/redo
 * through the document command model; save/open with persisted selection,
 * settings and revision lineage.
 *
 * Client-safety: imports ONLY the pure drafting modules
 * (`@offisos/cad-app-shell/drafting` — precision/geom2d/entities/snap have
 * no node:crypto dependency) and the transport. No engine ever loads in the
 * browser (LOCK-003/018).
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { CADDocumentSnapshot, LayerRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import {
  createDoc,
  draftingAddLayer,
  draftingCreate,
  draftingOp,
  draftingRemoveLayer,
  draftingSetSettings,
  draftingUpdateLayer,
  getState,
  openFromBytes,
  redo,
  save,
  setSelection,
  undo,
  unwrapSaveBytes,
} from "@/cad/client/http-transport";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import { isDraftingElement, type DraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import { resolveSnap } from "@offisos/cad-app-shell/drafting/snap";
import { SNAP_KIND_PRIORITY } from "@offisos/cad-app-shell/caddocument/workspace";
import { hitTest, parseDraftEntity } from "@/cad/drafting/hit";

type Tool =
  | "select"
  | "line"
  | "polyline"
  | "circle"
  | "arc"
  | "rectangle"
  | "dim-linear"
  | "dim-radius"
  | "trim"
  | "extend"
  | "pan";

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "select", label: "Select", hint: "click entities (shift adds/removes)" },
  { id: "line", label: "Line", hint: "2 points" },
  { id: "polyline", label: "Polyline", hint: "points, Enter or double-click ends" },
  { id: "circle", label: "Circle", hint: "center + radius point" },
  { id: "arc", label: "Arc", hint: "center + start + end (CCW)" },
  { id: "rectangle", label: "Rect", hint: "2 corners" },
  { id: "dim-linear", label: "Dim", hint: "2 points + offset side" },
  { id: "dim-radius", label: "R-Dim", hint: "click a circle/arc" },
  { id: "trim", label: "Trim", hint: "click the part to remove (lines)" },
  { id: "extend", label: "Extend", hint: "click the end to extend (lines)" },
  { id: "pan", label: "Pan", hint: "drag to pan; wheel zooms" },
];

export function DraftingWorkbench(): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const viewTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = React.useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [snapshot, setSnapshot] = React.useState<CADDocumentSnapshot | null>(null);
  const [selection, setSel] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tool, setTool] = React.useState<Tool>("select");
  const [activeLayer, setActiveLayer] = React.useState("0");
  const [pending, setPending] = React.useState<Vec2[]>([]);
  const [cursor, setCursor] = React.useState<Vec2 | null>(null);
  const [pan, setPan] = React.useState({ x: -20, y: -20 });
  const [zoom, setZoom] = React.useState(6);
  const [dx, setDx] = React.useState("10");
  const [dy, setDy] = React.useState("0");
  const [entryX, setEntryX] = React.useState("0");
  const [entryY, setEntryY] = React.useState("0");
  const [newLayerName, setNewLayerName] = React.useState("");

  const settings = snapshot?.draftingSettings;
  const layers = snapshot?.layers ?? [];
  const selectedSet = React.useMemo(() => new Set(selection), [selection]);

  const refresh = React.useCallback(async () => {
    const res = await getState();
    if (!res.ok) {
      setError(`[getState] ${res.code}: ${res.message}`);
      return;
    }
    const snap = res.value as CADDocumentSnapshot;
    setSnapshot(snap);
    setSel([...(snap.selection ?? [])]);
    if (snap.draftingSettings?.view !== undefined) {
      setPan({ x: snap.draftingSettings.view.pan[0], y: snap.draftingSettings.view.pan[1] });
      setZoom(snap.draftingSettings.view.zoom);
    }
    if (!(snap.layers ?? []).some((l) => l.id === activeLayer)) {
      setActiveLayer(snap.layers?.[0]?.id ?? "0");
    }
  }, [activeLayer]);

  // Initial load (async — setState fires after the await, lint-safe).
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getState();
      if (cancelled) return;
      if (!res.ok) {
        setError(`[getState] ${res.code}: ${res.message}`);
        return;
      }
      const snap = res.value as CADDocumentSnapshot;
      setSnapshot(snap);
      setSel([...(snap.selection ?? [])]);
      if (snap.draftingSettings?.view !== undefined) {
        setPan({ x: snap.draftingSettings.view.pan[0], y: snap.draftingSettings.view.pan[1] });
        setZoom(snap.draftingSettings.view.zoom);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = React.useCallback(
    async (label: string, fn: () => Promise<CommandQueryResponse>): Promise<CommandQueryResponse> => {
      setBusy(true);
      setError(null);
      let res: CommandQueryResponse;
      try {
        res = await fn();
      } catch (e) {
        res = { ok: false, code: "unexpected", message: (e as Error).message, retryable: false };
      }
      if (!res.ok) setError(`[${label}] ${res.code}: ${res.message}`);
      await refresh();
      setBusy(false);
      return res;
    },
    [refresh],
  );

  // --- view transform ---------------------------------------------------------

  const zoomFactor = React.useCallback((): number => zoom, [zoom]);

  const toScreen = React.useCallback(
    (p: Vec2): [number, number] => {
      const h = canvasRef.current?.clientHeight ?? 480;
      return [(p[0] - pan.x) * zoom, h - (p[1] - pan.y) * zoom];
    },
    [pan, zoom],
  );

  const toWorld = React.useCallback(
    (sx: number, sy: number): Vec2 => {
      const h = canvasRef.current?.clientHeight ?? 480;
      return [sx / zoom + pan.x, (h - sy) / zoom + pan.y];
    },
    [pan, zoom],
  );

  const persistView = React.useCallback(
    (p: { x: number; y: number }, z: number) => {
      if (viewTimer.current !== null) clearTimeout(viewTimer.current);
      viewTimer.current = setTimeout(() => {
        void draftingSetSettings({ view: { pan: [p.x, p.y], zoom: z } });
      }, 400);
    },
    [],
  );

  // --- snapping preview (the SAME pure core the server queries run) ----------

  const visibleEntities = React.useMemo(() => {
    const visible = new Set(layers.filter((l) => l.visible).map((l) => l.id));
    return (snapshot?.elements ?? []).filter((el) => {
      const layer = (el.props as { layer?: unknown }).layer;
      return typeof layer === "string" && visible.has(layer);
    });
  }, [snapshot, layers]);

  const snapPoint = React.useCallback(
    (world: Vec2): Vec2 => {
      if (!settings?.snap.enabled) return world;
      const r = resolveSnap({
        point: world,
        tolerance: settings.snap.tolerance,
        kinds: settings.snap.kinds,
        gridSize: settings.grid.size,
        entities: visibleEntities,
      });
      if (r.best === null) return world;
      return [r.best.point[0], r.best.point[1]];
    },
    [settings, visibleEntities],
  );

  // --- creation ------------------------------------------------------------

  const createEntities = React.useCallback(
    async (entities: Record<string, unknown>[], label: string) => {
      await run(label, () => draftingCreate(entities));
    },
    [run],
  );

  const onCanvasClick = React.useCallback(
    async (screenX: number, screenY: number, shift: boolean) => {
      const world = toWorld(screenX, screenY);
      const snapped = snapPoint(world);
      switch (tool) {
        case "select": {
          const hit = hitTest(visibleEntities, world, 8 / zoom);
          if (hit === null) {
            if (!shift) await run("clear selection", () => setSelection([]));
            return;
          }
          const next = shift
            ? (selection.includes(hit) ? selection.filter((id) => id !== hit) : [...selection, hit])
            : [hit];
          await run("selection", () => setSelection(next));
          return;
        }
        case "trim":
        case "extend": {
          const hit = hitTest(visibleEntities, world, 8 / zoom);
          if (hit === null) return;
          await run(tool, () =>
            draftingOp(tool === "trim" ? "drafting.trim" : "drafting.extend", {
              targetId: hit,
              pick: [world[0], world[1]],
            }));
          return;
        }
        case "dim-radius": {
          const hit = hitTest(visibleEntities, world, 8 / zoom);
          if (hit === null) return;
          const el = snapshot?.elements.find((e) => e.id === hit);
          const entity = el !== undefined ? parseDraftEntity(el) : null;
          if (entity === null || (entity.type !== "circle" && entity.type !== "arc")) {
            setError("[dim-radius] target must be a circle or arc");
            return;
          }
          await createEntities([{ type: "dim-radius", layer: activeLayer, target: hit }], "radius dimension");
          return;
        }
        case "pan":
          return;
        default:
          break;
      }
      const next = [...pending, snapped];
      const need: Record<string, number> = {
        line: 2, circle: 2, arc: 3, rectangle: 2, "dim-linear": 3, polyline: Infinity,
      };
      if (tool === "polyline") {
        setPending(next);
        return;
      }
      if (next.length < (need[tool] ?? 2)) {
        setPending(next);
        return;
      }
      const [a, b, c] = next as [Vec2, Vec2, Vec2];
      let entity: Record<string, unknown> | null = null;
      let label: string = tool;
      switch (tool) {
        case "line":
          entity = { type: "line", layer: activeLayer, from: a, to: b };
          break;
        case "circle": {
          const radius = Math.hypot(b[0] - a[0], b[1] - a[1]);
          entity = { type: "circle", layer: activeLayer, center: a, radius };
          break;
        }
        case "arc": {
          const r1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const r2 = Math.hypot(c[0] - a[0], c[1] - a[1]);
          const a0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const a1 = Math.atan2(c[1] - a[1], c[0] - a[0]);
          entity = { type: "arc", layer: activeLayer, center: a, radius: (r1 + r2) / 2, startAngle: a0, endAngle: a1 };
          break;
        }
        case "rectangle":
          entity = { type: "rectangle", layer: activeLayer, corner1: a, corner2: b };
          break;
        case "dim-linear": {
          const dxl = b[0] - a[0];
          const dyl = b[1] - a[1];
          const len = Math.hypot(dxl, dyl) || 1;
          const nx = -dyl / len;
          const ny = dxl / len;
          const offset = (c[0] - a[0]) * nx + (c[1] - a[1]) * ny;
          entity = { type: "dim-linear", layer: activeLayer, p1: a, p2: b, mode: "aligned", offset };
          label = "linear dimension";
          break;
        }
        default:
          entity = null;
      }
      setPending([]);
      if (entity !== null) await createEntities([entity], label);
    },
    [toWorld, snapPoint, tool, pending, selection, snapshot, activeLayer, zoom, visibleEntities, run, createEntities],
  );

  const finishPolyline = React.useCallback(async () => {
    if (tool !== "polyline") {
      setPending([]);
      return;
    }
    if (pending.length >= 2) {
      await createEntities([{ type: "polyline", layer: activeLayer, points: pending }], "polyline");
    }
    setPending([]);
  }, [tool, pending, activeLayer, createEntities]);

  // --- pointer handlers --------------------------------------------------------

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (tool === "pan" || e.button === 1) {
      dragRef.current = { startX: sx, startY: sy, panX: pan.x, panY: pan.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (dragRef.current !== null) {
      const d = dragRef.current;
      setPan({ x: d.panX - (sx - d.startX) / zoom, y: d.panY + (sy - d.startY) / zoom });
      return;
    }
    const world = toWorld(sx, sy);
    setCursor(world);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current !== null) {
      dragRef.current = null;
      persistView(pan, zoom);
      return;
    }
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    void onCanvasClick(e.clientX - rect.left, e.clientY - rect.top, e.shiftKey);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const z = Math.min(400, Math.max(0.5, zoom * factor));
    setZoom(z);
    persistView(pan, z);
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPending([]);
      if (e.key === "Enter" && (document.activeElement?.tagName ?? "") !== "INPUT") void finishPolyline();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finishPolyline]);

  // --- canvas rendering ---------------------------------------------------------

  const snapPreviewPoint = React.useMemo(
    () => (cursor !== null ? snapPoint(cursor) : null),
    [cursor, snapPoint],
  );
  const snappedNow =
    cursor !== null && snapPreviewPoint !== null &&
    (snapPreviewPoint[0] !== cursor[0] || snapPreviewPoint[1] !== cursor[1]);

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

    const grid = settings?.grid;
    if (grid?.enabled) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 1;
      const startX = Math.floor(pan.x / grid.size) * grid.size;
      const startY = Math.floor(pan.y / grid.size) * grid.size;
      ctx.beginPath();
      for (let x = startX; x <= pan.x + w / zoom; x += grid.size) {
        const [sx] = toScreen([x, 0]);
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      }
      for (let y = startY; y <= pan.y + h / zoom; y += grid.size) {
        const [, sy] = toScreen([0, y]);
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }

    const layerById = new Map<string, LayerRecord>(layers.map((l) => [l.id, l] as const));
    for (const el of visibleEntities) {
      const entity = parseDraftEntity(el);
      if (entity === null) continue;
      const layer = layerById.get(entity.layer);
      if (layer !== undefined && !layer.visible) continue;
      drawEntity(ctx, entity, {
        color: layer?.color ?? "#111827",
        selected: selectedSet.has(el.id),
        toScreen,
        zoom: zoomFactor(),
      });
    }

    if (pending.length > 0) {
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const [x0, y0] = toScreen(pending[0] as Vec2);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < pending.length; i++) {
        const [x, y] = toScreen(pending[i] as Vec2);
        ctx.lineTo(x, y);
      }
      if (cursor !== null && tool !== "select" && tool !== "pan") {
        const anchor = snapPreviewPoint ?? cursor;
        const [x, y] = toScreen(anchor);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (snappedNow && snapPreviewPoint !== null) {
      const [x, y] = toScreen(snapPreviewPoint);
      ctx.strokeStyle = "#0d9488";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
  }, [snapshot, settings, layers, visibleEntities, selectedSet, toScreen, pan, zoom, pending, cursor, snapPreviewPoint, snappedNow, tool, zoomFactor]);

  // --- file actions ------------------------------------------------------------

  const onSave = async () => {
    const res = await run("save", () => save());
    const saved = unwrapSaveBytes(res);
    if (saved === null) return;
    const blob = new Blob([new Uint8Array(saved.bytes)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "offisos-drafting.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const onOpenFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    void (async () => {
      const buf = new Uint8Array(await file.arrayBuffer());
      await run("open", () => openFromBytes(buf));
    })();
    e.target.value = "";
  };

  const snapKindsActive = (kind: string): boolean => (settings?.snap.kinds ?? []).includes(kind as never);
  const onToggleSnapKind = (kind: string) => {
    const cur = settings?.snap.kinds ?? [];
    const next = cur.includes(kind as never) ? cur.filter((k) => k !== kind) : [...cur, kind];
    if (next.length === 0) return;
    void run("snap kinds", () => draftingSetSettings({ snap: { kinds: next } }));
  };

  const revisions = snapshot?.modelHistory?.revisions.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>2D Drafting Workbench</CardTitle>
        <CardDescription>
          Layers, entities, snapping, trim/extend, undo/redo, save/open — every mutation through the shared App API
          (COMPAT-CAD-001). Wheel = zoom, Pan tool or middle-drag = pan, Esc = cancel, Enter = finish polyline.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error !== null && (
          <div role="alert" className="mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1" role="toolbar" aria-label="drafting tools">
              {TOOLS.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={tool === t.id ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => {
                    setTool(t.id);
                    setPending([]);
                  }}
                  title={t.hint}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            <canvas
              ref={canvasRef}
              className="w-full h-[480px] rounded border bg-white touch-none"
              style={{ cursor: tool === "pan" ? "grab" : "crosshair" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onWheel={onWheel}
              onDoubleClick={() => void finishPolyline()}
              aria-label="2D drafting canvas"
            />
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                cursor: {cursor !== null ? `(${cursor[0].toFixed(2)}, ${cursor[1].toFixed(2)}) mm` : "—"}
              </span>
              {snappedNow && <Badge variant="secondary">snap</Badge>}
              <span>selection: {selection.length}</span>
              <span>revisions: {revisions}</span>
              <span className="font-mono">{snapshot?.version.version_id.slice(0, 30) ?? ""}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">ΔX</span>
              <input aria-label="delta x" className="w-16 border rounded px-2 py-1 text-sm" value={dx} onChange={(e) => setDx(e.target.value)} />
              <span className="text-xs text-muted-foreground">ΔY</span>
              <input aria-label="delta y" className="w-16 border rounded px-2 py-1 text-sm" value={dy} onChange={(e) => setDy(e.target.value)} />
              <Button size="sm" variant="outline" disabled={busy || selection.length === 0}
                onClick={() => void run("move", () => draftingOp("drafting.move", { ids: selection, dx: Number(dx), dy: Number(dy) }))}>
                Move
              </Button>
              <Button size="sm" variant="outline" disabled={busy || selection.length === 0}
                onClick={() => void run("copy", () => draftingOp("drafting.copy", { ids: selection, dx: Number(dx), dy: Number(dy) }))}>
                Copy
              </Button>
              <Button size="sm" variant="outline" disabled={busy || selection.length === 0}
                onClick={() => void run("delete", () => draftingOp("drafting.delete", { ids: selection }))}>
                Delete
              </Button>
              <Separator orientation="vertical" className="h-6" />
              <Button size="sm" variant="outline" disabled={!snapshot?.editorState.canUndo} onClick={() => void run("undo", () => undo())}>
                Undo
              </Button>
              <Button size="sm" variant="outline" disabled={!snapshot?.editorState.canRedo} onClick={() => void run("redo", () => redo())}>
                Redo
              </Button>
              <Separator orientation="vertical" className="h-6" />
              <Button size="sm" variant="outline" onClick={() => void run("new document", () => createDoc({ entityId: `drafting-${Date.now()}` }))}>
                New
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void onSave()}>Save ↓</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>Open ↑</Button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onOpenFile} />
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <div className="text-sm font-semibold mb-1">Coordinate entry (exact, snap-free)</div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">X</span>
                <input aria-label="exact x" className="w-20 border rounded px-2 py-1 text-sm" value={entryX} onChange={(e) => setEntryX(e.target.value)} />
                <span className="text-xs text-muted-foreground">Y</span>
                <input aria-label="exact y" className="w-20 border rounded px-2 py-1 text-sm" value={entryY} onChange={(e) => setEntryY(e.target.value)} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const p: Vec2 = [Number(entryX), Number(entryY)];
                    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
                    const [sx, sy] = toScreen(p);
                    void onCanvasClick(sx, sy, false);
                  }}
                >
                  Place
                </Button>
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold mb-1">Layers</div>
              <ScrollArea className="max-h-48 pr-2">
                <ul className="flex flex-col gap-1">
                  {layers.map((l) => (
                    <li key={l.id} className="flex items-center gap-2 text-sm">
                      <button
                        aria-label={`toggle visibility of layer ${l.name}`}
                        className="w-5 h-5 rounded border flex items-center justify-center text-xs"
                        onClick={() => void run("layer visibility", () => draftingUpdateLayer(l.id, { visible: !l.visible }))}
                      >
                        {l.visible ? "◉" : "◌"}
                      </button>
                      <span className="w-3 h-3 rounded-sm border" style={{ background: l.color }} />
                      <button
                        className={activeLayer === l.id ? "font-bold underline" : ""}
                        onClick={() => setActiveLayer(l.id)}
                      >
                        {l.name}
                      </button>
                      <span className="text-xs text-muted-foreground">{l.id}</span>
                      {l.id !== "0" && (
                        <button
                          className="ml-auto text-xs text-red-700"
                          disabled={busy}
                          onClick={() => void run("remove layer", () => draftingRemoveLayer(l.id))}
                        >
                          remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </ScrollArea>
              <div className="flex items-center gap-2 mt-1">
                <input
                  aria-label="new layer name"
                  className="border rounded px-2 py-1 text-sm flex-1"
                  placeholder="new layer name"
                  value={newLayerName}
                  onChange={(e) => setNewLayerName(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || newLayerName.length === 0}
                  onClick={() => {
                    const name = newLayerName;
                    void run("add layer", () => draftingAddLayer({ name }));
                    setNewLayerName("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold mb-1">Snapping</div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings?.snap.enabled ?? true}
                  onChange={(e) => void run("snap toggle", () => draftingSetSettings({ snap: { enabled: e.target.checked } }))}
                />
                enabled
              </label>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                {SNAP_KIND_PRIORITY.map((k) => (
                  <label key={k} className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={snapKindsActive(k)} onChange={() => onToggleSnapKind(k)} />
                    {k}
                  </label>
                ))}
              </div>
              <label className="block text-xs mt-1">
                tolerance (mm)
                <input
                  aria-label="snap tolerance"
                  className="ml-2 w-16 border rounded px-1 py-0.5 text-sm"
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={settings?.snap.tolerance ?? 0.5}
                  onChange={(e) => void run("snap tolerance", () => draftingSetSettings({ snap: { tolerance: Number(e.target.value) } }))}
                />
              </label>
            </div>

            <div>
              <div className="text-sm font-semibold mb-1">Grid</div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings?.grid.enabled ?? true}
                  onChange={(e) => void run("grid toggle", () => draftingSetSettings({ grid: { enabled: e.target.checked } }))}
                />
                visible
              </label>
              <label className="block text-xs mt-1">
                size (mm)
                <input
                  aria-label="grid size"
                  className="ml-2 w-16 border rounded px-1 py-0.5 text-sm"
                  type="number"
                  step="1"
                  min="0.1"
                  value={settings?.grid.size ?? 1}
                  onChange={(e) => void run("grid size", () => draftingSetSettings({ grid: { size: Number(e.target.value) } }))}
                />
              </label>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- deterministic canvas drawing ------------------------------------------------

function drawEntity(
  ctx: CanvasRenderingContext2D,
  entity: DraftEntity,
  opts: { color: string; selected: boolean; toScreen: (p: Vec2) => [number, number]; zoom: number },
): void {
  const { color, selected, toScreen, zoom } = opts;
  const annotation = entity.type === "dim-linear" || entity.type === "dim-radius";
  ctx.strokeStyle = selected ? "#0284c7" : annotation ? "#6b7280" : color;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.setLineDash([]);
  const line = (a: Vec2, b: Vec2) => {
    const [x1, y1] = toScreen(a);
    const [x2, y2] = toScreen(b);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  switch (entity.type) {
    case "line":
      line(entity.from, entity.to);
      break;
    case "polyline": {
      ctx.beginPath();
      const [x0, y0] = toScreen(entity.points[0] as Vec2);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < entity.points.length; i++) {
        const [x, y] = toScreen(entity.points[i] as Vec2);
        ctx.lineTo(x, y);
      }
      if (entity.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    case "circle": {
      const [cx, cy] = toScreen(entity.center);
      ctx.beginPath();
      ctx.arc(cx, cy, entity.radius * zoom, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arc": {
      const [cx, cy] = toScreen(entity.center);
      const rScreen = entity.radius * zoom;
      let sweep = entity.endAngle - entity.startAngle;
      if (sweep <= 0) sweep += Math.PI * 2;
      // world CCW → canvas y-flipped: draw clockwise from -start
      ctx.beginPath();
      ctx.arc(cx, cy, rScreen, -entity.startAngle, -(entity.startAngle + sweep), true);
      ctx.stroke();
      break;
    }
    case "rectangle": {
      const [x1, y1] = toScreen(entity.corner1);
      const [x2, y2] = toScreen(entity.corner2);
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      break;
    }
    case "dim-linear": {
      const dxl = entity.p2[0] - entity.p1[0];
      const dyl = entity.p2[1] - entity.p1[1];
      const len = Math.hypot(dxl, dyl) || 1;
      const nx = -dyl / len;
      const ny = dxl / len;
      const a: Vec2 = [entity.p1[0] + nx * entity.offset, entity.p1[1] + ny * entity.offset];
      const b: Vec2 = [entity.p2[0] + nx * entity.offset, entity.p2[1] + ny * entity.offset];
      ctx.lineWidth = 1;
      line(entity.p1, a);
      line(entity.p2, b);
      line(a, b);
      const [tx, ty] = toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      ctx.fillStyle = "#374151";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText(`${entity.measured.toFixed(2)}`, tx + 4, ty - 4);
      break;
    }
    case "dim-radius": {
      // radius dims render next to their target (no own geometry); draw at origin marker
      ctx.lineWidth = 1;
      ctx.fillStyle = "#374151";
      ctx.font = "12px ui-monospace, monospace";
      const [x, y] = toScreen([0, 0]);
      ctx.fillText(`R${entity.measured.toFixed(2)} → ${entity.target}`, 8 + x - x, 16);
      break;
    }
  }
  void isDraftingElement;
}
