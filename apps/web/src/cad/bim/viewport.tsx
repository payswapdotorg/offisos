"use client";

/**
 * BIM 3D viewport (COMPAT-CAD-002 / Issue #39) — Web host.
 *
 * Bounded deterministic visualization: an SVG orthographic wireframe of every
 * solid-bearing BIM element's WORLD EXTENT box, projected from the standard
 * camera returned by the shared `bim.camera` query (the same pure camera
 * module the server runs — §5.5 parity). After `bim.buildGeometry`, boxes
 * come from the ACTUAL engine meshBBox props; before that, from the
 * engine-free derived extents (the same pure core the server derives).
 *
 * Declared bounds of this visualization: axis-aligned extent boxes only (no
 * engine meshes, no boolean results, no textures), painter-sorted faces with
 * a deterministic type layering (slab → wall → opening → door/window →
 * space), light per-type face fills + wireframe edges, selected ids
 * highlighted. No WebGL, no three.js, no npm additions (LOCK-003/018: the
 * engine stays behind the adapter boundary server-side).
 */

import * as React from "react";
import {
  BOX_EDGES,
  BOX_FACES,
  boxCorners,
  fitTransform,
  projectionBasis,
  projectRelative,
  toScreen,
  type Vec3,
  type WorldBox,
} from "@/cad/bim/projection";

export type BimBoxType =
  | "bim.wall"
  | "bim.slab"
  | "bim.space"
  | "bim.opening"
  | "bim.door"
  | "bim.window"
  // COMPAT-BIM-003: component instances render as their derived parametric
  // boxes (definitions/materials/grids/reference planes have no solid and
  // never reach the viewport).
  | "bim.componentInstance";

export interface BimBox {
  readonly id: string;
  readonly type: BimBoxType;
  readonly bbox: WorldBox;
  /** True when the engine-realized meshBBox prop is present (post-build). */
  readonly built: boolean;
}

export interface BimCameraState {
  readonly preset: string;
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
}

interface BimViewportProps {
  readonly boxes: readonly BimBox[];
  readonly camera: BimCameraState | null;
  readonly modelBBox: WorldBox | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly onSelect: (id: string, additive: boolean) => void;
  readonly onClearSelection: () => void;
}

const VIEW_W = 800;
const VIEW_H = 520;

/** Deterministic per-type presentation (stone/teal/amber palette — no
 *  engine vocabulary; openings render as dashed void outlines). */
const TYPE_STYLE: Record<BimBoxType, { fill: string; stroke: string; layer: number }> = {
  "bim.slab": { fill: "rgba(168,162,158,0.20)", stroke: "#78716c", layer: 0 },
  "bim.wall": { fill: "rgba(120,113,108,0.16)", stroke: "#57534e", layer: 1 },
  "bim.opening": { fill: "none", stroke: "#a8a29e", layer: 2 },
  "bim.door": { fill: "rgba(217,119,6,0.30)", stroke: "#b45309", layer: 3 },
  "bim.window": { fill: "rgba(45,212,191,0.32)", stroke: "#0f766e", layer: 3 },
  "bim.space": { fill: "rgba(13,148,136,0.10)", stroke: "#0d9488", layer: 4 },
  "bim.componentInstance": { fill: "rgba(139,92,246,0.22)", stroke: "#7c3aed", layer: 3 },
};

const GRID_COLOR = "#e5e7eb";

export function BimViewport({ boxes, camera, modelBBox, selectedIds, onSelect, onClearSelection }: BimViewportProps): React.JSX.Element {
  // Camera → screen basis + fit (recomputed deterministically each render).
  const basis = camera === null
    ? null
    : projectionBasis(camera.eye, camera.target, camera.up);
  const fit = basis !== null && modelBBox !== null
    ? fitTransform(basis, modelBBox, VIEW_W, VIEW_H, 48)
    : null;

  const screenPoint = React.useCallback(
    (p: Vec3): { x: number; y: number; depth: number } | null => {
      if (basis === null || fit === null) return null;
      const rel = projectRelative(basis, p);
      const s = toScreen(rel, fit);
      return { x: s.x, y: s.y, depth: rel.depth };
    },
    [basis, fit],
  );

  // Ground grid on the z=0 plane, spanning the model bbox footprint (bounded
  // to ≤ 21 lines per axis by growing the step).
  const gridLines = React.useMemo(() => {
    if (basis === null || fit === null || modelBBox === null) return [];
    const [minX, minY, , maxX, maxY] = modelBBox;
    let step = 1000;
    while ((maxX - minX) / step > 20 || (maxY - minY) / step > 20) step *= 2;
    const x0 = Math.floor(minX / step) * step;
    const y0 = Math.floor(minY / step) * step;
    const lines: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
    for (let x = x0; x <= maxX + step; x += step) {
      const a = toScreen(projectRelative(basis, [x, y0, 0]), fit);
      const b = toScreen(projectRelative(basis, [x, maxY + step, 0]), fit);
      lines.push({ a, b });
    }
    for (let y = y0; y <= maxY + step; y += step) {
      const a = toScreen(projectRelative(basis, [x0, y, 0]), fit);
      const b = toScreen(projectRelative(basis, [maxX + step, y, 0]), fit);
      lines.push({ a, b });
    }
    return lines;
  }, [basis, fit, modelBBox]);

  // World-axes triad (1000 mm unit vectors from the world origin).
  const axes = React.useMemo(() => {
    if (basis === null || fit === null) return null;
    const o = toScreen(projectRelative(basis, [0, 0, 0]), fit);
    const vec = (v: Vec3) => toScreen(projectRelative(basis, v), fit);
    return {
      o,
      x: vec([1000, 0, 0]),
      y: vec([0, 1000, 0]),
      z: vec([0, 0, 1000]),
    };
  }, [basis, fit]);

  // Deterministic draw order: type layer first, then far→near (depth desc).
  const ordered = React.useMemo(() => {
    if (basis === null) return [];
    const annotated = boxes.map((box) => {
      const c = boxCorners(box.bbox).map((p) => screenPoint(p));
      if (c.some((p) => p === null)) return null;
      const pts = c as { x: number; y: number; depth: number }[];
      const centerDepth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;
      return { box, pts, centerDepth };
    });
    return annotated
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => {
        const la = TYPE_STYLE[a.box.type].layer;
        const lb = TYPE_STYLE[b.box.type].layer;
        if (la !== lb) return la - lb;
        return b.centerDepth - a.centerDepth;
      });
  }, [boxes, basis, screenPoint]);

  return (
    <div className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full h-auto rounded border bg-white dark:bg-neutral-900"
        role="img"
        aria-label={
          camera === null
            ? "BIM viewport — no camera yet (author a solid-bearing element)"
            : `BIM viewport — ${camera.preset} orthographic wireframe of element extents`
        }
        onClick={() => onClearSelection()}
      >
        {/* ground grid (z = 0) */}
        {gridLines.map((l, i) => (
          <line key={`g-${i}`} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} stroke={GRID_COLOR} strokeWidth={0.8} className="dark:opacity-30" />
        ))}
        {/* world axes triad */}
        {axes !== null && (
          <g strokeWidth={1.4} fontSize={10} className="font-mono">
            <line x1={axes.o.x} y1={axes.o.y} x2={axes.x.x} y2={axes.x.y} stroke="#b91c1c" />
            <line x1={axes.o.x} y1={axes.o.y} x2={axes.y.x} y2={axes.y.y} stroke="#166534" />
            <line x1={axes.o.x} y1={axes.o.y} x2={axes.z.x} y2={axes.z.y} stroke="#1f2937" className="dark:stroke-neutral-300" />
            <text x={axes.x.x + 3} y={axes.x.y} fill="#b91c1c">X</text>
            <text x={axes.y.x + 3} y={axes.y.y} fill="#166534">Y</text>
            <text x={axes.z.x + 3} y={axes.z.y} fill="currentColor" className="text-neutral-700 dark:text-neutral-300">Z</text>
          </g>
        )}

        {ordered.length === 0 && camera !== null && (
          <text x={VIEW_W / 2} y={VIEW_H / 2} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 15 }}>
            no solid-bearing BIM elements yet — author a story + wall/slab/space (stories are level containers)
          </text>
        )}
        {camera === null && (
          <text x={VIEW_W / 2} y={VIEW_H / 2} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 15 }}>
            camera unavailable until a solid-bearing element exists (bim.camera derives from the model bbox)
          </text>
        )}

        {ordered.map(({ box, pts }) => {
          const style = TYPE_STYLE[box.type];
          const selected = selectedIds.has(box.id);
          // Faces: painter-sorted far → near within the box, light per-type fill.
          const faces = BOX_FACES.map((f) => {
            const idx = f as readonly [number, number, number, number];
            const depth = (pts[idx[0]].depth + pts[idx[1]].depth + pts[idx[2]].depth + pts[idx[3]].depth) / 4;
            const points = idx
              .map((i) => `${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`)
              .join(" ");
            return { depth, points };
          }).sort((a, b) => b.depth - a.depth);
          // Label anchor: topmost (smallest screen y) corner.
          const labelPt = pts.reduce((best, p) => (p.y < best.y ? p : best), pts[0]!);
          return (
            <g
              key={box.id}
              role="button"
              aria-label={`Select ${box.type} ${box.id}`}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(box.id, e.shiftKey);
              }}
            >
              {faces.map((f, i) => (
                <polygon
                  key={i}
                  points={f.points}
                  fill={style.fill === "none" ? "none" : selected ? "rgba(217,119,6,0.14)" : style.fill}
                  stroke="none"
                  pointerEvents={style.fill === "none" ? "none" : "visiblePainted"}
                />
              ))}
              {BOX_EDGES.map((e, i) => {
                const a = pts[e[0]]!;
                const b = pts[e[1]]!;
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={selected ? "#d97706" : style.stroke}
                    strokeWidth={selected ? 2.4 : box.type === "bim.opening" ? 1 : 1.3}
                    strokeDasharray={box.type === "bim.opening" ? "6,3" : undefined}
                    opacity={box.type === "bim.opening" ? 0.9 : 1}
                  />
                );
              })}
              <title>{`${box.type} ${box.id}${box.built ? " — engine meshBBox" : " — derived extents"}`}</title>
              {selected && (
                <text
                  x={labelPt.x}
                  y={labelPt.y - 6}
                  textAnchor="middle"
                  style={{ fontSize: 11 }}
                  className="fill-foreground font-mono"
                >
                  {box.id}
                </text>
              )}
            </g>
          );
        })}

        {camera !== null && (
          <text x={12} y={VIEW_H - 12} style={{ fontSize: 11 }} className="fill-muted-foreground font-mono">
            {`camera: ${camera.preset} · orthographic · mm`}
          </text>
        )}
      </svg>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Bounded deterministic visualization — orthographic wireframe of element world extents
        (derived pure-core geometry; engine meshBBox after Build geometry). No engine meshes are
        loaded in the browser; edges/faces are painter-sorted, not hidden-line-removed.
      </p>
    </div>
  );
}
