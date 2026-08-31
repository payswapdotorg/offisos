/**
 * CAD-PARITY-013 layout book ordering + sheet numbering (Issue #104) — the
 * deterministic derivation the Layout Book, publisher sets, schedules and
 * title-block "sheetNumber" fields all share.
 *
 * Pure + deterministic (LOCK-003/018): identical (navigatorNodes, layouts)
 * → identical book order → identical sheet numbers, on every host, every
 * run. The DERIVED numbering is NEVER stored (the schedules.run precedent:
 * there is no parallel source of truth).
 *
 * Book order (the Archicad Layout Book semantics, bounded):
 * - subset nodes are ordered by (order, id) at each level, recursively;
 * - the layouts filed under one node come in DOCUMENT (table) order;
 * - root-level layouts (no subsetId) come after all subset subtrees, in
 *   document order.
 *
 * Sheet numbering:
 * - a layout under a subset with numbering "custom" gets
 *   `${prefix}-${padded}` where the counter starts at the subset's
 *   `customNumber` value (its digit count defines the zero padding) and
 *   increments per layout in book order within the subset's SUBTREE;
 * - every OTHER layout (subset-less, or under a "none" subset) gets
 *   "L" + the 1-based position (zero-padded to 2) among ALL such layouts
 *   in document order.
 */

import type { LayoutRecord, NavigatorNodeRecord } from "../../contracts/caddocument.js";

/** The subset nodes of the book, root level first, each level ordered by
 *  (order, id), children following their parent (depth-first). */
export function bookOrderedSubsets(nodes: readonly NavigatorNodeRecord[]): readonly NavigatorNodeRecord[] {
  const subsets = nodes.filter((n) => n.kind === "subset");
  const byParent = new Map<string | null, NavigatorNodeRecord[]>();
  for (const n of subsets) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1));
  }
  const out: NavigatorNodeRecord[] = [];
  const walk = (parent: string | null): void => {
    for (const node of byParent.get(parent) ?? []) {
      out.push(node);
      walk(node.id);
    }
  };
  walk(null);
  return out;
}

/** The layouts of ONE subset node's SUBTREE in book order (nodes ordered by
 *  (order, id) recursively; layouts in document order within a node). */
export function subsetLayouts(
  nodeId: string,
  nodes: readonly NavigatorNodeRecord[],
  layouts: readonly LayoutRecord[],
): readonly LayoutRecord[] {
  const subsets = nodes.filter((n) => n.kind === "subset");
  const byParent = new Map<string | null, NavigatorNodeRecord[]>();
  for (const n of subsets) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1));
  }
  const out: LayoutRecord[] = [];
  const walk = (id: string | null): void => {
    if (id === null) return;
    for (const layout of layouts) {
      if (layout.subsetId === id) out.push(layout);
    }
    for (const child of byParent.get(id) ?? []) walk(child.id);
  };
  walk(nodeId);
  return out;
}

/** The FULL book order: every layout of every subset subtree (subsets in
 *  book order), then the root-level (subset-less) layouts in document
 *  order. The deterministic publisher expansion / book listing order. */
export function bookOrderedLayouts(
  nodes: readonly NavigatorNodeRecord[],
  layouts: readonly LayoutRecord[],
): readonly LayoutRecord[] {
  const out: LayoutRecord[] = [];
  for (const subset of bookOrderedSubsets(nodes)) {
    if (subset.parentId === null) {
      out.push(...subsetLayouts(subset.id, nodes, layouts));
    }
  }
  for (const layout of layouts) {
    if (layout.subsetId === undefined) out.push(layout);
  }
  return out;
}

/** Resolve the sheet number of ONE layout (the pure deterministic
 *  derivation — see the module doc for the exact rules).
 *
 * - layout under a subset (or its subtree) with numbering "custom":
 *   `${prefix}-${padded counter}` — the counter starts at the subset's
 *   customNumber value and increments per layout in the subset's book
 *   order (an absent prefix renders as the empty string, e.g. "-01");
 * - every other layout: "L" + the 1-based document-order position among
 *   ALL non-custom layouts, zero-padded to 2 ("L01", "L02", …).
 */
export function sheetNumberOf(
  layout: LayoutRecord,
  nodes: readonly NavigatorNodeRecord[],
  layouts: readonly LayoutRecord[],
): string {
  if (layout.subsetId !== undefined) {
    const subset = nodes.find((n) => n.id === layout.subsetId && n.kind === "subset");
    if (subset !== undefined && subset.numbering === "custom") {
      const custom = subset.customNumber ?? "1";
      const start = Number.parseInt(custom, 10);
      const width = custom.length;
      const ordered = subsetLayouts(subset.id, nodes, layouts);
      const index = ordered.findIndex((l) => l.id === layout.id);
      const n = (Number.isFinite(start) ? start : 1) + (index > 0 ? index : 0);
      const prefix = subset.prefix ?? "";
      return `${prefix}-${String(n).padStart(width, "0")}`;
    }
  }
  // The "L" numbering: document order among ALL non-custom layouts.
  const nonCustom = layouts.filter((l) => {
    if (l.subsetId === undefined) return true;
    const subset = nodes.find((n) => n.id === l.subsetId && n.kind === "subset");
    return !(subset !== undefined && subset.numbering === "custom");
  });
  const index = nonCustom.findIndex((l) => l.id === layout.id);
  return `L${String((index >= 0 ? index : 0) + 1).padStart(2, "0")}`;
}

/** The revision codes of ONE layout (its revisionIds joined through the
 *  revision table, in record order — the title block "revisions" field). */
export function revisionCodesOf(
  layout: LayoutRecord,
  revisions: readonly { readonly id: string; readonly code: string }[],
): readonly string[] {
  const byId = new Map(revisions.map((r) => [r.id, r.code]));
  const out: string[] = [];
  for (const revId of layout.revisionIds ?? []) {
    const code = byId.get(revId);
    if (code !== undefined) out.push(code);
  }
  return out;
}
