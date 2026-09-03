/**
 * CAD-PARITY-018 (Issue #118) — the bounded specialized-toolsets core:
 * the versioned capability registry (API-001), the typed architecture
 * composition builders over the verified BIM primitives, the bounded MEP
 * routing semantics (route validation + clash/clearance diagnostics +
 * in-record connections), the bounded mechanical equipment layout
 * (ports, arrays) and the canonical raster/underlay reference semantics
 * (status derivation + the typed non-authoritative trace) (additive,
 * engine-free, Architecture v1.1 FROZEN).
 *
 * Governing boundaries honored here (LOCK-003/018/019, the P015/P017
 * precedents):
 *  - This module family is pure TypeScript: no engine imports, no host
 *    imports, no environment reads, no wall-clock, no random. Every
 *    derivation is a pure function of the canonical records.
 *  - The CADDocument stays the single canonical system of record. The
 *    MEP/mechanical/raster records are DOCUMENT-OWNED rows of the
 *    specialized table (`tls-NNNNNN`, monotonic, never reused, checkpoint
 *    in the model history); every mutation flows through
 *    doc.execute(edit) — ONE atomic revision per mutating command.
 *  - Architecture composition REUSES the verified BIM primitives: the
 *    builders emit EXACTLY the entity batches the existing
 *    bim.createElements path validates and applies — no parallel element
 *    semantics, no fabricated geometry (the unsupported sub-cases return
 *    typed declines, never a guess).
 *  - The raster trace is NON-AUTHORITATIVE by construction
 *    (authoritative:false + the commit notice): canonical geometry only
 *    exists after rasterCommitTrace creates real elements through the
 *    existing element-creation edit path.
 *
 * Determinism: fixed formulas, deterministic ordering, exact distances
 * and typed failure codes — repeated execution over identical canonical
 * inputs yields byte-identical declared outputs (the P016/P017
 * reproducibility discipline, unchanged).
 */

import type { CommandName, QueryName } from "../contracts/app-api.js";
import type { ToolsetCapabilityView } from "../contracts/toolsets.js";

export { ToolsetError, toolsetErr } from "./errors.js";
export { TOOLSETS_API_VERSION } from "../contracts/toolsets.js";

// ---------------------------------------------------------------------------
// The capability registry (API-001 — the versioned public
// specialized-toolsets surface). The closed list of governed App API
// requests the toolsets add. Anything outside the list is the App API's
// own typed unknown-command/unknown-query decline — never a fabricated
// semantic.
// ---------------------------------------------------------------------------

interface ToolsetCapabilityDef {
  readonly name: CommandName | QueryName;
  readonly kind: "command" | "query";
  readonly toolset: "arch" | "mep" | "mechanical" | "raster";
  readonly summary: string;
}

export const TOOLSET_CAPABILITIES: readonly ToolsetCapabilityDef[] = [
  // --- architecture (composition over the verified BIM primitives) ---
  { name: "toolset.archWallRun", kind: "command", toolset: "arch", summary: "Compose a multi-segment wall run from a polyline (one atomic element batch, deterministic per-segment names)." },
  { name: "toolset.archHostedOpening", kind: "command", toolset: "arch", summary: "Place a hosted door/window opening into an existing wall (the P011 opening host binding)." },
  { name: "toolset.archRoof", kind: "command", toolset: "arch", summary: "Place a parametric gable roof over an axis-aligned footprint." },
  { name: "toolset.archStairRun", kind: "command", toolset: "arch", summary: "Place a single-flight stair with optional deterministic side railings." },
  { name: "toolset.archSpaceGrid", kind: "command", toolset: "arch", summary: "Compose a rectangular space grid with deterministic prefix-<col>-<row> names." },
  { name: "toolset.archDimChain", kind: "command", toolset: "arch", summary: "Compose a linear-dimension chain over picked points (aligned drafting dimensions)." },
  { name: "toolset.archComponentArray", kind: "command", toolset: "arch", summary: "Compose a rectangular component-instance array at deterministic offsets." },
  // --- MEP (bounded routing, validation, diagnostics) ---
  { name: "toolset.mepAddRun", kind: "command", toolset: "mep", summary: "Add one bounded MEP run record (duct/pipe/conduit; tls- identity minted by the document)." },
  { name: "toolset.mepSetRun", kind: "command", toolset: "mep", summary: "Replace one MEP run record (full-record restore semantics)." },
  { name: "toolset.mepRemoveRun", kind: "command", toolset: "mep", summary: "Remove one MEP run record." },
  { name: "toolset.mepConnect", kind: "command", toolset: "mep", summary: "Connect one run end to an equipment port, another run end or a free endpoint (domain-neutral, typed mismatches)." },
  { name: "toolset.mepValidateRoute", kind: "query", toolset: "mep", summary: "Derive the deterministic route-validation violations of one MEP run." },
  { name: "toolset.mepClashReport", kind: "query", toolset: "mep", summary: "Derive the deterministic clash/clearance diagnostics of MEP runs against BIM wall/slab bodies." },
  // --- mechanical (bounded equipment layout) ---
  { name: "toolset.mechAddEquipment", kind: "command", toolset: "mechanical", summary: "Add one bounded mechanical equipment record with ordinal ports (tls- identity)." },
  { name: "toolset.mechSetEquipment", kind: "command", toolset: "mechanical", summary: "Replace one mechanical equipment record (full-record restore semantics)." },
  { name: "toolset.mechRemoveEquipment", kind: "command", toolset: "mechanical", summary: "Remove one mechanical equipment record." },
  { name: "toolset.mechArray", kind: "command", toolset: "mechanical", summary: "Compose a rectangular equipment array with port positions offset deterministically." },
  // --- raster/underlay (canonical references + typed trace) ---
  { name: "toolset.rasterAddSource", kind: "command", toolset: "raster", summary: "Register one raster underlay source record (identity + digest + optional bounded lineWork)." },
  { name: "toolset.rasterAttach", kind: "command", toolset: "raster", summary: "Attach one raster reference to a registered source (transform/clipping/visibility)." },
  { name: "toolset.rasterSetReference", kind: "command", toolset: "raster", summary: "Replace one raster reference record (full-record restore semantics)." },
  { name: "toolset.rasterRemoveReference", kind: "command", toolset: "raster", summary: "Remove one raster reference record." },
  { name: "toolset.rasterCommitTrace", kind: "command", toolset: "raster", summary: "Commit traced vectors as canonical line elements through the existing element-creation path (lineage in props)." },
  { name: "toolset.rasterStatus", kind: "query", toolset: "raster", summary: "Derive the fresh raster reference status table (ok/stale/missing, typed reasons)." },
  { name: "toolset.rasterTrace", kind: "query", toolset: "raster", summary: "Derive the non-authoritative trace vectors of one reference through its transform (with clipping)." },
  // --- discovery ---
  { name: "toolset.capabilities", kind: "query", toolset: "arch", summary: "The versioned typed specialized-toolsets capability discovery table." },
  { name: "toolset.listRecords", kind: "query", toolset: "arch", summary: "The specialized-record inventory (id-sorted rows with kind + toolset)." },
];

const TOOLSET_CAPABILITY_INDEX: ReadonlyMap<string, ToolsetCapabilityDef> = new Map(
  TOOLSET_CAPABILITIES.map((c) => [c.name, c]),
);

/** The registry lookup (null when the name is not a toolset capability). */
export function toolsetCapabilityOf(name: string): ToolsetCapabilityDef | null {
  return TOOLSET_CAPABILITY_INDEX.get(name) ?? null;
}

/** The registry view rows (the discovery surface). */
export function toolsetCapabilityViews(): readonly ToolsetCapabilityView[] {
  return TOOLSET_CAPABILITIES.map((c) => ({
    name: c.name,
    kind: c.kind,
    toolset: c.toolset,
    summary: c.summary,
  }));
}

export {
  validateMepRunData,
  validateMechEquipmentData,
  validateRasterSourceData,
  validateRasterReferenceData,
  normalizeToolsetRecord,
  validateSpecializedRecord,
  deriveSpecializedSequence,
} from "./records.js";
export {
  buildWallRun,
  buildHostedOpening,
  buildRoof,
  buildStairRun,
  buildSpaceGrid,
  buildComponentArray,
  buildDimensionChain,
} from "./arch.js";
export { validateRoute, clashReport, connectRun } from "./mep.js";
export { buildEquipmentArray } from "./mechanical.js";
export { referenceStatus, trace, selectTraceVectors, mapPoint } from "./raster.js";
