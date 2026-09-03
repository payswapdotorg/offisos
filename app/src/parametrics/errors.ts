/**
 * COMPAT-CAD-004 (Issue #121) — the parametrics core typed failures.
 *
 * The closed failure-code table is documented in contracts/parametrics.ts
 * (the LOCK-007/008 discipline: every out-of-bounds or out-of-vocabulary
 * request is a typed deterministic failure naming the exact limitation —
 * never a silent approximation, never a fabricated semantic).
 */

export class ParametricsError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ParametricsError";
    this.code = code;
  }
}

/** Convenience constructor (the BlockError/ToolsetError convention). */
export function parametricsErr(message: string, code: string): ParametricsError {
  return new ParametricsError(message, code);
}
