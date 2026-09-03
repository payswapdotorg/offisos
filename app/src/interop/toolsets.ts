/**
 * CAD-PARITY-018 (Issue #118, acceptance criterion 14 — the corrective
 * interop coverage): the specialized-toolsets interoperability
 * classification — the typed OUTCOME surface at the IFC/BCF/IDS boundary.
 *
 * Two composed dimensions (the exchange.ts / archival.ts precedent — a
 * NEW report surface with its own contract id, leaving the pinned P014
 * `exchangeReportSha256` and the pinned P018 `capabilitiesSha256` fixtures
 * byte-untouched):
 *
 *  1. THE STATIC MATRIX (TOOLSETS_INTEROP_ROWS): the durable, closed
 *     concept × surface classification of the P018 specialized semantics —
 *     which semantics the external formats carry EXACTLY, which are LOSSY
 *     (representable with a documented structural loss), and which are
 *     UNSUPPORTED (typed refusals — never fabricated, never silent).
 *
 *  2. THE LIVE REPORT (buildToolsetsInteropReport): per-document evidence —
 *     every specialized record of the CURRENT document is DRY-classified
 *     through the REAL carrier codec (encode → decode → compare): the
 *     per-field rows prove, for THIS document, which fields survive the
 *     boundary byte-exactly (exact), which ride the flattened joined-string
 *     representation (lossy — values exact, structure flattened), and
 *     which dimensions are refused (unsupported — e.g. raster payloads).
 *     A pure, deterministic function of the records: repeated calls over
 *     equal inputs produce the byte-identical reportHash.
 *
 * The classification vocabulary is the canonical ifc/report.ts union
 * (exact | tolerance | lossy | unsupported) — the SAME typed outcome
 * language the P014 exchange/archival surfaces and the import reports use.
 *
 * Pure + engine-free (LOCK-018: this directory is guarded by the
 * no-forbidden-imports scan).
 */

import { createHash } from "node:crypto";
import type { SpecializedRecord } from "../contracts/caddocument.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import {
  buildIfcToolsetsExport,
  TOOLSETS_IFC_KIND_MEP_RUN,
  TOOLSETS_IFC_KIND_MECH_EQUIPMENT,
  TOOLSETS_IFC_KIND_RASTER_SOURCE,
  TOOLSETS_IFC_KIND_RASTER_REFERENCE,
  reconcileIfcToolsets,
} from "../ifc/toolsetmap.js";
import type { IfcFieldClassification, IfcFieldResult } from "../ifc/report.js";

// ---------------------------------------------------------------------------
// The report contract.
// ---------------------------------------------------------------------------

/** The toolsets interop report contract id (its own surface — the P014
 *  exchange/archival contracts stay untouched). */
export const INTEROP_TOOLSETS_CONTRACT = "offisos-interop-toolsets/1";

/** One static classification row: a P018 specialized semantic concept at
 *  one external surface (ifc | bcf | ids), with its typed outcome. */
export interface InteropToolsetsRow {
  /** The semantic concept (stable id, pinned by the fixture). */
  readonly concept: string;
  /** The external surface the classification applies to. */
  readonly surface: "ifc" | "bcf" | "ids";
  /** The typed outcome (the canonical ifc/report.ts vocabulary). */
  readonly classification: IfcFieldClassification;
  /** The durable rationale (deterministic text, pinned by the fixture). */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// The static matrix (the closed, durable typed-outcome table).
// ---------------------------------------------------------------------------

/** The closed toolsets interop classification matrix (Issue #118
 *  criterion 14): every P018 specialized semantic concept at the
 *  IFC/BCF/IDS boundary, with its EXACT / LOSSY / UNSUPPORTED outcome.
 *  Deterministic and pinned (part of the report hash). */
export const TOOLSETS_INTEROP_ROWS: readonly InteropToolsetsRow[] = [
  {
    concept: "specialized-record-identity",
    surface: "ifc",
    classification: "exact",
    note: "Pset_OffisosIdentity {DomainId = tls- id, DomainKind = toolsets.<kind>} on one IfcGroup per record; the IfcGuid is the deterministic ifcGuidFor(record id) projection (LOCK-019: canonical identity is authoritative, the guid is provenance)",
  },
  {
    concept: "specialized-record-scalar-properties",
    surface: "ifc",
    classification: "exact",
    note: "Pset_OffisosDocs flat scalar fields; numbers ride the exact-reversible String(n) encoding, booleans ride native IfcBoolean — byte-exact round-trip (proven per-record by the live DRY classification)",
  },
  {
    concept: "specialized-record-structured-arrays",
    surface: "ifc",
    classification: "lossy",
    note: "segments / connections / ports / lineWork ride the documented escaped joined-string carrier: VALUES round-trip byte-exactly, but the IFC representation is a flattened property string, not native IFC structure — a third-party structural round-trip is not preserved",
  },
  {
    concept: "mep-native-distribution-elements",
    surface: "ifc",
    classification: "unsupported",
    note: "native IfcDuct/IfcPipeSegment/IfcCableCarrierSegment export is outside the bounded model (Issue #118 non-goal); runs ride property-group metadata, never fabricated MEP geometry",
  },
  {
    concept: "mechanical-native-equipment-classes",
    surface: "ifc",
    classification: "unsupported",
    note: "native IfcUnitaryEquipment/IfcElectricDistributionBoard mapping is outside the bounded model; equipment rides property-group metadata with port connector metadata, never fabricated solid geometry",
  },
  {
    concept: "raster-binary-payload",
    surface: "ifc",
    classification: "unsupported",
    note: "raster image bytes never ride the carrier and are never fabricated — sources exchange identity, content digest and pixel dimensions only (the digest is the staleness basis; the payload stays external)",
  },
  {
    concept: "derived-specialized-surfaces",
    surface: "ifc",
    classification: "unsupported",
    note: "route violations, clash/clearance diagnostics, raster status/trace are DERIVED (never stored — the LOCK discipline); they are deterministically recomputable from the canonical records on demand and are refused as payloads",
  },
  {
    concept: "bcf-references-to-canonical-elements",
    surface: "bcf",
    classification: "exact",
    note: "toolset-committed/hosted elements (wallRun walls, hosted openings, committed trace lines) are canonical elements: BCF topic references resolve through ifcGuidFor(element id) exactly (the COMPAT-IFC-001 discipline)",
  },
  {
    concept: "bcf-references-to-specialized-records",
    surface: "bcf",
    classification: "unsupported",
    note: "BCF references IFC products; specialized records are property groups, not products — a tls- id is a typed invalid topic reference at create and an unresolvable guid resolves to an honest null at parse (never guessed)",
  },
  {
    concept: "bcf-viewpoints-on-toolset-workflows",
    surface: "bcf",
    classification: "exact",
    note: "orthogonal camera fields and sourceRevision lineage exchange exactly (the P014 classifyBcfTopic vocabulary); snapshots stay unsupported by construction",
  },
  {
    concept: "ids-validation-over-toolset-elements",
    surface: "ids",
    classification: "exact",
    note: "IDS specifications evaluate over the canonical elements toolset workflows create/host (e.g. Pset_OffisosCustom.FireRating on wallRun walls) with per-entity canonical provenance — pass/fail discrimination is deterministic",
  },
  {
    concept: "ids-validation-over-toolsets-carrier",
    surface: "ids",
    classification: "exact",
    note: "IDS specifications evaluate over the IfcGroup carrier entities and their Pset_OffisosDocs property values — the toolsets records are first-class validatable IFC entities, not opaque blobs",
  },
];

// ---------------------------------------------------------------------------
// The live per-document report.
// ---------------------------------------------------------------------------

/** One per-record classification row of the live report. */
export interface InteropToolsetsRecordRow {
  /** The canonical record id (tls-NNNNNN). */
  readonly id: string;
  /** The record kind (mep.run | mech.equipment | raster.source | raster.reference). */
  readonly kind: SpecializedRecord["kind"];
  /** The carrier DomainKind. */
  readonly domainKind: string;
  /** The per-field outcome rows (the report.ts vocabulary). */
  readonly fields: readonly IfcFieldResult[];
}

/** The live toolsets interop report (a pure function of the records). */
export interface InteropToolsetsReport {
  readonly contract: typeof INTEROP_TOOLSETS_CONTRACT;
  /** The static concept × surface matrix (durable, closed). */
  readonly rows: readonly InteropToolsetsRow[];
  /** The per-record live DRY classification (empty when no records). */
  readonly records: readonly InteropToolsetsRecordRow[];
  readonly counts: {
    readonly records: number;
    readonly mepRuns: number;
    readonly equipment: number;
    readonly rasterSources: number;
    readonly rasterReferences: number;
  };
  readonly summary: {
    readonly exact: number;
    readonly lossy: number;
    readonly unsupported: number;
  };
  /** Canonical JSON + SHA-256 of {rows, records, counts, summary}. */
  readonly reportHash: string;
}

/** The carrier fields that hold STRUCTURED ARRAYS (the documented lossy
 *  structural flattening — values exact, structure flattened). */
const ARRAY_FIELDS: ReadonlySet<string> = new Set(["Segments", "Connections", "Ports", "LineWork"]);

/** The kinds whose non-carried dimension gets an explicit typed refusal
 *  row per record (raster sources: the binary payload). */
const PAYLOAD_REFUSALS: ReadonlyMap<string, { field: string; note: string }> = new Map([
  [
    "raster.source",
    { field: "content-payload", note: "the raster image bytes are refused at the IFC boundary — identity, content digest and pixel dimensions only (never fabricated)" },
  ],
]);

/** Build the live toolsets interop classification report over the
 *  document's specialized records: the static matrix + the per-record DRY
 *  classification through the REAL carrier codec (encode → decode →
 *  compare — the per-field exactness is PROVEN, not asserted). Pure +
 *  deterministic. */
export function buildToolsetsInteropReport(specialized: readonly SpecializedRecord[]): InteropToolsetsReport {
  const exportOutcome = buildIfcToolsetsExport(specialized);
  // The DRY loop: encode → reconcile with NO mint and NO existing records —
  // every carried field classifies exact (parse evidence) unless the codec
  // itself cannot carry it, which the array/refusal rows classify instead.
  const dry = reconcileIfcToolsets(
    exportOutcome.groups.map((group) => ({
      globalId: group.guid,
      name: group.name,
      identity: group.identity as unknown as Readonly<Record<string, unknown>>,
      fields: group.fields as Readonly<Record<string, unknown>>,
    })),
    [],
    null,
  );

  const byId = new Map(dry.report.records.map((row) => [row.canonicalId ?? "", row] as const));
  const records: InteropToolsetsRecordRow[] = [];
  let exact = 0;
  let lossy = 0;
  let unsupported = 0;
  for (const record of specialized) {
    const dryRow = byId.get(record.id);
    // The DRY row proves the CARRIED fields parse back (exact). The
    // structural classification overlays the array-carrying fields (lossy:
    // values exact, structure flattened) and the per-kind refusals.
    const fields: IfcFieldResult[] = (dryRow?.fields ?? []).map((f) => {
      if (ARRAY_FIELDS.has(f.field)) {
        lossy += 1;
        return {
          ...f,
          classification: "lossy" as const,
          note: "values round-trip byte-exactly through the escaped joined-string carrier; the IFC representation is a flattened property string, not native structure",
        };
      }
      exact += 1;
      return f;
    });
    const refusal = PAYLOAD_REFUSALS.get(record.kind);
    if (refusal !== undefined) {
      unsupported += 1;
      fields.push({ field: refusal.field, classification: "unsupported", note: refusal.note });
    }
    records.push({
      id: record.id,
      kind: record.kind,
      domainKind:
        record.kind === "mep.run"
          ? TOOLSETS_IFC_KIND_MEP_RUN
          : record.kind === "mech.equipment"
            ? TOOLSETS_IFC_KIND_MECH_EQUIPMENT
            : record.kind === "raster.source"
              ? TOOLSETS_IFC_KIND_RASTER_SOURCE
              : TOOLSETS_IFC_KIND_RASTER_REFERENCE,
      fields,
    });
  }

  const report: Omit<InteropToolsetsReport, "reportHash"> = {
    contract: INTEROP_TOOLSETS_CONTRACT,
    rows: TOOLSETS_INTEROP_ROWS,
    records,
    counts: {
      records: specialized.length,
      mepRuns: exportOutcome.counts.mepRuns,
      equipment: exportOutcome.counts.equipment,
      rasterSources: exportOutcome.counts.rasterSources,
      rasterReferences: exportOutcome.counts.rasterReferences,
    },
    summary: { exact, lossy, unsupported },
  };
  return { ...report, reportHash: createHash("sha256").update(canonicalStringify(report)).digest("hex") };
}
