/**
 * CAD-PARITY-018 (Issue #118, acceptance criterion 14 — the corrective
 * interop coverage): the specialized-toolsets exchange carrier — the
 * CADDocument specialized records (`tls-NNNNNN`) ↔ IfcGroup entities.
 *
 * This is the P014 documentation carrier (ifc/docmap.ts) applied to the
 * P018 specialized records, with the SAME discipline and ZERO worker /
 * adapter-protocol changes:
 *
 * CARRIER (one IfcGroup per specialized record): IfcGroup is an IfcRoot
 * (the guid derives deterministically from the canonical record id through
 * identity.ts ifcGuidFor — the "locked caller guid" discipline shared with
 * elements and documentation records) AND an IfcObject (psets attach
 * through the worker's standard pset path):
 *   - Pset_OffisosIdentity {DomainId: <tls- id>, DomainKind:
 *     "toolsets.<kind>"} — identity provenance ONLY (LOCK-019: the
 *     canonical id is THE identity; the IfcGuid is its deterministic
 *     projection);
 *   - Pset_OffisosDocs {…record fields as string/boolean values} — the
 *     SAME fields pset the documentation carrier uses (the worker's group
 *     writer is generic over identity+fields records; the IFC adapter
 *     maps toolsets groups onto it and discriminates them back by
 *     DomainKind on parse).
 *
 * FIELD ENCODING (documented, deterministic, reversible):
 *   - SCALARS ride as flat fields. Numbers ride the EXACT-REVERSIBLE
 *     String(n) encoding (the ECMAScript Number::toString algorithm is
 *     fully specified and shortest-round-trip: decode is Number(s), an
 *     exact identity for every finite double) — so the boundary
 *     classification for numeric fields is EXACT, never tolerance.
 *     Booleans ride native IfcBoolean values.
 *   - STRUCTURED ARRAYS (run segments, in-record connections, equipment
 *     ports, raster lineWork vectors) serialize as JOINED STRINGS with
 *     backslash escaping of the component separators (the docmap codec
 *     discipline, separators , | ; : escaped at every join level):
 *       segments:  "x,y,z|x,y,z" per segment, semicolon-joined per run;
 *       connections: "id|at|domain|kind|body" per connection, semicolon-joined
 *                    (body: "equipmentId:portId" | "runId:end" |
 *                    "x,y,z");
 *       ports:     "id|kind|x|y|z|nominal|domain" per port (absent
 *                  optional slots encode as empty strings), semicolon-joined;
 *       lineWork:  "x1,y1,x2,y2" per vector, semicolon-joined.
 *     The decode is the exact mirror (split outer→inner, one unescape per
 *     level) — the VALUES round-trip byte-exactly; the IFC REPRESENTATION
 *     is a flattened property string, not native IFC structure (the
 *     typed LOSSY classification of the interop report, interop/toolsets.ts).
 *
 * RECONCILE SEMANTICS (import; the two established P014/P018 disciplines
 * composed):
 *   - DomainId matching an EXISTING record of the same kind →
 *     CLASSIFY-ONLY (the document authority stays; per-field exact/lossy
 *     classification of source-vs-document differences — the docmap
 *     discipline);
 *   - well-formed DomainId (non-empty, ≤ 16 chars) not colliding → CREATE
 *     PRESERVING the declared id (the tls- id IS the canonical identity —
 *     LOCK-019, the importmap element discipline: a foreign file never
 *     DICTATES identity, but a declared Offisos identity is honored);
 *   - malformed/absent DomainId → CREATE with a MINTED id when a mint is
 *     supplied (the document mints), else the DRY classification row;
 *   - malformed record data (any decode/validation failure) → a typed
 *     UNSUPPORTED row — never silently dropped, never guessed (LOCK-007).
 *   Every creation re-validates through the SAME single grammar
 *   (toolsets/records.ts normalizeToolsetRecord) before it can become a
 *   document edit.
 *
 * Pure + engine-free (LOCK-018: this directory is guarded by the
 * no-forbidden-imports scan).
 */

import { createHash } from "node:crypto";
import type { SpecializedRecord } from "../contracts/caddocument.js";
import type { IfcParsedToolsetRecord, IfcToolsetRecord } from "../contracts/ifc.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { normalizeToolsetRecord } from "../toolsets/records.js";
import { ifcGuidFor } from "./identity.js";
import {
  classifyValue,
  exactField,
  summarizeReports,
  unsupportedField,
  type IfcElementReport,
  type IfcFieldResult,
} from "./report.js";

// ---------------------------------------------------------------------------
// The closed exchange vocabulary.
// ---------------------------------------------------------------------------

/** The DomainKind of an `mep.run` exchange record. */
export const TOOLSETS_IFC_KIND_MEP_RUN = "toolsets.mep.run" as const;
/** The DomainKind of a `mech.equipment` exchange record. */
export const TOOLSETS_IFC_KIND_MECH_EQUIPMENT = "toolsets.mech.equipment" as const;
/** The DomainKind of a `raster.source` exchange record. */
export const TOOLSETS_IFC_KIND_RASTER_SOURCE = "toolsets.raster.source" as const;
/** The DomainKind of a `raster.reference` exchange record. */
export const TOOLSETS_IFC_KIND_RASTER_REFERENCE = "toolsets.raster.reference" as const;

/** The closed toolsets DomainKind vocabulary (the adapter discriminates by
 *  exactly these values; anything else stays a documentation-side record
 *  and classifies as an unknown-kind row there). */
export const TOOLSETS_IFC_KINDS: readonly string[] = [
  TOOLSETS_IFC_KIND_MEP_RUN,
  TOOLSETS_IFC_KIND_MECH_EQUIPMENT,
  TOOLSETS_IFC_KIND_RASTER_SOURCE,
  TOOLSETS_IFC_KIND_RASTER_REFERENCE,
];

/** Is a parsed group identity a toolsets carrier record? */
export function isToolsetsDomainKind(identity: Readonly<Record<string, unknown>> | null): boolean {
  if (identity === null || typeof identity !== "object") return false;
  const kind = identity["DomainKind"];
  return typeof kind === "string" && (TOOLSETS_IFC_KINDS as readonly string[]).includes(kind);
}

/** The specialized-record id length bound (toolsets/records.ts discipline). */
const TOOLSET_ID_MAX = 16;

// ---------------------------------------------------------------------------
// The joined-string codec (the docmap discipline: escape every component,
// join on one separator per structure level, split outer→inner with one
// unescape per level).
// ---------------------------------------------------------------------------

const SEPARATORS = [",", "|", ";", ":"] as const;

/** Escape a literal component (backslash + every separator). */
function esc(value: string): string {
  let out = value.split("\\").join("\\\\");
  for (const sep of SEPARATORS) {
    out = out.split(sep).join(`\\${sep}`);
  }
  return out;
}

/** Split an escaped joined string on ONE separator (unescaped only). */
function splitEsc(value: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "\\") {
      const next = value[i + 1];
      if (next !== undefined && (next === "\\" || (SEPARATORS as readonly string[]).includes(next))) {
        current += next;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === sep) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Join escaped components on ONE separator (one structure level). */
function encJoin(values: readonly string[], sep: string): string {
  return values.map(esc).join(sep);
}

// ---------------------------------------------------------------------------
// The scalar codec (exact-reversible number encoding + strict readers).
// ---------------------------------------------------------------------------

/** Encode a finite number as its exact-reversible string form. */
function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`toolsets carrier: non-finite number ${String(value)}`);
  }
  return String(value);
}

/** Decode a carrier number field (strict: string, non-empty, finite). */
function numOf(value: unknown, path: string): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}: expected an encoded number string (got ${JSON.stringify(value)})`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${path}: '${value}' does not decode to a finite number`);
  }
  return n;
}

/** Decode a carrier string field (strict). */
function strOf(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path}: expected a string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Decode an optional carrier string field (absent → undefined). */
function optStrOf(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return strOf(value, path);
}

/** Decode an optional carrier encoded-number field (absent → undefined). */
function optNumOf(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return numOf(value, path);
}

/** Decode a carrier boolean field (strict). */
function boolOf(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path}: expected a boolean (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** The decoded fields of a record (unknown until validated). */
type Fields = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Encode: SpecializedRecord → IfcToolsetRecord (per kind).
// ---------------------------------------------------------------------------

function recordOf(
  id: string,
  kind: string,
  name: string,
  fields: Readonly<Record<string, string | number | boolean>>,
): IfcToolsetRecord {
  return {
    guid: ifcGuidFor(id),
    name,
    identity: { DomainId: id, DomainKind: kind },
    fields,
  };
}

function encodeMepRun(record: Extract<SpecializedRecord, { kind: "mep.run" }>): IfcToolsetRecord {
  const data = record.data;
  const fields: Record<string, string | number | boolean> = {
    Domain: data.domain,
    Shape: data.shape,
    NominalSize: num(data.nominalSize),
    Segments: encJoin(
      data.segments.map((seg) =>
        encJoin(
          [encJoin([num(seg.start.x), num(seg.start.y), num(seg.start.z)], ","), encJoin([num(seg.end.x), num(seg.end.y), num(seg.end.z)], ",")],
          "|",
        ),
      ),
      ";",
    ),
  };
  if (data.insulationMm !== undefined) fields["InsulationMm"] = num(data.insulationMm);
  if (data.name !== undefined) fields["Name"] = data.name;
  if (data.connections !== undefined && data.connections.length > 0) {
    fields["Connections"] = encJoin(
      data.connections.map((conn) => {
        let body: string;
        switch (conn.target.kind) {
          case "equipment":
            body = encJoin([conn.target.equipmentId, conn.target.portId], ":");
            break;
          case "run":
            body = encJoin([conn.target.runId, conn.target.end], ":");
            break;
          case "endpoint":
            body = encJoin([num(conn.target.point.x), num(conn.target.point.y), num(conn.target.point.z)], ",");
            break;
        }
        return encJoin([conn.id, conn.at, conn.domain, conn.target.kind, body], "|");
      }),
      ";",
    );
  }
  return recordOf(record.id, TOOLSETS_IFC_KIND_MEP_RUN, data.name ?? record.id, fields);
}

function encodeMechEquipment(record: Extract<SpecializedRecord, { kind: "mech.equipment" }>): IfcToolsetRecord {
  const data = record.data;
  const fields: Record<string, string | number | boolean> = {
    Kind: data.kind,
    OriginX: num(data.origin.x),
    OriginY: num(data.origin.y),
    OriginZ: num(data.origin.z),
  };
  if (data.name !== undefined) fields["Name"] = data.name;
  if (data.rotationDeg !== undefined) fields["RotationDeg"] = num(data.rotationDeg);
  if (data.ports.length > 0) {
    fields["Ports"] = encJoin(
      data.ports.map((port) =>
        encJoin(
          [
            port.id,
            port.kind,
            num(port.position.x),
            num(port.position.y),
            num(port.position.z),
            port.nominal !== undefined ? num(port.nominal) : "",
            port.domain !== undefined ? port.domain : "",
          ],
          "|",
        ),
      ),
      ";",
    );
  }
  return recordOf(record.id, TOOLSETS_IFC_KIND_MECH_EQUIPMENT, data.name ?? record.id, fields);
}

function encodeRasterSource(record: Extract<SpecializedRecord, { kind: "raster.source" }>): IfcToolsetRecord {
  const data = record.data;
  const fields: Record<string, string | number | boolean> = {
    SourceRef: data.sourceRef,
    ContentDigest: data.contentDigest,
    WidthPx: num(data.widthPx),
    HeightPx: num(data.heightPx),
  };
  if (data.lineWork !== undefined && data.lineWork.length > 0) {
    fields["LineWork"] = encJoin(
      data.lineWork.map((v) => encJoin([num(v.x1), num(v.y1), num(v.x2), num(v.y2)], ",")),
      ";",
    );
  }
  return recordOf(record.id, TOOLSETS_IFC_KIND_RASTER_SOURCE, data.sourceRef, fields);
}

function encodeRasterReference(record: Extract<SpecializedRecord, { kind: "raster.reference" }>): IfcToolsetRecord {
  const data = record.data;
  const fields: Record<string, string | number | boolean> = {
    SourceRef: data.sourceRef,
    DeclaredDigest: data.declaredDigest,
    OriginX: num(data.transform.origin.x),
    OriginY: num(data.transform.origin.y),
    Scale: num(data.transform.scale),
    RotationDeg: num(data.transform.rotationDeg),
    Visible: data.visible,
  };
  if (data.clipping !== undefined) {
    fields["ClipX"] = num(data.clipping.x);
    fields["ClipY"] = num(data.clipping.y);
    fields["ClipW"] = num(data.clipping.w);
    fields["ClipH"] = num(data.clipping.h);
  }
  if (data.layer !== undefined) fields["Layer"] = data.layer;
  return recordOf(record.id, TOOLSETS_IFC_KIND_RASTER_REFERENCE, data.sourceRef, fields);
}

/** Encode one specialized record (kind-dispatched; throws on a foreign kind). */
export function encodeToolsetRecord(record: SpecializedRecord): IfcToolsetRecord {
  switch (record.kind) {
    case "mep.run":
      return encodeMepRun(record);
    case "mech.equipment":
      return encodeMechEquipment(record);
    case "raster.source":
      return encodeRasterSource(record);
    case "raster.reference":
      return encodeRasterReference(record);
  }
}

/** The toolsets export outcome (fixed kind-group order, deterministic). */
export interface IfcToolsetsExport {
  /** One IfcToolsetRecord per specialized record, fixed kind-group order
   *  (mep runs → mechanical equipment → raster sources → raster
   *  references), each kind in document order (record id ascending). */
  readonly groups: readonly IfcToolsetRecord[];
  readonly counts: {
    readonly mepRuns: number;
    readonly equipment: number;
    readonly rasterSources: number;
    readonly rasterReferences: number;
  };
}

/** Build the IfcGroup exchange records for the specialized records.
 *  Deterministic: a pure function of the records (fixed order, fixed
 *  encoding); repeated calls over equal inputs produce byte-equal output. */
export function buildIfcToolsetsExport(specialized: readonly SpecializedRecord[]): IfcToolsetsExport {
  const runs = specialized.filter((r): r is Extract<SpecializedRecord, { kind: "mep.run" }> => r.kind === "mep.run");
  const equipment = specialized.filter((r): r is Extract<SpecializedRecord, { kind: "mech.equipment" }> => r.kind === "mech.equipment");
  const sources = specialized.filter((r): r is Extract<SpecializedRecord, { kind: "raster.source" }> => r.kind === "raster.source");
  const references = specialized.filter((r): r is Extract<SpecializedRecord, { kind: "raster.reference" }> => r.kind === "raster.reference");
  const groups = [...runs, ...equipment, ...sources, ...references].map(encodeToolsetRecord);
  return {
    groups,
    counts: {
      mepRuns: runs.length,
      equipment: equipment.length,
      rasterSources: sources.length,
      rasterReferences: references.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Decode: fields → the record data grammar (strict; every failure throws a
// descriptive Error the reconcile maps to a typed unsupported row).
// ---------------------------------------------------------------------------

function decodePoint3(values: readonly string[], path: string): { x: number; y: number; z: number } {
  if (values.length !== 3) {
    throw new Error(`${path}: expected 3 coordinates (got ${values.length})`);
  }
  return { x: numOf(values[0], `${path}.x`), y: numOf(values[1], `${path}.y`), z: numOf(values[2], `${path}.z`) };
}

function decodeMepRunData(fields: Fields): unknown {
  const segments = splitEsc(strOf(fields["Segments"], "mep.run.Segments"), ";").map((seg, i) => {
    const parts = splitEsc(seg, "|");
    if (parts.length !== 2) {
      throw new Error(`mep.run.Segments[${i}]: expected 'start|end' (got ${parts.length} parts)`);
    }
    return {
      start: decodePoint3(splitEsc(parts[0]!, ","), `mep.run.Segments[${i}].start`),
      end: decodePoint3(splitEsc(parts[1]!, ","), `mep.run.Segments[${i}].end`),
    };
  });
  const data: Record<string, unknown> = {
    domain: strOf(fields["Domain"], "mep.run.Domain"),
    shape: strOf(fields["Shape"], "mep.run.Shape"),
    nominalSize: numOf(fields["NominalSize"], "mep.run.NominalSize"),
    segments,
  };
  if (fields["InsulationMm"] !== undefined) data["insulationMm"] = numOf(fields["InsulationMm"], "mep.run.InsulationMm");
  if (fields["Name"] !== undefined) data["name"] = strOf(fields["Name"], "mep.run.Name");
  if (fields["Connections"] !== undefined) {
    data["connections"] = splitEsc(strOf(fields["Connections"], "mep.run.Connections"), ";").map((conn, i) => {
      const parts = splitEsc(conn, "|");
      if (parts.length !== 5) {
        throw new Error(`mep.run.Connections[${i}]: expected 'id|at|domain|kind|body' (got ${parts.length} parts)`);
      }
      const [id, at, domain, kind, body] = parts as [string, string, string, string, string];
      if (id.length === 0 || at.length === 0 || domain.length === 0 || kind.length === 0 || body.length === 0) {
        throw new Error(`mep.run.Connections[${i}]: empty connection component`);
      }
      let target: { kind: string } & Record<string, unknown>;
      switch (kind) {
        case "equipment": {
          const t = splitEsc(body, ":");
          if (t.length !== 2) throw new Error(`mep.run.Connections[${i}].target: expected 'equipmentId:portId'`);
          target = { kind: "equipment", equipmentId: t[0]!, portId: t[1]! };
          break;
        }
        case "run": {
          const t = splitEsc(body, ":");
          if (t.length !== 2) throw new Error(`mep.run.Connections[${i}].target: expected 'runId:end'`);
          target = { kind: "run", runId: t[0]!, end: t[1]! };
          break;
        }
        case "endpoint": {
          target = { kind: "endpoint", point: decodePoint3(splitEsc(body, ","), `mep.run.Connections[${i}].target.point`) };
          break;
        }
        default:
          throw new Error(`mep.run.Connections[${i}].target: unknown kind '${kind}'`);
      }
      return { id, at, domain, target };
    });
  }
  return data;
}

function decodeMechEquipmentData(fields: Fields): unknown {
  const data: Record<string, unknown> = {
    kind: strOf(fields["Kind"], "mech.equipment.Kind"),
    origin: {
      x: numOf(fields["OriginX"], "mech.equipment.OriginX"),
      y: numOf(fields["OriginY"], "mech.equipment.OriginY"),
      z: numOf(fields["OriginZ"], "mech.equipment.OriginZ"),
    },
    ports: [],
  };
  if (fields["Name"] !== undefined) data["name"] = strOf(fields["Name"], "mech.equipment.Name");
  if (fields["RotationDeg"] !== undefined) data["rotationDeg"] = numOf(fields["RotationDeg"], "mech.equipment.RotationDeg");
  if (fields["Ports"] !== undefined) {
    data["ports"] = splitEsc(strOf(fields["Ports"], "mech.equipment.Ports"), ";").map((port, i) => {
      const parts = splitEsc(port, "|");
      if (parts.length !== 7) {
        throw new Error(`mech.equipment.Ports[${i}]: expected 'id|kind|x|y|z|nominal|domain' (got ${parts.length} parts)`);
      }
      const [id, kind, xs, ys, zs, nominal, domain] = parts as [string, string, string, string, string, string, string];
      if (id.length === 0 || kind.length === 0) {
        throw new Error(`mech.equipment.Ports[${i}]: empty id or kind`);
      }
      const decoded: Record<string, unknown> = {
        id,
        kind,
        position: {
          x: numOf(xs, `mech.equipment.Ports[${i}].x`),
          y: numOf(ys, `mech.equipment.Ports[${i}].y`),
          z: numOf(zs, `mech.equipment.Ports[${i}].z`),
        },
      };
      if (nominal.length > 0) decoded["nominal"] = numOf(nominal, `mech.equipment.Ports[${i}].nominal`);
      if (domain.length > 0) decoded["domain"] = domain;
      return decoded;
    });
  }
  return data;
}

function decodeRasterSourceData(fields: Fields): unknown {
  const data: Record<string, unknown> = {
    sourceRef: strOf(fields["SourceRef"], "raster.source.SourceRef"),
    contentDigest: strOf(fields["ContentDigest"], "raster.source.ContentDigest"),
    widthPx: numOf(fields["WidthPx"], "raster.source.WidthPx"),
    heightPx: numOf(fields["HeightPx"], "raster.source.HeightPx"),
  };
  if (fields["LineWork"] !== undefined) {
    data["lineWork"] = splitEsc(strOf(fields["LineWork"], "raster.source.LineWork"), ";").map((v, i) => {
      const parts = splitEsc(v, ",");
      if (parts.length !== 4) {
        throw new Error(`raster.source.LineWork[${i}]: expected 'x1,y1,x2,y2' (got ${parts.length} parts)`);
      }
      return {
        x1: numOf(parts[0], `raster.source.LineWork[${i}].x1`),
        y1: numOf(parts[1], `raster.source.LineWork[${i}].y1`),
        x2: numOf(parts[2], `raster.source.LineWork[${i}].x2`),
        y2: numOf(parts[3], `raster.source.LineWork[${i}].y2`),
      };
    });
  }
  return data;
}

function decodeRasterReferenceData(fields: Fields): unknown {
  const data: Record<string, unknown> = {
    sourceRef: strOf(fields["SourceRef"], "raster.reference.SourceRef"),
    declaredDigest: strOf(fields["DeclaredDigest"], "raster.reference.DeclaredDigest"),
    transform: {
      origin: {
        x: numOf(fields["OriginX"], "raster.reference.OriginX"),
        y: numOf(fields["OriginY"], "raster.reference.OriginY"),
      },
      scale: numOf(fields["Scale"], "raster.reference.Scale"),
      rotationDeg: numOf(fields["RotationDeg"], "raster.reference.RotationDeg"),
    },
    visible: boolOf(fields["Visible"], "raster.reference.Visible"),
  };
  if (fields["ClipX"] !== undefined) {
    data["clipping"] = {
      x: numOf(fields["ClipX"], "raster.reference.ClipX"),
      y: numOf(fields["ClipY"], "raster.reference.ClipY"),
      w: numOf(fields["ClipW"], "raster.reference.ClipW"),
      h: numOf(fields["ClipH"], "raster.reference.ClipH"),
    };
  }
  if (fields["Layer"] !== undefined) data["layer"] = strOf(fields["Layer"], "raster.reference.Layer");
  return data;
}

// ---------------------------------------------------------------------------
// Reconcile: parsed IfcGroup records → canonical records + the typed
// classification report (the docmap discipline).
// ---------------------------------------------------------------------------

/** The mint contract for toolsets record creation (null = the DRY loop). */
export interface IfcToolsetsMint {
  /** Mints a fresh canonical `tls-NNNNNN` identity (document-owned). */
  readonly specialized: () => string;
}

/** The toolsets reconcile outcome. */
export interface IfcToolsetsReconcileOutcome {
  /** The CREATION drafts (id-preserved or minted) — the caller turns these
   *  into addSpecialized edits (they re-validate through the SAME grammar
   *  at execute). Existing matches are classify-only (never drafts). */
  readonly records: readonly SpecializedRecord[];
  /** The per-record classification report (the report.ts vocabulary). */
  readonly report: {
    readonly records: readonly IfcElementReport[];
    readonly summary: ReturnType<typeof summarizeReports>;
  };
  /** Canonical JSON + SHA-256 of the report (determinism artifact). */
  readonly reportHash: string;
}

/** Canonical JSON + SHA-256 content hash of a toolsets report. */
export function ifcToolsetsReportHash(report: IfcToolsetsReconcileOutcome["report"]): string {
  return createHash("sha256").update(canonicalStringify(report)).digest("hex");
}

function recordKindOf(domainKind: string): "mep.run" | "mech.equipment" | "raster.source" | "raster.reference" | null {
  switch (domainKind) {
    case TOOLSETS_IFC_KIND_MEP_RUN:
      return "mep.run";
    case TOOLSETS_IFC_KIND_MECH_EQUIPMENT:
      return "mech.equipment";
    case TOOLSETS_IFC_KIND_RASTER_SOURCE:
      return "raster.source";
    case TOOLSETS_IFC_KIND_RASTER_REFERENCE:
      return "raster.reference";
    default:
      return null;
  }
}

function toolsetOfKind(kind: "mep.run" | "mech.equipment" | "raster.source" | "raster.reference"): "mep" | "mechanical" | "raster" {
  switch (kind) {
    case "mep.run":
      return "mep";
    case "mech.equipment":
      return "mechanical";
    case "raster.source":
    case "raster.reference":
      return "raster";
  }
}

function decodeData(kind: "mep.run" | "mech.equipment" | "raster.source" | "raster.reference", fields: Fields): unknown {
  switch (kind) {
    case "mep.run":
      return decodeMepRunData(fields);
    case "mech.equipment":
      return decodeMechEquipmentData(fields);
    case "raster.source":
      return decodeRasterSourceData(fields);
    case "raster.reference":
      return decodeRasterReferenceData(fields);
  }
}

/** Field-level comparison of the expected (re-encoded existing record)
 *  against the parsed pset values (the docmap compareFields discipline). */
function compareFields(
  expected: Readonly<Record<string, string | number | boolean>>,
  actual: Fields,
): IfcFieldResult[] {
  const fields: IfcFieldResult[] = [];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (expectedValue === undefined) {
      fields.push({ field: key, classification: "lossy", actual: actualValue as string | number | boolean, note: "field added by the source" });
      continue;
    }
    if (actualValue === undefined) {
      fields.push({ field: key, classification: "lossy", expected: expectedValue, note: "field absent in the source" });
      continue;
    }
    fields.push(classifyValue(key, expectedValue, actualValue));
  }
  return fields;
}

/** Reconcile the parsed toolsets IfcGroup records against the existing
 *  specialized records (see the module header for the semantics). Pure +
 *  deterministic. */
export function reconcileIfcToolsets(
  parsed: readonly IfcParsedToolsetRecord[],
  existing: readonly SpecializedRecord[],
  mint: IfcToolsetsMint | null,
): IfcToolsetsReconcileOutcome {
  const existingById = new Map(existing.map((r) => [r.id, r] as const));
  const rows: IfcElementReport[] = [];
  const records: SpecializedRecord[] = [];

  for (const raw of parsed) {
    const name = raw.name;
    const identity = raw.identity;
    const domainKind = identity !== null && typeof identity === "object"
      ? (identity as Readonly<Record<string, unknown>>)["DomainKind"]
      : undefined;
    const domainId = identity !== null && typeof identity === "object"
      ? (identity as Readonly<Record<string, unknown>>)["DomainId"]
      : undefined;
    const kind = typeof domainKind === "string" ? recordKindOf(domainKind) : null;
    if (kind === null) {
      rows.push({
        canonicalId: null,
        globalId: raw.globalId,
        ifcClass: `IfcGroup(${typeof domainKind === "string" ? domainKind : "unknown"})`,
        name,
        action: "unsupported",
        fields: [unsupportedField("identity", "the group carries no Offisos identity or a DomainKind outside the toolsets exchange vocabulary")],
      });
      continue;
    }
    if (typeof domainId !== "string") {
      rows.push({
        canonicalId: null,
        globalId: raw.globalId,
        ifcClass: `IfcGroup(${domainKind})`,
        name,
        action: "unsupported",
        fields: [unsupportedField("identity", "the toolsets group carries no DomainId")],
      });
      continue;
    }

    // --- the EXISTING match: classify-only (the document authority stays) --
    const existingRecord = existingById.get(domainId);
    if (existingRecord !== undefined) {
      if (existingRecord.kind !== kind) {
        rows.push({
          canonicalId: domainId,
          globalId: raw.globalId,
          ifcClass: `IfcGroup(${domainKind})`,
          name,
          action: "unsupported",
          fields: [unsupportedField("identity", `the declared DomainKind '${domainKind}' conflicts with the existing record kind '${existingRecord.kind}'`)],
        });
        continue;
      }
      const expected = encodeToolsetRecord(existingRecord).fields;
      const fields = compareFields(expected, raw.fields);
      const hasLoss = fields.some((f) => f.classification === "lossy" || f.classification === "unsupported");
      rows.push({
        canonicalId: domainId,
        globalId: raw.globalId,
        ifcClass: `IfcGroup(${domainKind})`,
        name,
        action: hasLoss ? "reconciled" : "unchanged",
        fields,
      });
      continue;
    }

    // --- creation (preserved identity when well-formed, else minted) -------
    const trimmed = domainId.trim();
    const preservedId = trimmed.length > 0 && trimmed.length <= TOOLSET_ID_MAX ? trimmed : null;
    if (mint === null) {
      // DRY path: classify the carried fields exact (parse evidence) and
      // record the source identity as the row id (the docmap DRY pattern).
      rows.push({
        canonicalId: preservedId ?? domainId,
        globalId: raw.globalId,
        ifcClass: `IfcGroup(${domainKind})`,
        name,
        action: "created",
        fields: Object.keys(raw.fields).sort().map((key) => exactField(key)),
      });
      continue;
    }
    const targetId = preservedId ?? mint.specialized();
    try {
      const record = normalizeToolsetRecord({
        id: targetId,
        toolset: toolsetOfKind(kind),
        kind,
        data: decodeData(kind, raw.fields),
      });
      records.push(record);
      rows.push({
        canonicalId: record.id,
        globalId: raw.globalId,
        ifcClass: `IfcGroup(${domainKind})`,
        name,
        action: "created",
        fields: Object.keys(raw.fields).sort().map((key) => exactField(key)),
      });
    } catch (e) {
      rows.push({
        canonicalId: null,
        globalId: raw.globalId,
        ifcClass: `IfcGroup(${domainKind})`,
        name,
        action: "unsupported",
        fields: [unsupportedField("record", (e as Error).message)],
      });
    }
  }

  const report = { records: rows, summary: summarizeReports(rows) };
  return { records, report, reportHash: ifcToolsetsReportHash(report) };
}
