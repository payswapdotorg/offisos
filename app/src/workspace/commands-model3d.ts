/**
 * CAD-PARITY-009 command registry extension (Issue #90) — the 3D
 * navigation, UCS/workplane & bounded-modeling vocabulary.
 *
 * Commands:
 *  - UCS — the UCS manager echo: the named-UCS inventory (names + origins,
 *    the active one marked, the implicit World included) + the 3D Model view
 *    hint (the manager surface — the UCS dropdown and the triad live on the
 *    3D viewport, the LAYOUT manager pattern).
 *  - UCSNEW — define a named UCS: a name (Enter keeps the next UCSn) plus
 *    three typed "x,y,z" triples (the new origin, a point on the new X
 *    axis, a point in the new XY plane), each resolved through the CURRENT
 *    UCS. xAxis = normalize(X − origin); yAxis = the component ⊥ xAxis,
 *    normalized. Degenerate triples are emitted as-is so the App API
 *    surfaces the typed ucs_invalid decline through the error echo — never
 *    silently repaired.
 *  - UCSRENAME — rename a UCS (names unique; solids carry the immutable id
 *    — reference-safe by construction). Enter keeps the active UCS.
 *  - UCSDELETE — remove a named UCS (Enter keeps the active UCS; removing
 *    the ACTIVE UCS surfaces the typed ucs_active decline — activate World
 *    first).
 *  - UCSW — activate the implicit World UCS.
 *  - UCSACT — activate a named UCS (the non-versioned current-workplane
 *    switch, the activeLayer precedent).
 *  - VPOINT — the bounded 3D view command: ONE standard-view keyword
 *    (Top/Bottom/Front/Back/Left/Right/Iso, case-insensitive, Enter keeps
 *    Iso) → the shared standard camera (view3d.standard).
 *  - ZOOM3D — the bounded 3D zoom: Fit → the deterministic model extents
 *    (view3d.fit). Orbit/pan/wheel gestures are viewport interactions the
 *    host canvas runs through the SHARED camera module (orbitCamera/
 *    panCamera/zoomCamera) and persists through view3d.set — no host-local
 *    navigation math anywhere (LOCK-004).
 *  - BOX / CYLINDER / EXTRUDE — the bounded solid primitives placed through
 *    the ACTIVE UCS (UCS-placed descriptors; the engine mesh/provenance
 *    persists in the SAME atomic revision). The optional `at`/profile/
 *    baseZ inputs are ACTIVE-UCS coordinates — exactly the payload grammar.
 *  - MOVE3D / ROTATE3D / SCALE3D — the UCS-aware solid transforms. The
 *    element id is a plain typed token (el-NNNNNN); the typed transform
 *    triples are ACTIVE-UCS coordinates (the payload grammar — the server
 *    resolves them through the SAME UCS the command pins in ucsId).
 *  - SECTIONPLANE / SECTIONPLANEEDIT / SECTIONPLANEDELETE — the named
 *    section-plane lifecycle (the bounded section PREVIEW surface; the
 *    origin/normal triples are world coordinates, resolved through the
 *    CURRENT UCS like UCSNEW's).
 *  - 3DSTATE (alias VIEW3D) — the 3D state echo: the persisted camera, the
 *    active UCS and the solid count. NOTE: the command-name grammar is
 *    digit-tolerant (resolveCommand uppercases + indexes the registry —
 *    keymap.ts maps physical keys, never command tokens), so the AutoCAD-
 *    style digit-leading name resolves at the command line on both hosts.
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * `ucs.*`/`view3d.*`/`model3d.*`/`sectionplane.*` dispatch to the shared
 * model3d core (server-side validation; the document is the single
 * authority). The SAME registry drives ribbon, palette, keyboard and
 * command line on BOTH hosts (LOCK-004).
 */

import type { Vec3 } from "../contracts/geometry.js";
import type { UcsRecord } from "../contracts/caddocument.js";
import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  PromptStep,
  PromptValue,
} from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import {
  WORLD_UCS,
  defaultCamera,
  formatCamera,
  parseTypedPoint3D,
  resolveTypedPoint3D,
  v3Dot,
  v3Normalize,
  v3Sub,
} from "./model3d/index.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-layouts.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, ui, echo };
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: string): string {
  const v = values[id];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`command builder: step '${id}' has no text`);
  }
  if (v.kind !== "text") throw new Error(`command builder: step '${id}' is not text`);
  return v.text;
}

function numberValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: number): number {
  const v = values[id];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`command builder: step '${id}' has no number`);
  }
  if (v.kind !== "number") throw new Error(`command builder: step '${id}' is not a number`);
  return v.value;
}

function pointsValue(values: Readonly<Record<string, PromptValue>>, id: string): readonly (readonly [number, number])[] {
  const v = values[id];
  if (v === undefined || v.kind !== "points") throw new Error(`command builder: step '${id}' has no points`);
  return v.points.map((p) => [p[0], p[1]] as readonly [number, number]);
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function fmt3(v: Vec3): string {
  return `${trimNum(v[0])},${trimNum(v[1])},${trimNum(v[2])}`;
}

/** The ACTIVE UCS record (the implicit World when unset/unknown — the
 *  ucs.activate/App API resolution semantics). */
function activeUcs(ctx: CommandContext): UcsRecord {
  if (ctx.activeUcsId !== "world") {
    const found = ctx.ucs.find((u) => u.id === ctx.activeUcsId);
    if (found !== undefined) return found;
  }
  return WORLD_UCS;
}

/** The ACTIVE UCS display name. */
function activeUcsName(ctx: CommandContext): string {
  return activeUcs(ctx).name;
}

/** Resolve one prompt value as a WORLD point: a typed "x,y,z" triple
 *  resolved through the CURRENT UCS (parseTypedPoint3D + resolveTypedPoint3D
 *  — the AutoCAD typed-input-in-the-active-workplane convention), or a plan
 *  point value (a canvas pick interpreted on the UCS XY plane, z = 0). */
function worldPoint(values: Readonly<Record<string, PromptValue>>, id: string, ucs: UcsRecord): Vec3 {
  const v = values[id];
  if (v === undefined) throw new Error(`command builder: step '${id}' is missing`);
  if (v.kind === "point") {
    const resolved = resolveTypedPoint3D(ucs, { point: [v.point[0], v.point[1], 0], relative: false }, null);
    if (resolved === null) throw new Error(`command builder: step '${id}' could not resolve the pick through the active UCS`);
    return resolved;
  }
  if (v.kind !== "text") throw new Error(`command builder: step '${id}' must be a typed 'x,y,z' triple`);
  const typed = parseTypedPoint3D(v.text);
  if (typed === null) {
    throw new Error(`'${v.text}' is not a 3D point — type 'x,y,z' (e.g. 10,0,0)`);
  }
  const resolved = resolveTypedPoint3D(ucs, typed, null);
  if (resolved === null) {
    throw new Error("relative '@x,y,z' input needs a base point — type an absolute 'x,y,z' triple");
  }
  return resolved;
}

/** Parse one prompt value as an ACTIVE-UCS coordinate triple, passed through
 *  to the payload grammar verbatim (model3d.* payloads resolve the triple
 *  through the SAME UCS the command pins in ucsId — identical semantics,
 *  zero host-side duplication). */
function ucsTriple(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: Vec3): Vec3 {
  const v = values[id];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`command builder: step '${id}' is missing`);
  }
  if (v.kind === "point") return [v.point[0], v.point[1], 0];
  if (v.kind !== "text") throw new Error(`command builder: step '${id}' must be a typed 'x,y,z' triple`);
  const typed = parseTypedPoint3D(v.text);
  if (typed === null) {
    throw new Error(`'${v.text}' is not a 3D point — type 'x,y,z' (e.g. 5,0,0)`);
  }
  if (typed.relative) {
    throw new Error("relative '@x,y,z' input needs a base point — type an absolute 'x,y,z' triple");
  }
  return typed.point;
}

/** Parse a standard-view keyword (case-insensitive; the bounded set). */
function parseStandardView(text: string): "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" {
  const t = text.trim().toLowerCase();
  if (t === "top" || t === "bottom" || t === "front" || t === "back" || t === "left" || t === "right" || t === "iso") return t;
  throw new Error(`unknown standard view '${text}' — valid: Top, Bottom, Front, Back, Left, Right, Iso`);
}

// ---------------------------------------------------------------------------
// The command registry extension.
// ---------------------------------------------------------------------------

export const COMMANDS_MODEL3D: readonly WorkspaceCommand[] = [
  {
    id: "ucs",
    name: "UCS",
    aliases: [],
    label: "UCS Manager",
    description:
      "List the named UCS/workplanes (names + origins, the active one marked, the implicit World included) and open the 3D Model view — the UCS dropdown, the workplane triad and the grid live there.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [],
    instant: (ctx) => {
      const echo: string[] = [];
      const records = ctx.ucs;
      const active = activeUcs(ctx);
      echo.push(`Named UCS (${records.length + 1}):`);
      echo.push(`  World${active.id === "world" ? " (active)" : ""} — origin 0,0,0 (implicit)`);
      for (const ucs of records) {
        echo.push(`  ${ucs.name}${ucs.id === active.id ? " (active)" : ""} — origin ${fmt3(ucs.origin)} (${ucs.id})`);
      }
      if (records.length === 0) echo.push("  (no named UCS yet — UCSNEW defines one)");
      return plan([], echo, [{ action: "view.model3d" }]);
    },
  },
  {
    id: "ucsnew",
    name: "UCSNEW",
    aliases: [],
    label: "New UCS",
    description:
      "Define a named UCS/workplane: the new origin, a point on the new X axis and a point in the new XY plane — each a typed 'x,y,z' triple resolved through the CURRENT UCS. Enter keeps the next UCSn name. Degenerate axis triples surface the typed ucs_invalid decline through the ucs.define error echo.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "name", kind: "text", prompt: "Enter UCS name:", optional: true },
      { id: "origin", kind: "text", prompt: "Enter new UCS origin (x,y,z):" },
      { id: "xAxis", kind: "text", prompt: "Enter a point on the new X axis (x,y,z):" },
      { id: "yAxis", kind: "text", prompt: "Enter a point in the new XY plane (x,y,z):" },
    ],
    build: (values, ctx) => {
      const fallback = `UCS${ctx.ucs.length + 1}`;
      const name = textValue(values, "name", fallback).trim();
      if (name.length === 0) throw new Error("UCS name must be a non-empty string");
      if (name.toLowerCase() === "world") {
        throw new Error("the name 'World' is reserved for the implicit World UCS");
      }
      if (ctx.ucs.some((u) => u.name === name)) {
        throw new Error(`UCS name '${name}' already exists — UCS names are unique`);
      }
      const current = activeUcs(ctx);
      const origin = worldPoint(values, "origin", current);
      const xPoint = worldPoint(values, "xAxis", current);
      const yPoint = worldPoint(values, "yAxis", current);
      // xAxis = normalize(X − origin); yAxis = the component ⊥ xAxis,
      // normalized. Degenerate differences pass through RAW so the App API
      // validation declines them as ucs_invalid (explicit, never silent).
      const xDiff = v3Sub(xPoint, origin);
      const xAxis = v3Normalize(xDiff) ?? xDiff;
      const yRaw = v3Sub(yPoint, origin);
      const d = v3Dot(yRaw, xAxis);
      let yAxis: Vec3 = [yRaw[0] - xAxis[0] * d, yRaw[1] - xAxis[1] * d, yRaw[2] - xAxis[2] * d];
      yAxis = v3Normalize(yAxis) ?? yAxis;
      return plan(
        [
          // zAxis omitted — the server derives the exact right-handed x × y.
          { name: "ucs.define", payload: { name, origin: [...origin], xAxis: [...xAxis], yAxis: [...yAxis] } },
        ],
        [
          `UCS '${name}' defined — origin ${fmt3(origin)}, X ${fmt3(xAxis)}, Y ${fmt3(yAxis)} (world). UCSACT activates it.`,
        ],
      );
    },
  },
  {
    id: "ucsrename",
    name: "UCSRENAME",
    aliases: [],
    label: "Rename UCS",
    description:
      "Rename a UCS (names are unique; solids carry the immutable id — a rename is reference-safe by construction). Enter keeps the active UCS.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "ucs", kind: "text", prompt: "Enter UCS to rename <active>:", optional: true },
      { id: "newName", kind: "text", prompt: "Enter new name:" },
    ],
    build: (values, ctx) => {
      if (ctx.ucs.length === 0) throw new Error("no named UCS exist yet — UCSNEW defines one");
      const source = textValue(values, "ucs", activeUcsName(ctx)).trim();
      const record = ctx.ucs.find((u) => u.name === source);
      if (record === undefined) {
        const names = ctx.ucs.map((u) => u.name).join(", ");
        throw new Error(`unknown UCS '${source}' — available: ${names}`);
      }
      const newName = textValue(values, "newName").trim();
      if (newName.length === 0) throw new Error("the new UCS name must be a non-empty string");
      if (newName.toLowerCase() === "world") {
        throw new Error("the name 'World' is reserved for the implicit World UCS");
      }
      return plan(
        [{ name: "ucs.update", payload: { name: record.name, patch: { name: newName } } }],
        [`UCS '${record.name}' renamed to '${newName}'.`],
      );
    },
  },
  {
    id: "ucsdelete",
    name: "UCSDELETE",
    aliases: [],
    label: "Delete UCS",
    description:
      "Remove a named UCS. Enter keeps the active UCS — removing the ACTIVE UCS surfaces the typed ucs_active decline (activate World with UCSW first); the implicit World UCS is never removable.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "ucs", kind: "text", prompt: "Enter UCS to delete <active>:", optional: true },
    ],
    build: (values, ctx) => {
      if (ctx.ucs.length === 0) throw new Error("no named UCS exist yet");
      const source = textValue(values, "ucs", activeUcsName(ctx)).trim();
      return plan(
        [{ name: "ucs.remove", payload: { name: source } }],
        [`UCS '${source}' removed.`],
      );
    },
  },
  {
    id: "ucsw",
    name: "UCSW",
    aliases: [],
    label: "World UCS",
    description:
      "Activate the implicit World UCS (the non-versioned current-workplane switch — UCSDELETE of the active UCS requires it).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [],
    instant: () =>
      plan(
        [{ name: "ucs.activate", payload: { id: "world" } }],
        ["World UCS active (origin 0,0,0, identity axes)."],
        [{ action: "view.model3d" }],
      ),
  },
  {
    id: "ucsact",
    name: "UCSACT",
    aliases: [],
    label: "Activate UCS",
    description:
      "Activate a named UCS by name (the non-versioned current-workplane switch — typed 'x,y,z' triples and the model3d payloads resolve through it; the activeLayer precedent).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "name", kind: "text", prompt: "Enter UCS name to activate:" },
    ],
    build: (values) => {
      const name = textValue(values, "name").trim();
      if (name.length === 0) throw new Error("UCS name must be a non-empty string");
      return plan(
        [{ name: "ucs.activate", payload: { name } }],
        [`UCS '${name}' activation requested (the workplane switch is not versioned).`],
        [{ action: "view.model3d" }],
      );
    },
  },
  {
    id: "vpoint",
    name: "VPOINT",
    aliases: [],
    label: "3D Views",
    description:
      "The bounded 3D view command: one standard-view keyword (Top/Bottom/Front/Back/Left/Right/Iso, case-insensitive, Enter keeps Iso) → the shared standard camera of the deterministic model extents (view3d.standard — persisted, non-versioned view state).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      {
        id: "view",
        kind: "text",
        prompt: "Enter standard view [Top/Bottom/Front/Back/Left/Right/Iso] <Iso>:",
        optional: true,
        defaultValue: "Iso",
      },
    ],
    build: (values) => {
      const view = parseStandardView(textValue(values, "view", "Iso"));
      return plan(
        [{ name: "view3d.standard", payload: { view, aspect: 1 } }],
        [`View set to the ${view.toUpperCase()} standard view (the deterministic model extents).`],
        [{ action: "view.model3d" }],
      );
    },
  },
  {
    id: "zoom3d",
    name: "ZOOM3D",
    aliases: [],
    label: "3D Zoom Fit",
    description:
      "The bounded 3D zoom: Fit — the shared fitCameraToBBox over the deterministic model extents, keeping the current view direction (view3d.fit). Orbit/pan/wheel gestures live on the 3D viewport through the SHARED camera module and persist through view3d.set.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "mode", kind: "text", prompt: "Enter zoom mode [Fit] <Fit>:", optional: true, defaultValue: "Fit" },
    ],
    build: (values) => {
      const mode = textValue(values, "mode", "Fit").trim().toLowerCase();
      if (mode !== "fit") {
        throw new Error(`unknown zoom mode '${mode}' — this slice supports Fit (orbit/pan/wheel are viewport gestures)`);
      }
      return plan(
        [{ name: "view3d.fit", payload: { aspect: 1 } }],
        ["3D view fitted to the model extents (all eight corners inside the view)."],
        [{ action: "view.model3d" }],
      );
    },
  },
  {
    id: "box3d",
    name: "BOX",
    aliases: [],
    label: "3D Box",
    description:
      "Create a box solid through the ACTIVE UCS: width/depth/height (> 0) plus an optional base point (ACTIVE-UCS 'x,y,z' triple, Enter keeps 0,0,0 — the base corner; edges along the UCS axes). The engine mesh + provenance persist in the SAME atomic revision.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "width", kind: "number", prompt: "Enter box width (UCS X):" },
      { id: "depth", kind: "number", prompt: "Enter box depth (UCS Y):" },
      { id: "height", kind: "number", prompt: "Enter box height (UCS Z):" },
      { id: "at", kind: "text", prompt: "Enter base point (UCS x,y,z) <0,0,0>:", optional: true, defaultValue: "0,0,0" },
    ],
    build: (values, ctx) => {
      const width = numberValue(values, "width");
      const depth = numberValue(values, "depth");
      const height = numberValue(values, "height");
      if (!(width > 0) || !(depth > 0) || !(height > 0)) {
        throw new Error("box width/depth/height must be positive numbers");
      }
      const at = ucsTriple(values, "at", [0, 0, 0]);
      const ucs = activeUcs(ctx);
      return plan(
        [{ name: "model3d.box", payload: { width, depth, height, at: [...at], ucsId: ucs.id } }],
        [`Box ${trimNum(width)}×${trimNum(depth)}×${trimNum(height)} at ${fmt3(at)} through UCS '${ucs.name}'.`],
      );
    },
  },
  {
    id: "cylinder3d",
    name: "CYLINDER",
    aliases: [],
    label: "3D Cylinder",
    description:
      "Create a cylinder solid through the ACTIVE UCS: radius/height (> 0) plus an optional base-center point (ACTIVE-UCS 'x,y,z' triple, Enter keeps 0,0,0; the axis runs along the UCS Z).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "radius", kind: "number", prompt: "Enter cylinder radius:" },
      { id: "height", kind: "number", prompt: "Enter cylinder height (UCS Z):" },
      { id: "at", kind: "text", prompt: "Enter base center point (UCS x,y,z) <0,0,0>:", optional: true, defaultValue: "0,0,0" },
    ],
    build: (values, ctx) => {
      const radius = numberValue(values, "radius");
      const height = numberValue(values, "height");
      if (!(radius > 0) || !(height > 0)) {
        throw new Error("cylinder radius/height must be positive numbers");
      }
      const at = ucsTriple(values, "at", [0, 0, 0]);
      const ucs = activeUcs(ctx);
      return plan(
        [{ name: "model3d.cylinder", payload: { radius, height, at: [...at], ucsId: ucs.id } }],
        [`Cylinder r${trimNum(radius)} h${trimNum(height)} at ${fmt3(at)} through UCS '${ucs.name}'.`],
      );
    },
  },
  {
    id: "extrude3d",
    name: "EXTRUDE",
    aliases: [],
    label: "3D Extrude",
    description:
      "Create an extrusion-derived solid through the ACTIVE UCS: a planar profile of typed 'x,y' points (≥ 3; Enter ends the profile), the extrusion height along the UCS Z and an optional base Z offset. The profile lives in the UCS XY plane.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      {
        id: "profile",
        kind: "point",
        prompt: "Enter profile point (UCS x,y) — Enter finishes the profile:",
        optional: true,
        multiple: true,
        minInputs: 3,
      },
      { id: "height", kind: "number", prompt: "Enter extrusion height (UCS Z):" },
      { id: "baseZ", kind: "number", prompt: "Enter base Z offset (UCS) <0>:", optional: true, defaultValue: 0 },
    ],
    build: (values, ctx) => {
      const profile = pointsValue(values, "profile");
      if (profile.length < 3) {
        throw new Error(`the profile needs at least 3 points — ${profile.length} collected`);
      }
      const height = numberValue(values, "height");
      if (!(height > 0)) throw new Error("the extrusion height must be a positive number");
      const baseZ = numberValue(values, "baseZ", 0);
      if (!Number.isFinite(baseZ)) throw new Error("the base Z offset must be a finite number");
      const ucs = activeUcs(ctx);
      // canonical-minimal: baseZ omitted at 0 — the persisted element props
      // carry no baseZ key until it is set (the P009 parity-anchor shape).
      const payload: Record<string, unknown> = { profile: profile.map((p) => [p[0], p[1]]), height, ucsId: ucs.id };
      if (baseZ !== 0) payload.baseZ = baseZ;
      return plan(
        [{ name: "model3d.extrude", payload }],
        [
          `Extruded a ${profile.length}-point profile (UCS XY) by ${trimNum(height)}${baseZ !== 0 ? ` from base Z ${trimNum(baseZ)}` : ""} through UCS '${ucs.name}'.`,
        ],
      );
    },
  },
  {
    id: "move3d",
    name: "MOVE3D",
    aliases: [],
    label: "3D Move",
    description:
      "Move a model3d solid: the element id (el-NNNNNN) and the displacement as an ACTIVE-UCS 'x,y,z' triple (the payload grammar — the server resolves it through the SAME UCS).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "elementId", kind: "text", prompt: "Enter solid element id (el-NNNNNN):" },
      { id: "delta", kind: "text", prompt: "Enter displacement (ACTIVE UCS x,y,z):" },
    ],
    build: (values, ctx) => {
      const elementId = textValue(values, "elementId").trim();
      if (elementId.length === 0) throw new Error("the element id must be a non-empty string");
      const delta = ucsTriple(values, "delta");
      const ucs = activeUcs(ctx);
      return plan(
        [{ name: "model3d.move", payload: { elementId, delta: [...delta], ucsId: ucs.id } }],
        [`Move ${elementId} by ${fmt3(delta)} (UCS '${ucs.name}').`],
      );
    },
  },
  {
    id: "rotate3d",
    name: "ROTATE3D",
    aliases: [],
    label: "3D Rotate",
    description:
      "Rotate a model3d solid about an axis: the element id, the rotation axis as an ACTIVE-UCS 'x,y,z' triple, the angle in degrees and an optional base point (ACTIVE-UCS triple; Enter keeps the UCS origin).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "elementId", kind: "text", prompt: "Enter solid element id (el-NNNNNN):" },
      { id: "axis", kind: "text", prompt: "Enter rotation axis (ACTIVE UCS x,y,z):" },
      { id: "deg", kind: "number", prompt: "Enter rotation angle (degrees):" },
      { id: "base", kind: "text", prompt: "Enter base point (ACTIVE UCS x,y,z) <UCS origin>:", optional: true },
    ],
    build: (values, ctx) => {
      const elementId = textValue(values, "elementId").trim();
      if (elementId.length === 0) throw new Error("the element id must be a non-empty string");
      const axis = ucsTriple(values, "axis");
      const deg = numberValue(values, "deg");
      if (!Number.isFinite(deg)) throw new Error("the rotation angle must be a finite number");
      const ucs = activeUcs(ctx);
      const payload: Record<string, unknown> = { elementId, axis: [...axis], deg, ucsId: ucs.id };
      if (values.base !== undefined) {
        payload.base = [...ucsTriple(values, "base")];
      }
      return plan(
        [{ name: "model3d.rotate", payload }],
        [`Rotate ${elementId} by ${trimNum(deg)}° about ${fmt3(axis)}${values.base !== undefined ? " (base set)" : ""} (UCS '${ucs.name}').`],
      );
    },
  },
  {
    id: "scale3d",
    name: "SCALE3D",
    aliases: [],
    label: "3D Scale",
    description:
      "Uniformly scale a model3d solid: the element id, the factor (> 0) and an optional base point (ACTIVE-UCS triple; Enter keeps the UCS origin).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "elementId", kind: "text", prompt: "Enter solid element id (el-NNNNNN):" },
      { id: "factor", kind: "number", prompt: "Enter scale factor:" },
      { id: "base", kind: "text", prompt: "Enter base point (ACTIVE UCS x,y,z) <UCS origin>:", optional: true },
    ],
    build: (values, ctx) => {
      const elementId = textValue(values, "elementId").trim();
      if (elementId.length === 0) throw new Error("the element id must be a non-empty string");
      const factor = numberValue(values, "factor");
      if (!(factor > 0)) throw new Error("the scale factor must be a positive number");
      const ucs = activeUcs(ctx);
      const payload: Record<string, unknown> = { elementId, factor, ucsId: ucs.id };
      if (values.base !== undefined) {
        payload.base = [...ucsTriple(values, "base")];
      }
      return plan(
        [{ name: "model3d.scale", payload }],
        [`Scale ${elementId} by ${trimNum(factor)}${values.base !== undefined ? " (base set)" : ""} (UCS '${ucs.name}').`],
      );
    },
  },
  {
    id: "sectionplane",
    name: "SECTIONPLANE",
    aliases: [],
    label: "New Section Plane",
    description:
      "Define a named section/slice plane: the name, the plane origin and the plane normal — typed 'x,y,z' triples resolved through the CURRENT UCS (the payload grammar is world coordinates). The normal is normalized at the document boundary; the bounded section preview (model3d.sectionPreview) derives from it on demand.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "name", kind: "text", prompt: "Enter section plane name:" },
      { id: "origin", kind: "text", prompt: "Enter plane origin (x,y,z):" },
      { id: "normal", kind: "text", prompt: "Enter plane normal (x,y,z):" },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name").trim();
      if (name.length === 0) throw new Error("the section plane name must be a non-empty string");
      const current = activeUcs(ctx);
      const origin = worldPoint(values, "origin", current);
      const normal = worldPoint(values, "normal", current);
      return plan(
        [{ name: "sectionplane.create", payload: { name, origin: [...origin], normal: [...normal] } }],
        [`Section plane '${name}' at ${fmt3(origin)}, normal ${fmt3(normal)} (normalized on the server).`],
      );
    },
  },
  {
    id: "sectionplaneedit",
    name: "SECTIONPLANEEDIT",
    aliases: [],
    label: "Edit Section Plane",
    description:
      "Patch a named section plane: Enter keeps each field (name, origin, normal); only the provided fields go into the patch (an empty patch is an honest no-op echo). The origin/normal triples resolve through the CURRENT UCS.",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "name", kind: "text", prompt: "Enter section plane to edit:" },
      { id: "newName", kind: "text", prompt: "Enter new name <keep>:", optional: true },
      { id: "origin", kind: "text", prompt: "Enter new origin (x,y,z) <keep>:", optional: true },
      { id: "normal", kind: "text", prompt: "Enter new normal (x,y,z) <keep>:", optional: true },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name").trim();
      if (name.length === 0) throw new Error("the section plane name must be a non-empty string");
      const current = activeUcs(ctx);
      const patch: Record<string, unknown> = {};
      const newName = textValue(values, "newName", "").trim();
      if (newName.length > 0) patch.name = newName;
      if (values.origin !== undefined) patch.origin = [...worldPoint(values, "origin", current)];
      if (values.normal !== undefined) patch.normal = [...worldPoint(values, "normal", current)];
      if (Object.keys(patch).length === 0) {
        return plan([], [`Section plane '${name}': no changes (Enter kept every field).`]);
      }
      return plan(
        [{ name: "sectionplane.update", payload: { name, patch } }],
        [`Section plane '${name}' patched: ${Object.keys(patch).join(", ")}.`],
      );
    },
  },
  {
    id: "sectionplanedelete",
    name: "SECTIONPLANEDELETE",
    aliases: [],
    label: "Delete Section Plane",
    description:
      "Remove a named section-plane definition (the derived preview recomputes on demand — nothing stored references it).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [
      { id: "name", kind: "text", prompt: "Enter section plane to delete:" },
    ],
    build: (values) => {
      const name = textValue(values, "name").trim();
      if (name.length === 0) throw new Error("the section plane name must be a non-empty string");
      return plan(
        [{ name: "sectionplane.remove", payload: { name } }],
        [`Section plane '${name}' removed.`],
      );
    },
  },
  {
    id: "state3d",
    name: "3DSTATE",
    aliases: ["VIEW3D"],
    label: "3D State",
    description:
      "Echo the 3D state: the persisted deterministic camera (eye/target/mode/zoom), the active UCS and the model3d solid count. The digit-leading name is grammar-legal (command tokens are registry-indexed, never alphabetic-restricted).",
    category: "model3d",
    ribbonTab: "3D Model",
    steps: [],
    instant: (ctx) => {
      const camera = ctx.view3d ?? defaultCamera();
      const ucs = activeUcs(ctx);
      return plan(
        [],
        [
          "3D state:",
          `  camera: ${formatCamera(camera)}`,
          `  active UCS: ${ucs.name} (${ucs.id})`,
          `  solids: ${ctx.model3dSolidCount}`,
        ],
        [{ action: "view.model3d" }],
      );
    },
  },
];
