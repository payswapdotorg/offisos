/**
 * CAD-PARITY-018 (Issue #118) — the typed failure of the
 * specialized-toolsets core (the AutomationError precedent, unchanged
 * shape). Thrown by the pure validators/builders/derivations; mapped
 * typed at the App API boundary (contract.ts) — never a generic error.
 */

export class ToolsetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The typed-failure constructor helper (codes documented in
 *  contracts/toolsets.ts). */
export function toolsetErr(code: string, message: string): ToolsetError {
  return new ToolsetError(code, message);
}
