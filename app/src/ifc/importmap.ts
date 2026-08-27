/**
 * IFC import + semantic reconciliation (COMPAT-IFC-001 / Issue #47).
 *
 * Maps the parsed IFC semantic IR (contracts/ifc.ts IfcParseResult — file
 * units, METRE convention) back into canonical BIM entities (mm domain) and
 * RECONCILES against the existing document state on CANONICAL identity:
 *
 *   - elements carrying Pset_OffisosIdentity.DomainId that matches an
 *     existing canonical element id → RECONCILED (field-level comparison:
 *     exact / declared-tolerance / lossy / unsupported per field);
 *   - DomainId not present in the document → CREATED with that id preserved
 *     (stable canonical identity across the round trip — the acceptance
 *     requirement), IFC GlobalId retained as engineId provenance ONLY;
 *   - no identity pset (external authoring) → CREATED with a minted id,
 *     GlobalId → engineId provenance;
 *   - fields the source cannot supply → LOSSY/UNSUPPORTED classification in
 *     the report; the ONLY fallbacks are caller-declared options, recorded
 *     in the report (never silent).
 *
 * Geometry reconstruction (wall/opening/slab/space conventions — see the
 * worker's build path): walls from the placement rotation + profile bbox
 * (axis at the bbox centre line); openings projected onto the reconstructed
 * host wall frame; slabs from the axis-aligned footprint bbox; spaces from
 * the footprint curve + placement. Everything is deterministic; comparisons
 * carry the declared tolerance (report.ts).
 */

import type { IfcParseResult, IfcParsedElement, IfcParsedStory } from "../contracts/ifc.js";
import {
  makeDoor,
  makeOpening,
  makeSlab,
  makeSpace,
  makeStory,
  makeWall,
  makeWindow,
  polygonArea,
} from "../bim/elements.js";
import type { Element } from "../contracts/caddocument.js";
import {
  IFC_ROUNDTRIP_TOLERANCE_MM,
  classifyNumber,
  toleranceField,
  classifyValue,
  exactField,
  type IfcElementReport,
  type IfcFieldResult,
  type IfcImportReport,
  ifcReportHash,
  summarizeReports,
  unsupportedField,
} from "./report.js";

const IDENTITY_PSET = "Pset_OffisosIdentity";
const PARAMS_PSET = "Pset_OffisosParams";

/** Compare authored custom props (Pset_OffisosCustom) against the element's
 *  current extra props; returns field results + the props patch (when any
 *  key changed). Round-trips authored properties — never silently dropped. */
function compareCustomProps(
  source: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
): { fields: IfcFieldResult[]; changed: Record<string, unknown> | null } {
  const fields: IfcFieldResult[] = [];
  const changed: Record<string, unknown> = {};
  const known = new Set(knownKeys);
  const currentCustom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!known.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      currentCustom[key] = value;
    }
  }
  const sourceKeys = new Set(Object.keys(source));
  for (const key of new Set([...Object.keys(currentCustom), ...sourceKeys])) {
    const expected = currentCustom[key];
    const actual = source[key];
    if (expected === undefined) {
      fields.push({ field: `custom.${key}`, classification: "lossy", actual, note: "property added by the import" });
      changed[key] = actual;
    } else if (actual === undefined) {
      fields.push({ field: `custom.${key}`, classification: "lossy", expected, note: "property absent in the source" });
      changed[key] = null; // explicit removal (setProps null-removes? — documented removal)
    } else if (expected === actual) {
      fields.push({ field: `custom.${key}`, classification: "exact" });
    } else if (typeof expected === "number" && typeof actual === "number" && Math.abs(expected - actual) <= IFC_ROUNDTRIP_TOLERANCE_MM) {
      fields.push(toleranceField(`custom.${key}`, expected, actual));
    } else {
      fields.push({ field: `custom.${key}`, classification: "lossy", expected, actual });
      changed[key] = actual;
    }
  }
  return { fields, changed: Object.keys(changed).length > 0 ? changed : null };
}


/** Build a FULL setProps patch from the current props + changed keys
 *  (setProps replaces the whole props object — partial patches would wipe
 *  unchanged keys). A null value in `changed` REMOVES the key. */
function fullPropsPatch(
  current: Readonly<Record<string, unknown>>,
  changed: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const full: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changed)) {
    if (value === null) {
      delete full[key];
    } else {
      full[key] = value;
    }
  }
  return full;
}

const EPS = 1e-9;

export interface IfcImportOptions {
  /** Declared fallback for stories lacking Pset_OffisosParams.Height
   *  (canonical mm). Recorded in the report when applied. */
  readonly defaultStoryHeight?: number;
  /** Declared fallback for spaces lacking height (canonical mm), mirroring
   *  defaultStoryHeight. Recorded in the report when applied. */
  readonly defaultSpaceHeight?: number;
  /** Canonical-id mint for created elements with no preserved identity
   *  (external files). The IMPORT path passes the document's mintElementId
   *  so created elements get real `el-NNNNNN` ids and hosted references
   *  resolve within the same batch; the DRY-RUN path omits it (created
   *  elements report canonicalId: null and reference placeholders
   *  internally). */
  readonly mintId?: () => string;
}

export interface IfcImportRecord {
  /** Minted record id (if-NNNNNN, document authority). */
  readonly id: string;
  /** Fixed import timestamp (deterministic records). */
  readonly at: string;
  /** SHA-256 of the imported IFC bytes. */
  readonly sourceHash: string;
  readonly schema: string;
  readonly lengthUnitName: string | null;
  readonly lengthUnitPrefix: string | null;
  readonly scaleToMm: number;
  readonly reportHash: string;
  readonly summary: IfcImportReport["summary"];
  /** Per-element canonical↔GlobalId provenance mapping. */
  readonly mapping: readonly {
    readonly canonicalId: string | null;
    readonly globalId: string;
    readonly ifcClass: string;
    readonly action: IfcElementReport["action"];
  }[];
}

export interface IfcImportOutcome {
  /** New canonical entity inputs (id preserved from identity psets when
   *  resolvable; no id → the document mints). */
  readonly entities: readonly Record<string, unknown>[];
  /** Source IfcGuid per entity (aligned by index; engineId provenance ONLY). */
  readonly globalIds: readonly (string | null)[];
  /** Reconciliation patches for existing elements. */
  readonly patches: readonly { elementId: string; patch: Readonly<Record<string, unknown>> }[];
  readonly report: IfcImportReport;
  readonly record: Omit<IfcImportRecord, "id" | "at">;
}

/** Declared length-unit factor: file length units → canonical mm. */
export function ifcLengthScale(name: string | null, prefix: string | null): number | null {
  if (name === null) return null;
  const upper = name.toUpperCase();
  if (upper === "METRE") {
    switch (prefix) {
      case null:
      case "":
        return 1000;
      case "MILLI": return 1;
      case "CENTI": return 10;
      case "KILO": return 1_000_000;
      default: return null;
    }
  }
  if (upper === "FOOT" || upper === "FEET") return 304.8;
  if (upper === "INCH") return 25.4;
  return null;
}

interface Identity {
  readonly DomainId: string;
  readonly DomainKind: string;
}

function identityOf(el: IfcParsedElement | IfcParsedStory): Identity | null {
  const pset = el.psets[IDENTITY_PSET];
  if (typeof pset !== "object" || pset === null) return null;
  const id = (pset as Record<string, unknown>).DomainId;
  if (typeof id !== "string" || id.length === 0) return null;
  return { DomainId: id, DomainKind: typeof (pset as Record<string, unknown>).DomainKind === "string" ? (pset as Record<string, unknown>).DomainKind as string : "" };
}

function paramsOf(el: IfcParsedElement | IfcParsedStory): Readonly<Record<string, unknown>> {
  const pset = el.psets["Pset_OffisosParams"];
  return typeof pset === "object" && pset !== null ? (pset as Record<string, unknown>) : {};
}

/** Rotation 2x2 → axis unit vector (null when not a planar rotation). */
function rotationToAxis(rot: readonly [readonly [number, number], readonly [number, number]] | null): { u: readonly [number, number]; angle: number } | null {
  if (rot === null) return { u: [1, 0] as const, angle: 0 };
  const [r0, r1] = rot;
  const ux = r0[0];
  const uy = r1[0];
  const len = Math.sqrt(ux * ux + uy * uy);
  if (len <= 1e-12) return null;
  const u: readonly [number, number] = [ux / len, uy / len];
  const vx = r0[1];
  const vy = r1[1];
  const dot = u[0] * vx + u[1] * vy;
  const vlen = Math.sqrt(vx * vx + vy * vy);
  if (Math.abs(dot) > 1e-9 || Math.abs(vlen - 1) > 1e-9) return null;
  return { u, angle: Math.atan2(u[1], u[0]) };
}

/** An existing canonical element's raw props view. */
interface ExistingElement {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/** Resolve the reconcile-or-create identity for a parsed element. */
function resolveCanonicalId(
  identity: Identity | null,
  existingById: ReadonlyMap<string, ExistingElement>,
  expectedType: string,
): { mode: "reconcile"; existing: ExistingElement } | { mode: "create"; explicitId: string | null } {
  if (identity === null) return { mode: "create", explicitId: null };
  const existing = existingById.get(identity.DomainId);
  if (existing !== undefined && existing.type === expectedType) {
    return { mode: "reconcile", existing };
  }
  if (!existingById.has(identity.DomainId)) {
    return { mode: "create", explicitId: identity.DomainId };
  }
  return { mode: "create", explicitId: null };
}

/** Build the reconciliation outcome for a parsed IFC file against the
 *  existing canonical document state. */
export function reconcileIfcImport(
  parsed: IfcParseResult,
  sourceHash: string,
  existing: readonly Element[],
  options: IfcImportOptions = {},
): IfcImportOutcome {
  const scale = ifcLengthScale(parsed.lengthUnitName, parsed.lengthUnitPrefix);
  if (scale === null) {
    throw new Error(
      `IFC import: unsupported length unit (name=${String(parsed.lengthUnitName)}, prefix=${String(parsed.lengthUnitPrefix)}); the supported set is METRE{MILLI,CENTI,none,KILO}, FOOT, INCH`,
    );
  }

  const declaredFallbacks: string[] = [];
  const elements: IfcElementReport[] = [];
  const entities: Record<string, unknown>[] = [];
  const entityGlobalIds: (string | null)[] = [];
  const patches: { elementId: string; patch: Readonly<Record<string, unknown>> }[] = [];
  const mapping: { canonicalId: string | null; globalId: string; ifcClass: string; action: IfcElementReport["action"] }[] = [];

  const existingById = new Map<string, ExistingElement>();
  for (const el of existing) {
    const p = el.props as Record<string, unknown>;
    if (p !== null && typeof p === "object" && p.bim === true && typeof p.type === "string") {
      existingById.set(el.id, { id: el.id, type: p.type as string, props: p });
    }
  }

  const unsupported = (el: IfcParsedElement | IfcParsedStory, ifcClass: string, note: string): void => {
    elements.push({
      canonicalId: null,
      globalId: el.globalId,
      ifcClass,
      name: el.name,
      action: "unsupported",
      fields: [unsupportedField("geometry", note)],
    });
    mapping.push({ canonicalId: null, globalId: el.globalId, ifcClass, action: "unsupported" });
  };

  // --- stories ----------------------------------------------------------------
  const storyIdByGlobalId = new Map<string, string>(); // resolved canonical ids (or @story: placeholders)
  const storyLevelByCanonical = new Map<string, number>();
  for (const story of parsed.stories) {
    const identity = identityOf(story);
    const fields: IfcFieldResult[] = [];
    let height: number | null = null;
    if (typeof paramsOf(story).Height === "number") {
      height = (paramsOf(story).Height as number) * scale;
      fields.push(exactField("height"));
    } else if (options.defaultStoryHeight !== undefined) {
      height = options.defaultStoryHeight;
      declaredFallbacks.push(`story '${story.name}': height fell back to the declared default ${options.defaultStoryHeight} mm`);
      fields.push({ field: "height", classification: "lossy", note: "source lacks story height; declared default applied" });
    } else {
      fields.push(unsupportedField("height", "source lacks story height and no default was declared"));
    }
    const level = story.elevation * scale;
    const globalId = story.globalId;

    if (height === null) {
      elements.push({ canonicalId: null, globalId, ifcClass: "IfcBuildingStorey", name: story.name, action: "unsupported", fields });
      mapping.push({ canonicalId: null, globalId, ifcClass: "IfcBuildingStorey", action: "unsupported" });
      continue;
    }

    const res = resolveCanonicalId(identity, existingById, "bim.story");
    if (res.mode === "reconcile") {
      const s = res.existing.props;
      const level0 = s.level as number;
      const height0 = s.height as number;
      const name0 = (s.name as string | undefined) ?? "";
      const storyFields = [
        classifyValue("name", name0, story.name),
        classifyNumber("level", level0, level),
        classifyNumber("height", height0, height),
      ];
      const changed: Record<string, unknown> = {};
      if (story.name !== name0) changed.name = story.name;
      if (Math.abs(level - level0) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.level = level;
      if (Math.abs(height - height0) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.height = height;
      const action = Object.keys(changed).length > 0 ? "reconciled" : "unchanged";
      if (Object.keys(changed).length > 0) patches.push({ elementId: res.existing.id, patch: fullPropsPatch(res.existing.props, changed) });
      elements.push({ canonicalId: res.existing.id, globalId, ifcClass: "IfcBuildingStorey", name: story.name, action, fields: storyFields });
      mapping.push({ canonicalId: res.existing.id, globalId, ifcClass: "IfcBuildingStorey", action });
      storyIdByGlobalId.set(globalId, res.existing.id);
      storyLevelByCanonical.set(res.existing.id, level0);
    } else {
      const minted = res.explicitId ?? (options.mintId !== undefined ? options.mintId() : null);
      const entity: Record<string, unknown> = { type: "bim.story", name: story.name, level, height };
      if (minted !== null) entity.id = minted;
      entities.push(entity);
      entityGlobalIds.push(globalId);
      const canonicalId = minted ?? `@story:${globalId}`;
      elements.push({ canonicalId: minted, globalId, ifcClass: "IfcBuildingStorey", name: story.name, action: "created", fields });
      mapping.push({ canonicalId: minted, globalId, ifcClass: "IfcBuildingStorey", action: "created" });
      storyIdByGlobalId.set(globalId, canonicalId);
      storyLevelByCanonical.set(canonicalId, level);
    }
  }

  // story ids that carry a real canonical id (minted or preserved); placeholder
  // ids (dry-run) resolve too — hosted elements reference them internally.
  const realStoryIds = new Set<string>();
  for (const id of storyIdByGlobalId.values()) {
    if (!id.startsWith("@story:")) realStoryIds.add(id);
  }
  const storyIdOf = (globalId: string | null): { id: string; level: number } | null => {
    if (globalId === null) return null;
    const id = storyIdByGlobalId.get(globalId);
    if (id === undefined) return null;
    const level = storyLevelByCanonical.get(id);
    return level === undefined ? null : { id, level };
  };

  // --- walls (pass 1 — hosted elements need their frames) ----------------------
  interface WallFrame {
    canonicalId: string;
    storyId: string;
    start: readonly [number, number];
    u: readonly [number, number];
    width: number;
    baseZ: number;
  }
  const wallFrames = new Map<string, WallFrame>();

  const sorted = [...parsed.elements].sort((a, b) =>
    a.ifcClass === b.ifcClass ? a.globalId.localeCompare(b.globalId) : a.ifcClass.localeCompare(b.ifcClass),
  );

  for (const el of sorted.filter((e) => e.ifcClass === "IfcWall")) {
    const identity = identityOf(el);
    const story = storyIdOf(el.storyGlobalId);
    if (story === null) {
      unsupported(el, el.ifcClass, "wall is not contained in a mapped storey");
      continue;
    }
    if (el.placement === null || el.profile === null || el.rotation === null) {
      unsupported(el, el.ifcClass, "wall lacks an extractable extruded-rect body profile or placement");
      continue;
    }
    const axis = rotationToAxis(el.rotation);
    if (axis === null) {
      unsupported(el, el.ifcClass, "wall placement is not a planar rotation");
      continue;
    }
    const prof = el.profile;
    const T = el.placement;
    const R = el.rotation;
    const ly = prof.y0 + prof.ydim / 2;
    const start: readonly [number, number] = [
      (T[0] + R[0][0] * prof.x0 + R[0][1] * ly) * scale,
      (T[1] + R[1][0] * prof.x0 + R[1][1] * ly) * scale,
    ];
    const lex = prof.x0 + prof.xdim;
    const end: readonly [number, number] = [
      (T[0] + R[0][0] * lex + R[0][1] * ly) * scale,
      (T[1] + R[1][0] * lex + R[1][1] * ly) * scale,
    ];
    const width = prof.ydim * scale;
    const height = prof.depth * scale;
    const baseOffset = (T[2] - story.level / scale) * scale;

    const res = resolveCanonicalId(identity, existingById, "bim.wall");
    if (res.mode === "reconcile") {
      const w = res.existing.props;
      const name0 = (w.name as string | undefined) ?? "";
      const start0 = w.start as readonly [number, number];
      const end0 = w.end as readonly [number, number];
      const width0 = w.width as number;
      const height0 = w.height as number;
      const baseOffset0 = w.baseOffset as number;
      const wallFields = [
        classifyValue("name", name0, el.name),
        classifyNumber("start.x", start0[0], start[0]),
        classifyNumber("start.y", start0[1], start[1]),
        classifyNumber("end.x", end0[0], end[0]),
        classifyNumber("end.y", end0[1], end[1]),
        classifyNumber("width", width0, width),
        classifyNumber("height", height0, height),
        classifyNumber("baseOffset", baseOffset0, baseOffset),
      ];
      const changed: Record<string, unknown> = {};
      if (el.name !== name0) changed.name = el.name;
      if (Math.abs(start0[0] - start[0]) > IFC_ROUNDTRIP_TOLERANCE_MM || Math.abs(start0[1] - start[1]) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.start = [start[0], start[1]];
      if (Math.abs(end0[0] - end[0]) > IFC_ROUNDTRIP_TOLERANCE_MM || Math.abs(end0[1] - end[1]) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.end = [end[0], end[1]];
      if (Math.abs(width0 - width) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.width = width;
      if (Math.abs(height0 - height) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.height = height;
      if (Math.abs(baseOffset0 - baseOffset) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.baseOffset = baseOffset;
      const custom = compareCustomProps(
        (el.psets["Pset_OffisosCustom"] as Record<string, unknown> | undefined) ?? {},
        res.existing.props,
        ["bim", "type", "id", "name", "storyId", "start", "end", "width", "height", "baseOffset"],
      );
      wallFields.push(...custom.fields);
      if (custom.changed !== null) Object.assign(changed, custom.changed);
      const action = Object.keys(changed).length > 0 ? "reconciled" : "unchanged";
      if (Object.keys(changed).length > 0) patches.push({ elementId: res.existing.id, patch: fullPropsPatch(res.existing.props, changed) });
      elements.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action, fields: wallFields });
      mapping.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, action });
      wallFrames.set(el.globalId, {
        canonicalId: res.existing.id,
        storyId: w.storyId as string,
        start, u: axis.u, width, baseZ: T[2] * scale,
      });
    } else {
      const entity: Record<string, unknown> = {
        type: "bim.wall",
        storyId: story.id,
        start: [start[0], start[1]],
        end: [end[0], end[1]],
        width, height, baseOffset,
      };
      if (el.name !== "") entity.name = el.name;
      const minted = res.explicitId ?? (options.mintId !== undefined ? options.mintId() : null);
      if (minted !== null) entity.id = minted;
      entities.push(entity);
      entityGlobalIds.push(el.globalId);
      const canonicalId = minted ?? `@wall:${el.globalId}`;
      elements.push({
        canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action: "created",
        fields: [exactField("start"), exactField("end"), exactField("width"), exactField("height"), exactField("baseOffset")],
      });
      mapping.push({ canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, action: "created" });
      wallFrames.set(el.globalId, { canonicalId, storyId: story.id, start, u: axis.u, width, baseZ: T[2] * scale });
    }
  }

  // --- openings ----------------------------------------------------------------
  const openingIdByGlobalId = new Map<string, string>();
  const openingHostWallByGlobalId = new Map<string, WallFrame>();
  for (const el of sorted.filter((e) => e.ifcClass === "IfcOpeningElement")) {
    const identity = identityOf(el);
    const host = el.hostGlobalId !== null ? wallFrames.get(el.hostGlobalId) : undefined;
    if (host === undefined || host.canonicalId.startsWith("@wall:")) {
      unsupported(el, el.ifcClass, "opening's host wall is not importable");
      continue;
    }
    if (el.placement === null || el.profile === null || el.rotation === null) {
      unsupported(el, el.ifcClass, "opening lacks placement/profile/rotation");
      continue;
    }
    const prof = el.profile;
    const T = el.placement;
    const R = el.rotation;
    const nx = T[0] + R[0][0] * prof.x0 + R[0][1] * prof.y0;
    const ny = T[1] + R[1][0] * prof.x0 + R[1][1] * prof.y0;
    const distance = (nx * scale - host.start[0]) * host.u[0] + (ny * scale - host.start[1]) * host.u[1];
    const sill = T[2] * scale - host.baseZ;
    const width = prof.xdim * scale;
    const height = prof.depth * scale;

    const res = resolveCanonicalId(identity, existingById, "bim.opening");
    if (res.mode === "reconcile") {
      const o = res.existing.props;
      const distance0 = o.distance as number;
      const sill0 = o.sill as number;
      const width0 = o.width as number;
      const height0 = o.height as number;
      const hostId0 = o.hostId as string;
      const openingFields = [
        classifyNumber("distance", distance0, distance),
        classifyNumber("sill", sill0, sill),
        classifyNumber("width", width0, width),
        classifyNumber("height", height0, height),
        classifyValue("hostId", hostId0, host.canonicalId),
      ];
      const changed: Record<string, unknown> = {};
      if (Math.abs(distance0 - distance) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.distance = distance;
      if (Math.abs(sill0 - sill) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.sill = sill;
      if (Math.abs(width0 - width) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.width = width;
      if (Math.abs(height0 - height) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.height = height;
      if (hostId0 !== host.canonicalId) changed.hostId = host.canonicalId;
      const action = Object.keys(changed).length > 0 ? "reconciled" : "unchanged";
      if (Object.keys(changed).length > 0) patches.push({ elementId: res.existing.id, patch: fullPropsPatch(res.existing.props, changed) });
      elements.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action, fields: openingFields });
      mapping.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, action });
      openingIdByGlobalId.set(el.globalId, res.existing.id);
    } else {
      const entity: Record<string, unknown> = {
        type: "bim.opening",
        hostId: host.canonicalId,
        distance, width, height, sill,
      };
      if (el.name !== "") entity.name = el.name;
      const minted = res.explicitId ?? (options.mintId !== undefined ? options.mintId() : null);
      if (minted !== null) entity.id = minted;
      entities.push(entity);
      entityGlobalIds.push(el.globalId);
      const canonicalId = minted ?? `@opening:${el.globalId}`;
      elements.push({
        canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action: "created",
        fields: [exactField("distance"), exactField("sill"), exactField("width"), exactField("height")],
      });
      mapping.push({ canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, action: "created" });
      openingIdByGlobalId.set(el.globalId, canonicalId);
    }
    openingHostWallByGlobalId.set(el.globalId, host);
  }

  // --- doors / windows -----------------------------------------------------------
  for (const el of sorted.filter((e) => e.ifcClass === "IfcDoor" || e.ifcClass === "IfcWindow")) {
    const identity = identityOf(el);
    const isDoor = el.ifcClass === "IfcDoor";
    const expectedType = isDoor ? "bim.door" : "bim.window";
    const openingGlobal = el.fillOpeningGlobalId;
    const openingId = openingGlobal !== null ? openingIdByGlobalId.get(openingGlobal) : undefined;
    const hostWall = openingGlobal !== null ? openingHostWallByGlobalId.get(openingGlobal) : undefined;
    if (openingId === undefined || openingId.startsWith("@opening:") || hostWall === undefined || hostWall.canonicalId.startsWith("@wall:")) {
      elements.push({
        canonicalId: null, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action: "unsupported",
        fields: [unsupportedField("opening", `${isDoor ? "door" : "window"} does not fill an importable opening`)],
      });
      mapping.push({ canonicalId: null, globalId: el.globalId, ifcClass: el.ifcClass, action: "unsupported" });
      continue;
    }
    const fields: IfcFieldResult[] = [];
    const params = paramsOf(el);
    let swing = "left";
    let leafThickness = 40;
    if (isDoor) {
      if (params.Swing === "left" || params.Swing === "right") {
        swing = params.Swing;
        fields.push(exactField("swing"));
      } else {
        fields.push({ field: "swing", classification: "lossy", note: "source lacks door swing; canonical default 'left' applied" });
      }
      if (typeof params.LeafThickness === "number") {
        leafThickness = params.LeafThickness as number;
        fields.push(exactField("leafThickness"));
      } else {
        fields.push({ field: "leafThickness", classification: "lossy", note: "source lacks leaf thickness; canonical default 40 mm applied" });
      }
    }

    const res = resolveCanonicalId(identity, existingById, expectedType);
    if (res.mode === "reconcile") {
      const f = res.existing.props;
      const name0 = (f.name as string | undefined) ?? "";
      const fillFields = [
        classifyValue("name", name0, el.name),
        classifyValue("openingId", f.openingId as string, openingId),
        classifyValue("storyId", f.storyId as string, hostWall.storyId),
      ];
      if (isDoor) {
        fillFields.push(classifyValue("swing", (f.swing as string | undefined) ?? "left", swing));
        fillFields.push(classifyNumber("leafThickness", (f.leafThickness as number | undefined) ?? 40, leafThickness));
      }
      const changed: Record<string, unknown> = {};
      if (el.name !== name0) changed.name = el.name;
      if ((f.openingId as string) !== openingId) changed.openingId = openingId;
      if (isDoor && ((f.swing as string | undefined) ?? "left") !== swing) changed.swing = swing;
      if (isDoor && Math.abs(((f.leafThickness as number | undefined) ?? 40) - leafThickness) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.leafThickness = leafThickness;
      const action = Object.keys(changed).length > 0 ? "reconciled" : "unchanged";
      if (Object.keys(changed).length > 0) patches.push({ elementId: res.existing.id, patch: fullPropsPatch(res.existing.props, changed) });
      elements.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action, fields: fillFields });
      mapping.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, action });
    } else {
      const minted = res.explicitId ?? (options.mintId !== undefined ? options.mintId() : null);
      const entity: Record<string, unknown> = {
        type: expectedType,
        openingId,
        storyId: hostWall.storyId,
      };
      if (isDoor) {
        entity.swing = swing;
        entity.leafThickness = leafThickness;
      }
      if (el.name !== "") entity.name = el.name;
      if (minted !== null) entity.id = minted;
      entities.push(entity);
      entityGlobalIds.push(el.globalId);
      elements.push({ canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action: "created", fields });
      mapping.push({ canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, action: "created" });
    }
  }

  // --- slabs ----------------------------------------------------------------------
  for (const el of sorted.filter((e) => e.ifcClass === "IfcSlab")) {
    const identity = identityOf(el);
    const story = storyIdOf(el.storyGlobalId);
    if (story === null || el.placement === null || el.profile === null) {
      unsupported(el, el.ifcClass, "slab lacks storey, placement or extractable profile");
      continue;
    }
    const rot = rotationToAxis(el.rotation);
    if (rot === null || Math.abs(rot.angle) > 1e-9) {
      unsupported(el, el.ifcClass, "canonical slabs are axis-aligned; the source slab placement is rotated");
      continue;
    }
    const T = el.placement;
    const prof = el.profile;
    const corner1: readonly [number, number] = [(T[0] + prof.x0) * scale, (T[1] + prof.y0) * scale];
    const corner2: readonly [number, number] = [(T[0] + prof.x0 + prof.xdim) * scale, (T[1] + prof.y0 + prof.ydim) * scale];
    const thickness = prof.depth * scale;
    const baseOffset = (T[2] - story.level / scale) * scale;

    const res = resolveCanonicalId(identity, existingById, "bim.slab");
    if (res.mode === "reconcile") {
      const s = res.existing.props;
      const name0 = (s.name as string | undefined) ?? "";
      const c1 = s.corner1 as readonly [number, number];
      const c2 = s.corner2 as readonly [number, number];
      const slabFields = [
        classifyValue("name", name0, el.name),
        classifyNumber("corner1.x", c1[0], corner1[0]),
        classifyNumber("corner1.y", c1[1], corner1[1]),
        classifyNumber("corner2.x", c2[0], corner2[0]),
        classifyNumber("corner2.y", c2[1], corner2[1]),
        classifyNumber("thickness", s.thickness as number, thickness),
        classifyNumber("baseOffset", s.baseOffset as number, baseOffset),
      ];
      const changed: Record<string, unknown> = {};
      if (el.name !== name0) changed.name = el.name;
      if (Math.abs(c1[0] - corner1[0]) > IFC_ROUNDTRIP_TOLERANCE_MM || Math.abs(c1[1] - corner1[1]) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.corner1 = [corner1[0], corner1[1]];
      if (Math.abs(c2[0] - corner2[0]) > IFC_ROUNDTRIP_TOLERANCE_MM || Math.abs(c2[1] - corner2[1]) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.corner2 = [corner2[0], corner2[1]];
      if (Math.abs((s.thickness as number) - thickness) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.thickness = thickness;
      if (Math.abs((s.baseOffset as number) - baseOffset) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.baseOffset = baseOffset;
      const slabCustom = compareCustomProps(
        (el.psets["Pset_OffisosCustom"] as Record<string, unknown> | undefined) ?? {},
        res.existing.props,
        ["bim", "type", "id", "name", "storyId", "corner1", "corner2", "thickness", "baseOffset"],
      );
      slabFields.push(...slabCustom.fields);
      if (slabCustom.changed !== null) Object.assign(changed, slabCustom.changed);
      const action = Object.keys(changed).length > 0 ? "reconciled" : "unchanged";
      if (Object.keys(changed).length > 0) patches.push({ elementId: res.existing.id, patch: fullPropsPatch(res.existing.props, changed) });
      elements.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action, fields: slabFields });
      mapping.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, action });
    } else {
      const entity: Record<string, unknown> = {
        type: "bim.slab",
        storyId: story.id,
        corner1: [corner1[0], corner1[1]],
        corner2: [corner2[0], corner2[1]],
        thickness, baseOffset,
      };
      if (el.name !== "") entity.name = el.name;
      const minted = res.explicitId ?? (options.mintId !== undefined ? options.mintId() : null);
      if (minted !== null) entity.id = minted;
      entities.push(entity);
      entityGlobalIds.push(el.globalId);
      elements.push({
        canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action: "created",
        fields: [exactField("corner1"), exactField("corner2"), exactField("thickness"), exactField("baseOffset")],
      });
      mapping.push({ canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, action: "created" });
    }
  }

  // --- spaces -----------------------------------------------------------------------
  for (const el of sorted.filter((e) => e.ifcClass === "IfcSpace")) {
    const identity = identityOf(el);
    const story = storyIdOf(el.storyGlobalId);
    if (story === null || el.footprint === null || el.placement === null) {
      unsupported(el, el.ifcClass, "space lacks storey, placement or extractable footprint curve");
      continue;
    }
    const T = el.placement;
    let pts: readonly (readonly [number, number])[] = el.footprint.map((p) => [(p[0] + T[0]) * scale, (p[1] + T[1]) * scale] as const);
    if (pts.length >= 2) {
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      if (Math.abs(first[0] - last[0]) < EPS && Math.abs(first[1] - last[1]) < EPS) {
        pts = pts.slice(0, -1);
      }
    }
    if (pts.length < 3) {
      unsupported(el, el.ifcClass, "space footprint has fewer than 3 points");
      continue;
    }
    const fields: IfcFieldResult[] = [];
    const heightParam = paramsOf(el).Height;
    let height: number | null = null;
    if (typeof heightParam === "number") {
      height = (heightParam as number) * scale;
      fields.push(exactField("height"));
    } else if (options.defaultSpaceHeight !== undefined) {
      height = options.defaultSpaceHeight;
      declaredFallbacks.push(`space '${el.name}': height fell back to the declared default ${options.defaultSpaceHeight} mm`);
      fields.push({ field: "height", classification: "lossy", note: "source lacks space height; declared default applied" });
    } else {
      fields.push(unsupportedField("height", "source lacks space height (Pset_OffisosParams.Height)"));
    }
    const longName = (el.psets["Pset_SpaceCommon"] as Record<string, unknown> | undefined)?.LongName;
    const name = el.name !== "" ? el.name : typeof longName === "string" ? longName : "";
    if (name === "") {
      fields.push(unsupportedField("name", "space has neither Name nor Pset_SpaceCommon.LongName"));
    }
    const baseOffset = (T[2] - story.level / scale) * scale;
    const qtoArea = (el.qtos["Qto_SpaceCommon"] as Record<string, unknown> | undefined)?.GrossFloorArea;
    if (typeof qtoArea === "number") {
      fields.push(classifyNumber("area", polygonArea(pts), (qtoArea as number) * scale * scale));
    }
    if (height === null || name === "") {
      elements.push({ canonicalId: null, globalId: el.globalId, ifcClass: el.ifcClass, name: el.name, action: "unsupported", fields });
      mapping.push({ canonicalId: null, globalId: el.globalId, ifcClass: el.ifcClass, action: "unsupported" });
      continue;
    }

    const res = resolveCanonicalId(identity, existingById, "bim.space");
    if (res.mode === "reconcile") {
      const s = res.existing.props;
      const fp0 = s.footprint as readonly (readonly [number, number])[];
      const spaceFields: IfcFieldResult[] = [
        classifyValue("name", s.name as string, name),
        classifyNumber("height", s.height as number, height),
        classifyNumber("baseOffset", s.baseOffset as number, baseOffset),
      ];
      for (let i = 0; i < Math.max(fp0.length, pts.length); i++) {
        const p0 = fp0[i];
        const p1 = pts[i];
        spaceFields.push(classifyNumber(`footprint[${i}].x`, p0?.[0] ?? Number.NaN, p1?.[0] ?? Number.NaN));
        spaceFields.push(classifyNumber(`footprint[${i}].y`, p0?.[1] ?? Number.NaN, p1?.[1] ?? Number.NaN));
      }
      const changed: Record<string, unknown> = {};
      if (name !== (s.name as string)) changed.name = name;
      if (Math.abs((s.height as number) - height) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.height = height;
      if (Math.abs((s.baseOffset as number) - baseOffset) > IFC_ROUNDTRIP_TOLERANCE_MM) changed.baseOffset = baseOffset;
      const spaceCustom = compareCustomProps(
        (el.psets["Pset_OffisosCustom"] as Record<string, unknown> | undefined) ?? {},
        res.existing.props,
        ["bim", "type", "id", "name", "storyId", "footprint", "height", "baseOffset", "area"],
      );
      spaceFields.push(...spaceCustom.fields);
      if (spaceCustom.changed !== null) Object.assign(changed, spaceCustom.changed);
      const fpChanged = fp0.length !== pts.length || fp0.some((p, i) => Math.abs(p[0] - pts[i]![0]) > IFC_ROUNDTRIP_TOLERANCE_MM || Math.abs(p[1] - pts[i]![1]) > IFC_ROUNDTRIP_TOLERANCE_MM);
      if (fpChanged) changed.footprint = pts.map((p) => [p[0], p[1]]);
      const action = Object.keys(changed).length > 0 ? "reconciled" : "unchanged";
      if (Object.keys(changed).length > 0) patches.push({ elementId: res.existing.id, patch: fullPropsPatch(res.existing.props, changed) });
      elements.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, name, action, fields: spaceFields });
      mapping.push({ canonicalId: res.existing.id, globalId: el.globalId, ifcClass: el.ifcClass, action });
    } else {
      const entity: Record<string, unknown> = {
        type: "bim.space",
        storyId: story.id,
        name,
        footprint: pts.map((p) => [p[0], p[1]]),
        height, baseOffset,
      };
      const minted = res.explicitId ?? (options.mintId !== undefined ? options.mintId() : null);
      if (minted !== null) entity.id = minted;
      entities.push(entity);
      entityGlobalIds.push(el.globalId);
      elements.push({ canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, name, action: "created", fields });
      mapping.push({ canonicalId: minted, globalId: el.globalId, ifcClass: el.ifcClass, action: "created" });
    }
  }

  const report: IfcImportReport = {
    source: {
      sha256: sourceHash,
      schema: parsed.schema,
      lengthUnitName: parsed.lengthUnitName,
      lengthUnitPrefix: parsed.lengthUnitPrefix,
      scaleToMm: scale,
    },
    elements,
    summary: summarizeReports(elements),
    declaredFallbacks,
  };

  return {
    entities,
    globalIds: entityGlobalIds,
    patches,
    report,
    record: {
      sourceHash,
      schema: parsed.schema,
      lengthUnitName: parsed.lengthUnitName,
      lengthUnitPrefix: parsed.lengthUnitPrefix,
      scaleToMm: scale,
      reportHash: ifcReportHash(report),
      summary: report.summary,
      mapping,
    },
  };
}


/** Convert the import outcome's new-entity inputs into validated document
 *  elements (LOCK-007: every input re-validated through the strict BIM
 *  constructors — stored props are never trusted). `globalIdOf` supplies the
 *  per-entity IfcGuid (engineId provenance ONLY, LOCK-019). */
export function importEntitiesToElements(
  entities: readonly Record<string, unknown>[],
  globalIdOf: (index: number) => string | null,
): { id: string; kind: "bim"; engineId: string | null; props: Readonly<Record<string, unknown>> }[] {
  const out: { id: string; kind: "bim"; engineId: string | null; props: Readonly<Record<string, unknown>> }[] = [];
  for (const [index, raw] of entities.entries()) {
    const input = raw as Record<string, unknown>;
    const id = typeof input.id === "string" && input.id.length > 0 ? input.id : "";
    let entity: Record<string, unknown>;
    switch (input.type) {
      case "bim.story": entity = { ...makeStory(input) }; break;
      case "bim.wall": entity = { ...makeWall(input) }; break;
      case "bim.slab": entity = { ...makeSlab(input) }; break;
      case "bim.opening": entity = { ...makeOpening(input) }; break;
      case "bim.door": entity = { ...makeDoor(input) }; break;
      case "bim.window": entity = { ...makeWindow(input) }; break;
      case "bim.space": entity = { ...makeSpace(input) }; break;
      default:
        throw new Error(`IFC import: unknown entity type '${String(input.type)}'`);
    }
    // authored name survives when present
    if (typeof input.name === "string" && input.name !== "") entity.name = input.name;
    if (typeof input.id === "string" && input.id.length > 0) entity.id = input.id;
    const props: Record<string, unknown> = { bim: true, type: input.type, ...entity };
    delete props.id;
    out.push({
      id,
      kind: "bim",
      engineId: globalIdOf(index),
      props,
    });
  }
  return out;
}
