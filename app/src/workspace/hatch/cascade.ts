/**
 * COMPAT-CAD-010 (Issue #18) — the hatch boundary cascade.
 *
 * The ASSOCIATIVITY engine (the CAD-PARITY-005 remeasure-cascade + the
 * CC008 ARRAY source-deletion precedents):
 *  - when a referenced BOUNDARY entity changes (move/modify), the hatch's
 *    stored boundary loop snapshots RE-RESOLVE from the post-edit world
 *    inside the SAME atomic revision (one undo entry) — full-record props
 *    rewrite, display overrides preserved (the remeasure convention);
 *  - when a referenced boundary entity is DELETED, the hatch is
 *    cascade-erased in the SAME atomic revision (the "no orphaned
 *    boundary-owned entities" contract — UNDO restores both atomically,
 *    REDO re-erases both).
 *
 * Pure functions over (elements, edits) — engine-free, host-free,
 * deterministic (LOCK-003/018).
 */

import type { DocumentEdit, Element } from "../../contracts/caddocument.js";
import { applyEditsInMemory } from "../constraints/cascade.js";
import {
  HatchError,
  type HatchBoundaryRef,
  type HatchEntity,
  boundaryLoopOfElement,
  hatchFromElement,
  hatchToProps,
} from "./types.js";

/** One hatch view over the element world (document order). */
export interface HatchView {
  readonly id: string;
  readonly hatch: HatchEntity;
}

const DISPLAY_KEYS: readonly string[] = ["color", "linetype", "lineweight", "transparency"];

/** The hatch views of the given elements (document order). */
export function hatchViewsOf(elements: readonly Element[]): HatchView[] {
  const out: HatchView[] = [];
  for (const el of elements) {
    const h = hatchFromElement(el);
    if (h !== null) out.push({ id: el.id, hatch: h });
  }
  return out;
}

/** Which hatch ids reference any of the given element ids as boundaries? */
export function hatchesReferencing(
  hatches: readonly HatchView[],
  changedIds: ReadonlySet<string>,
): readonly string[] {
  const out: string[] = [];
  for (const { id, hatch } of hatches) {
    for (const ref of hatch.boundary) {
      if (changedIds.has(ref.id)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/** The hatch ids whose boundary references are ALL deleted → cascade-erase
 *  set (the deterministic deletion policy: ANY deleted boundary reference
 *  cascade-erases the hatch — a hatch over a partial boundary is an
 *  orphaned entity; deleting the hatch's own id is a plain removal). */
export function hatchesOfBoundaries(elements: readonly Element[], deletedIds: readonly string[]): string[] {
  const deleted = new Set(deletedIds);
  const out: string[] = [];
  for (const { id, hatch } of hatchViewsOf(elements)) {
    if (deleted.has(id)) continue; // direct hatch deletion — plain removal
    for (const ref of hatch.boundary) {
      if (deleted.has(ref.id)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/** The boundary-snapshot cascade: re-resolve every hatch whose boundary
 *  references an element changed by `edit`, against the post-edit world.
 *  Returns setProps edits (full-record rewrite, display preserved) + the
 *  deterministic summary notes. A boundary that became UNSUPPORTED after
 *  the edit (e.g. a closed polyline opened by a trim) is a typed failure
 *  the caller surfaces — the cascade never fabricates a loop. */
export function hatchBoundaryCascade(
  elements: readonly Element[],
  edit: DocumentEdit,
): { edits: DocumentEdit[]; notes: string[]; failure: HatchError | null } {
  const changedIds = new Set<string>();
  collectEditedIds(edit, changedIds);
  if (changedIds.size === 0) return { edits: [], notes: [], failure: null };
  const hatches = hatchViewsOf(elements).filter(({ hatch }) => {
    for (const ref of hatch.boundary) {
      if (changedIds.has(ref.id)) return true;
    }
    return false;
  });
  if (hatches.length === 0) return { edits: [], notes: [], failure: null };
  const worldAfter = applyEditsInMemory(elements, edit);
  const byId = new Map(worldAfter.map((el) => [el.id, el] as const));
  const edits: DocumentEdit[] = [];
  const notes: string[] = [];
  for (const { id, hatch } of hatches) {
    const next: HatchBoundaryRef[] = [];
    for (const ref of hatch.boundary) {
      const el = byId.get(ref.id);
      if (el === undefined) continue; // deletion cascade handles removed refs
      try {
        next.push({ id: ref.id, loop: boundaryLoopOfElement(el) });
      } catch (e) {
        // A still-existing boundary that is no longer a supported closed
        // loop: typed failure, never a fabricated snapshot.
        return { edits: [], notes: [], failure: e as HatchError };
      }
    }
    if (next.length === 0) continue;
    const props = hatchToProps({ ...hatch, boundary: next });
    const current = elements.find((el) => el.id === id);
    const currentProps = (current?.props ?? {}) as Record<string, unknown>;
    for (const key of DISPLAY_KEYS) {
      if (currentProps[key] !== undefined) props[key] = currentProps[key];
    }
    edits.push({ type: "setProps", elementId: id, patch: props });
    notes.push(`${id}: boundary re-resolved (${next.length} loop${next.length === 1 ? "" : "s"})`);
  }
  return { edits, notes, failure: null };
}

/** Collect the element ids an edit touches (updateElement/setProps patch
 *  + removeElement; addElement ids are new — no hatch references them
 *  yet). */
function collectEditedIds(edit: DocumentEdit, out: Set<string>): void {
  if (edit.type === "applyEdits") {
    for (const e of edit.edits) collectEditedIds(e, out);
    return;
  }
  if (edit.type === "updateElement" || edit.type === "setProps" || edit.type === "removeElement") {
    out.add(edit.elementId);
  }
}
