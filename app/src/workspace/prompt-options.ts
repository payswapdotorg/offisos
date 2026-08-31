/**
 * CAD-PARITY-013 (Issue #104) — the prompt option-value helpers, extracted
 * from prompt-engine.ts into a CYCLE-FREE module.
 *
 * Why: command registry modules (commands-*.ts) consume these helpers in
 * their builders, and prompt-engine.ts itself imports the registry
 * (commandById/resolveCommand) — so a registry module importing the helpers
 * from prompt-engine.ts creates a module-evaluation cycle whose TDZ breaks
 * any entry point that imports the registry module FIRST (e.g. a test
 * importing DEFAULT_SCHEDULE_COLUMNS from commands-documentation.js). The
 * helpers are pure functions over the collected PromptValue map (no engine
 * dependency), so they live here; prompt-engine.ts re-exports them so every
 * existing importer keeps working unchanged (the `ln` alias pattern).
 *
 * The `opt:<step>:<keyword>` storage-key convention is pinned by BOTH the
 * prompt engine's option-capture logic and these readers — ONE definition
 * (this module) keeps them in lockstep.
 */

import type { PromptValue } from "./types.js";

/** Storage key for a collected option value. */
export function optionValueKey(stepId: string, keyword: string): string {
  return `opt:${stepId}:${keyword}`;
}

/** Read a collected option value (null when the option was never used). */
export function optionValue(
  values: Readonly<Record<string, PromptValue>>,
  stepId: string,
  keyword: string,
): PromptValue | null {
  return values[optionValueKey(stepId, keyword)] ?? null;
}
