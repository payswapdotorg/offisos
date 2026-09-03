/**
 * IFC core barrel (COMPAT-IFC-001 / Issue #47).
 *
 * The pure, engine-free IFC/openBIM core (LOCK-018-scanned): deterministic
 * IfcGuid identity derivation, canonical export mapping, import + semantic
 * reconciliation with explicit loss/unsupported reporting, and the
 * IDS/BCF provenance binding helpers. The IfcOpenShell toolchain stays
 * behind the adapter/worker boundary (src/adapters/ifc).
 */

export { ifcGuidFor, isIfcGuid, IFC_GUID_SALT } from "./identity.js";
export { buildIfcExportRequest, type IfcExportOutcome } from "./exportmap.js";
export {
  reconcileIfcImport,
  ifcLengthScale,
  importEntitiesToElements,
  type IfcImportOptions,
  type IfcImportOutcome,
  type IfcImportRecord,
} from "./importmap.js";
// CAD-PARITY-014 (additive, Issue #107): the documentation exchange carrier
// (the IfcGroup mapping + reconciliation).
export {
  buildIfcDocumentationExport,
  ifcDocsReportHash,
  reconcileIfcDocumentation,
  type IfcDocumentationExport,
  type IfcDocumentationTables,
  type IfcDocsMint,
  type IfcDocsRecordDrafts,
  type IfcDocsReconcileOutcome,
  type IfcDocsReport,
  type IfcDocsTargetState,
} from "./docmap.js";
// CAD-PARITY-018 (additive, Issue #118 criterion 14): the specialized
// toolsets exchange carrier (the same IfcGroup discipline, zero worker
// change — the adapter maps these groups onto the generic group carrier).
export {
  buildIfcToolsetsExport,
  encodeToolsetRecord,
  ifcToolsetsReportHash,
  isToolsetsDomainKind,
  reconcileIfcToolsets,
  TOOLSETS_IFC_KINDS,
  TOOLSETS_IFC_KIND_MEP_RUN,
  TOOLSETS_IFC_KIND_MECH_EQUIPMENT,
  TOOLSETS_IFC_KIND_RASTER_SOURCE,
  TOOLSETS_IFC_KIND_RASTER_REFERENCE,
  type IfcToolsetsExport,
  type IfcToolsetsMint,
  type IfcToolsetsReconcileOutcome,
} from "./toolsetmap.js";
export type {
  IfcToolsetRecord,
  IfcToolsetsInput,
  IfcParsedToolsetRecord,
  IfcParsedToolsets,
} from "../contracts/ifc.js";
export {
  ifcReportHash,
  IFC_ROUNDTRIP_TOLERANCE_MM,
  type IfcFieldClassification,
  type IfcFieldResult,
  type IfcElementAction,
  type IfcElementReport,
  type IfcImportReport,
} from "./report.js";
