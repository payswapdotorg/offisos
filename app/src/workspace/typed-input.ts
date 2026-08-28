/**
 * CAD-PARITY-002 typed coordinate input — AutoCAD-class command-line entry
 * syntax, parsed deterministically (Issue #75; spec/cad-bim/ui.md
 * "coordinate/geometry correctness" evidence target).
 *
 * Supported syntax (case-insensitive, whitespace-tolerant):
 *   x,y            absolute cartesian point      ("1200,300")
 *   @x,y           point relative to the base    ("@500,0")
 *   dist<angle     absolute polar (degrees)      ("1000<45")
 *   @dist<angle    polar relative to the base    ("@1000<90")
 *   number         a distance (distance steps) or DIRECT DISTANCE entry
 *                  (point steps: along the base→cursor rubber-band direction)
 *
 * Failures are explicit and actionable — never silently approximated
 * (LOCK-008 explicit uncertainty). Pure, engine-free, host-free.
 */

import type { Vec2 } from "../drafting/precision.js";

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

export interface TypedPointInput {
  readonly kind: "point";
  readonly point: Vec2;
  /** true when the syntax was relative (@…) — informational for echo. */
  readonly relative: boolean;
}

export interface TypedDistanceInput {
  readonly kind: "distance";
  readonly distance: number;
}

export interface TypedNumberInput {
  readonly kind: "number";
  readonly value: number;
}

export type TypedInput =
  | TypedPointInput
  | TypedDistanceInput
  | TypedNumberInput
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unrecognized" };

function parseFinite(raw: string): number | null {
  if (!NUMBER.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify one typed string WITHOUT resolving against a base point.
 * Cartesian/polar syntax is resolved to an absolute point here only when
 * non-relative; relative forms are resolved later (resolveTypedPoint) once
 * the base is known.
 */
export function classifyTypedInput(text: string): TypedInput {
  const s = text.trim();
  if (s.length === 0) return { kind: "unrecognized" };

  const relative = s.startsWith("@");
  const body = relative ? s.slice(1) : s;

  // Polar syntax: "dist<angle" (angle in degrees).
  const polar = body.match(/^([+-]?(?:\d+\.?\d*|\.\d+))<\s*(-?[+-]?(?:\d+\.?\d*|\.\d+))$/);
  if (polar !== null) {
    const dist = parseFinite(polar[1] ?? "");
    let angleDeg = parseFinite((polar[2] ?? "").replace("+", ""));
    if (dist !== null && angleDeg !== null) {
      const rad = (angleDeg * Math.PI) / 180;
      if (relative) {
        // Relative polar needs the base — carried as an unresolved marker.
        return { kind: "text", text: s };
      }
      return {
        kind: "point",
        point: [dist * Math.cos(rad), dist * Math.sin(rad)],
        relative: false,
      };
    }
  }

  // Cartesian syntax: "x,y".
  const parts = body.split(",");
  if (parts.length === 2) {
    const x = parseFinite((parts[0] ?? "").trim());
    const y = parseFinite((parts[1] ?? "").trim());
    if (x !== null && y !== null) {
      if (relative) {
        // Relative cartesian needs the base — carried as an unresolved marker.
        return { kind: "text", text: s };
      }
      return { kind: "point", point: [x, y], relative: false };
    }
  }

  // Bare number: distance or direct-distance entry (context decides).
  const n = parseFinite(body);
  if (n !== null) {
    if (relative) return { kind: "distance", distance: Math.abs(n) };
    return { kind: "number", value: n };
  }

  return { kind: "text", text: s };
}

export type TypedPointResolution =
  | { readonly ok: true; readonly point: Vec2; readonly syntax: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a typed string to a world point for a POINT step, given the base
 * point (last collected point or the step's base step) and the current
 * cursor position (needed for direct-distance entry).
 */
export function resolveTypedPoint(
  text: string,
  base: Vec2 | null,
  cursor: Vec2 | null,
): TypedPointResolution {
  const s = text.trim();
  const relative = s.startsWith("@");
  const body = relative ? s.slice(1) : s;

  const polar = body.match(/^([+-]?(?:\d+\.?\d*|\.\d+))<\s*(-?[+-]?(?:\d+\.?\d*|\.\d+))$/);
  if (polar !== null) {
    const dist = parseFinite(polar[1] ?? "");
    const angleDeg = parseFinite((polar[2] ?? "").replace("+", ""));
    if (dist === null || angleDeg === null) {
      return { ok: false, reason: `Cannot parse polar input '${text}'.` };
    }
    if (!relative) {
      const rad = (angleDeg * Math.PI) / 180;
      return { ok: true, point: [dist * Math.cos(rad), dist * Math.sin(rad)], syntax: `polar ${dist}<${angleDeg}°` };
    }
    if (base === null) {
      return { ok: false, reason: "Relative polar input requires a base point — specify the first point first." };
    }
    const rad = (angleDeg * Math.PI) / 180;
    return {
      ok: true,
      point: [base[0] + dist * Math.cos(rad), base[1] + dist * Math.sin(rad)],
      syntax: `relative polar @${dist}<${angleDeg}°`,
    };
  }

  const parts = body.split(",");
  if (parts.length === 2) {
    const x = parseFinite((parts[0] ?? "").trim());
    const y = parseFinite((parts[1] ?? "").trim());
    if (x === null || y === null) {
      return { ok: false, reason: `Cannot parse coordinate '${text}' — use 'x,y' or '@dx,dy'.` };
    }
    if (!relative) return { ok: true, point: [x, y], syntax: `absolute ${x},${y}` };
    if (base === null) {
      return { ok: false, reason: "Relative input requires a base point — specify the first point first." };
    }
    return { ok: true, point: [base[0] + x, base[1] + y], syntax: `relative @${x},${y}` };
  }

  // Direct distance entry: bare number along base→cursor.
  const n = parseFinite(body);
  if (n !== null) {
    if (n < 0) return { ok: false, reason: "Direct distance entry requires a non-negative distance." };
    if (base === null) {
      return { ok: false, reason: "Direct distance entry requires a base point — specify the first point first." };
    }
    if (cursor === null) {
      return { ok: false, reason: "Direct distance entry requires a cursor direction — move the crosshair and re-enter." };
    }
    const dx = cursor[0] - base[0];
    const dy = cursor[1] - base[1];
    const len = Math.hypot(dx, dy);
    if (len <= 1e-12) {
      return { ok: false, reason: "Direct distance entry requires the crosshair to move away from the base point." };
    }
    return {
      ok: true,
      point: [base[0] + (dx / len) * n, base[1] + (dy / len) * n],
      syntax: `direct distance ${n}`,
    };
  }

  return { ok: false, reason: `'${text}' is not a coordinate — use 'x,y', '@dx,dy', 'dist<angle' or a distance.` };
}

/** Resolve a typed string to a positive distance for a DISTANCE step. */
export function resolveTypedDistance(
  text: string,
  base: Vec2 | null,
  cursor: Vec2 | null,
): TypedPointResolution {
  const s = text.trim();
  const n = parseFinite(s);
  if (n !== null) {
    if (n <= 0) return { ok: false, reason: "Distance must be positive." };
    return { ok: true, point: [n, 0], syntax: `distance ${n}` };
  }
  return resolveTypedPoint(text, base, cursor);
}
