/**
 * Documentation annotation entities (COMPAT-CAD-003, Issue #41:
 * "Dimensions / Tags / Annotations").
 *
 * Documentation annotations are ELEMENTS (kind "annotation" — the reserved
 * third ElementKind) carrying a `type` from this module's vocabulary:
 *
 *   docs.dim  : { type:"docs.dim", viewId, refIds:[a,b], axis, mode, offset,
 *                 measured?, dangling?, reason? }
 *               — a linear dimension between TWO canonical element ids,
 *                 measured in the VIEW's coordinate axis. `measured` is a
 *                 DERIVED value refreshed by docs.regenerate (parametric:
 *                 model changes flow through re-projection; the drafting
 *                 slice's measure-at-creation dims stay non-parametric by
 *                 contrast — documented divergence, both intentional).
 *   docs.tag  : { type:"docs.tag", viewId, targetId, label?, dangling?, reason? }
 *               — an element tag whose `label` is derived from the target's
 *                 canonical properties at regeneration.
 *   docs.note : { type:"docs.note", viewId, x, y, text }
 *               — a free note anchored in view coordinates (no model ref).
 *
 * `refIds`/`targetId`/`viewId` are CANONICAL identities — the acceptance
 * criterion "dimensions/annotations remain associated with canonical element
 * IDs". When a reference is lost the annotation is NOT re-targeted or
 * removed: docs.regenerate marks it `dangling: true` with an explicit reason
 * (no silent approximation, LOCK-007).
 *
 * Pure, engine-free, host-free (LOCK-018). Validation is strict — malformed
 * input is rejected with descriptive errors, never guessed.
 */

import type { Element } from "../contracts/caddocument.js";
import { assertVec2 } from "../bim/elements.js";

/** Documentation annotation entity type vocabulary (COMPAT-CAD-003). */
export type DocsAnnotationType = "docs.dim" | "docs.tag" | "docs.note";

/** Dimension axes in VIEW coordinates (the projected plane's axes). */
export type DocsDimAxis = "x" | "y";

/** Dimension measurement modes:
 *  - overall — the full span covered by both references (face-to-face
 *    overall dimension);
 *  - clear   — the positive gap between the two references (0 when they
 *    overlap — honest, never negative). */
export type DocsDimMode = "overall" | "clear";

const ANNOTATION_TYPES: readonly DocsAnnotationType[] = ["docs.dim", "docs.tag", "docs.note"];
const DIM_AXES: readonly DocsDimAxis[] = ["x", "y"];
const DIM_MODES: readonly DocsDimMode[] = ["overall", "clear"];

/** Is a props type one of the documentation annotation types? */
export function isDocsAnnotationType(type: unknown): type is DocsAnnotationType {
  return typeof type === "string" && (ANNOTATION_TYPES as readonly string[]).includes(type);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate + build a `docs.dim` annotation (unvalidated derived fields are
 *  rejected — `measured` may only be written by regeneration, never
 *  hand-authored). */
export function makeDocsDim(input: Record<string, unknown>): Omit<DocsDimProps, "measured" | "dangling" | "reason"> {
  if (typeof input.viewId !== "string" || input.viewId.length === 0) {
    throw new Error("docs.dim requires a non-empty viewId");
  }
  if (
    !Array.isArray(input.refIds) || input.refIds.length !== 2 ||
    !input.refIds.every((x) => typeof x === "string" && x.length > 0)
  ) {
    throw new Error("docs.dim requires refIds: exactly two canonical element ids");
  }
  if (input.refIds[0] === input.refIds[1]) {
    throw new Error("docs.dim refIds must reference two DIFFERENT elements (a dimension spans two references)");
  }
  if (!(DIM_AXES as readonly unknown[]).includes(input.axis)) {
    throw new Error(`docs.dim axis must be 'x' | 'y' (view-space axis), got ${JSON.stringify(input.axis)}`);
  }
  if (!(DIM_MODES as readonly unknown[]).includes(input.mode)) {
    throw new Error(`docs.dim mode must be 'overall' | 'clear', got ${JSON.stringify(input.mode)}`);
  }
  const offset = input.offset === undefined ? 0 : input.offset;
  if (!isFiniteNumber(offset)) {
    throw new Error("docs.dim offset must be a finite number (view-space offset of the dimension line)");
  }
  for (const forbidden of ["measured", "dangling", "reason", "type"] as const) {
    if (input[forbidden] !== undefined) {
      throw new Error(`docs.dim: '${forbidden}' is a derived field — set it through docs.regenerate, not at creation`);
    }
  }
  return {
    type: "docs.dim",
    viewId: input.viewId,
    refIds: [input.refIds[0] as string, input.refIds[1] as string],
    axis: input.axis as DocsDimAxis,
    mode: input.mode as DocsDimMode,
    offset,
  };
}

/** Validate + build a `docs.tag` annotation. */
export function makeDocsTag(input: Record<string, unknown>): Omit<DocsTagProps, "label" | "dangling" | "reason"> {
  if (typeof input.viewId !== "string" || input.viewId.length === 0) {
    throw new Error("docs.tag requires a non-empty viewId");
  }
  if (typeof input.targetId !== "string" || input.targetId.length === 0) {
    throw new Error("docs.tag requires a non-empty targetId (the tagged canonical element)");
  }
  for (const forbidden of ["label", "dangling", "reason", "type"] as const) {
    if (input[forbidden] !== undefined) {
      throw new Error(`docs.tag: '${forbidden}' is a derived field — set it through docs.regenerate, not at creation`);
    }
  }
  return { type: "docs.tag", viewId: input.viewId, targetId: input.targetId };
}

/** Validate + build a `docs.note` annotation (fully authored content). */
export function makeDocsNote(input: Record<string, unknown>): DocsNoteProps {
  if (typeof input.viewId !== "string" || input.viewId.length === 0) {
    throw new Error("docs.note requires a non-empty viewId");
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new Error("docs.note requires a non-empty text");
  }
  const at = assertVec2([input.x, input.y], "docs.note anchor");
  return { type: "docs.note", viewId: input.viewId, x: at[0], y: at[1], text: input.text };
}

/** Props of a docs.dim annotation element. */
export interface DocsDimProps {
  readonly type: "docs.dim";
  readonly viewId: string;
  readonly refIds: readonly [string, string];
  readonly axis: DocsDimAxis;
  readonly mode: DocsDimMode;
  readonly offset: number;
  /** Derived (docs.regenerate): the measured span/gap in mm. */
  readonly measured?: number;
  /** Derived: true when a reference is missing/unprojectable. */
  readonly dangling?: boolean;
  /** Derived: explicit dangling reason. */
  readonly reason?: string;
}

/** Props of a docs.tag annotation element. */
export interface DocsTagProps {
  readonly type: "docs.tag";
  readonly viewId: string;
  readonly targetId: string;
  /** Derived (docs.regenerate): the tag label resolved from the target. */
  readonly label?: string;
  readonly dangling?: boolean;
  readonly reason?: string;
}

/** Props of a docs.note annotation element. */
export interface DocsNoteProps {
  readonly type: "docs.note";
  readonly viewId: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/** Cast an element's props to a docs annotation, or null when the element is
 *  not a documentation annotation. */
export function elementToDocsAnnotationOrNull(el: Element): (DocsDimProps | DocsTagProps | DocsNoteProps) | null {
  if (el.kind !== "annotation") return null;
  const type = el.props.type;
  if (!isDocsAnnotationType(type)) return null;
  return el.props as unknown as DocsDimProps | DocsTagProps | DocsNoteProps;
}

/** Build the annotation ELEMENT (kind "annotation") for validated props. */
export function annotationElement(id: string, props: DocsDimProps | DocsTagProps | DocsNoteProps): Element {
  return { id, kind: "annotation", engineId: null, props: props as unknown as Record<string, unknown> };
}
