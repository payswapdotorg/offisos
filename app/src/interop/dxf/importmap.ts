/**
 * CAD-PARITY-014 (Issue #107) — the bounded DXF import mapping (D5).
 *
 * Maps the parsed bounded DXF (dxf/reader.ts) back into canonical document
 * edits — the ifc/importmap.ts discipline: every created entity is
 * re-validated through the STRICT canonical constructors (propsToGeom for
 * geometry, makeText for `an.text` annotations — LOCK-007: stored file
 * values are never trusted blindly), ids come from the DOCUMENT MINTS (the
 * authority mints; a foreign file never dictates canonical identity), and
 * every unit normalization goes through the declared $INSUNITS factor
 * table (missing/other units are a typed dxf_unsupported decline at the
 * command layer — no guessing).
 *
 * Unsupported DXF constructs (anything outside the bounded entity
 * vocabulary) arrive ALREADY counted per type from the reader and pass
 * through into this outcome — never fabricated.
 *
 * Colors cross the bounded ACI boundary through the documented shared
 * mapping (dxf/shared.ts): non-palette values classify LOSSY in the report
 * rows, never silently approximated.
 *
 * Pure + engine-free (LOCK-018).
 */

import type { DocumentEdit, Element, LayerRecord, LtypeRecord } from "../../contracts/caddocument.js";
import { annotationToProps, makeText } from "../../workspace/annotation/index.js";
import { propsToGeom } from "../../workspace/geometry/types.js";
import { STANDARD_LINEWEIGHTS } from "../../workspace/standards/index.js";
import { aciToHex } from "./shared.js";
import type { DxfReadOutcome } from "./reader.js";
import { exactField, type IfcElementReport, type IfcFieldResult } from "../../ifc/report.js";

export interface DxfMapExisting {
  /** The existing layer table (matched by NAME — the DXF key). */
  readonly layers: readonly LayerRecord[];
  /** The existing user linetype table (matched by name). */
  readonly ltypes: readonly LtypeRecord[];
}

export interface DxfMapMint {
  readonly mintLayerId: () => string;
  readonly mintElementId: () => string;
}

export interface DxfImportOutcome {
  readonly unit: string;
  readonly scaleToMm: number;
  /** addLtype edits for unknown non-builtin linetypes (in file order). */
  readonly ltypeEdits: readonly DocumentEdit[];
  /** addLayer edits for unknown layers (in file order). */
  readonly layerEdits: readonly DocumentEdit[];
  /** addElement-ready element drafts (file order; ids minted, null in the
   *  DRY path when no mint was supplied). */
  readonly elements: readonly Element[];
  /** Layer NAME → canonical layer id (existing or minted). */
  readonly layerIdByName: ReadonlyMap<string, string>;
  /** The import classification rows (one per imported entity). */
  readonly rows: readonly IfcElementReport[];
  /** Unsupported constructs counted per type (passed through from the reader). */
  readonly unsupported: readonly { readonly type: string; readonly count: number }[];
  /** Element drafts + created layers count. */
  readonly created: number;
}

/** Nearest standard lineweight (mm) for a raw DXF 1/100 mm code. */
function nearestStandardLineweight(mm: number): { mm: number; exact: boolean } {
  let best = STANDARD_LINEWEIGHTS[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of STANDARD_LINEWEIGHTS) {
    const dist = Math.abs(candidate - mm);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return { mm: best, exact: bestDist === 0 };
}

/** Map the parsed bounded DXF into canonical document edits + the
 *  classification report. `unit` is the RESOLVED declared unit (the caller
 *  resolves $INSUNITS through the shared factor table and declines typed
 *  before mapping). `mint` absent = the DRY path (round-trip verification):
 *  drafts carry empty ids and nothing is written. */
export function mapDxfImport(
  outcome: DxfReadOutcome,
  existing: DxfMapExisting,
  unit: { readonly unit: string; readonly factor: number },
  mint: DxfMapMint | null,
): DxfImportOutcome {
  const scale = unit.factor;
  const scaleOf = (v: number): number => v * scale;

  // --- linetype table: unknown non-builtin names become user ltype records ----
  const ltypeEdits: DocumentEdit[] = [];
  const knownLtypeNames = new Set<string>(existing.ltypes.map((l) => l.name));
  const importedLtypeNames = new Set<string>();
  for (const ltype of outcome.ltypes) {
    if (ltype.name.length === 0 || ltype.name === "Continuous") continue;
    if (knownLtypeNames.has(ltype.name) || BUILTIN_NAMES.has(ltype.name)) continue;
    if (importedLtypeNames.has(ltype.name)) continue;
    if (ltype.pattern.some((seg) => !Number.isFinite(seg))) continue; // malformed — skipped, never guessed
    importedLtypeNames.add(ltype.name);
    ltypeEdits.push({
      type: "addLtype",
      ltype: { name: ltype.name, description: ltype.description, pattern: [...ltype.pattern] },
    });
  }

  // --- layer table: match by name, unknown → create (document authority) ------
  const layerEdits: DocumentEdit[] = [];
  const layerIdByName = new Map<string, string>();
  for (const layer of existing.layers) layerIdByName.set(layer.name, layer.id);
  for (const parsed of outcome.layers) {
    if (parsed.name.length === 0) continue;
    if (layerIdByName.has(parsed.name)) continue; // matched by name — the DXF exchange key
    const color = aciToHex(parsed.aci);
    const rawLineweightMm = parsed.lineweightCode !== null ? parsed.lineweightCode / 100 : 0.25;
    const lineweight = nearestStandardLineweight(rawLineweightMm);
    const id = mint !== null ? mint.mintLayerId() : null;
    const record: LayerRecord = {
      id: id ?? "",
      name: parsed.name,
      color: color.hex,
      visible: !parsed.off,
      ...(parsed.frozen ? { frozen: true } : {}),
      ...(parsed.locked ? { locked: true } : {}),
      ...(parsed.linetype !== null ? { linetype: parsed.linetype } : {}),
      ...(parsed.lineweightCode !== null ? { lineweight: lineweight.mm } : {}),
    };
    if (id !== null) {
      layerIdByName.set(parsed.name, id);
      layerEdits.push({ type: "addLayer", layer: record });
    }
  }

  // --- entities → canonical element drafts -------------------------------------
  const elements: Element[] = [];
  const rows: IfcElementReport[] = [];
  for (const entity of outcome.entities) {
    const fields: IfcFieldResult[] = [];
    // Layer resolution: the LAYER table is the authority; unknown names map
    // to the canonical default layer "0" (lossy, classified).
    const layerName = entity.layer ?? "0";
    let layerId = layerIdByName.get(layerName);
    if (layerId === undefined) {
      layerId = layerIdByName.get("0") ?? "0";
      fields.push({
        field: "layer",
        classification: "lossy",
        expected: "0",
        actual: layerName,
        note: "entity references a layer outside the LAYER table — mapped to the canonical default layer",
      });
    }
    // Display overrides (entity-level codes; ByLayer entities inherit).
    const overrides: Record<string, unknown> = {};
    if (entity.aci !== null) {
      const color = aciToHex(entity.aci);
      overrides.color = color.hex;
      if (!color.exact) {
        fields.push({ field: "color", classification: "lossy", expected: color.hex, actual: entity.aci, note: "non-palette ACI decoded through the documented hue-grid approximation" });
      } else {
        fields.push(exactField("color"));
      }
    }
    if (entity.linetype !== null && (BUILTIN_NAMES.has(entity.linetype) || knownLtypeNames.has(entity.linetype) || importedLtypeNames.has(entity.linetype))) {
      overrides.linetype = entity.linetype;
    } else if (entity.linetype !== null) {
      fields.push({ field: "linetype", classification: "lossy", expected: null, actual: entity.linetype, note: "entity linetype does not resolve in the file or document — override dropped (ByLayer)" });
    }
    if (entity.lineweightCode !== null) {
      overrides.lineweight = entity.lineweightCode / 100;
    }

    if (entity.type === "TEXT") {
      // TEXT → an.text annotation through the strict constructor.
      if (!(entity.height > 0)) {
        rows.push({
          canonicalId: null,
          globalId: null,
          ifcClass: `DXF ${entity.type}`,
          name: entity.value,
          action: "unsupported",
          fields: [{ field: "height", classification: "unsupported", note: `TEXT height ${entity.height} is not positive — the canonical an.text constructor rejects it` }],
        });
        continue;
      }
      try {
        const annotation = makeText({
          type: "text",
          layer: layerId,
          x: scaleOf(entity.x),
          y: scaleOf(entity.y),
          height: scaleOf(entity.height),
          rotation: (entity.rotationDeg * Math.PI) / 180,
          value: entity.value,
        });
        const props = { ...annotationToProps(annotation), ...overrides } as Record<string, unknown>;
        const id = mint !== null ? mint.mintElementId() : null;
        elements.push({ id: id ?? "", kind: "annotation", engineId: null, props });
        fields.push(
          exactField("value"),
          exactField("position"),
          exactField("height"),
          exactField("rotation"),
        );
        rows.push({ canonicalId: id, globalId: null, ifcClass: `DXF ${entity.type}`, name: entity.value, action: "created", fields });
        continue;
      } catch (e) {
        rows.push({
          canonicalId: null,
          globalId: null,
          ifcClass: `DXF ${entity.type}`,
          name: entity.value,
          action: "unsupported",
          fields: [{ field: "text", classification: "unsupported", note: (e as Error).message }],
        });
        continue;
      }
    }

    // Geometry: raw file values → canonical mm + the strict decoder check.
    const geom = geometryOf(entity, scaleOf);
    if (geom === null) {
      rows.push({
        canonicalId: null,
        globalId: null,
        ifcClass: `DXF ${entity.type}`,
        name: entity.type,
        action: "unsupported",
        fields: [{ field: "geometry", classification: "unsupported", note: "entity values do not decode into the canonical geometry vocabulary" }],
      });
      continue;
    }
    const props: Record<string, unknown> = { drafting: true, layer: layerId, ...(geom as unknown as Record<string, unknown>), ...overrides };
    if (propsToGeom(props) === null) {
      rows.push({
        canonicalId: null,
        globalId: null,
        ifcClass: `DXF ${entity.type}`,
        name: entity.type,
        action: "unsupported",
        fields: [{ field: "geometry", classification: "unsupported", note: "the canonical decoder rejects the reconstructed geometry (LOCK-007)" }],
      });
      continue;
    }
    const id = mint !== null ? mint.mintElementId() : null;
    elements.push({ id: id ?? "", kind: "geometry", engineId: null, props });
    fields.push(...geometryFields(entity));
    rows.push({ canonicalId: id, globalId: null, ifcClass: `DXF ${entity.type}`, name: entity.type, action: "created", fields });
  }

  return {
    unit: unit.unit,
    scaleToMm: scale,
    ltypeEdits,
    layerEdits,
    elements,
    layerIdByName,
    rows,
    unsupported: outcome.unsupported,
    created: elements.length + layerEdits.length + ltypeEdits.length,
  };
}

const BUILTIN_NAMES = new Set<string>([
  "Continuous", "Dashed", "Hidden", "Center", "Phantom", "Dot", "DashDot", "Divide", "Border",
]);

/** Reconstruct the canonical geometry record of one parsed entity (raw file
 *  values × the unit factor); null when the values are degenerate. */
function geometryOf(
  entity: Exclude<DxfReadOutcome["entities"][number], { type: "TEXT" }>,
  scale: (v: number) => number,
): Record<string, unknown> | null {
  switch (entity.type) {
    case "LINE":
      return { type: "line", x1: scale(entity.x1), y1: scale(entity.y1), x2: scale(entity.x2), y2: scale(entity.y2) };
    case "CIRCLE":
      if (!(entity.r > 0)) return null;
      return { type: "circle", cx: scale(entity.cx), cy: scale(entity.cy), r: scale(entity.r) };
    case "ARC": {
      if (!(entity.r > 0)) return null;
      return {
        type: "arc",
        cx: scale(entity.cx),
        cy: scale(entity.cy),
        r: scale(entity.r),
        startAngle: (entity.startDeg * Math.PI) / 180,
        endAngle: (entity.endDeg * Math.PI) / 180,
      };
    }
    case "ELLIPSE": {
      // The writer's documented mirror: group 11 = the CANONICAL rx axis
      // endpoint (relative to the center), group 40 = ry/rx.
      const rx = Math.hypot(entity.majorX, entity.majorY);
      if (!(rx > 0) || !(entity.ratio > 0)) return null;
      return {
        type: "ellipse",
        cx: scale(entity.cx),
        cy: scale(entity.cy),
        rx: scale(rx),
        ry: scale(rx * entity.ratio),
        rotation: Math.atan2(entity.majorY, entity.majorX),
      };
    }
    case "LWPOLYLINE": {
      if (entity.points.length < 2) return null;
      return {
        type: "polyline",
        vertices: entity.points.map((p) => ({ x: scale(p.x), y: scale(p.y) })),
        closed: entity.closed,
      };
    }
    case "SPLINE": {
      if (entity.controlPoints.length < 2 || entity.degree < 1) return null;
      // The canonical clamped B-spline degree convention (3 for >= 4 points,
      // else points-1) — the file's degree is honored only when it matches
      // the convention (bounded: our writer always writes the convention).
      const conventional = entity.controlPoints.length >= 4 ? 3 : entity.controlPoints.length - 1;
      if (entity.degree !== conventional) {
        return null;
      }
      return {
        type: "spline",
        controlPoints: entity.controlPoints.map((p) => ({ x: scale(p.x), y: scale(p.y) })),
        degree: entity.degree,
      };
    }
    case "POINT":
      return { type: "point", x: scale(entity.x), y: scale(entity.y) };
    case "RAY":
    case "XLINE":
      return {
        type: entity.type === "RAY" ? "ray" : "xline",
        x1: scale(entity.x1),
        y1: scale(entity.y1),
        x2: scale(entity.x1 + entity.dx),
        y2: scale(entity.y1 + entity.dy),
      };
  }
}

/** The exact field results of one imported entity (unit-normalized values). */
function geometryFields(entity: DxfReadOutcome["entities"][number]): IfcFieldResult[] {
  switch (entity.type) {
    case "TEXT":
      return [exactField("value"), exactField("position"), exactField("height"), exactField("rotation")];
    case "LINE":
    case "RAY":
    case "XLINE":
      return [exactField("position")];
    case "CIRCLE":
    case "ARC":
      return [exactField("center"), exactField("radius"), ...(entity.type === "ARC" ? [exactField("angles")] : [])];
    case "ELLIPSE":
      return [exactField("center"), exactField("axes"), exactField("rotation")];
    case "LWPOLYLINE":
      return [exactField("vertices"), exactField("closed")];
    case "SPLINE":
      return [exactField("controlPoints"), exactField("degree")];
    case "POINT":
      return [exactField("position")];
  }
}
