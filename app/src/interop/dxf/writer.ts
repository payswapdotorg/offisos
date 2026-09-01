/**
 * CAD-PARITY-014 (Issue #107) — the deterministic bounded DXF R2000 ASCII
 * writer (D5).
 *
 * The APPROVED BOUNDARY (the work-item contract): the current
 * GEOMETRY-kind drafting entities (line/polyline/circle/arc/ellipse/spline/
 * point/ray/xline), the `an.text` annotations as TEXT entities, the LTYPE
 * table for every referenced linetype and the LAYER table for every layer.
 * Everything else (annotation dims/leaders/mtext, regions, BIM elements,
 * blocks, model3d, docs records) is SKIPPED and counted in the export report
 * — explicit, never silently approximated (LOCK-007).
 *
 * Determinism (LOCK-003): sections in fixed order (HEADER → TABLES →
 * ENTITIES → EOF), exactly three header variables ($ACADVER "AC1015",
 * $INSUNITS 4 = mm, $EXTMIN/$EXTMAX of the content), deterministic
 * sequential handles starting at 0x100 (+1 per object in emission order =
 * table order for tables, document order for entities), a fixed 6-decimal
 * number format, NO timestamps and NO variable headers beyond the three.
 * Identical document state → byte-identical DXF on every host, every run
 * (the plotIRToSVG/plotIRToPDF writer discipline).
 *
 * "ByLayer" entities emit layer-resolved properties (documented rule): an
 * entity WITHOUT a display override omits the 62/6/370 codes entirely — the
 * DXF ByLayer semantics — and the LAYER table carries the resolved ACI
 * color, linetype name and lineweight code. Entities WITH overrides emit
 * their own codes (the override wins, exactly the canonical resolution
 * chain of workspace/standards).
 *
 * Pure + engine-free (LOCK-018).
 */

import type { Element, LayerRecord, LtypeRecord, DrawingStandards } from "../../contracts/caddocument.js";
import { annotationFromElement } from "../../workspace/annotation/index.js";
import { propsToGeom, type Geom } from "../../workspace/geometry/types.js";
import { displayOverridesOf, ltypeExists, ltypePattern, BUILT_IN_LTYPES } from "../../workspace/standards/index.js";
import { DXF_ACADVER, DXF_INSUNITS_MM, dxfFmt, hexToAci } from "./shared.js";

/** The writer input: the CURRENT document surface (pure data — no document
 *  dependency so both hosts build the identical bytes). */
export interface DxfWriteInput {
  readonly elements: readonly Element[];
  readonly layers: readonly LayerRecord[];
  readonly ltypes: readonly LtypeRecord[];
  readonly standards?: DrawingStandards;
}

export interface DxfWriteOutcome {
  /** The full ASCII DXF text (line-feed terminated lines). */
  readonly text: string;
  readonly counts: {
    readonly exported: number;
    readonly skipped: number;
    /** Exported entities per DXF entity type (LINE/CIRCLE/…/TEXT). */
    readonly byKind: Readonly<Record<string, number>>;
  };
  /** The sorted distinct skipped element kinds (LOCK-007: counted, never silent). */
  readonly skippedKinds: readonly string[];
  /** The exported source element ids in EMISSION order (the round-trip
   *  verification pairs these with the re-imported drafts). */
  readonly exportedIds: readonly string[];
}

/** Sequential handle source starting at 0x100 (256) — deterministic hex. */
class HandleSource {
  private next = 0x100;
  mint(): string {
    const handle = this.next.toString(16).toUpperCase();
    this.next += 1;
    return handle;
  }
}

/** The DXF line builder (code/value pairs, LF-terminated). */
class PairWriter {
  private readonly lines: string[] = [];
  pair(code: number, value: string | number): void {
    this.lines.push(String(code), String(value));
  }
  build(): string {
    return this.lines.join("\n") + "\n";
  }
}

interface EntityPlan {
  readonly kind: "line" | "circle" | "arc" | "ellipse" | "lwpolyline" | "spline" | "point" | "ray" | "xline" | "text";
  readonly geom: Geom | null;
  readonly text: { readonly x: number; readonly y: number; readonly height: number; readonly rotation: number; readonly value: string } | null;
  readonly props: Readonly<Record<string, unknown>>;
  /** The source element id (the round-trip verification pairs it with the
   *  re-imported draft). */
  readonly id: string;
}

/** The DXF group-0 marker of one plan kind. */
function dxfMarker(kind: EntityPlan["kind"]): string {
  return kind === "lwpolyline" ? "LWPOLYLINE" : kind === "text" ? "TEXT" : kind.toUpperCase();
}

/** The world bounding box of the exported content (mm) — the $EXTMIN/$EXTMAX
 *  source. TEXT contributes its insertion point (text extents are a font
 *  metric — the bounded writer documents the point-only contribution). */
function contentExtents(plans: readonly EntityPlan[]): { min: readonly [number, number]; max: readonly [number, number] } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  const grow = (x: number, y: number, r?: number): void => {
    any = true;
    minX = Math.min(minX, x - (r ?? 0));
    minY = Math.min(minY, y - (r ?? 0));
    maxX = Math.max(maxX, x + (r ?? 0));
    maxY = Math.max(maxY, y + (r ?? 0));
  };
  for (const plan of plans) {
    if (plan.text !== null) {
      grow(plan.text.x, plan.text.y);
      continue;
    }
    const geom = plan.geom;
    if (geom === null) continue;
    switch (geom.type) {
      case "line":
      case "ray":
      case "xline":
        grow(geom.x1, geom.y1);
        grow(geom.x2, geom.y2);
        break;
      case "polyline":
        for (const v of geom.vertices) grow(v.x, v.y);
        break;
      case "circle":
      case "arc":
        grow(geom.cx, geom.cy, geom.r);
        break;
      case "ellipse":
        grow(geom.cx, geom.cy, Math.max(geom.rx, geom.ry));
        break;
      case "spline":
        for (const v of geom.controlPoints) grow(v.x, v.y);
        break;
      case "point":
        grow(geom.x, geom.y);
        break;
      case "region":
        break;
    }
  }
  return any ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

/** Class-clamped uniform knot vector for a clamped B-spline with n control
 *  points and degree p (normalized [0,1]; deterministic). */
function clampedKnots(count: number, degree: number): number[] {
  const knots: number[] = [];
  for (let i = 0; i <= degree; i += 1) knots.push(0);
  const internal = count - degree - 1;
  for (let i = 1; i <= internal; i += 1) knots.push(i / internal);
  for (let i = 0; i <= degree; i += 1) knots.push(1);
  return knots;
}

/** Emit one DXF angle in degrees (canonical radians CCW → degrees CCW). */
function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Write the bounded deterministic DXF R2000 ASCII text for the current
 *  drafting surface. Empty documents export a valid EMPTY DXF (header +
 *  empty tables + empty ENTITIES + EOF) — the bounded decision: an ok
 *  export with zero entities, not a typed decline (the document state is
 *  legitimately empty; the counts report it). */
export function writeDxf(input: DxfWriteInput): DxfWriteOutcome {
  const { elements, layers, ltypes, standards } = input;
  const layerById = new Map(layers.map((l) => [l.id, l] as const));
  const layerNameOf = (layerId: string | null): string => {
    if (layerId !== null) {
      const layer = layerById.get(layerId);
      if (layer !== undefined) return layer.name;
    }
    return "0"; // the canonical default layer name
  };

  // --- classify the document surface (document order) --------------------------
  const plans: EntityPlan[] = [];
  const byKind: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const note = (kind: string): void => {
    skipped[kind] = (skipped[kind] ?? 0) + 1;
  };
  for (const el of elements) {
    if (el.kind === "geometry") {
      const geom = propsToGeom(el.props as Record<string, unknown>);
      if (geom === null) {
        note("geometry-unknown");
        continue;
      }
      const plan = (kind: EntityPlan["kind"]): EntityPlan => ({ kind, geom, text: null, props: el.props as Record<string, unknown>, id: el.id });
      switch (geom.type) {
        case "line": plans.push(plan("line")); break;
        case "polyline": plans.push(plan("lwpolyline")); break;
        case "circle": plans.push(plan("circle")); break;
        case "arc": plans.push(plan("arc")); break;
        case "ellipse": plans.push(plan("ellipse")); break;
        case "spline": plans.push(plan("spline")); break;
        case "point": plans.push(plan("point")); break;
        case "ray": plans.push(plan("ray")); break;
        case "xline": plans.push(plan("xline")); break;
        case "region":
          // Regions are associative DERIVED constructs (the boundary is
          // exported as its base geometry by the host when authored as such;
          // the region wrapper itself is outside the boundary).
          note("region");
          break;
      }
      continue;
    }
    if (el.kind === "annotation") {
      const annotation = annotationFromElement(el);
      if (annotation !== null && annotation.type === "text") {
        plans.push({
          kind: "text",
          geom: null,
          text: {
            x: annotation.x,
            y: annotation.y,
            height: annotation.height,
            rotation: annotation.rotation,
            value: annotation.value,
          },
          props: el.props as Record<string, unknown>,
          id: el.id,
        });
        continue;
      }
      note(annotation !== null ? `annotation.${annotation.type}` : (el.props.type as string) ?? "annotation");
      continue;
    }
    // BIM elements + everything else: outside the DXF boundary.
    note(el.kind === "bim" ? "bim" : (el.kind as string));
  }
  for (const plan of plans) {
    const marker = dxfMarker(plan.kind);
    byKind[marker] = (byKind[marker] ?? 0) + 1;
  }

  // --- resolved linetype set (layer linetypes + entity overrides) --------------
  const referencedLtypes = new Set<string>();
  for (const layer of layers) {
    const linetype = layer.linetype ?? "Continuous";
    if (ltypeExists(linetype, ltypes)) referencedLtypes.add(linetype);
    else note(`linetype-unresolved:${linetype}`);
  }
  for (const plan of plans) {
    const overrides = displayOverridesOf(plan.props);
    if (overrides.linetype !== null) {
      if (ltypeExists(overrides.linetype, ltypes)) referencedLtypes.add(overrides.linetype);
      else note(`linetype-unresolved:${overrides.linetype}`);
    }
    // The canonical default linetype of layers without an explicit one.
    const layerId = typeof (plan.props as Record<string, unknown>).layer === "string"
      ? ((plan.props as Record<string, unknown>).layer as string)
      : null;
    const layer = layerId !== null ? layerById.get(layerId) : undefined;
    if (layer === undefined) referencedLtypes.add("Continuous");
  }

  // --- write --------------------------------------------------------------------
  const handles = new HandleSource();
  const w = new PairWriter();

  // HEADER (exactly three variables — no timestamps, nothing else).
  w.pair(0, "SECTION");
  w.pair(2, "HEADER");
  w.pair(9, "$ACADVER");
  w.pair(1, DXF_ACADVER);
  w.pair(9, "$INSUNITS");
  w.pair(70, DXF_INSUNITS_MM);
  const extents = contentExtents(plans);
  const extMin = extents?.min ?? [0, 0];
  const extMax = extents?.max ?? [0, 0];
  w.pair(9, "$EXTMIN");
  w.pair(10, dxfFmt(extMin[0]));
  w.pair(20, dxfFmt(extMin[1]));
  w.pair(30, "0");
  w.pair(9, "$EXTMAX");
  w.pair(10, dxfFmt(extMax[0]));
  w.pair(20, dxfFmt(extMax[1]));
  w.pair(30, "0");
  w.pair(0, "ENDSEC");

  // TABLES — LTYPE first (layers reference linetypes by name).
  w.pair(0, "SECTION");
  w.pair(2, "TABLES");
  const ltypeNames = [...referencedLtypes].sort();
  w.pair(0, "TABLE");
  w.pair(2, "LTYPE");
  w.pair(5, handles.mint());
  w.pair(100, "AcDbSymbolTable");
  w.pair(70, ltypeNames.length);
  for (const name of ltypeNames) {
    const builtIn = BUILT_IN_LTYPES.find((l) => l.name === name);
    const pattern = builtIn !== undefined ? [...builtIn.pattern] : ltypePattern(name, ltypes);
    const description = builtIn !== undefined ? builtIn.description : (ltypes.find((l) => l.name === name)?.description ?? "");
    w.pair(0, "LTYPE");
    w.pair(5, handles.mint());
    w.pair(100, "AcDbSymbolTableRecord");
    w.pair(100, "AcDbLinetypeTableRecord");
    w.pair(2, name);
    w.pair(70, 0);
    w.pair(3, description);
    w.pair(72, 65);
    w.pair(73, pattern.length);
    w.pair(40, dxfFmt(pattern.reduce((sum, seg) => sum + Math.abs(seg), 0)));
    for (const seg of pattern) {
      w.pair(49, dxfFmt(seg));
    }
  }
  w.pair(0, "ENDTAB");

  // LAYER table (every layer, table order).
  w.pair(0, "TABLE");
  w.pair(2, "LAYER");
  w.pair(5, handles.mint());
  w.pair(100, "AcDbSymbolTable");
  w.pair(70, layers.length);
  for (const layer of layers) {
    const aci = hexToAci(layer.color).aci;
    const flags = (layer.frozen === true ? 1 : 0) | (layer.locked === true ? 4 : 0);
    const lineweight = layer.lineweight ?? standards?.defaultLineweight ?? 0.25;
    const lineweightCode = Math.max(0, Math.round(lineweight * 100));
    w.pair(0, "LAYER");
    w.pair(5, handles.mint());
    w.pair(100, "AcDbSymbolTableRecord");
    w.pair(100, "AcDbLayerTableRecord");
    w.pair(2, layer.name);
    w.pair(70, flags);
    // Negative color = layer OFF (the DXF convention).
    w.pair(62, layer.visible ? aci : -aci);
    w.pair(6, layer.linetype ?? "Continuous");
    w.pair(370, lineweightCode);
  }
  w.pair(0, "ENDTAB");
  w.pair(0, "ENDSEC");

  // ENTITIES — document order; the ByLayer rule (see the module header).
  w.pair(0, "SECTION");
  w.pair(2, "ENTITIES");
  for (const plan of plans) {
    const props = plan.props;
    const layerId = typeof props.layer === "string" ? props.layer : null;
    const layerName = layerNameOf(layerId);
    const overrides = displayOverridesOf(props);
    const emitCommon = (): void => {
      w.pair(0, dxfMarker(plan.kind));
      w.pair(5, handles.mint());
      w.pair(100, "AcDbEntity");
      w.pair(8, layerName);
      if (overrides.color !== null) {
        w.pair(62, hexToAci(overrides.color).aci);
      }
      if (overrides.linetype !== null) {
        w.pair(6, overrides.linetype);
      }
      if (overrides.lineweight !== null) {
        w.pair(370, Math.max(0, Math.round(overrides.lineweight * 100)));
      }
    };
    const g = plan.geom;
    if (plan.kind === "text" && plan.text !== null) {
      emitCommon();
      w.pair(100, "AcDbText");
      w.pair(1, plan.text.value);
      w.pair(10, dxfFmt(plan.text.x));
      w.pair(20, dxfFmt(plan.text.y));
      w.pair(30, "0");
      w.pair(40, dxfFmt(plan.text.height));
      w.pair(50, dxfFmt(deg(plan.text.rotation)));
      continue;
    }
    switch (plan.kind) {
      case "line": {
        const geom = g as { type: "line"; x1: number; y1: number; x2: number; y2: number };
        emitCommon();
        w.pair(100, "AcDbLine");
        w.pair(10, dxfFmt(geom.x1));
        w.pair(20, dxfFmt(geom.y1));
        w.pair(30, "0");
        w.pair(11, dxfFmt(geom.x2));
        w.pair(21, dxfFmt(geom.y2));
        w.pair(31, "0");
        break;
      }
      case "circle": {
        const geom = g as { type: "circle"; cx: number; cy: number; r: number };
        emitCommon();
        w.pair(100, "AcDbCircle");
        w.pair(10, dxfFmt(geom.cx));
        w.pair(20, dxfFmt(geom.cy));
        w.pair(30, "0");
        w.pair(40, dxfFmt(geom.r));
        break;
      }
      case "arc": {
        const geom = g as { type: "arc"; cx: number; cy: number; r: number; startAngle: number; endAngle: number };
        emitCommon();
        w.pair(100, "AcDbCircle");
        w.pair(10, dxfFmt(geom.cx));
        w.pair(20, dxfFmt(geom.cy));
        w.pair(30, "0");
        w.pair(40, dxfFmt(geom.r));
        w.pair(100, "AcDbArc");
        w.pair(50, dxfFmt(deg(geom.startAngle)));
        w.pair(51, dxfFmt(deg(geom.endAngle)));
        break;
      }
      case "ellipse": {
        const geom = g as { type: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotation: number };
        emitCommon();
        w.pair(100, "AcDbEllipse");
        w.pair(10, dxfFmt(geom.cx));
        w.pair(20, dxfFmt(geom.cy));
        w.pair(30, "0");
        // Group 11 = the major-axis endpoint RELATIVE to the center (its
        // length is the semi-major length rx; the canonical ellipse contract).
        w.pair(11, dxfFmt(geom.rx * Math.cos(geom.rotation)));
        w.pair(21, dxfFmt(geom.rx * Math.sin(geom.rotation)));
        w.pair(31, "0");
        w.pair(40, dxfFmt(geom.ry / geom.rx));
        w.pair(41, "0");
        w.pair(42, "6.283185");
        break;
      }
      case "lwpolyline": {
        const geom = g as { type: "polyline"; vertices: readonly { x: number; y: number }[]; closed: boolean };
        emitCommon();
        w.pair(100, "AcDbPolyline");
        w.pair(90, geom.vertices.length);
        w.pair(70, geom.closed ? 1 : 0);
        w.pair(43, "0");
        for (const v of geom.vertices) {
          w.pair(10, dxfFmt(v.x));
          w.pair(20, dxfFmt(v.y));
        }
        break;
      }
      case "spline": {
        const geom = g as { type: "spline"; controlPoints: readonly { x: number; y: number }[]; degree: number };
        emitCommon();
        w.pair(100, "AcDbSpline");
        w.pair(70, 0);
        w.pair(71, geom.degree);
        const knots = clampedKnots(geom.controlPoints.length, geom.degree);
        w.pair(72, knots.length);
        w.pair(73, geom.controlPoints.length);
        w.pair(74, 0);
        for (const knot of knots) {
          w.pair(40, dxfFmt(knot));
        }
        for (const v of geom.controlPoints) {
          w.pair(10, dxfFmt(v.x));
          w.pair(20, dxfFmt(v.y));
          w.pair(30, "0");
        }
        break;
      }
      case "point": {
        const geom = g as { type: "point"; x: number; y: number };
        emitCommon();
        w.pair(100, "AcDbPoint");
        w.pair(10, dxfFmt(geom.x));
        w.pair(20, dxfFmt(geom.y));
        w.pair(30, "0");
        break;
      }
      case "ray":
      case "xline": {
        const geom = g as { type: "ray"; x1: number; y1: number; x2: number; y2: number };
        emitCommon();
        w.pair(100, plan.kind === "ray" ? "AcDbRay" : "AcDbXline");
        w.pair(10, dxfFmt(geom.x1));
        w.pair(20, dxfFmt(geom.y1));
        w.pair(30, "0");
        // Second point defines the direction (not normalized — the DXF rule).
        w.pair(11, dxfFmt(geom.x2 - geom.x1));
        w.pair(21, dxfFmt(geom.y2 - geom.y1));
        w.pair(31, "0");
        break;
      }
      case "text":
        break;
    }
  }
  w.pair(0, "ENDSEC");
  w.pair(0, "EOF");

  const skippedKinds = Object.keys(skipped).sort();
  const skippedTotal = Object.values(skipped).reduce((sum, n) => sum + n, 0);
  return {
    text: w.build(),
    counts: {
      exported: plans.length,
      skipped: skippedTotal,
      byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    skippedKinds,
    exportedIds: plans.map((plan) => plan.id),
  };
}
