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
export {
  ifcReportHash,
  IFC_ROUNDTRIP_TOLERANCE_MM,
  type IfcFieldClassification,
  type IfcFieldResult,
  type IfcElementAction,
  type IfcElementReport,
  type IfcImportReport,
} from "./report.js";
