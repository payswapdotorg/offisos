"use client";

/**
 * CAD-PARITY-009 3D Model viewport (Issue #90) — Web host.
 *
 * The bounded deterministic 3D view surface: the canonical 3D scene rendered
 * through the SHARED buildScene3DSVG writer (the byte-identical SVG both
 * hosts produce from the same inputs), driven ONLY by the shared model3d
 * core — no host-local navigation math anywhere (LOCK-004):
 *
 *  - gestures: left-drag = orbitCamera(dx·0.5°, dy·0.5°), shift/middle-drag
 *    = panCamera, wheel = zoomCamera(1.1); each gesture end persists through
 *    view3d.set (debounced for the wheel) — the camera state is document
 *    editor state, identical on both hosts.
 *  - the seven standard views + Fit through view3d.standard/view3d.fit (the
 *    VPOINT/ZOOM3D semantics).
 *  - the UCS dropdown (World + the named table) through ucs.activate.
 *  - quick BOX/CYLINDER buttons (sane deterministic defaults) through
 *    model3d.box/model3d.cylinder placed through the ACTIVE UCS.
 *
 * Declared bounds: extent-level wireframes (the persisted meshBBox) with the
 * UCS triad + workplane grid (ucsGridSegments, bounded); NO view-cube widget
 * (the shared classifyViewCubeZone stays core-tested); no engine loads in
 * the browser (LOCK-003/018 — the barrel is pure + browser-safe).
 */

import * as React from "react";
import { Box, Cylinder, Crosshair, Expand } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CADDocumentSnapshot, Camera3DState, UcsRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Command } from "@offisos/cad-app-shell/contracts/app-api";
import { send } from "@/cad/client/http-transport";
import {
  WORLD_UCS,
  buildScene3DSVG,
  defaultCamera,
  formatCamera,
  orbitCamera,
  panCamera,
  ucsGridSegments,
  zoomCamera,
  type BBox3D,
  type Scene3DElement,
  type StandardViewName,
  type UcsGridSegment,
} from "@offisos/cad-app-shell/workspace/model3d/index.js";

const VIEW_W = 800;
const VIEW_H = 600;
const VIEW_ASPECT = VIEW_W / VIEW_H;

const STANDARD_VIEWS: readonly { id: StandardViewName; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "iso", label: "Iso" },
];

/** The bounded workplane grid: the adaptive step keeps ≤ ~20 cells per axis
 *  (the BIM viewport's doubling rule); majorEvery 5; hard cap 400 segments
 *  (ucsGridSegments declines truncation upstream — never silent). */
const GRID_MAX_SEGMENTS = 400;
const GRID_MAJOR_EVERY = 5;
const GRID_MAX_CELLS = 20;

const UNIT_BOX: BBox3D = { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };

interface Model3DViewportProps {
  readonly snapshot: CADDocumentSnapshot | null;
  readonly selection: readonly string[];
  readonly onRefresh: () => void | Promise<void>;
}

/** Parse one element's persisted extent (props.meshBBox) — null when absent. */
function bboxOf(element: { readonly props: unknown }): BBox3D | null {
  const b = (element.props as { meshBBox?: unknown } | null)?.meshBBox;
  if (!Array.isArray(b) || b.length !== 6 || !b.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { minX: b[0] as number, minY: b[1] as number, minZ: b[2] as number, maxX: b[3] as number, maxY: b[4] as number, maxZ: b[5] as number };
}

/** The scene surface of the snapshot elements (id + extent + engine token). */
function sceneElements(snapshot: CADDocumentSnapshot): readonly Scene3DElement[] {
  return snapshot.elements.map((el) => {
    const props = el.props as { meshToken?: unknown };
    const out: { id: string; bbox: BBox3D | null; meshToken?: string } = { id: el.id, bbox: bboxOf(el) };
    if (typeof props.meshToken === "string") out.meshToken = props.meshToken;
    return out;
  });
}

/** The ACTIVE UCS record (the implicit World when unset/unknown). */
function activeUcsOf(snapshot: CADDocumentSnapshot | null): UcsRecord {
  if (snapshot === null) return WORLD_UCS;
  const id = snapshot.draftingSettings?.activeUcs;
  if (id !== undefined && id !== "world") {
    const found = (snapshot.ucs ?? []).find((u) => u.id === id);
    if (found !== undefined) return found;
  }
  return WORLD_UCS;
}

function unionBox(boxes: readonly BBox3D[]): BBox3D {
  let out = boxes[0]!;
  for (const b of boxes.slice(1)) {
    out = {
      minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), minZ: Math.min(out.minZ, b.minZ),
      maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY), maxZ: Math.max(out.maxZ, b.maxZ),
    };
  }
  return out;
}

export function Model3DViewport(props: Model3DViewportProps): React.JSX.Element {
  const { snapshot, selection, onRefresh } = props;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const persistTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = React.useRef<{ kind: "orbit" | "pan"; x: number; y: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const persistedCamera: Camera3DState | null = snapshot?.draftingSettings?.view3d ?? null;
  // The gesture-time override (orbit/pan/zoom in flight). The effective
  // camera DERIVES during render: gesture override > persisted > default —
  // no state-sync effect (the document is the authority; the override clears
  // when its persist resolves — an event context, never render).
  const [gestureCamera, setGestureCamera] = React.useState<Camera3DState | null>(null);
  const camera = gestureCamera ?? persistedCamera ?? defaultCamera();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dragKind, setDragKind] = React.useState<"orbit" | "pan" | null>(null);

  const ucs = activeUcsOf(snapshot);
  const elements = React.useMemo(() => (snapshot === null ? [] : sceneElements(snapshot)), [snapshot]);
  const solids = React.useMemo(
    () => (snapshot?.elements ?? []).filter((el) => (el.props as { type?: unknown } | null)?.type === "model3d.solid"),
    [snapshot],
  );

  const run = React.useCallback(async (name: Command["name"], payload: unknown): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await send({ type: "command", name, payload });
      if (!res.ok) {
        setError(`[${name}] ${res.code}: ${res.message}`);
        return false;
      }
      await onRefresh();
      return true;
    } finally {
      setBusy(false);
    }
  }, [onRefresh]);

  /** Persist a camera through view3d.set (the ONLY view mutation path). The
   *  gesture override clears once the persist + refresh resolve — the
   *  persisted state takes over (identical values → a seamless handoff). */
  const persistCamera = React.useCallback(
    (next: Camera3DState): void => {
      if (persistTimer.current !== null) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      void run("view3d.set", {
        eye: [...next.eye],
        target: [...next.target],
        up: [...next.up],
        mode: next.mode,
        orthoHalfHeight: next.orthoHalfHeight,
        fovDeg: next.fovDeg,
      }).then((applied) => {
        if (applied) setGestureCamera(null);
      });
    },
    [run],
  );

  // --- gestures (the SHARED camera module only — LOCK-004) -------------------

  const worldPerPixel = React.useCallback((cam: Camera3DState): number => {
    if (cam.mode === "orthographic") return (cam.orthoHalfHeight * 2) / VIEW_H;
    const dx = cam.eye[0] - cam.target[0];
    const dy = cam.eye[1] - cam.target[1];
    const dz = cam.eye[2] - cam.target[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return (2 * Math.tan((cam.fovDeg * Math.PI) / 360) * dist) / VIEW_H;
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (snapshot === null) return;
    const pan = e.button === 1 || (e.button === 0 && e.shiftKey);
    const orbit = e.button === 0 && !e.shiftKey;
    if (!pan && !orbit) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind: pan ? "pan" : "orbit", x: e.clientX, y: e.clientY };
    setDragKind(pan ? "pan" : "orbit");
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    dragRef.current = { ...drag, x: e.clientX, y: e.clientY };
    if (drag.kind === "orbit") {
      const next = orbitCamera(camera, dx * 0.5, dy * 0.5);
      if (next !== null) setGestureCamera(next);
    } else {
      const next = panCamera(camera, -dx, dy, worldPerPixel(camera));
      if (next !== null) setGestureCamera(next);
    }
  };

  const onPointerUp = (): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    setDragKind(null);
    setDragging(false);
    persistCamera(camera);
  };

  // Wheel: zoom in 1.1× / out 1/1.1×, debounced persist (a non-passive native
  // listener so the page never scrolls with the gesture).
  React.useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (snapshot === null) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = zoomCamera(camera, factor);
      if (next === null) return;
      setGestureCamera(next);
      if (persistTimer.current !== null) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        persistTimer.current = null;
        void run("view3d.set", {
          eye: [...next.eye], target: [...next.target], up: [...next.up],
          mode: next.mode, orthoHalfHeight: next.orthoHalfHeight, fovDeg: next.fovDeg,
        }).then((applied) => {
          if (applied) setGestureCamera(null);
        });
      }, 180);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [snapshot, camera, run]);

  // --- the canonical scene (the SHARED writer: identical inputs → the
  //     byte-identical SVG on both hosts) --------------------------------------

  const gridSegments = React.useMemo<readonly UcsGridSegment[]>(() => {
    const boxes = elements.map((el) => el.bbox).filter((b): b is BBox3D => b !== null);
    const box = boxes.length > 0 ? unionBox(boxes) : UNIT_BOX;
    const maxDim = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
    let step = 1;
    while (maxDim / step > GRID_MAX_CELLS) step *= 2;
    const { segments } = ucsGridSegments(ucs, box, step, GRID_MAJOR_EVERY, GRID_MAX_SEGMENTS);
    return segments;
  }, [elements, ucs]);

  const svg = React.useMemo(
    () =>
      buildScene3DSVG({
        viewport: { width: VIEW_W, height: VIEW_H },
        camera,
        elements,
        ucs,
        grid: gridSegments,
        selectedIds: [...selection],
      }),
    [camera, elements, ucs, gridSegments, selection],
  );

  const ucsOptions = React.useMemo(() => ["World", ...(snapshot?.ucs ?? []).map((u) => u.name)], [snapshot]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 p-2" aria-label="3D Model view">
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="3D view tools">
        {STANDARD_VIEWS.map((view) => (
          <Button
            key={view.id}
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={busy || snapshot === null}
            title={`view3d.standard — the ${view.label} standard view of the model extents (VPOINT ${view.label})`}
            onClick={() => void run("view3d.standard", { view: view.id, aspect: VIEW_ASPECT })}
          >
            {view.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={busy || snapshot === null}
          title="view3d.fit — all eight corners of the extents inside the view (ZOOM3D Fit)"
          onClick={() => void run("view3d.fit", { aspect: VIEW_ASPECT })}
        >
          <Expand className="h-3.5 w-3.5" aria-hidden /> Fit
        </Button>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" htmlFor="model3d-ucs-select">
          <Crosshair className="h-3.5 w-3.5" aria-hidden /> UCS
        </label>
        <select
          id="model3d-ucs-select"
          className="h-7 rounded border bg-background px-1.5 text-[11px]"
          value={ucs.name}
          disabled={busy || snapshot === null}
          title="ucs.activate — the active workplane (triad + grid + typed 'x,y,z' resolution)"
          onChange={(e) => {
            const name = e.target.value;
            if (name === "World") void run("ucs.activate", { id: "world" });
            else void run("ucs.activate", { name });
          }}
        >
          {ucsOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={busy || snapshot === null}
          title="model3d.box — quick 2×3×4 box through the ACTIVE UCS (at 0,0,0)"
          onClick={() => void run("model3d.box", { width: 2, depth: 3, height: 4, at: [0, 0, 0], ucsId: ucs.id })}
        >
          <Box className="h-3.5 w-3.5" aria-hidden /> Box
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={busy || snapshot === null}
          title="model3d.cylinder — quick r2 h5 cylinder through the ACTIVE UCS (at 0,0,0)"
          onClick={() => void run("model3d.cylinder", { radius: 2, height: 5, at: [0, 0, 0], ucsId: ucs.id })}
        >
          <Cylinder className="h-3.5 w-3.5" aria-hidden /> Cylinder
        </Button>
      </div>

      {error !== null && (
        <p role="alert" className="border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden rounded border bg-white dark:bg-neutral-900"
        data-testid="model3d-viewport"
        role="application"
        aria-label="3D Model viewport — orbit with drag, pan with shift-drag or middle-drag, zoom with the wheel"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ cursor: dragging ? (dragKind === "pan" ? "move" : "grabbing") : "crosshair" }}
      >
        {snapshot === null ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            No document yet — create or open one to view the 3D model (UCS, solids, section previews).
          </div>
        ) : (
          <div
            data-testid="model3d-scene"
            data-format="offisos-scene3d-svg"
            className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
            // The canonical deterministic scene SVG from the SHARED writer —
            // trusted module output (pure string building, no user input).
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground" data-testid="model3d-info">
        {snapshot === null
          ? "3D state: no document."
          : `3D state: ${formatCamera(camera)} · UCS ${ucs.name} (${ucs.id}) · ${solids.length} solid${solids.length === 1 ? "" : "s"} — drag orbit · shift/middle pan · wheel zoom (the shared camera module; gestures persist through view3d.set).`}
      </p>
    </section>
  );
}
