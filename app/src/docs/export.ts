/**
 * Sheet export — the canonical deterministic Sheet IR (COMPAT-CAD-003,
 * Issue #41: "Sheets / Layouts / Title Blocks" + "future PDF/DWG export
 * contracts without proprietary writer implementation").
 *
 * The Sheet IR is the ADAPTER CONTRACT: a canonical JSON artifact embedding
 * the sheet frame, title block, view placements, each placed view's
 * projected primitives (deterministic by construction) and its resolved
 * annotations. It is serialized with the canonical stringify + hashed — the
 * same bytes on every host. Future PDF/DWG adapters consume the IR; the
 * writers themselves are NOT implemented in this slice and requests for
 * those formats fail with a typed docs_unsupported error (explicit
 * uncertainty, LOCK-007 — the contract is established, the writer is not).
 *
 * Pure + engine-free (LOCK-018).
 */

import { createHash } from "node:crypto";
import type { DocsSheetRecord, DocsTitleBlock, DocsViewRecord, Element } from "../contracts/caddocument.js";
import { DOCS_SHEET_FRAME } from "../contracts/caddocument.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { elementToDocsAnnotationOrNull } from "./entities.js";
import { projectAllViews, viewContentHash } from "./regenerate.js";
import type { ViewProjection } from "./project.js";

/** The Sheet IR format identity (additive versioning per api-contract.md §8). */
export const SHEET_IR_FORMAT = "offisos-sheet-ir" as const;
export const SHEET_IR_FORMAT_VERSION = "1" as const;

/** Supported export formats for this slice. */
export type DocsExportFormat = "sheet-ir" | "pdf" | "dwg";

export function isDocsExportFormat(v: unknown): v is DocsExportFormat {
  return v === "sheet-ir" || v === "pdf" || v === "dwg";
}

/** One placed view inside the IR: the placement frame + the view's fresh
 *  projection + its annotations (resolved current values). */
export interface SheetIRView {
  readonly viewId: string;
  readonly kind: string;
  readonly title: string;
  readonly placement: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly contentHash: string;
  readonly primitiveCount: number;
  readonly bbox: { readonly uMin: number; readonly uMax: number; readonly vMin: number; readonly vMax: number } | null;
  readonly primitives: readonly unknown[];
  readonly annotations: readonly unknown[];
}

/** The canonical Sheet IR artifact. */
export interface SheetIR {
  readonly format: typeof SHEET_IR_FORMAT;
  readonly formatVersion: typeof SHEET_IR_FORMAT_VERSION;
  readonly sheet: {
    readonly id: string;
    readonly title: string;
    readonly frame: { readonly width: number; readonly height: number; readonly titleBlockWidth: number };
    readonly titleBlock: DocsTitleBlock;
  };
  readonly views: readonly SheetIRView[];
}

/** Build the Sheet IR for one sheet against the CURRENT document state.
 *  Throws when the sheet or a placed view cannot be resolved (the command
 *  layer maps typed errors). */
export function buildSheetIR(
  sheet: DocsSheetRecord,
  views: readonly DocsViewRecord[],
  elements: readonly Element[],
): { ir: SheetIR; canonical: string; hash: string } {
  const projections = projectAllViews(views, elements);
  const irViews: SheetIRView[] = [];
  for (const placement of sheet.viewPlacements) {
    const view = views.find((v) => v.id === placement.viewId);
    if (view === undefined) {
      throw new Error(`sheet '${sheet.id}': placement references unknown view '${placement.viewId}'`);
    }
    const result = projections.get(view.id);
    if (result === undefined || result.projection === null) {
      throw new Error(`sheet '${sheet.id}': view '${view.id}' does not project (${result?.error ?? "unknown"})`);
    }
    const projection = result.projection;
    const annotations = collectViewAnnotations(view.id, elements);
    irViews.push({
      viewId: view.id,
      kind: view.kind,
      title: view.title,
      placement: { x: placement.x, y: placement.y, w: placement.w, h: placement.h },
      contentHash: viewContentHash(projection),
      primitiveCount: projection.primitives.length,
      bbox: projection.bbox,
      primitives: projection.primitives as readonly unknown[],
      annotations,
    });
  }
  const ir: SheetIR = {
    format: SHEET_IR_FORMAT,
    formatVersion: SHEET_IR_FORMAT_VERSION,
    sheet: {
      id: sheet.id,
      title: sheet.title,
      frame: {
        width: DOCS_SHEET_FRAME.width,
        height: DOCS_SHEET_FRAME.height,
        titleBlockWidth: DOCS_SHEET_FRAME.titleBlockWidth,
      },
      titleBlock: sheet.titleBlock,
    },
    views: irViews,
  };
  const canonical = canonicalStringify(ir);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return { ir, canonical, hash };
}

/** The annotations of one view in canonical order (document insertion order). */
export function collectViewAnnotations(viewId: string, elements: readonly Element[]): unknown[] {
  const out: unknown[] = [];
  for (const el of elements) {
    const annotation = elementToDocsAnnotationOrNull(el);
    if (annotation === null) continue;
    if (annotation.viewId !== viewId) continue;
    out.push({ id: el.id, ...annotation });
  }
  return out;
}

export type { ViewProjection };
