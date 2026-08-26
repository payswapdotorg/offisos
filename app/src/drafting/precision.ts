/**
 * Drafting precision policy (COMPAT-CAD-001, Issue #37 precision scope).
 *
 * Declared tolerance rules — there is NO silent approximation anywhere in the
 * drafting core: every geometric predicate classifies with an EXPLICIT
 * tolerance from this table, every published coordinate is the raw IEEE-754
 * double computed by the analytic construction, and tests assert against
 * these declared tolerances (deterministic numerical assertions with declared
 * tolerances are an acceptance criterion).
 *
 * Angle convention: radians, measured CCW from the +X axis, normalized to
 * [0, 2π). Arcs sweep CCW from startAngle to endAngle (endAngle > startAngle
 * after normalization; a full circle is startAngle == endAngle on the `circle`
 * entity, never on `arc`).
 */

/** Absolute tolerance for point-coincidence and on-curve classification. */
export const COINCIDENCE_EPS = 1e-9;

/** Absolute tolerance for parallelism / degeneracy classification of
 *  cross/determinant tests (a fixed absolute epsilon is the declared rule —
 *  drafting coordinates are bounded by the workspace envelope). */
export const PARALLEL_EPS = 1e-12;

/** Parameter-space (t along a curve) tolerance for boundary classification. */
export const PARAM_EPS = 1e-12;

/** Declared tolerance table (published for tests and the App API surface). */
export const DRAFTING_TOLERANCES = {
  coincidence: COINCIDENCE_EPS,
  parallel: PARALLEL_EPS,
  param: PARAM_EPS,
} as const;

export type Vec2 = readonly [number, number];

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate a finite 2D point (LOCK-007: reject, never guess). */
export function assertPoint(p: unknown, what: string): Vec2 {
  if (!Array.isArray(p) || p.length !== 2 || !p.every(isFiniteNumber)) {
    throw new Error(`${what} must be [number, number] with finite values (got ${JSON.stringify(p)})`);
  }
  return [p[0] as number, p[1] as number];
}

/** Validate a finite positive number (LOCK-007). */
export function assertPositiveFinite(v: unknown, what: string): number {
  if (!isFiniteNumber(v) || (v as number) <= 0) {
    throw new Error(`${what} must be a positive finite number (got ${JSON.stringify(v)})`);
  }
  return v as number;
}

/** Validate a finite number (LOCK-007). */
export function assertFinite(v: unknown, what: string): number {
  if (!isFiniteNumber(v)) {
    throw new Error(`${what} must be a finite number (got ${JSON.stringify(v)})`);
  }
  return v as number;
}

const TWO_PI = 2 * Math.PI;

/** Normalize an angle to [0, 2π). Deterministic. */
export function normalizeAngle(a: number): number {
  if (!isFiniteNumber(a)) throw new Error("angle must be finite");
  const wrapped = a % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/** Canonical CCW sweep from start to end angle, in (0, 2π]. When start and
 *  end normalize to the same value the sweep is the FULL circle (2π). */
export function ccwSweep(startAngle: number, endAngle: number): number {
  const a0 = normalizeAngle(startAngle);
  const a1 = normalizeAngle(endAngle);
  const sweep = a1 - a0;
  return sweep <= 0 ? sweep + TWO_PI : sweep;
}

/** Is `angle` within the CCW arc [start, start+sweep]? Tolerance-declared
 *  (both endpoints inclusive). */
export function angleWithinArc(angle: number, startAngle: number, sweep: number): boolean {
  const rel = normalizeAngle(angle - startAngle);
  return rel <= sweep + PARAM_EPS || Math.abs(rel - TWO_PI) <= PARAM_EPS;
}
