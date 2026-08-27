"use client";

/**
 * Sheet preview (COMPAT-CAD-003 / Issue #41) — Web host.
 *
 * Deterministic SVG presentation of ONE documentation sheet
 * (`docs.listSheets`): the canonical A1 landscape frame (841×594 mm) with the
 * fixed 200 mm title-block strip on the right edge — the drawable region is
 * [0, 641]×[0, 594]. View placements are drawn to scale as rectangles with
 * their view titles; the title-block fields render inside the strip. Sheet
 * millimetres map 1:1 into the viewBox with the origin at the BOTTOM-left
 * (+y up, drafting convention — placements use the same convention).
 *
 * Pure presentation — the exportable artifact is the canonical Sheet IR
 * (`docs.exportSheet`), not this drawing.
 */

import * as React from "react";
import { DOCS_SHEET_FRAME } from "@offisos/cad-app-shell/contracts/caddocument";
import type {
  DocsSheetRecord,
  DocsViewListEntry,
} from "@/cad/client/http-transport";

const FRAME_W = DOCS_SHEET_FRAME.width; // 841
const FRAME_H = DOCS_SHEET_FRAME.height; // 594
const STRIP_W = DOCS_SHEET_FRAME.titleBlockWidth; // 200
const DRAWABLE_W = FRAME_W - STRIP_W; // 641

const STROKE = "#57534e"; // stone-600
const LIGHT = "#a8a29e"; // stone-400
const TEXT = "#44403c"; // stone-700
const ACCENT = "#0f766e"; // teal-700 — placement accents

interface DocsSheetPreviewProps {
  readonly sheet: DocsSheetRecord;
  /** View list entries (title/kind/hash lookup for placed views). */
  readonly views: readonly DocsViewListEntry[];
}

export function DocsSheetPreview({ sheet, views }: DocsSheetPreviewProps): React.JSX.Element {
  const byId = React.useMemo(() => new Map(views.map((v) => [v.view.id, v])), [views]);
  const sheetY = (v: number): number => FRAME_H - v; // +y up → SVG y down

  return (
    <svg
      data-testid="docs-sheet-preview"
      viewBox={`0 0 ${FRAME_W} ${FRAME_H}`}
      className="w-full h-auto rounded border bg-white dark:bg-neutral-900"
      role="img"
      aria-label={`Sheet preview — ${sheet.title} (A1, 841×594 mm)`}
    >
      {/* A1 frame + the fixed title-block strip on the right */}
      <rect x={0} y={0} width={FRAME_W} height={FRAME_H} fill="none" stroke={STROKE} strokeWidth={2} />
      <rect x={DRAWABLE_W} y={0} width={STRIP_W} height={FRAME_H} fill="rgba(120,113,108,0.06)" stroke={STROKE} strokeWidth={1.2} />
      <line x1={DRAWABLE_W} y1={0} x2={DRAWABLE_W} y2={FRAME_H} stroke={STROKE} strokeWidth={2} />

      {/* view placements — drawn to scale (sheet mm), +y up */}
      {sheet.viewPlacements.map((p) => {
        const entry = byId.get(p.viewId);
        const known = entry !== undefined;
        const y = sheetY(p.y + p.h);
        return (
          <g key={`${p.viewId}-${p.x}-${p.y}`} data-placement={p.viewId}>
            <rect
              x={p.x}
              y={y}
              width={p.w}
              height={p.h}
              fill="none"
              stroke={known ? ACCENT : "#b91c1c"}
              strokeWidth={1.4}
              strokeDasharray={known ? undefined : "6,3"}
            />
            <text x={p.x + 3} y={y - 4} fontSize={11} fill={known ? ACCENT : "#b91c1c"} fontFamily="ui-monospace, monospace">
              {known ? `${entry.view.title} (${entry.view.kind})` : `${p.viewId} — unknown view`}
            </text>
            {known && (
              <text x={p.x + 3} y={y + p.h - 5} fontSize={9} fill={LIGHT} fontFamily="ui-monospace, monospace">
                {`${entry.view.id} · ${entry.primitiveCount} prim · ${(entry.contentHash ?? "").slice(0, 8)}`}
              </text>
            )}
          </g>
        );
      })}

      {/* title block fields, rendered inside the strip */}
      <g fontFamily="ui-monospace, monospace" fill={TEXT}>
        <text x={DRAWABLE_W + 12} y={36} fontSize={13} fontWeight="bold">
          TITLE BLOCK
        </text>
        <line x1={DRAWABLE_W + 10} y1={44} x2={FRAME_W - 10} y2={44} stroke={LIGHT} strokeWidth={0.8} />

        <text x={DRAWABLE_W + 12} y={62} fontSize={9} fill={LIGHT}>PROJECT</text>
        <text x={DRAWABLE_W + 12} y={76} fontSize={12}>{sheet.titleBlock.projectName}</text>

        <text x={DRAWABLE_W + 12} y={98} fontSize={9} fill={LIGHT}>SHEET TITLE</text>
        <text x={DRAWABLE_W + 12} y={112} fontSize={12}>{sheet.titleBlock.sheetTitle}</text>

        <text x={DRAWABLE_W + 12} y={134} fontSize={9} fill={LIGHT}>SHEET</text>
        <text x={DRAWABLE_W + 12} y={156} fontSize={22} fontWeight="bold">{sheet.titleBlock.sheetNumber}</text>

        <line x1={DRAWABLE_W + 10} y1={170} x2={FRAME_W - 10} y2={170} stroke={LIGHT} strokeWidth={0.8} />

        {sheet.titleBlock.author !== undefined && sheet.titleBlock.author !== "" && (
          <>
            <text x={DRAWABLE_W + 12} y={188} fontSize={9} fill={LIGHT}>AUTHOR</text>
            <text x={DRAWABLE_W + 12} y={201} fontSize={11}>{sheet.titleBlock.author}</text>
          </>
        )}
        {sheet.titleBlock.date !== undefined && sheet.titleBlock.date !== "" && (
          <>
            <text x={DRAWABLE_W + 12} y={222} fontSize={9} fill={LIGHT}>DATE</text>
            <text x={DRAWABLE_W + 12} y={235} fontSize={11}>{sheet.titleBlock.date}</text>
          </>
        )}

        <line x1={DRAWABLE_W + 10} y1={250} x2={FRAME_W - 10} y2={250} stroke={LIGHT} strokeWidth={0.8} />
        <text x={DRAWABLE_W + 12} y={268} fontSize={9} fill={LIGHT}>SHEET ID</text>
        <text x={DRAWABLE_W + 12} y={281} fontSize={11}>{sheet.id}</text>
        <text x={DRAWABLE_W + 12} y={297} fontSize={9} fill={LIGHT}>SHEET TITLE (RECORD)</text>
        <text x={DRAWABLE_W + 12} y={309} fontSize={10}>{sheet.title}</text>

        <text x={DRAWABLE_W + 12} y={FRAME_H - 40} fontSize={9} fill={LIGHT}>FRAME</text>
        <text x={DRAWABLE_W + 12} y={FRAME_H - 27} fontSize={10}>A1 · {FRAME_W}×{FRAME_H} mm</text>
        <text x={DRAWABLE_W + 12} y={FRAME_H - 13} fontSize={10}>drawable {DRAWABLE_W}×{FRAME_H}</text>
      </g>

      <text x={10} y={FRAME_H - 10} fontSize={10} fill={LIGHT} fontFamily="ui-monospace, monospace">
        {`placements: ${sheet.viewPlacements.length} · sheet mm · +y up`}
      </text>
    </svg>
  );
}
