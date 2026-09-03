/**
 * CAD-PARITY-018 (Issue #118) — the specialized-record validators (the
 * validatePropertyDefRecord precedent, total + deterministic: reject
 * typed, never guess). Everything here is pure data validation over the
 * contracts/toolsets.ts grammar; the CADDocument layer (and ONLY it)
 * calls these through normalizeToolsetRecord when applying
 * addSpecialized/setSpecializedRecord edits, and the App API handlers
 * pre-validate drafts with the SAME functions (a failing command never
 * burns a tls- identity).
 *
 * Failure codes (contracts/toolsets.ts documents the full table):
 *  - toolset_bad_payload   — malformed fields, wrong vocabulary, wrong types
 *  - toolset_out_of_bounds — count/size bounds exceeded
 *  - toolset_route_invalid — MEP routing grammar violations (continuity,
 *                            duct orthogonality)
 */

import {
  TOOLSETS_CONDUIT_NOMINAL_MAX_MM,
  TOOLSETS_CONDUIT_NOMINAL_MIN_MM,
  TOOLSETS_DUCT_NOMINAL_MAX_MM,
  TOOLSETS_DUCT_NOMINAL_MIN_MM,
  TOOLSETS_MAX_CONNECTIONS_PER_RUN,
  TOOLSETS_MAX_EQUIPMENT,
  TOOLSETS_MAX_LINEWORK_VECTORS,
  TOOLSETS_MAX_PORTS_PER_EQUIPMENT,
  TOOLSETS_MAX_RASTER_REFERENCES,
  TOOLSETS_MAX_RASTER_SOURCES,
  TOOLSETS_MAX_RUNS,
  TOOLSETS_MAX_SEGMENTS_PER_RUN,
  TOOLSETS_PIPE_NOMINAL_MAX_MM,
  TOOLSETS_PIPE_NOMINAL_MIN_MM,
  TOOLSETS_RASTER_SCALE_MAX,
  TOOLSETS_RASTER_SCALE_MIN,
  type MechEquipmentData,
  type MechEquipmentKind,
  type MechPortKind,
  type MepDomain,
  type MepRunData,
  type MepRunShape,
  type RasterReferenceData,
  type RasterSourceData,
} from "../contracts/toolsets.js";
import type { SpecializedRecord, SpecializedRecordKind, SpecializedToolset } from "../contracts/caddocument.js";
import { toolsetErr } from "./errors.js";

// ---------------------------------------------------------------------------
// Shared strict value helpers (LOCK-007: reject, never guess).
// ---------------------------------------------------------------------------

const TOOLSET_ID_MAX = 64;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw toolsetErr("toolset_bad_payload", `${path} must be an object`);
  }
  return value;
}

function optionalBoundedString(value: unknown, path: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw toolsetErr("toolset_bad_payload", `${path} must be a string when present`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw toolsetErr("toolset_bad_payload", `${path} must be a trimmed non-empty string (max ${max} chars)`);
  }
  return trimmed;
}

function requireBoundedString(value: unknown, path: string, max: number): string {
  const s = optionalBoundedString(value, path, max);
  if (s === undefined) throw toolsetErr("toolset_bad_payload", `${path} is required (max ${max} chars)`);
  return s;
}

function requireFinite(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) {
    throw toolsetErr("toolset_bad_payload", `${path} must be a finite number`);
  }
  return value;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
  const n = requireFinite(value, path);
  if (n < 0) throw toolsetErr("toolset_bad_payload", `${path} must be ≥ 0 (got ${n})`);
  return n;
}

function requirePositiveFinite(value: unknown, path: string): number {
  const n = requireFinite(value, path);
  if (n <= 0) throw toolsetErr("toolset_bad_payload", `${path} must be > 0 (got ${n})`);
  return n;
}

/** A plain-object 3D point {x, y, z} with finite numbers. */
function requirePoint3(value: unknown, path: string): { x: number; y: number; z: number } {
  const p = requireObject(value, path);
  for (const key of ["x", "y", "z"] as const) {
    if (!isFiniteNumber(p[key])) {
      throw toolsetErr("toolset_bad_payload", `${path}.${key} must be a finite number`);
    }
  }
  return { x: p.x as number, y: p.y as number, z: p.z as number };
}

function checkKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw toolsetErr("toolset_bad_payload", `${path}: unknown field '${key}' (allowed: ${allowed.join(", ")})`);
    }
  }
}

function nominalBoundsOf(domain: MepDomain): { min: number; max: number } {
  switch (domain) {
    case "duct":
      return { min: TOOLSETS_DUCT_NOMINAL_MIN_MM, max: TOOLSETS_DUCT_NOMINAL_MAX_MM };
    case "pipe":
      return { min: TOOLSETS_PIPE_NOMINAL_MIN_MM, max: TOOLSETS_PIPE_NOMINAL_MAX_MM };
    case "conduit":
      return { min: TOOLSETS_CONDUIT_NOMINAL_MIN_MM, max: TOOLSETS_CONDUIT_NOMINAL_MAX_MM };
  }
}

// ---------------------------------------------------------------------------
// MEP run validation (structure + the routing grammar).
// ---------------------------------------------------------------------------

const MEP_RUN_KEYS = ["domain", "shape", "nominalSize", "insulationMm", "name", "segments", "connections"] as const;
const MEP_SEGMENT_KEYS = ["start", "end"] as const;
const MEP_CONNECTION_KEYS = ["id", "at", "target", "domain"] as const;

/** Structural + routing validation of one `mep.run` data payload. The
 *  routing grammar (LOCK-007 — typed, never a guess):
 *   - segments are CONTINUOUS (each segment's end is exactly the next
 *     segment's start) and non-degenerate (non-zero length);
 *   - DUCT runs are ORTHOGONAL (every segment is axis-aligned: exactly one
 *     nonzero axis component); pipe/conduit allow arbitrary headings.
 *  Table-size bounds (max runs per document) are enforced by the document
 *  layer — the pure validator has no table access. */
export function validateMepRunData(data: unknown): MepRunData {
  const d = requireObject(data, "mep.run data");
  checkKeys(d, MEP_RUN_KEYS, "mep.run data");
  if (d.domain !== "duct" && d.domain !== "pipe" && d.domain !== "conduit") {
    throw toolsetErr("toolset_bad_payload", "mep.run domain must be 'duct' | 'pipe' | 'conduit'");
  }
  if (d.shape !== "round" && d.shape !== "rect") {
    throw toolsetErr("toolset_bad_payload", "mep.run shape must be 'round' | 'rect'");
  }
  const domain = d.domain as MepDomain;
  const shape = d.shape as MepRunShape;
  const bounds = nominalBoundsOf(domain);
  const nominalSize = requireFinite(d.nominalSize, "mep.run nominalSize");
  if (nominalSize < bounds.min || nominalSize > bounds.max) {
    throw toolsetErr(
      "toolset_bad_payload",
      `mep.run nominalSize for domain '${domain}' must be within [${bounds.min}, ${bounds.max}] mm (got ${nominalSize})`,
    );
  }
  let insulationMm: number | undefined;
  if (d.insulationMm !== undefined) {
    insulationMm = requireNonNegativeFinite(d.insulationMm, "mep.run insulationMm");
  }
  const name = optionalBoundedString(d.name, "mep.run name", 60);
  if (!Array.isArray(d.segments) || d.segments.length < 1) {
    throw toolsetErr("toolset_bad_payload", "mep.run segments must be a non-empty array");
  }
  if (d.segments.length > TOOLSETS_MAX_SEGMENTS_PER_RUN) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `mep.run exceeds the ${TOOLSETS_MAX_SEGMENTS_PER_RUN}-segment bound (got ${d.segments.length})`,
    );
  }
  const segments = d.segments.map((raw, i) => {
    const s = requireObject(raw, `mep.run segments[${i}]`);
    checkKeys(s, MEP_SEGMENT_KEYS, `mep.run segments[${i}]`);
    return { start: requirePoint3(s.start, `mep.run segments[${i}].start`), end: requirePoint3(s.end, `mep.run segments[${i}].end`) };
  });
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const dx = seg.end.x - seg.start.x;
    const dy = seg.end.y - seg.start.y;
    const dz = seg.end.z - seg.start.z;
    if (dx === 0 && dy === 0 && dz === 0) {
      throw toolsetErr("toolset_route_invalid", `mep.run segments[${i}] is degenerate (start equals end)`);
    }
    if (domain === "duct") {
      const nonzero = [dx, dy, dz].filter((c) => c !== 0).length;
      if (nonzero !== 1) {
        throw toolsetErr(
          "toolset_route_invalid",
          `mep.run segments[${i}] is not axis-aligned (duct runs require orthogonal routing — exactly one nonzero axis component)`,
        );
      }
    }
    if (i + 1 < segments.length) {
      const next = segments[i + 1]!;
      if (next.start.x !== seg.end.x || next.start.y !== seg.end.y || next.start.z !== seg.end.z) {
        throw toolsetErr(
          "toolset_route_invalid",
          `mep.run segments[${i + 1}].start must equal segments[${i}].end (continuous route)`,
        );
      }
    }
  }
  let connections: MepRunData["connections"];
  if (d.connections !== undefined) {
    if (!Array.isArray(d.connections)) {
      throw toolsetErr("toolset_bad_payload", "mep.run connections must be an array when present");
    }
    if (d.connections.length > TOOLSETS_MAX_CONNECTIONS_PER_RUN) {
      throw toolsetErr(
        "toolset_out_of_bounds",
        `mep.run exceeds the ${TOOLSETS_MAX_CONNECTIONS_PER_RUN}-connection bound (got ${d.connections.length})`,
      );
    }
    const seenIds = new Set<string>();
    connections = d.connections.map((raw, i) => {
      const c = requireObject(raw, `mep.run connections[${i}]`);
      checkKeys(c, MEP_CONNECTION_KEYS, `mep.run connections[${i}]`);
      const id = requireBoundedString(c.id, `mep.run connections[${i}].id`, 16);
      if (seenIds.has(id)) {
        throw toolsetErr("toolset_bad_payload", `mep.run connection id '${id}' is not unique within the run`);
      }
      seenIds.add(id);
      if (c.at !== "start" && c.at !== "end") {
        throw toolsetErr("toolset_bad_payload", `mep.run connections[${i}].at must be 'start' | 'end'`);
      }
      const t = requireObject(c.target, `mep.run connections[${i}].target`);
      if (t.kind === "equipment") {
        return {
          id,
          at: c.at as "start" | "end",
          target: {
            kind: "equipment" as const,
            equipmentId: requireBoundedString(t.equipmentId, `mep.run connections[${i}].target.equipmentId`, TOOLSET_ID_MAX),
            portId: requireBoundedString(t.portId, `mep.run connections[${i}].target.portId`, 16),
          },
          domain: requireConnectionDomain(c.domain, `mep.run connections[${i}]`),
        };
      }
      if (t.kind === "run") {
        if (t.end !== "start" && t.end !== "end") {
          throw toolsetErr("toolset_bad_payload", `mep.run connections[${i}].target.end must be 'start' | 'end'`);
        }
        return {
          id,
          at: c.at as "start" | "end",
          target: {
            kind: "run" as const,
            runId: requireBoundedString(t.runId, `mep.run connections[${i}].target.runId`, TOOLSET_ID_MAX),
            end: t.end as "start" | "end",
          },
          domain: requireConnectionDomain(c.domain, `mep.run connections[${i}]`),
        };
      }
      if (t.kind === "endpoint") {
        return {
          id,
          at: c.at as "start" | "end",
          target: { kind: "endpoint" as const, point: requirePoint3(t.point, `mep.run connections[${i}].target.point`) },
          domain: requireConnectionDomain(c.domain, `mep.run connections[${i}]`),
        };
      }
      throw toolsetErr(
        "toolset_bad_payload",
        `mep.run connections[${i}].target.kind must be 'equipment' | 'run' | 'endpoint' (got ${JSON.stringify(t.kind)})`,
      );
    });
  }
  return {
    domain,
    shape,
    nominalSize,
    ...(insulationMm !== undefined ? { insulationMm } : {}),
    ...(name !== undefined ? { name } : {}),
    segments,
    ...(connections !== undefined ? { connections } : {}),
  };
}

function requireConnectionDomain(value: unknown, path: string): MepDomain {
  if (value !== "duct" && value !== "pipe" && value !== "conduit") {
    throw toolsetErr("toolset_bad_payload", `${path}.domain must be 'duct' | 'pipe' | 'conduit'`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Mechanical equipment validation.
// ---------------------------------------------------------------------------

const MECH_EQUIPMENT_KEYS = ["kind", "name", "origin", "rotationDeg", "ports"] as const;
const MECH_PORT_KEYS = ["id", "kind", "position", "nominal", "domain"] as const;
const MECH_EQUIPMENT_KINDS: readonly MechEquipmentKind[] = ["machine", "pump", "fan", "ahu", "panel", "tank"];
const MECH_PORT_KINDS: readonly MechPortKind[] = ["supply", "return", "drain", "vent", "power", "signal"];

/** Structural validation of one `mech.equipment` data payload. Port ids
 *  are the deterministic ordinals p1..pN in array order (the run-local
 *  grammar — never document-minted). */
export function validateMechEquipmentData(data: unknown): MechEquipmentData {
  const d = requireObject(data, "mech.equipment data");
  checkKeys(d, MECH_EQUIPMENT_KEYS, "mech.equipment data");
  if (!MECH_EQUIPMENT_KINDS.includes(d.kind as MechEquipmentKind)) {
    throw toolsetErr(
      "toolset_bad_payload",
      `mech.equipment kind must be one of ${MECH_EQUIPMENT_KINDS.join(" | ")} (got ${JSON.stringify(d.kind)})`,
    );
  }
  const name = optionalBoundedString(d.name, "mech.equipment name", 60);
  const origin = requirePoint3(d.origin, "mech.equipment origin");
  let rotationDeg: number | undefined;
  if (d.rotationDeg !== undefined) {
    rotationDeg = requireFinite(d.rotationDeg, "mech.equipment rotationDeg");
  }
  if (!Array.isArray(d.ports)) {
    throw toolsetErr("toolset_bad_payload", "mech.equipment ports must be an array");
  }
  if (d.ports.length > TOOLSETS_MAX_PORTS_PER_EQUIPMENT) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `mech.equipment exceeds the ${TOOLSETS_MAX_PORTS_PER_EQUIPMENT}-port bound (got ${d.ports.length})`,
    );
  }
  const ports = d.ports.map((raw, i) => {
    const p = requireObject(raw, `mech.equipment ports[${i}]`);
    checkKeys(p, MECH_PORT_KEYS, `mech.equipment ports[${i}]`);
    const id = requireBoundedString(p.id, `mech.equipment ports[${i}].id`, 8);
    if (id !== `p${i + 1}`) {
      throw toolsetErr(
        "toolset_bad_payload",
        `mech.equipment ports[${i}].id must be the deterministic ordinal 'p${i + 1}' (got '${id}')`,
      );
    }
    if (!MECH_PORT_KINDS.includes(p.kind as MechPortKind)) {
      throw toolsetErr(
        "toolset_bad_payload",
        `mech.equipment ports[${i}].kind must be one of ${MECH_PORT_KINDS.join(" | ")} (got ${JSON.stringify(p.kind)})`,
      );
    }
    const position = requirePoint3(p.position, `mech.equipment ports[${i}].position`);
    let nominal: number | undefined;
    let domain: MepDomain | undefined;
    if (p.nominal !== undefined) {
      nominal = requirePositiveFinite(p.nominal, `mech.equipment ports[${i}].nominal`);
      if (p.domain === undefined) {
        throw toolsetErr(
          "toolset_bad_payload",
          `mech.equipment ports[${i}].nominal requires the connector domain (duct | pipe | conduit)`,
        );
      }
    }
    if (p.domain !== undefined) {
      domain = requireConnectionDomain(p.domain, `mech.equipment ports[${i}]`);
    }
    if (domain !== undefined && nominal !== undefined) {
      const bounds = nominalBoundsOf(domain);
      if (nominal < bounds.min || nominal > bounds.max) {
        throw toolsetErr(
          "toolset_bad_payload",
          `mech.equipment ports[${i}].nominal for domain '${domain}' must be within [${bounds.min}, ${bounds.max}] mm (got ${nominal})`,
        );
      }
    }
    return {
      id,
      kind: p.kind as MechPortKind,
      position,
      ...(nominal !== undefined ? { nominal } : {}),
      ...(domain !== undefined ? { domain } : {}),
    };
  });
  return {
    kind: d.kind as MechEquipmentKind,
    ...(name !== undefined ? { name } : {}),
    origin,
    ...(rotationDeg !== undefined ? { rotationDeg } : {}),
    ports,
  };
}

// ---------------------------------------------------------------------------
// Raster source/reference validation.
// ---------------------------------------------------------------------------

const RASTER_SOURCE_KEYS = ["sourceRef", "contentDigest", "widthPx", "heightPx", "lineWork"] as const;
const RASTER_LINE_KEYS = ["x1", "y1", "x2", "y2"] as const;
const RASTER_REFERENCE_KEYS = ["sourceRef", "declaredDigest", "transform", "clipping", "visible", "layer"] as const;
const RASTER_TRANSFORM_KEYS = ["origin", "scale", "rotationDeg"] as const;
const RASTER_CLIPPING_KEYS = ["x", "y", "w", "h"] as const;

/** Structural validation of one `raster.source` data payload (identity by
 *  reference + digest + pixel dimensions + the optional bounded lineWork
 *  vector set — the trace source). Source-Ref uniqueness among sources is
 *  enforced by the document layer (the pure validator has no table
 *  access). */
export function validateRasterSourceData(data: unknown): RasterSourceData {
  const d = requireObject(data, "raster.source data");
  checkKeys(d, RASTER_SOURCE_KEYS, "raster.source data");
  const sourceRef = requireBoundedString(d.sourceRef, "raster.source sourceRef", TOOLSET_ID_MAX);
  const contentDigest = requireBoundedString(d.contentDigest, "raster.source contentDigest", 128);
  const widthPx = requirePositiveFinite(d.widthPx, "raster.source widthPx");
  const heightPx = requirePositiveFinite(d.heightPx, "raster.source heightPx");
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx)) {
    throw toolsetErr("toolset_bad_payload", "raster.source widthPx/heightPx must be integers (pixels)");
  }
  let lineWork: RasterSourceData["lineWork"];
  if (d.lineWork !== undefined) {
    if (!Array.isArray(d.lineWork)) {
      throw toolsetErr("toolset_bad_payload", "raster.source lineWork must be an array when present");
    }
    if (d.lineWork.length > TOOLSETS_MAX_LINEWORK_VECTORS) {
      throw toolsetErr(
        "toolset_out_of_bounds",
        `raster.source lineWork exceeds the ${TOOLSETS_MAX_LINEWORK_VECTORS}-vector bound (got ${d.lineWork.length})`,
      );
    }
    lineWork = d.lineWork.map((raw, i) => {
      const v = requireObject(raw, `raster.source lineWork[${i}]`);
      checkKeys(v, RASTER_LINE_KEYS, `raster.source lineWork[${i}]`);
      return {
        x1: requireFinite(v.x1, `raster.source lineWork[${i}].x1`),
        y1: requireFinite(v.y1, `raster.source lineWork[${i}].y1`),
        x2: requireFinite(v.x2, `raster.source lineWork[${i}].x2`),
        y2: requireFinite(v.y2, `raster.source lineWork[${i}].y2`),
      };
    });
  }
  return {
    sourceRef,
    contentDigest,
    widthPx,
    heightPx,
    ...(lineWork !== undefined ? { lineWork } : {}),
  };
}

/** Structural validation of one `raster.reference` data payload (the
 *  declared source + transform + optional clipping + visibility; SHAPE
 *  only — whether the source exists / matches the digest is the derived
 *  runtime status, never a stored guess). */
export function validateRasterReferenceData(data: unknown): RasterReferenceData {
  const d = requireObject(data, "raster.reference data");
  checkKeys(d, RASTER_REFERENCE_KEYS, "raster.reference data");
  const sourceRef = requireBoundedString(d.sourceRef, "raster.reference sourceRef", TOOLSET_ID_MAX);
  const declaredDigest = requireBoundedString(d.declaredDigest, "raster.reference declaredDigest", 128);
  const t = requireObject(d.transform, "raster.reference transform");
  checkKeys(t, RASTER_TRANSFORM_KEYS, "raster.reference transform");
  const to = requireObject(t.origin, "raster.reference transform.origin");
  for (const key of ["x", "y"] as const) {
    if (!isFiniteNumber(to[key])) {
      throw toolsetErr("toolset_bad_payload", `raster.reference transform.origin.${key} must be a finite number`);
    }
  }
  const scale = requirePositiveFinite(t.scale, "raster.reference transform.scale");
  if (scale < TOOLSETS_RASTER_SCALE_MIN || scale > TOOLSETS_RASTER_SCALE_MAX) {
    throw toolsetErr(
      "toolset_bad_payload",
      `raster.reference transform.scale must be within [${TOOLSETS_RASTER_SCALE_MIN}, ${TOOLSETS_RASTER_SCALE_MAX}] (got ${scale})`,
    );
  }
  const rotationDeg = requireFinite(t.rotationDeg, "raster.reference transform.rotationDeg");
  let clipping: RasterReferenceData["clipping"];
  if (d.clipping !== undefined) {
    const c = requireObject(d.clipping, "raster.reference clipping");
    checkKeys(c, RASTER_CLIPPING_KEYS, "raster.reference clipping");
    clipping = {
      x: requireFinite(c.x, "raster.reference clipping.x"),
      y: requireFinite(c.y, "raster.reference clipping.y"),
      w: requirePositiveFinite(c.w, "raster.reference clipping.w"),
      h: requirePositiveFinite(c.h, "raster.reference clipping.h"),
    };
  }
  if (typeof d.visible !== "boolean") {
    throw toolsetErr("toolset_bad_payload", "raster.reference visible must be a boolean");
  }
  const layer = optionalBoundedString(d.layer, "raster.reference layer", 32);
  return {
    sourceRef,
    declaredDigest,
    transform: { origin: { x: to.x as number, y: to.y as number }, scale, rotationDeg },
    ...(clipping !== undefined ? { clipping } : {}),
    visible: d.visible,
    ...(layer !== undefined ? { layer } : {}),
  };
}

// ---------------------------------------------------------------------------
// The specialized-record envelope (the document-layer normalizer).
// ---------------------------------------------------------------------------

const SPECIALIZED_TOOLSETS: readonly SpecializedToolset[] = ["mep", "mechanical", "raster"];
const KIND_OF_TOOLSET: Record<SpecializedToolset, readonly SpecializedRecordKind[]> = {
  mep: ["mep.run"],
  mechanical: ["mech.equipment"],
  raster: ["raster.source", "raster.reference"],
};

/** Validate + canonicalize one specialized record (the envelope + the
 *  per-kind data payload). The document layer calls this when applying
 *  addSpecialized/setSpecializedRecord — the record grammar is enforced
 *  in ONE place. */
export function normalizeToolsetRecord(record: unknown): SpecializedRecord {
  const r = requireObject(record, "specialized record");
  checkKeys(r, ["id", "toolset", "kind", "data"], "specialized record");
  const id = requireBoundedString(r.id, "specialized record id", 16);
  if (!SPECIALIZED_TOOLSETS.includes(r.toolset as SpecializedToolset)) {
    throw toolsetErr(
      "toolset_bad_payload",
      `specialized record toolset must be one of ${SPECIALIZED_TOOLSETS.join(" | ")} (got ${JSON.stringify(r.toolset)})`,
    );
  }
  const toolset = r.toolset as SpecializedToolset;
  const allowedKinds = KIND_OF_TOOLSET[toolset] ?? [];
  if (!allowedKinds.includes(r.kind as SpecializedRecordKind)) {
    throw toolsetErr(
      "toolset_bad_payload",
      `specialized record kind '${JSON.stringify(r.kind)}' is not valid for toolset '${toolset}' (allowed: ${allowedKinds.join(", ")})`,
    );
  }
  switch (r.kind) {
    case "mep.run":
      if (toolset !== "mep") throw toolsetErr("toolset_bad_payload", "specialized record kind 'mep.run' requires toolset 'mep'");
      return { id, toolset, kind: "mep.run", data: validateMepRunData(r.data) };
    case "mech.equipment":
      if (toolset !== "mechanical") throw toolsetErr("toolset_bad_payload", "specialized record kind 'mech.equipment' requires toolset 'mechanical'");
      return { id, toolset, kind: "mech.equipment", data: validateMechEquipmentData(r.data) };
    case "raster.source":
      if (toolset !== "raster") throw toolsetErr("toolset_bad_payload", "specialized record kind 'raster.source' requires toolset 'raster'");
      return { id, toolset, kind: "raster.source", data: validateRasterSourceData(r.data) };
    case "raster.reference":
      if (toolset !== "raster") throw toolsetErr("toolset_bad_payload", "specialized record kind 'raster.reference' requires toolset 'raster'");
      return { id, toolset, kind: "raster.reference", data: validateRasterReferenceData(r.data) };
  }
  throw toolsetErr("toolset_bad_payload", `specialized record kind must be a string (got ${JSON.stringify(r.kind)})`);
}

/** The alias the App API handlers use (same single grammar). */
export const validateSpecializedRecord = normalizeToolsetRecord;

/** The table-size bounds (enforced by the document/command layer with the
 *  same typed codes — the pure validators have no table access). */
export const TOOLSETS_TABLE_BOUNDS = {
  maxRuns: TOOLSETS_MAX_RUNS,
  maxEquipment: TOOLSETS_MAX_EQUIPMENT,
  maxRasterSources: TOOLSETS_MAX_RASTER_SOURCES,
  maxRasterReferences: TOOLSETS_MAX_RASTER_REFERENCES,
} as const;

/** Derive the next `tls-NNNNNN` sequence from a record set (the
 *  derivePropertyDefSequence precedent — the document takes max(derived,
 *  history checkpoint) on open so identities are never reused). */
export function deriveSpecializedSequence(records: readonly { id: string }[]): number {
  let max = 0;
  for (const rec of records) {
    const m = /^tls-(\d{6,})$/.exec(rec.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}
