/**
 * CAD-PARITY-014 (Issue #107) — the P014 interoperability exchange
 * classification report (D6): `interop.exchangeReport`.
 *
 * The authoritative classification of what exchanges through which carrier,
 * using the ifc/report.ts classification vocabulary (exact / tolerance /
 * lossy / unsupported) — the SAME vocabulary as the IFC reconciliation
 * reports and the P013 docs.exchangeReport (which stays UNCHANGED — the
 * frozen slice record; this is the P014 successor surface). Rows are static
 * evidence of the bounded design decisions; `counts` are the CURRENT
 * document tables (the P013 exchange report discipline).
 *
 * Pure + engine-free (LOCK-018). Deterministic: static rows in fixed order,
 * counts in fixed key order.
 */

import type { IfcFieldClassification } from "../ifc/report.js";

/** The exchange report contract identity. */
export const INTEROP_EXCHANGE_CONTRACT = "offisos-interop-exchange/1";

export interface InteropExchangeEntry {
  readonly concept: string;
  readonly classification: IfcFieldClassification;
  readonly note: string;
}

export interface InteropExchangeCounts {
  readonly elements: number;
  readonly layers: number;
  readonly views: number;
  readonly sheets: number;
  readonly layouts: number;
  readonly titleBlocks: number;
  readonly schedules: number;
  readonly revisions: number;
  readonly publisherSets: number;
  readonly navigatorNodes: number;
}

export interface InteropExchangeReport {
  readonly contract: typeof INTEROP_EXCHANGE_CONTRACT;
  readonly classifications: readonly InteropExchangeEntry[];
  readonly counts: InteropExchangeCounts;
}

/** The P014 exchange classification rows (the committed design evidence). */
export const INTEROP_EXCHANGE_ROWS: readonly InteropExchangeEntry[] = [
  {
    concept: "model-elements",
    classification: "exact",
    note: "Model geometry/material/component semantics exchange through ifc.export with identity-pset reconciliation (COMPAT-IFC-001); coordination primitives are canonical-only and counted as not exported.",
  },
  {
    concept: "documentation-metadata",
    classification: "exact",
    note: "The P013 documentation tables exchange as IfcGroup entities carrying Pset_OffisosIdentity + Pset_OffisosDocs (the D2 carrier); metadata round-trips field-exact through ifc.import.",
  },
  {
    concept: "saved-view-content",
    classification: "tolerance",
    note: "View CONTENT is derived — never exchanged: projections regenerate from the model (projectAllViews) in the target document; the view DEFINITIONS (metadata) exchange exactly, the projected primitives are recomputed (note: derivation, not loss).",
  },
  {
    concept: "sheets",
    classification: "exact",
    note: "Documentation sheets (sh-*) stay OUT of IFC by design (COMPAT-CAD-003 constructs): their carrier is the canonical Sheet IR (docs.exportSheet 'sheet-ir') plus the deterministic pdf/svg writers.",
  },
  {
    concept: "dxf-geometry",
    classification: "tolerance",
    note: "The bounded DXF R2000 ASCII writer/reader (dxf.export/dxf.import) exchanges the 2D drafting geometry within the approved entity boundary; out-of-boundary kinds are skipped and counted (LOCK-007), colors cross the bounded ACI palette (lossy unless palette-exact).",
  },
  {
    concept: "dwg",
    classification: "unsupported",
    note: "The proprietary DWG binary is an explicit typed decline (dwg_unsupported) — reverse engineering it is a work-item non-goal; DXF is the open interchange path.",
  },
  {
    concept: "bcf-references/viewpoints",
    classification: "tolerance",
    note: "BCF topics exchange selection references (IfcGuids resolving back to canonical ids) and camera viewpoints (position/direction/up, perspective or orthogonal with view-to-world scale) within the declared 1e-6 tolerance; snapshot bitmaps are UNSUPPORTED (typed).",
  },
  {
    concept: "bcf-lineage",
    classification: "exact",
    note: "The topic's source revision (the caller-chosen canonical model state reference) rides as the BCF 3.0 topic document reference (description 'offisos-source-model-revision', url = the revision identity) and parses back exactly.",
  },
  {
    concept: "ids-validation",
    classification: "exact",
    note: "IDS validation runs through the pinned IfcTester toolchain (ifc.idsValidate) with per-entity results bound to canonical provenance — structured, deterministic results.",
  },
  {
    concept: "archival-formats",
    classification: "exact",
    note: "The archival registry (interop.archivalList) classifies every carrier's legal status: open standards (IFC/PDF/SVG/BCF), the published DXF interchange spec, the open native JSON save — and the proprietary DWG decline.",
  },
];

/** Build the interop exchange report for the current document counts. */
export function buildInteropExchangeReport(counts: InteropExchangeCounts): InteropExchangeReport {
  return {
    contract: INTEROP_EXCHANGE_CONTRACT,
    classifications: INTEROP_EXCHANGE_ROWS,
    counts,
  };
}
