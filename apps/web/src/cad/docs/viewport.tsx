"use client";

/**
 * Documentation drawing viewport (COMPAT-CAD-003 / Issue #41) — Web host.
 *
 * Deterministic SVG presentation of ONE view's projected primitives
 * (`docs.getViewGeometry`): fixed viewBox derived from the projection bbox
 * with a relative margin, Y flipped so +v is up (drafting convention), stroke
 * rendering for line/polyline/circle/arc/text. Every primitive carries
 * `data-viewprimitive` + `data-sourceid` (canonical element identity) for
 * hit-testing. The view's annotations (dims/tags/notes resolved with their
 * derived values by docs.regenerate) are drawn as an overlay — dimension
 * lines with `${mm} mm` measured text, tag labels at their target's
 * projection, notes at their anchor.
 *
 * Pure presentation of server-derived state — no projection math is
 * re-implemented here beyond the bbox grouping the core itself uses for dim
 * measurement (mirrored read-only). Stone/teal/amber palette (no indigo).
 */

import * as React from "react";
import type {
  DocsAnnotation,
  DocsViewGeometryResult,
  DocsViewPrimitive,
} from "@/cad/client/http-transport";

/** Per-source view-space extent of a primitive list (the same grouping the
 *  core's dim measurement uses — mirrored read-only for overlay placement). */
function extentsBySource(
  primitives: readonly DocsViewPrimitive[],
): Map<string, { uMin: number; uMax: number; vMin: number; vMax: number }> {
  const out = new Map<string, { uMin: number; uMax: number; vMin: number; vMax: number }>();
  const include = (id: string, uMin: number, uMax: number, vMin: number, vMax: number): void => {
    const cur = out.get(id);
    out.set(id, cur === undefined ? { uMin, uMax, vMin, vMax } : {
      uMin: Math.min(cur.uMin, uMin),
      uMax: Math.max(cur.uMax, uMax),
      vMin: Math.min(cur.vMin, vMin),
      vMax: Math.max(cur.vMax, vMax),
    });
  };
  for (const p of primitives) {
    if (p.type === "line") {
      include(p.sourceId, Math.min(p.from[0], p.to[0]), Math.max(p.from[0], p.to[0]), Math.min(p.from[1], p.to[1]), Math.max(p.from[1], p.to[1]));
    } else if (p.type === "polyline") {
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const pt of p.points) {
        uMin = Math.min(uMin, pt[0]); uMax = Math.max(uMax, pt[0]);
        vMin = Math.min(vMin, pt[1]); vMax = Math.max(vMax, pt[1]);
      }
      include(p.sourceId, uMin, uMax, vMin, vMax);
    } else if (p.type === "circle" || p.type === "arc") {
      include(p.sourceId, p.center[0] - p.radius, p.center[0] + p.radius, p.center[1] - p.radius, p.center[1] + p.radius);
    } else {
      include(p.sourceId, p.at[0], p.at[0], p.at[1], p.at[1]);
    }
  }
  return out;
}

/** SVG path for an arc in view space (y-up), mapped to screen (y = −v).
 *  A CCW sweep in view space (Δangle > 0) appears CCW on screen after the
 *  reflection → SVG sweep-flag 0; |Δ| > π sets the large-arc flag. */
function arcPath(
  center: readonly [number, number],
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const x0 = center[0] + radius * Math.cos(startAngle);
  const y0 = -(center[1] + radius * Math.sin(startAngle));
  const x1 = center[0] + radius * Math.cos(endAngle);
  const y1 = -(center[1] + radius * Math.sin(endAngle));
  const delta = endAngle - startAngle;
  const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
  const sweep = delta > 0 ? 0 : 1;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${largeArc} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const STROKE = "#57534e"; // stone-600 — drawing linework
const GRID = "#e5e7eb";
const DIM_COLOR = "#b45309"; // amber-700 — dimensions
const TAG_COLOR = "#0f766e"; // teal-700 — tags
const NOTE_COLOR = "#78716c"; // stone-500 — notes
const TEXT_FILL = "#44403c"; // stone-700 — primitive text

interface DocsViewportProps {
  readonly geometry: DocsViewGeometryResult | null;
}

export function DocsViewport({ geometry }: DocsViewportProps): React.JSX.Element {
  if (geometry === null || geometry.primitives.length === 0) {
    return (
      <div
        data-testid="docs-viewport-empty"
        className="flex aspect-[4/3] w-full items-center justify-center rounded border bg-white text-sm text-muted-foreground dark:bg-neutral-900"
        role="img"
        aria-label="Documentation viewport — no projected primitives"
      >
        {geometry === null
          ? "select a view to project (docs.getViewGeometry)"
          : "view projects no primitives — check the model scope / skips"}
      </div>
    );
  }

  // --- deterministic frame: bbox + relative margin, Y flipped (+v up) -------
  const primitives = geometry.primitives;
  const bbox =
    geometry.bbox ??
    (() => {
      const ext = extentsBySource(primitives);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const b of ext.values()) {
        uMin = Math.min(uMin, b.uMin); uMax = Math.max(uMax, b.uMax);
        vMin = Math.min(vMin, b.vMin); vMax = Math.max(vMax, b.vMax);
      }
      return { uMin, uMax, vMin, vMax };
    })();
  const width = Math.max(bbox.uMax - bbox.uMin, 1);
  const height = Math.max(bbox.vMax - bbox.vMin, 1);
  const extent = Math.max(width, height, 1);
  const margin = extent * 0.1;
  const vbX = bbox.uMin - margin;
  const vbY = -bbox.vMax - margin;
  const vbW = width + 2 * margin;
  const vbH = height + 2 * margin;

  // Relative presentation metrics (deterministic in the bbox extent, mm).
  const strokeWidth = Math.max(extent / 1000, 0.4);
  const textFont = extent / 38;
  const annFont = extent / 34;
  const tick = extent / 45;

  // Bounded grid (≤ ~21 lines per axis, step doubling from 500 mm).
  const gridLines: React.ReactElement[] = [];
  let step = 500;
  while (vbW / step > 21 || vbH / step > 21) step *= 2;
  const uStart = Math.ceil((bbox.uMin - margin) / step) * step;
  for (let u = uStart; u <= bbox.uMax + margin; u += step) {
    gridLines.push(
      <line key={`gu-${u}`} x1={u} y1={-(bbox.vMax + margin)} x2={u} y2={-(bbox.vMin - margin)} stroke={GRID} strokeWidth={strokeWidth / 3} />,
    );
  }
  const vStart = Math.ceil((bbox.vMin - margin) / step) * step;
  for (let v = vStart; v <= bbox.vMax + margin; v += step) {
    gridLines.push(
      <line key={`gv-${v}`} x1={bbox.uMin - margin} y1={-v} x2={bbox.uMax + margin} y2={-v} stroke={GRID} strokeWidth={strokeWidth / 3} />,
    );
  }

  // --- annotation overlay placement (read-only mirror of the core grouping) -
  const bySource = extentsBySource(primitives);
  const overlays: React.ReactElement[] = [];
  for (const ann of geometry.annotations) {
    if (ann.type === "docs.dim") {
      const refs = ann.refIds ?? [];
      const a = bySource.get(refs[0] ?? "");
      const b = bySource.get(refs[1] ?? "");
      if (a === undefined || b === undefined) continue; // dangling → shown in the annotation list
      const offset = ann.offset ?? 0;
      const measured = typeof ann.measured === "number" ? `${ann.measured} mm` : "— mm";
      if (ann.axis === "x") {
        const u1 = Math.min(a.uMin, b.uMin);
        const u2 = Math.max(a.uMax, b.uMax);
        overlays.push(
          <g key={ann.id} data-annotation={ann.id} stroke={DIM_COLOR} strokeWidth={strokeWidth} fill="none">
            <line x1={u1} y1={-offset} x2={u2} y2={-offset} />
            <line x1={u1} y1={-(offset - tick / 2)} x2={u1} y2={-(offset + tick / 2)} />
            <line x1={u2} y1={-(offset - tick / 2)} x2={u2} y2={-(offset + tick / 2)} />
            <text
              x={(u1 + u2) / 2}
              y={-(offset + tick * 0.8)}
              textAnchor="middle"
              stroke="none"
              fill={DIM_COLOR}
              fontSize={annFont}
              fontFamily="ui-monospace, monospace"
            >
              {measured}
            </text>
          </g>,
        );
      } else {
        const v1 = Math.min(a.vMin, b.vMin);
        const v2 = Math.max(a.vMax, b.vMax);
        const left = offset < (bbox.uMin + bbox.uMax) / 2;
        const tx = offset + (left ? -tick * 0.8 : tick * 0.8);
        overlays.push(
          <g key={ann.id} data-annotation={ann.id} stroke={DIM_COLOR} strokeWidth={strokeWidth} fill="none">
            <line x1={offset} y1={-v1} x2={offset} y2={-v2} />
            <line x1={offset - tick / 2} y1={-v1} x2={offset + tick / 2} y2={-v1} />
            <line x1={offset - tick / 2} y1={-v2} x2={offset + tick / 2} y2={-v2} />
            <text
              x={tx}
              y={-(v1 + v2) / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              stroke="none"
              fill={DIM_COLOR}
              fontSize={annFont}
              fontFamily="ui-monospace, monospace"
              transform={`rotate(-90 ${tx} ${-(v1 + v2) / 2})`}
            >
              {measured}
            </text>
          </g>,
        );
      }
    } else if (ann.type === "docs.tag") {
      const target = bySource.get(ann.targetId ?? "");
      if (target === undefined) continue; // dangling → shown in the annotation list
      const lx = target.uMin;
      const ly = target.vMax + tick;
      overlays.push(
        <g key={ann.id} data-annotation={ann.id}>
          <line x1={lx} y1={-target.vMax} x2={lx} y2={-ly} stroke={TAG_COLOR} strokeWidth={strokeWidth / 1.5} />
          <circle cx={lx} cy={-ly} r={strokeWidth * 1.6} fill={TAG_COLOR} />
          <text
            x={lx + tick * 0.4}
            y={-ly - tick * 0.2}
            fill={TAG_COLOR}
            fontSize={annFont}
            fontFamily="ui-monospace, monospace"
          >
            {ann.label ?? ann.targetId ?? ""}
          </text>
        </g>,
      );
    } else {
      // docs.note — anchored free text (always drawable).
      const nx = ann.x ?? 0;
      const ny = ann.y ?? 0;
      overlays.push(
        <g key={ann.id} data-annotation={ann.id}>
          <circle cx={nx} cy={-ny} r={strokeWidth * 2} fill={NOTE_COLOR} />
          <text
            x={nx + tick * 0.5}
            y={-ny - tick * 0.4}
            fill={NOTE_COLOR}
            fontSize={annFont}
            fontStyle="italic"
            fontFamily="ui-monospace, monospace"
          >
            {ann.text ?? ""}
          </text>
        </g>,
      );
    }
  }

  const view = geometry.view;
  const scaleDen = view.scale ?? 50;

  return (
    <svg
      data-testid="docs-viewport"
      viewBox={`${vbX.toFixed(2)} ${vbY.toFixed(2)} ${vbW.toFixed(2)} ${vbH.toFixed(2)}`}
      className="w-full h-auto rounded border bg-white dark:bg-neutral-900"
      role="img"
      aria-label={`Documentation viewport — ${view.title} (${view.kind}) projection`}
    >
      {gridLines}
      {primitives.map((p, i) => (
        <g key={i} data-viewprimitive={i} data-sourceid={p.sourceId}>
          {p.type === "line" && (
            <line x1={p.from[0]} y1={-p.from[1]} x2={p.to[0]} y2={-p.to[1]} stroke={STROKE} strokeWidth={strokeWidth} />
          )}
          {p.type === "polyline" && (
            p.closed ? (
              <polygon
                points={p.points.map((pt) => `${pt[0]},${-pt[1]}`).join(" ")}
                fill="none"
                stroke={STROKE}
                strokeWidth={strokeWidth}
              />
            ) : (
              <polyline
                points={p.points.map((pt) => `${pt[0]},${-pt[1]}`).join(" ")}
                fill="none"
                stroke={STROKE}
                strokeWidth={strokeWidth}
              />
            )
          )}
          {p.type === "circle" && (
            <circle cx={p.center[0]} cy={-p.center[1]} r={p.radius} fill="none" stroke={STROKE} strokeWidth={strokeWidth} />
          )}
          {p.type === "arc" && (
            <path d={arcPath(p.center, p.radius, p.startAngle, p.endAngle)} fill="none" stroke={STROKE} strokeWidth={strokeWidth} />
          )}
          {p.type === "text" && (
            <text
              x={p.at[0]}
              y={-p.at[1]}
              fill={TEXT_FILL}
              fontSize={textFont}
              fontFamily="ui-monospace, monospace"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {p.text}
            </text>
          )}
          <title>{`${p.type} · ${p.sourceId}`}</title>
        </g>
      ))}
      {overlays}
      <text
        x={vbX + margin / 3}
        y={vbY + vbH - margin / 3}
        style={{ fontSize: extent / 45 }}
        className="fill-muted-foreground font-mono"
      >
        {`${view.kind} · 1:${scaleDen} · view mm · +v up`}
      </text>
    </svg>
  );
}
