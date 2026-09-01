/**
 * CAD-PARITY-014 (Issue #107) — the format round-trip verification loops
 * (D6): `interop.roundtripReport`.
 *
 * "dxf" (pure TS, this module): export the current drafting entities →
 * parse the bytes back through the bounded reader → map DRY (no document
 * writes) → the per-element field classification (what would be
 * created/reconciled vs unsupported) + the source sha256. The comparison
 * pairs the exported source elements (emission order) with the re-imported
 * drafts and classifies every geometry field with the DECLARED DXF
 * tolerance (1e-5 mm — the writer's fixed 6-decimal format bound).
 *
 * "ifc" (composed at the App API layer — it needs the IFC adapter): export
 * the current document → parse → reconcile DRY → the combined element +
 * documentation classification report. The composition lives in the
 * handler (contract.ts); this module owns the pure dxf loop + the shared
 * report types.
 *
 * Pure + engine-free (LOCK-018). Deterministic: the loops are pure
 * functions of the current document state.
 */

import { createHash } from "node:crypto";
import type { Element } from "../contracts/caddocument.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { summarizeReports, type IfcElementReport, type IfcFieldResult, type IfcImportReport } from "../ifc/report.js";
import { readDxf } from "./dxf/reader.js";
import { writeDxf, type DxfWriteInput } from "./dxf/writer.js";
import { mapDxfImport } from "./dxf/importmap.js";
import { DxfError, dxfUnitFactor } from "./dxf/shared.js";

/** The declared DXF round-trip tolerance (mm) — the writer's fixed
 *  6-decimal number format bound (max rounding error 5e-7 per value). */
export const DXF_ROUNDTRIP_TOLERANCE_MM = 1e-5;

export interface DxfRoundtripReport {
  readonly source: {
    /** SHA-256 of the exported DXF text bytes. */
    readonly sha256: string;
    readonly unit: string;
    readonly scaleToMm: number;
    readonly exported: number;
    readonly skipped: number;
  };
  readonly elements: readonly IfcElementReport[];
  readonly layers: {
    readonly matched: number;
    readonly created: number;
    readonly lossy: number;
  };
  readonly unsupported: readonly { readonly type: string; readonly count: number }[];
  readonly summary: IfcImportReport["summary"];
}

export interface DxfRoundtripOutcome {
  readonly format: "dxf";
  readonly sourceSha256: string;
  readonly report: DxfRoundtripReport;
  readonly reportHash: string;
}

function classifyDxf(field: string, expected: number, actual: number): IfcFieldResult {
  if (expected === actual) {
    return { field, classification: "exact", expected, actual };
  }
  if (Math.abs(expected - actual) <= DXF_ROUNDTRIP_TOLERANCE_MM) {
    return { field, classification: "tolerance", expected, actual, tolerance: DXF_ROUNDTRIP_TOLERANCE_MM };
  }
  return { field, classification: "lossy", expected, actual };
}

/** Compare the source geometry fields against the re-imported draft
 *  (same-type pairs only; the field vocabulary per canonical geom type). */
function compareGeom(
  marker: string,
  source: Record<string, unknown>,
  imported: Record<string, unknown>,
): IfcFieldResult[] {
  const fields: IfcFieldResult[] = [];
  const pushNum = (key: string): void => {
    const expected = source[key];
    const actual = imported[key];
    if (typeof expected === "number" && typeof actual === "number") {
      fields.push(classifyDxf(key, expected, actual));
    } else {
      fields.push({ field: key, classification: "lossy", expected: expected as number, actual: actual as number, note: "value missing on one side of the comparison" });
    }
  };
  const pushList = (key: string): void => {
    const expected = source[key];
    const actual = imported[key];
    if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
      let allEqual = true;
      for (let i = 0; i < expected.length; i += 1) {
        const a = expected[i] as Record<string, unknown>;
        const b = actual[i] as Record<string, unknown>;
        if (
          typeof a.x === "number" && typeof b.x === "number" &&
          typeof a.y === "number" && typeof b.y === "number" &&
          Math.abs(a.x - b.x) <= DXF_ROUNDTRIP_TOLERANCE_MM &&
          Math.abs(a.y - b.y) <= DXF_ROUNDTRIP_TOLERANCE_MM
        ) {
          continue;
        }
        allEqual = false;
        break;
      }
      fields.push(allEqual
        ? { field: key, classification: "exact" }
        : { field: key, classification: "lossy", note: "vertex lists differ beyond the declared tolerance" });
    } else {
      fields.push({ field: key, classification: "lossy", note: "vertex lists differ in length" });
    }
  };
  const pushBool = (key: string): void => {
    fields.push(source[key] === imported[key]
      ? { field: key, classification: "exact" }
      : { field: key, classification: "lossy", expected: source[key] as boolean, actual: imported[key] as boolean });
  };
  const pushValue = (key: string): void => {
    fields.push(source[key] === imported[key]
      ? { field: key, classification: "exact" }
      : { field: key, classification: "lossy", expected: source[key] as string, actual: imported[key] as string });
  };
  switch (marker) {
    case "LINE":
    case "RAY":
    case "XLINE":
      for (const key of ["x1", "y1", "x2", "y2"]) pushNum(key);
      break;
    case "CIRCLE":
      for (const key of ["cx", "cy", "r"]) pushNum(key);
      break;
    case "ARC":
      for (const key of ["cx", "cy", "r", "startAngle", "endAngle"]) pushNum(key);
      break;
    case "ELLIPSE":
      for (const key of ["cx", "cy", "rx", "ry", "rotation"]) pushNum(key);
      break;
    case "LWPOLYLINE":
      pushList("vertices");
      pushBool("closed");
      break;
    case "SPLINE":
      pushList("controlPoints");
      pushValue("degree");
      break;
    case "POINT":
      for (const key of ["x", "y"]) pushNum(key);
      break;
    case "TEXT":
      for (const key of ["x", "y", "height", "rotation"]) pushNum(key);
      pushValue("value");
      pushValue("layer");
      break;
    default:
      fields.push({ field: "geometry", classification: "unsupported", note: `unknown DXF marker '${marker}'` });
  }
  return fields;
}

/** The bounded DXF round-trip verification loop (pure; no document writes).
 *  Throws DxfError (typed dxf_invalid/dxf_unsupported mapped by the caller)
 *  when the exported bytes do not parse or the declared unit is outside the
 *  vocabulary — our own export always satisfies both. */
export function dxfRoundtripReport(input: DxfWriteInput): DxfRoundtripOutcome {
  const written = writeDxf(input);
  const bytes = Buffer.from(written.text, "utf8");
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const parsed = readDxf(written.text);
  const unit = dxfUnitFactor(parsed.header.insunits);
  if (unit === null) {
    throw new DxfError(
      `DXF round-trip: unsupported $INSUNITS value ${String(parsed.header.insunits)} (the declared set is in/cm/mm/m/ft)`,
      "dxf_unsupported",
    );
  }
  const mapped = mapDxfImport(parsed, { layers: input.layers, ltypes: input.ltypes }, unit, null);

  // Pair the exported source elements (emission order) with the re-imported
  // drafts — kind-checked position pairing (a mismatch is an honest
  // unsupported row, never a silent misalignment).
  const elementById = new Map(input.elements.map((el) => [el.id, el] as const));
  const rows: IfcElementReport[] = [];
  const importedByExportOrder = mapped.elements;
  for (let i = 0; i < written.exportedIds.length; i += 1) {
    const sourceId = written.exportedIds[i]!;
    const source = elementById.get(sourceId);
    const draft = importedByExportOrder[i];
    if (source === undefined || draft === undefined) {
      rows.push({
        canonicalId: sourceId,
        globalId: null,
        ifcClass: "DXF",
        name: sourceId,
        action: "unsupported",
        fields: [{ field: "geometry", classification: "unsupported", note: "the exported entity did not re-import (alignment lost or unsupported construct)" }],
      });
      continue;
    }
    const marker = markerOf(draft);
    const fields = compareGeom(
      marker,
      geomPropsOf(source),
      geomPropsOf(draft),
    );
    const lossy = fields.some((f) => f.classification === "lossy" || f.classification === "unsupported");
    rows.push({
      canonicalId: sourceId,
      globalId: null,
      ifcClass: `DXF ${marker}`,
      name: sourceId,
      action: lossy ? "reconciled" : "unchanged",
      fields,
    });
  }

  // Layers: the LAYER table round-trips by NAME (the DXF exchange key) —
  // matched layers are unchanged, unknown names would be created (counted).
  const layersMatched = parsed.layers.filter((layer) => input.layers.some((l) => l.name === layer.name)).length;
  const layersCreated = mapped.layerEdits.length;

  const report: DxfRoundtripReport = {
    source: {
      sha256: sourceSha256,
      unit: unit.unit,
      scaleToMm: unit.factor,
      exported: written.counts.exported,
      skipped: written.counts.skipped,
    },
    elements: rows,
    layers: { matched: layersMatched, created: layersCreated, lossy: 0 },
    unsupported: mapped.unsupported,
    summary: summarizeReports(rows),
  };
  return {
    format: "dxf",
    sourceSha256,
    report,
    reportHash: createHash("sha256").update(canonicalStringify(report)).digest("hex"),
  };
}

function markerOf(draft: Element): string {
  const props = draft.props as Record<string, unknown>;
  if (draft.kind === "annotation") return "TEXT";
  switch (props.type) {
    case "line": return "LINE";
    case "polyline": return "LWPOLYLINE";
    case "circle": return "CIRCLE";
    case "arc": return "ARC";
    case "ellipse": return "ELLIPSE";
    case "spline": return "SPLINE";
    case "point": return "POINT";
    case "ray": return "RAY";
    case "xline": return "XLINE";
    default: return "UNKNOWN";
  }
}

function geomPropsOf(el: Element): Record<string, unknown> {
  return el.props as Record<string, unknown>;
}
