/**
 * CAD-PARITY-002 drafting-aid feedback (Issue #75; CAD-P-004 precision
 * feedback surfaces: "snap/polar/ortho/tracking feedback").
 *
 * Deterministic cursor constraint + readout helpers shared by both hosts.
 * Composition rule (canonical, LOCK-004 parity): the host applies
 * constrainCursor to the raw cursor FIRST, then resolves object snaps at the
 * constrained point (a snapped point always wins — the aid constrains the
 * search, the snap lands the point). Aids are HOST-LOCAL editor state and
 * never enter the document (LOCK-015).
 *
 * Phase-bounded (documented): OTRACK here tracks the LAST acquired point
 * (horizontal/vertical extension alignment); multi-point tracking
 * acquisitions land with CAD-2D-003 precision-aids parity.
 */

import type { Vec2 } from "../drafting/precision.js";

/** Editor drafting aids (host-local, non-authoritative — LOCK-015). */
export interface DraftingAids {
  readonly ortho: boolean;
  readonly polar: boolean;
  readonly otrack: boolean;
  /** Polar tracking increment in degrees (15° AutoCAD default). */
  readonly polarStepDeg: number;
  /** Capture window for polar/tracking alignment (± degrees). */
  readonly captureDeg: number;
}

export const DEFAULT_DRAFTING_AIDS: Readonly<DraftingAids> = {
  ortho: false,
  polar: false,
  otrack: false,
  polarStepDeg: 15,
  captureDeg: 5,
};

export interface CursorFeedback {
  /** The constrained cursor point the UI should render/land. */
  readonly point: Vec2;
  /** Which aid constrained the cursor this frame (null = free cursor). */
  readonly aid: "ortho" | "polar" | "otrack" | null;
  /** Aligned polar/tracking angle in degrees when aid is polar/otrack. */
  readonly angleDeg: number | null;
  /** Rubber-band distance from the base (when a base exists). */
  readonly length: number | null;
}

/**
 * Apply ortho/polar/otrack constraints to a raw cursor position relative to
 * the current base point (the last picked point or a step's base). Without
 * a base the aids cannot constrain anything — the raw cursor returns.
 */
export function constrainCursor(base: Vec2 | null, cursor: Vec2, aids: DraftingAids): CursorFeedback {
  if (base === null) {
    return { point: cursor, aid: null, angleDeg: null, length: null };
  }
  const dx = cursor[0] - base[0];
  const dy = cursor[1] - base[1];
  const len = Math.hypot(dx, dy);
  if (len <= 1e-12) {
    return { point: cursor, aid: null, angleDeg: null, length: 0 };
  }

  if (aids.ortho) {
    // Snap to the dominant axis, preserving the distance.
    const point: Vec2 = Math.abs(dx) >= Math.abs(dy) ? [base[0] + Math.sign(dx) * len, base[1]] : [base[0], base[1] + Math.sign(dy) * len];
    return { point, aid: "ortho", angleDeg: null, length: len };
  }

  const angle = Math.atan2(dy, dx);
  const deg = ((angle * 180) / Math.PI + 360) % 360;

  if (aids.polar) {
    const step = aids.polarStepDeg;
    const nearest = Math.round(deg / step) * step;
    const delta = Math.abs(((deg - nearest + 540) % 360) - 180);
    if (delta <= aids.captureDeg) {
      const rad = (nearest * Math.PI) / 180;
      const point: Vec2 = [base[0] + len * Math.cos(rad), base[1] + len * Math.sin(rad)];
      return { point, aid: "polar", angleDeg: nearest, length: len };
    }
  }

  if (aids.otrack) {
    // Track the horizontal/vertical extension of the base point when the
    // cursor is near alignment (within the capture window).
    const deltaToH = Math.abs(((deg - 0 + 540) % 360) - 180);
    const deltaToV = Math.abs(((deg - 90 + 540) % 360) - 180);
    const nearH = deltaToH <= aids.captureDeg || Math.abs(deltaToH - 360) <= aids.captureDeg;
    const nearV = deltaToV <= aids.captureDeg;
    if (nearH && !nearV) {
      return { point: [cursor[0], base[1]], aid: "otrack", angleDeg: 0, length: Math.abs(cursor[0] - base[0]) };
    }
    if (nearV) {
      return { point: [base[0], cursor[1]], aid: "otrack", angleDeg: 90, length: Math.abs(cursor[1] - base[1]) };
    }
  }

  return { point: cursor, aid: null, angleDeg: null, length: len };
}

// ---------------------------------------------------------------------------
// Coordinate readout (status bar / dynamic input).
// ---------------------------------------------------------------------------

export interface CoordinateFormat {
  readonly decimals: number;
}

export const DEFAULT_COORDINATE_FORMAT: CoordinateFormat = { decimals: 1 };

export function formatCoordinate(p: Vec2, format: CoordinateFormat = DEFAULT_COORDINATE_FORMAT): string {
  return `${p[0].toFixed(format.decimals)}, ${p[1].toFixed(format.decimals)}`;
}

export interface RubberInfo {
  readonly length: number;
  readonly angleDeg: number;
}

/** Rubber-band info for the dynamic readout while a point step is active. */
export function rubberInfo(base: Vec2, cursor: Vec2): RubberInfo {
  const dx = cursor[0] - base[0];
  const dy = cursor[1] - base[1];
  const len = Math.hypot(dx, dy);
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return { length: len, angleDeg: deg };
}
