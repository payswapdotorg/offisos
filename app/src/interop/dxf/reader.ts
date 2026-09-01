/**
 * CAD-PARITY-014 (Issue #107) — the bounded DXF ASCII reader (D5).
 *
 * Parses the APPROVED BOUNDARY (the writer's mirror): the bounded entity
 * vocabulary (LINE/CIRCLE/ARC/ELLIPSE/LWPOLYLINE/SPLINE/POINT/RAY/XLINE/TEXT
 * + the legacy POLYLINE/VERTEX/SEQEND composite), the LTYPE/LAYER tables
 * and the $INSUNITS length declaration. Everything outside the boundary is
 * SKIPPED and counted PER TYPE (the typed unsupported report — never
 * fabricated, never silently approximated; LOCK-007). Unknown/duplicate
 * table entries and malformed values inside the boundary fail TYPED
 * (dxf_invalid) — no repair.
 *
 * The reader is unit-agnostic: it returns the file's RAW values plus the
 * declared $INSUNITS; the canonical mm normalization (the declared factor
 * table) and the element mapping live in dxf/importmap.ts (the
 * ifc/importmap.ts discipline: parse vs map).
 *
 * Pure + engine-free (LOCK-018). Deterministic: file order everywhere, no
 * maps with unstable iteration.
 */

import { DxfError } from "./shared.js";

// --- Parsed shapes ---------------------------------------------------------------

export interface DxfParsedLtype {
  readonly name: string;
  readonly description: string;
  /** Dash/gap sequence in drawing units (empty = Continuous). */
  readonly pattern: readonly number[];
}

export interface DxfParsedLayer {
  readonly name: string;
  /** Raw ACI color (negative = layer off; abs() is the color index). */
  readonly aci: number;
  readonly off: boolean;
  readonly frozen: boolean;
  readonly locked: boolean;
  /** Resolved linetype name (null when the record carries none). */
  readonly linetype: string | null;
  /** Lineweight code (1/100 mm; null when the record carries none). */
  readonly lineweightCode: number | null;
}

/** Common per-entity properties. */
export interface DxfEntityCommon {
  /** The referenced layer NAME (null = the "0" default). */
  readonly layer: string | null;
  /** Entity ACI color override (null when the entity carries no 62 code). */
  readonly aci: number | null;
  /** Entity linetype override (null when the entity carries no 6 code). */
  readonly linetype: string | null;
  /** Entity lineweight code override (null when the entity carries no 370). */
  readonly lineweightCode: number | null;
}

export type DxfParsedEntity =
  | (DxfEntityCommon & { readonly type: "LINE"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number })
  | (DxfEntityCommon & { readonly type: "CIRCLE"; readonly cx: number; readonly cy: number; readonly r: number })
  | (DxfEntityCommon & { readonly type: "ARC"; readonly cx: number; readonly cy: number; readonly r: number; readonly startDeg: number; readonly endDeg: number })
  | (DxfEntityCommon & { readonly type: "ELLIPSE"; readonly cx: number; readonly cy: number; readonly majorX: number; readonly majorY: number; readonly ratio: number })
  | (DxfEntityCommon & { readonly type: "LWPOLYLINE"; readonly points: readonly { readonly x: number; readonly y: number }[]; readonly closed: boolean })
  | (DxfEntityCommon & { readonly type: "SPLINE"; readonly controlPoints: readonly { readonly x: number; readonly y: number }[]; readonly degree: number })
  | (DxfEntityCommon & { readonly type: "POINT"; readonly x: number; readonly y: number })
  | (DxfEntityCommon & { readonly type: "RAY" | "XLINE"; readonly x1: number; readonly y1: number; readonly dx: number; readonly dy: number })
  | (DxfEntityCommon & { readonly type: "TEXT"; readonly x: number; readonly y: number; readonly height: number; readonly rotationDeg: number; readonly value: string });

export interface DxfReadOutcome {
  readonly header: {
    readonly acadver: string | null;
    readonly insunits: number | null;
  };
  readonly ltypes: readonly DxfParsedLtype[];
  readonly layers: readonly DxfParsedLayer[];
  readonly entities: readonly DxfParsedEntity[];
  /** Unsupported constructs, counted PER TYPE (file order preserved). */
  readonly unsupported: readonly { readonly type: string; readonly count: number }[];
}

// --- Tokenizer --------------------------------------------------------------------

/** One group code / value pair. Values stay STRING (the caller converts per
 *  the code semantics — no guessing at types). */
interface Pair {
  readonly code: number;
  readonly value: string;
}

/** Tokenize the ASCII DXF text into code/value pairs (CRLF- and
 *  LF-tolerant). Malformed pair streams fail typed. */
function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  // A trailing newline yields one empty tail line — drop exactly one.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeText = lines[i]!.trim();
    const code = Number.parseInt(codeText, 10);
    if (!/^-?\d+$/.test(codeText) || Number.isNaN(code)) {
      throw new DxfError(`DXF pair stream is malformed at line ${i + 1} (expected a group code, got '${codeText}')`, "dxf_invalid");
    }
    pairs.push({ code, value: lines[i + 1]! });
  }
  if (lines.length % 2 !== 0) {
    throw new DxfError("DXF pair stream has an odd line count (a dangling value without a group code)", "dxf_invalid");
  }
  return pairs;
}

function num(value: string, what: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    throw new DxfError(`DXF ${what} is not a finite number ('${value}')`, "dxf_invalid");
  }
  return n;
}

function int(value: string, what: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new DxfError(`DXF ${what} is not an integer ('${value}')`, "dxf_invalid");
  }
  return n;
}

/** A named group collector over a record's pairs. */
class GroupBag {
  private readonly byCode = new Map<number, string[]>();
  add(pair: Pair): void {
    const list = this.byCode.get(pair.code) ?? [];
    list.push(pair.value);
    this.byCode.set(pair.code, list);
  }
  first(code: number): string | undefined {
    return this.byCode.get(code)?.[0];
  }
  firstOf(code: number, orDefault: string): string {
    return this.byCode.get(code)?.[0] ?? orDefault;
  }
  all(code: number): readonly string[] {
    return this.byCode.get(code) ?? [];
  }
  num(code: number, what: string): number {
    const v = this.byCode.get(code)?.[0];
    if (v === undefined) {
      throw new DxfError(`DXF ${what} is missing (group ${code})`, "dxf_invalid");
    }
    return num(v, what);
  }
  numOr(code: number, orDefault: number): number {
    const v = this.byCode.get(code)?.[0];
    if (v === undefined) return orDefault;
    return num(v, `group ${code}`);
  }
  intOr(code: number, orDefault: number): number {
    const v = this.byCode.get(code)?.[0];
    if (v === undefined) return orDefault;
    return int(v, `group ${code}`);
  }
}

// --- Reader ------------------------------------------------------------------------

const READABLE = new Set<string>([
  "LINE", "CIRCLE", "ARC", "ELLIPSE", "LWPOLYLINE", "SPLINE", "POINT", "RAY", "XLINE", "TEXT", "POLYLINE",
]);

const TABLE_KINDS = new Set<string>(["LTYPE", "LAYER"]);

/** Parse the bounded DXF ASCII text. Throws DxfError (typed dxf_invalid) on
 *  structural violations inside the boundary; unknown constructs are
 *  skipped + counted. */
export function readDxf(text: string): DxfReadOutcome {
  const pairs = tokenize(text);
  const ltypes: DxfParsedLtype[] = [];
  const layers: DxfParsedLayer[] = [];
  const entities: DxfParsedEntity[] = [];
  const unsupportedCounts = new Map<string, number>();
  const skip = (type: string): void => {
    unsupportedCounts.set(type, (unsupportedCounts.get(type) ?? 0) + 1);
  };

  let acadver: string | null = null;
  let insunits: number | null = null;

  // Walk the pair stream as records: a record starts at a 0-code value and
  // spans until the next 0-code pair (the classic DXF record grammar).
  let i = 0;
  let section: string | null = null;
  let tableKind: string | null = null;

  const readRecord = (): { readonly marker: string; readonly bag: GroupBag } => {
    const marker = pairs[i]!.value;
    i += 1;
    const bag = new GroupBag();
    while (i < pairs.length && pairs[i]!.code !== 0) {
      bag.add(pairs[i]!);
      i += 1;
    }
    return { marker, bag };
  };

  /** The legacy POLYLINE/VERTEX/SEQEND composite: the POLYLINE record, then
   *  VERTEX sub-records (one 10/20 pair each), terminated by SEQEND —
   *  folded into ONE bounded polyline. */
  const readPolylineComposite = (): DxfParsedEntity => {
    const { bag } = readRecord();
    const common = commonOf(bag);
    const flags = bag.intOr(70, 0);
    const points: { x: number; y: number }[] = [];
    while (i < pairs.length && pairs[i]!.code === 0) {
      const subMarker = pairs[i]!.value;
      if (subMarker === "SEQEND") {
        readRecord();
        break;
      }
      if (subMarker !== "VERTEX") {
        // Not a vertex — the composite is over (a malformed file); stop
        // folding and let the outer loop handle the record.
        break;
      }
      const vertex = readRecord();
      const vx = vertex.bag.first(10);
      const vy = vertex.bag.first(20);
      if (vx !== undefined && vy !== undefined) {
        points.push({ x: num(vx, "VERTEX x"), y: num(vy, "VERTEX y") });
      }
    }
    return { ...common, type: "LWPOLYLINE", points, closed: (flags & 1) !== 0 };
  };

  while (i < pairs.length) {
    const pair = pairs[i]!;
    if (pair.code !== 0) {
      // 9-code header variables + section-level pairs.
      if (pair.code === 9 && section === "HEADER") {
        const variable = pair.value;
        i += 1;
        const bag = new GroupBag();
        while (i < pairs.length && pairs[i]!.code !== 0 && pairs[i]!.code !== 9) {
          bag.add(pairs[i]!);
          i += 1;
        }
        if (variable === "$ACADVER" && bag.first(1) !== undefined) acadver = bag.first(1) as string;
        if (variable === "$INSUNITS") insunits = bag.intOr(70, 0);
        continue;
      }
      // Stray pairs outside records (SECTION/ENDSEC bodies carry their own 2
      // codes handled below) — skip defensively without guessing.
      i += 1;
      continue;
    }
    const marker = pair.value;
    if (marker === "SECTION") {
      i += 1;
      const name = pairs[i] !== undefined && pairs[i]!.code === 2 ? pairs[i]!.value : null;
      section = name;
      tableKind = null;
      i += 1;
      continue;
    }
    if (marker === "ENDSEC") {
      section = null;
      tableKind = null;
      i += 1;
      continue;
    }
    if (marker === "EOF") {
      i += 1;
      continue;
    }
    if (marker === "TABLE") {
      const record = readRecord();
      tableKind = record.bag.first(2) ?? null;
      continue;
    }
    if (marker === "ENDTAB") {
      tableKind = null;
      i += 1;
      continue;
    }
    if (section === "TABLES" && tableKind !== null && TABLE_KINDS.has(tableKind)) {
      const record = readRecord();
      if (record.marker !== tableKind) {
        skip(`table-record:${record.marker}`);
        continue;
      }
      if (tableKind === "LTYPE") {
        const name = record.bag.first(2);
        if (name === undefined || name.length === 0) {
          skip("LTYPE");
          continue;
        }
        const pattern = record.bag.all(49).map((v) => num(v, "LTYPE dash element"));
        ltypes.push({
          name,
          description: record.bag.first(3) ?? "",
          pattern,
        });
        continue;
      }
      // LAYER
      const name = record.bag.first(2);
      if (name === undefined || name.length === 0) {
        skip("LAYER");
        continue;
      }
      const rawColor = record.bag.intOr(62, 7);
      const flags = record.bag.intOr(70, 0);
      layers.push({
        name,
        aci: Math.abs(rawColor),
        off: rawColor < 0,
        frozen: (flags & 1) !== 0,
        locked: (flags & 4) !== 0,
        linetype: record.bag.first(6) ?? null,
        lineweightCode: record.bag.first(370) !== undefined ? int(record.bag.first(370)!, "LAYER lineweight") : null,
      });
      continue;
    }
    if (section === "ENTITIES") {
      if (!READABLE.has(marker)) {
        // Unsupported construct (INSERT/DIMENSION/MTEXT/HATCH/3DFACE/SOLID/
        // blocks/anything outside the list): skipped + counted per type.
        readRecord();
        skip(marker);
        continue;
      }
      if (marker === "POLYLINE") {
        entities.push(readPolylineComposite());
        continue;
      }
      const record = readRecord();
      entities.push(readEntity(marker, record.bag));
      continue;
    }
    // Records inside HEADER/other sections (e.g. stray handles) — skip.
    readRecord();
  }

  const unsupported = [...unsupportedCounts.entries()].map(([type, count]) => ({ type, count }));
  return {
    header: { acadver, insunits },
    ltypes,
    layers,
    entities,
    unsupported,
  };
}

/** The per-entity common group codes (8/62/6/370). */
function commonOf(bag: GroupBag): DxfEntityCommon {
  return {
    layer: bag.first(8) ?? null,
    aci: bag.first(62) !== undefined ? int(bag.first(62)!, "entity color") : null,
    linetype: bag.first(6) ?? null,
    lineweightCode: bag.first(370) !== undefined ? int(bag.first(370)!, "entity lineweight") : null,
  };
}

function readEntity(marker: string, bag: GroupBag): DxfParsedEntity {
  const common = commonOf(bag);
  switch (marker) {
    case "LINE":
      return { ...common, type: "LINE", x1: bag.num(10, "LINE x1"), y1: bag.num(20, "LINE y1"), x2: bag.num(11, "LINE x2"), y2: bag.num(21, "LINE y2") };
    case "CIRCLE":
      return { ...common, type: "CIRCLE", cx: bag.num(10, "CIRCLE cx"), cy: bag.num(20, "CIRCLE cy"), r: bag.num(40, "CIRCLE r") };
    case "ARC":
      return { ...common, type: "ARC", cx: bag.num(10, "ARC cx"), cy: bag.num(20, "ARC cy"), r: bag.num(40, "ARC r"), startDeg: bag.num(50, "ARC start"), endDeg: bag.num(51, "ARC end") };
    case "ELLIPSE":
      return { ...common, type: "ELLIPSE", cx: bag.num(10, "ELLIPSE cx"), cy: bag.num(20, "ELLIPSE cy"), majorX: bag.num(11, "ELLIPSE majorX"), majorY: bag.num(21, "ELLIPSE majorY"), ratio: bag.num(40, "ELLIPSE ratio") };
    case "LWPOLYLINE": {
      const count = bag.intOr(90, 0);
      const xs = bag.all(10);
      const ys = bag.all(20);
      const points: { x: number; y: number }[] = [];
      for (let v = 0; v < count; v += 1) {
        if (xs[v] === undefined || ys[v] === undefined) {
          throw new DxfError(`LWPOLYLINE declares ${count} vertices but carries ${Math.min(xs.length, ys.length)} coordinate pairs`, "dxf_invalid");
        }
        points.push({ x: num(xs[v]!, "LWPOLYLINE x"), y: num(ys[v]!, "LWPOLYLINE y") });
      }
      const flags = bag.intOr(70, 0);
      return { ...common, type: "LWPOLYLINE", points, closed: (flags & 1) !== 0 };
    }
    case "SPLINE": {
      const degree = bag.intOr(71, 3);
      const controlCount = bag.intOr(73, 0);
      const xs = bag.all(10);
      const ys = bag.all(20);
      if (controlCount <= 0 || xs.length < controlCount || ys.length < controlCount) {
        throw new DxfError(`SPLINE declares ${controlCount} control points but carries ${Math.min(xs.length, ys.length)} coordinate pairs`, "dxf_invalid");
      }
      const controlPoints: { x: number; y: number }[] = [];
      for (let v = 0; v < controlCount; v += 1) {
        controlPoints.push({ x: num(xs[v]!, "SPLINE x"), y: num(ys[v]!, "SPLINE y") });
      }
      return { ...common, type: "SPLINE", controlPoints, degree };
    }
    case "POINT":
      return { ...common, type: "POINT", x: bag.num(10, "POINT x"), y: bag.num(20, "POINT y") };
    case "RAY":
    case "XLINE":
      return { ...common, type: marker, x1: bag.num(10, `${marker} base x`), y1: bag.num(20, `${marker} base y`), dx: bag.num(11, `${marker} dir x`), dy: bag.num(21, `${marker} dir y`) };
    case "TEXT":
      return { ...common, type: "TEXT", x: bag.num(10, "TEXT x"), y: bag.num(20, "TEXT y"), height: bag.num(40, "TEXT height"), rotationDeg: bag.numOr(50, 0), value: bag.firstOf(1, "") };
    default:
      throw new DxfError(`entity type '${marker}' is outside the bounded DXF reader vocabulary`, "dxf_invalid");
  }
}
