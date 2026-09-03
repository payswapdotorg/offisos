/**
 * COMPAT-CAD-004 (Issue #121) — the bounded deterministic pattern
 * operations: the MIRROR that includes symbol instances.
 *
 * The bounded vocabulary (everything else is a typed decline, never a
 * fabricated semantic):
 *  - drafting geometry entities (the CAD-PARITY-003 vocabulary) mirror
 *    EXACTLY through the verified kernel `mirrorGeom` — the SAME path the
 *    MIRROR command uses, including the constraint-aware cascade
 *    (severance + re-solve + associative re-measurement) when constraints
 *    are supplied: the geometry part is executed through the public
 *    `modifyEntities` (the verified entry), never a parallel semantics;
 *  - block instances (CAD-PARITY-006 block-ref elements) mirror through
 *    the DETERMINISTIC REFLECTED PLACEMENT: the insertion point mirrors
 *    across the axis, the rotation reflects (θ' = 2φ − θ — the classic
 *    mirror-angle law), the uniform scale is unchanged and the handedness
 *    flag flips (mirrored: true ↔ absent; mirroring twice returns to the
 *    unreflected canonical form). Attributes/material/display ride the
 *    full-record canonical rewrite (setProps/addElement through
 *    blockRefToProps — the strict constructor re-validates every write);
 *  - xref instances, annotations, BIM entities and unknown ids are typed
 *    declines naming the exact limitation.
 *
 * ONE atomic revision per operation: the geometry part and the instance
 * part are composed into ONE `applyEdits` batch (per-sub-edit inverses,
 * document-minted ids, exact undo/redo/replay — the established
 * discipline). Ordering is deterministic: geometry entities in the given
 * ids order first, then block instances in the given ids order (the
 * report rows carry the source ids in the SAME order; copy result ids
 * resolve from the post-execute snapshot in mint order).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { DocumentEdit, Element } from "../contracts/caddocument.js";
import type { PatternMirrorView } from "../contracts/parametrics.js";
import { PATTERNS_MAX_MIRROR_ENTITIES } from "../contracts/parametrics.js";
import { isBlockRefElement, isXrefRefElement, elementToBlockRef, blockRefToProps } from "../workspace/blocks/types.js";
import { mirrorPt, normAngle, type Pt } from "../workspace/geometry/math2d.js";
import { modifyEntities } from "../workspace/entity-ops.js";
import type { ConstraintRecord } from "../contracts/caddocument.js";
import { ParametricsError } from "./errors.js";

// ---------------------------------------------------------------------------
// The plan (pure derivation; the caller executes ONE atomic revision).
// ---------------------------------------------------------------------------

export interface MirrorRowPlan {
  /** The SOURCE element id (the row's identity — the given ids order). */
  readonly id: string;
  readonly kind: "geometry" | "block-ref";
  /** True = a copy was minted (eraseSource=false); false = in-place. */
  readonly copy: boolean;
  /** The post-mirror handedness of the row (geometry rows always true —
   *  their content is mirrored in place of the flag). */
  readonly mirrored: boolean;
}

export interface PatternMirrorPlan {
  /** The atomic edit batch (null = nothing to do — no revision burned). */
  readonly edit: DocumentEdit | null;
  readonly rows: readonly MirrorRowPlan[];
  readonly summary: string;
  readonly created: number;
  readonly modified: number;
}

interface Pt2 {
  readonly x: number;
  readonly y: number;
}

function finitePt(p: unknown, field: string): Pt {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    throw new ParametricsError(`${field} must be {x, y}`, "parametrics_bad_payload");
  }
  const o = p as Record<string, unknown>;
  for (const axis of ["x", "y"] as const) {
    const v = o[axis];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ParametricsError(`${field}.${axis} must be a finite number`, "parametrics_bad_payload");
    }
  }
  return { x: o.x as number, y: o.y as number };
}

/** Compose the bounded mirror plan (pure). `constraints` threads the
 *  document's constraint table into the verified geometry cascade. */
export function buildMirrorPlan(
  elements: readonly Element[],
  ids: readonly string[],
  p1: unknown,
  p2: unknown,
  eraseSource: boolean,
  constraints?: readonly ConstraintRecord[],
): PatternMirrorPlan {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ParametricsError("pattern.mirror requires a non-empty ids array", "parametrics_bad_payload");
  }
  if (ids.length > PATTERNS_MAX_MIRROR_ENTITIES) {
    throw new ParametricsError(
      `pattern.mirror is bounded to ${PATTERNS_MAX_MIRROR_ENTITIES} entities per batch (got ${ids.length})`,
      "parametrics_out_of_bounds",
    );
  }
  const a = finitePt(p1, "pattern.mirror axis point 1");
  const b = finitePt(p2, "pattern.mirror axis point 2");
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) <= 1e-9) {
    throw new ParametricsError("the mirror axis needs two distinct points", "parametrics_bad_payload");
  }
  if (typeof eraseSource !== "boolean") {
    throw new ParametricsError("pattern.mirror requires { eraseSource: boolean }", "parametrics_bad_payload");
  }

  const byId = new Map(elements.map((el) => [el.id, el]));
  const geometryIds: string[] = [];
  const instanceIds: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      throw new ParametricsError("pattern.mirror ids must be non-empty strings", "parametrics_bad_payload");
    }
    const el = byId.get(id);
    if (el === undefined) {
      throw new ParametricsError(`entity '${id}' does not exist`, "parametrics_not_found");
    }
    if (isXrefRefElement(el)) {
      throw new ParametricsError(
        `mirroring external-reference instances is outside the bounded pattern vocabulary (instance '${id}' declined — reload the reference mirrored instead)`,
        "parametrics_unsupported",
      );
    }
    if (isBlockRefElement(el)) {
      instanceIds.push(id);
      continue;
    }
    if (el.kind !== "geometry") {
      throw new ParametricsError(
        `mirroring ${el.kind} elements is outside the bounded pattern vocabulary (element '${id}' declined — drafting geometry and block instances only)`,
        "parametrics_unsupported",
      );
    }
    // Geometry (incl. drafting text? no — geometry kind only; annotation
    // elements have kind "annotation" and decline above).
    geometryIds.push(id);
  }

  const axisAngle = Math.atan2(dy, dx);
  const edits: DocumentEdit[] = [];
  const rows: MirrorRowPlan[] = [];
  let created = 0;
  let modified = 0;
  const parts: string[] = [];

  // --- the geometry part: through the VERIFIED cascade-aware entry -----
  let geometryEdit: DocumentEdit | null = null;
  if (geometryIds.length > 0) {
    const outcome = modifyEntities(
      elements,
      { op: "mirror", ids: geometryIds, p1: a, p2: b, eraseSource },
      constraints !== undefined && constraints.length > 0 ? { constraints } : {},
    );
    geometryEdit = outcome.edit;
    if (geometryEdit !== null) {
      if (geometryEdit.type === "applyEdits") edits.push(...geometryEdit.edits);
      else edits.push(geometryEdit);
      created += outcome.createdCount;
      modified += outcome.modifiedCount;
      parts.push(outcome.summary);
    }
    for (const id of geometryIds) {
      rows.push({ id, kind: "geometry", copy: !eraseSource, mirrored: true });
    }
  }

  // --- the block-instance part: the deterministic reflected placement --
  if (instanceIds.length > 0) {
    const instanceEdits: DocumentEdit[] = [];
    for (const id of instanceIds) {
      const el = byId.get(id)!;
      const view = elementToBlockRef(el);
      const ins = mirrorPt({ x: view.x, y: view.y }, a, b);
      const rotation = normAngle(2 * axisAngle - view.rotation);
      const mirrored = view.mirrored === true ? undefined : (true as const);
      const target = {
        ...view,
        x: ins.x,
        y: ins.y,
        rotation,
        ...(mirrored !== undefined ? { mirrored } : {}),
      };
      // exactOptionalPropertyTypes: strip the absent flag explicitly.
      const { mirrored: _drop, ...rest } = target as Record<string, unknown> & { mirrored?: true };
      const canonical = mirrored === undefined ? (rest as unknown as typeof target) : target;
      const props = blockRefToProps(canonical);
      if (eraseSource) {
        instanceEdits.push({ type: "setProps", elementId: id, patch: props });
        modified += 1;
      } else {
        instanceEdits.push({
          type: "addElement",
          element: { id: "", kind: "geometry", engineId: null, props },
        });
        created += 1;
      }
      rows.push({ id, kind: "block-ref", copy: !eraseSource, mirrored: mirrored !== undefined });
    }
    edits.push(...instanceEdits);
    parts.push(
      `${instanceIds.length} symbol instance${instanceIds.length === 1 ? "" : "s"} mirrored through the reflected placement (rotation' = 2φ − θ${eraseSource ? ", source replaced" : ", source kept"})`,
    );
  }

  if (edits.length === 0) {
    return {
      edit: null,
      rows,
      summary: "nothing to mirror",
      created: 0,
      modified: 0,
    };
  }
  return {
    edit: edits.length === 1 ? edits[0]! : { type: "applyEdits", edits },
    rows,
    summary: parts.join("; "),
    created,
    modified,
  };
}

/** Resolve the post-execute view rows (the handler maps minted copy ids
 *  from the post-execute snapshot: geometry copies mint first, then
 *  instance copies — the plan's fixed edit order). */
export function mirrorViewOf(
  plan: PatternMirrorPlan,
  newIds: readonly string[],
): PatternMirrorView {
  const geometryCopies = plan.rows.filter((r) => r.kind === "geometry" && r.copy);
  const instanceCopies = plan.rows.filter((r) => r.kind === "block-ref" && r.copy);
  const expected = geometryCopies.length + instanceCopies.length;
  if (newIds.length !== expected) {
    throw new ParametricsError(
      `mirror view resolution mismatch: ${newIds.length} new ids for ${expected} copies`,
      "parametrics_bad_payload",
    );
  }
  const resultById = new Map<string, string>();
  let cursor = 0;
  for (const row of geometryCopies) resultById.set(row.id, newIds[cursor++]!);
  for (const row of instanceCopies) resultById.set(row.id, newIds[cursor++]!);
  return {
    summary: plan.summary,
    created: plan.created,
    modified: plan.modified,
    rows: plan.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      resultId: r.copy ? (resultById.get(r.id) ?? "") : r.id,
      mirrored: r.mirrored,
    })),
  };
}
