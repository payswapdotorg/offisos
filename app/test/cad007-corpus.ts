/**
 * RESEARCH-CAD-007 shared representative geometry corpus (Issue #32).
 *
 * The SAME representative workflow every engine must satisfy: one element per
 * descriptor vocabulary node (box / cylinder / transform / fuse / cut), each
 * with a canonical RFQ category. The corpus lives in the REFERENCE engine's
 * exactness classes so BOTH the OCCT engine and the engine-free reference
 * adapter compute exact analytic results for it (values then agree within
 * the declared tolerances — the CAD-007 cross-engine proposition).
 *
 * Not a .test.ts file, so the CI glob (test/*.test.ts) ignores it.
 */

export interface CorpusElement {
  readonly id: string;
  readonly category: string;
  readonly descriptor: Record<string, unknown>;
}

/** Row-major translation matrix. */
export function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

/** Row-major rotation about Z by θ radians, then translation. */
export function rotationZ(theta: number, tx = 0, ty = 0, tz = 0): number[] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c, -s, 0, tx, s, c, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
}

export const CORPUS: readonly CorpusElement[] = [
  {
    id: "el-column-a",
    category: "concrete",
    descriptor: { shape: "box", width: 0.4, depth: 0.4, height: 3.0 },
  },
  {
    id: "el-slab",
    category: "concrete",
    descriptor: { shape: "box", width: 6, depth: 4, height: 0.2 },
  },
  {
    id: "el-pipe-riser",
    category: "steel",
    descriptor: { shape: "cylinder", radius: 0.05, height: 3, origin: [1, 1, 0], direction: [0, 0, 1] },
  },
  {
    id: "el-beam-rot",
    category: "steel",
    descriptor: {
      shape: "transform",
      matrix: rotationZ(Math.PI / 2, 5, 5, 0),
      target: { shape: "box", width: 2, depth: 0.1, height: 0.2 },
    },
  },
  {
    // two disjoint pads — fuse in the disjoint exactness class
    id: "el-footing",
    category: "concrete",
    descriptor: {
      shape: "fuse",
      a: { shape: "box", width: 1, depth: 1, height: 0.3 },
      b: { shape: "transform", matrix: translation(2, 0, 0), target: { shape: "box", width: 1, depth: 1, height: 0.3 } },
    },
  },
  {
    // slab with a through-opening — cut in the axis-aligned cell exactness class
    id: "el-slab-opening",
    category: "concrete",
    descriptor: {
      shape: "cut",
      a: { shape: "box", width: 6, depth: 4, height: 0.2 },
      b: { shape: "transform", matrix: translation(1, 1, -0.05), target: { shape: "box", width: 1, depth: 1, height: 0.3 } },
    },
  },
];

/** Exact analytic volumes (independent hand calculation for assertions). */
export const EXPECTED_VOLUMES: Readonly<Record<string, number>> = {
  "el-column-a": 0.4 * 0.4 * 3.0, // 0.48
  "el-slab": 6 * 4 * 0.2, // 4.8
  "el-pipe-riser": Math.PI * 0.05 * 0.05 * 3, // π·0.0025·3
  "el-beam-rot": 2 * 0.1 * 0.2, // 0.04 (rigid transform preserves volume)
  "el-footing": 2 * (1 * 1 * 0.3), // 0.6 (disjoint fuse)
  "el-slab-opening": 6 * 4 * 0.2 - 1 * 1 * 0.2, // 4.6 (through-opening subtracts exactly)
};

/** The model change for the cascade workflow: column grows 3.0 → 3.5 m. */
export function resizedColumnDescriptor(): Record<string, unknown> {
  return { shape: "box", width: 0.4, depth: 0.4, height: 3.5 };
}

/** Volume delta of the model change (exact): 0.4·0.4·0.5 = 0.08. */
export const EXPECTED_COLUMN_DELTA = 0.4 * 0.4 * 0.5;

/** The DEMO rate-table values the cascade asserts against (mirrors
 *  src/impact/cascade.ts DEMO_RATE_TABLE — kept in sync by the cascade test
 *  asserting against the exported table itself). */
export const DEMO_RATES = {
  concrete: 420,
  steel: 1150,
  uncategorized: 300,
} as const;
