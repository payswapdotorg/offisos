/**
 * CAD-PARITY-014 (Issue #107) — the bounded interoperability shared core
 * (module barrel).
 *
 * The P014 exchange surfaces (LOCK-018 — pure, engine-free; this directory
 * is guarded by the no-forbidden-imports scan):
 *
 *  - dxf/          — the bounded DXF R2000 ASCII writer + reader + the
 *                    import mapping (the open interchange path; DWG is the
 *                    explicit typed decline);
 *  - sheet-export  — the Sheet IR → Plot IR bridge onto the EXISTING
 *                    deterministic PDF/SVG plot writers (docs.exportSheet);
 *  - exchange      — the P014 interoperability exchange classification
 *                    report (interop.exchangeReport);
 *  - archival      — the archival format registry with the legal
 *                    classifications (interop.archivalList);
 *  - roundtrip     — the format round-trip verification loops
 *                    (interop.roundtripReport; the pure dxf loop + the
 *                    shared report types — the ifc loop composes at the App
 *                    API layer where the adapter lives);
 *  - bcf           — the BCF topic exchange classification (the camera/
 *                    lineage/snapshot field vocabulary);
 *  - toolsets      — the CAD-PARITY-018 specialized-toolsets interop
 *                    classification (the static typed OUTCOME matrix + the
 *                    live per-record DRY classification — Issue #118
 *                    criterion 14).
 *
 * The IFC-side carrier (the IfcGroup documentation exchange, the BCF
 * viewpoint/lineage contracts) lives in src/ifc + src/contracts/ifc.ts
 * (types only); the IfcOpenShell/bcf-client toolchain stays behind the
 * adapter/worker boundary (src/adapters/ifc).
 */

export {
  DXF_ACADVER,
  DXF_FORMAT,
  DXF_FORMAT_VERSION,
  DXF_INSUNITS_MM,
  DXF_UNIT_FACTORS,
  DXF_ACI_PALETTE,
  dxfFmt,
  dxfUnitFactor,
  hexToAci,
  aciToHex,
  looksLikeDwg,
  DxfError,
  DXF_WRITABLE_ENTITY_KINDS,
  type DxfWritableEntityKind,
  type HexToAciResult,
  type AciToHexResult,
  type DxfAciPaletteEntry,
} from "./dxf/shared.js";
export { writeDxf, type DxfWriteInput, type DxfWriteOutcome } from "./dxf/writer.js";
export {
  readDxf,
  type DxfReadOutcome,
  type DxfParsedEntity,
  type DxfParsedLayer,
  type DxfParsedLtype,
  type DxfEntityCommon,
} from "./dxf/reader.js";
export {
  mapDxfImport,
  type DxfMapExisting,
  type DxfMapMint,
  type DxfImportOutcome,
} from "./dxf/importmap.js";
export { sheetIRToPlotIR } from "./sheet-export.js";
export {
  INTEROP_EXCHANGE_CONTRACT,
  INTEROP_EXCHANGE_ROWS,
  buildInteropExchangeReport,
  type InteropExchangeEntry,
  type InteropExchangeCounts,
  type InteropExchangeReport,
} from "./exchange.js";
export {
  INTEROP_ARCHIVAL_CONTRACT,
  ARCHIVAL_REGISTRY,
  archivalList,
  type ArchivalRow,
  type ArchivalRegistry,
  type ArchivalLegalClassification,
} from "./archival.js";
export {
  dxfRoundtripReport,
  DXF_ROUNDTRIP_TOLERANCE_MM,
  type DxfRoundtripOutcome,
  type DxfRoundtripReport,
} from "./roundtrip.js";
export {
  classifyBcfTopic,
  BCF_CAMERA_TOLERANCE,
} from "./bcf.js";
// CAD-PARITY-018 (additive, Issue #118 criterion 14 — the corrective
// interop coverage): the specialized-toolsets interop classification (the
// static concept × surface matrix + the live per-record DRY classification
// through the REAL carrier codec).
export {
  INTEROP_TOOLSETS_CONTRACT,
  TOOLSETS_INTEROP_ROWS,
  buildToolsetsInteropReport,
  type InteropToolsetsRow,
  type InteropToolsetsRecordRow,
  type InteropToolsetsReport,
} from "./toolsets.js";
