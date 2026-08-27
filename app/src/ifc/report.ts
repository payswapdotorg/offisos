/**
 * IFC reconciliation report types (COMPAT-IFC-001 / Issue #47).
 *
 * The explicit loss/unsupported semantics the issue demands: every imported
 * element is classified per FIELD — exact preservation, preservation within
 * a declared tolerance, LOSSY (the value changed through the round trip),
 * or UNSUPPORTED (the field is not representable in the source) — plus the
 * element-level action (created / reconciled / unchanged / unsupported).
 * Nothing is silently approximated: the only permitted fallbacks are
 * caller-declared import options, recorded in the report as declared.
 *
 * The report is a canonical deterministic artifact: canonical JSON
 * (sorted keys) + SHA-256 content hash, byte-identical across hosts.
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "../caddocument/serialization.js";

/** Field-level preservation classification. */
export type IfcFieldClassification = "exact" | "tolerance" | "lossy" | "unsupported";

/** Declared numeric tolerance for round-trip comparisons (canonical mm). */
export const IFC_ROUNDTRIP_TOLERANCE_MM = 1e-3;

export interface IfcFieldResult {
  readonly field: string;
  readonly classification: IfcFieldClassification;
  /** Canonical value (when comparable). */
  readonly expected?: unknown;
  /** Imported value (when comparable). */
  readonly actual?: unknown;
  /** Declared tolerance for tolerance-classified numeric fields (mm). */
  readonly tolerance?: number;
  readonly note?: string;
}

export type IfcElementAction = "created" | "reconciled" | "unchanged" | "unsupported";

export interface IfcElementReport {
  /** Canonical element id (null for unsupported elements). */
  readonly canonicalId: string | null;
  /** Source IfcGuid (provenance; null when absent). */
  readonly globalId: string | null;
  readonly ifcClass: string;
  readonly name: string;
  readonly action: IfcElementAction;
  readonly fields: readonly IfcFieldResult[];
}

export interface IfcImportReport {
  readonly source: {
    /** SHA-256 of the IFC file bytes. */
    readonly sha256: string;
    readonly schema: string;
    readonly lengthUnitName: string | null;
    readonly lengthUnitPrefix: string | null;
    /** Declared factor file-length-units → canonical mm. */
    readonly scaleToMm: number;
  };
  readonly elements: readonly IfcElementReport[];
  readonly summary: {
    readonly created: number;
    readonly reconciled: number;
    readonly unchanged: number;
    readonly unsupported: number;
    readonly exact: number;
    readonly tolerance: number;
    readonly lossy: number;
    readonly unsupportedFields: number;
  };
  /** Caller-declared fallbacks actually applied (recorded, never silent). */
  readonly declaredFallbacks: readonly string[];
}

/** Canonical JSON + SHA-256 content hash of a report (determinism artifact). */
export function ifcReportHash(report: IfcImportReport): string {
  return createHash("sha256").update(canonicalStringify(report)).digest("hex");
}

/** Build a field result (exact). Undefined expected/actual are OMITTED —
 *  canonical JSON has no undefined (LOCK-007). */
export function exactField(field: string, expected?: unknown, actual?: unknown): IfcFieldResult {
  const out: Record<string, unknown> = { field, classification: "exact" };
  if (expected !== undefined) out.expected = expected;
  if (actual !== undefined) out.actual = actual;
  return out as unknown as IfcFieldResult;
}

/** Build a field result (tolerance within the declared mm bound). */
export function toleranceField(field: string, expected: number, actual: number): IfcFieldResult {
  return { field, classification: "tolerance", expected, actual, tolerance: IFC_ROUNDTRIP_TOLERANCE_MM };
}

/** Classify a numeric comparison (mm domain). NaN operands classify lossy
 *  with a note (never serialized as NaN — canonical JSON discipline). */
export function classifyNumber(field: string, expected: number, actual: number): IfcFieldResult {
  if (Number.isFinite(expected) && Number.isFinite(actual)) {
    if (expected === actual) return exactField(field, expected, actual);
    if (Math.abs(expected - actual) <= IFC_ROUNDTRIP_TOLERANCE_MM) {
      return toleranceField(field, expected, actual);
    }
    return { field, classification: "lossy", expected, actual };
  }
  return { field, classification: "lossy", note: "value missing on one side of the comparison" };
}

/** Classify a general value comparison. */
export function classifyValue(field: string, expected: unknown, actual: unknown): IfcFieldResult {
  if (expected === actual) return exactField(field, expected, actual);
  return { field, classification: "lossy", expected, actual };
}

/** Classify a field the source could not supply. */
export function unsupportedField(field: string, note: string): IfcFieldResult {
  return { field, classification: "unsupported", note };
}

/** Summarize element reports. */
export function summarizeReports(elements: readonly IfcElementReport[]): IfcImportReport["summary"] {
  let created = 0;
  let reconciled = 0;
  let unchanged = 0;
  let unsupported = 0;
  let exact = 0;
  let tolerance = 0;
  let lossy = 0;
  let unsupportedFields = 0;
  for (const el of elements) {
    switch (el.action) {
      case "created": created++; break;
      case "reconciled": reconciled++; break;
      case "unchanged": unchanged++; break;
      case "unsupported": unsupported++; break;
    }
    for (const f of el.fields) {
      switch (f.classification) {
        case "exact": exact++; break;
        case "tolerance": tolerance++; break;
        case "lossy": lossy++; break;
        case "unsupported": unsupportedFields++; break;
      }
    }
  }
  return { created, reconciled, unchanged, unsupported, exact, tolerance, lossy, unsupportedFields };
}
