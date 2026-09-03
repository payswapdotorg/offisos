/**
 * CAD-PARITY-018 command registry extension (Issue #118) — the
 * specialized professional toolsets vocabulary: the architecture
 * composition surface (wall runs, hosted openings, roofs, stairs,
 * spaces, dimension chains, component arrays), the bounded MEP
 * routing surface (runs, connections, route validation and clash
 * reports), the bounded mechanical layout surface (equipment,
 * deterministic arrays) and the raster/underlay surface (sources,
 * references, status, trace).
 *
 * Commands (all ribbonTab "Toolsets" — a new tab value the hosts map;
 * the registry is host-agnostic; ONE mutating app-api call per
 * command):
 *  - WALLRUN (WRUN) — compose a multi-segment wall run from a
 *    polyline over the verified P011 BIM primitives (optional
 *    junction openings at the interior vertices). ONE
 *    toolset.archWallRun command.
 *  - PLACEOPENING (POPN) — place a hosted door/window opening into
 *    an existing wall (the P011 host binding). ONE
 *    toolset.archHostedOpening command.
 *  - ROOFCREATE (ROOF) — compose a roof over the verified P011 roof
 *    primitive. ONE toolset.archRoof command.
 *  - STAIRRUN (STAI) — compose a stair run (with optional railing
 *    pair) over the P011 stair/railing primitives. ONE
 *    toolset.archStairRun command.
 *  - SPACEGRID (SPGR) — compose a bounded room/space grid. ONE
 *    toolset.archSpaceGrid command.
 *  - DIMCHAIN (DIMC) — compose an architectural dimension chain
 *    over the existing annotation primitives. ONE
 *    toolset.archDimChain command.
 *  - COMPARRAY (CAR) — compose a deterministic component-instance
 *    array. ONE toolset.archComponentArray command.
 *  - MEPRUN (MEPR) — create a bounded duct/pipe/conduit routing run
 *    record. ONE toolset.mepAddRun command.
 *  - MEPCONNECT (MCON) — connect a run end to a connector
 *    (equipment port / run / free endpoint — domain-neutral). ONE
 *    toolset.mepConnect command.
 *  - EQUIPADD (EQAD) — place a bounded mechanical equipment record
 *    with connector/port metadata. ONE toolset.mechAddEquipment
 *    command.
 *  - EQUIPARRAY (EQAR) — compose a deterministic equipment array.
 *    ONE toolset.mechArray command.
 *  - RASTERATTACH (RATT) — attach a raster/underlay reference to a
 *    registered source. ONE toolset.rasterAttach command.
 *  - TOOLSETREPORT (TSR) — the specialized-toolsets report surface
 *    (report.toolsets ui action — the host renders the REAL
 *    toolset.capabilities/listRecords/rasterStatus query results).
 *  - MEPREPORT (MEPR) — the MEP clash/clearance diagnostics report
 *    surface (report.toolsets).
 *  - RASTERSTATUS (RSTAT) — the raster reference status report
 *    surface (report.toolsets).
 *  - RASTERTRACE (RTRA) — the typed non-authoritative trace preview
 *    surface (report.toolsets).
 *
 * Echo discipline (the P013/P015/P016/P017 convention): the prompt
 * engine's echo lines are BUILD-TIME static — the response-derived
 * tails are appended by the HOST from the command response. Every
 * command is pure data + a pure builder emitting App API commands;
 * the dispatch lives in app-api/contract.ts (server-side validation;
 * the CADDocument is the single canonical authority — LOCK-019).
 * The SAME registry drives ribbon, palette, keyboard and command
 * line on BOTH hosts (LOCK-004).
 */

import type {
  AppApiCommandPlanEntry,
  CommandPlan,
  PromptValue,
} from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import { optionValue } from "./prompt-options.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-automation.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, echo, ui };
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: string): string | null {
  const v = values[id];
  if (v === undefined) return fallback !== undefined ? fallback : null;
  if (v.kind !== "text") return fallback !== undefined ? fallback : null;
  return v.text;
}

/** Parses "x,y" / "x,y,z" coordinate text into a point object (null on malformed). */
function pointValue(values: Readonly<Record<string, PromptValue>>, id: string, dims: 2 | 3): { x: number; y: number; z?: number } | null {
  const raw = textValue(values, id);
  if (raw === null) return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== dims) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const x = nums[0] ?? NaN;
  const y = nums[1] ?? NaN;
  const z = nums[2] ?? NaN;
  return dims === 2 ? { x, y } : { x, y, z };
}

/** Parses "x,y;x,y;…" polyline text into a point list (null on malformed). */
function polyValue(values: Readonly<Record<string, PromptValue>>, id: string): Array<{ x: number; y: number }> | null {
  const raw = textValue(values, id);
  if (raw === null) return null;
  const pts = raw.split(";").map((seg) => seg.trim()).filter((seg) => seg.length > 0);
  if (pts.length < 2) return null;
  const out: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    const parts = p.split(",").map((c) => c.trim());
    if (parts.length !== 2) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push({ x, y });
  }
  return out;
}

function numberValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: number): number | null {
  const raw = textValue(values, id);
  if (raw === null) return fallback !== undefined ? fallback : null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

const MEP_DOMAINS: readonly string[] = ["duct", "pipe", "conduit"];

function mepDomainOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "domain", "DUC") !== null) return "duct";
  if (optionValue(values, "domain", "PIP") !== null) return "pipe";
  if (optionValue(values, "domain", "CON") !== null) return "conduit";
  const typed = (textValue(values, "domain", "duct") ?? "").trim().toLowerCase();
  return MEP_DOMAINS.find((d) => d === typed) ?? null;
}

// ---------------------------------------------------------------------------
// The registry extension.
// ---------------------------------------------------------------------------

export const COMMANDS_TOOLSETS: readonly WorkspaceCommand[] = [
  // --- WALLRUN — compose a multi-segment wall run ---------------------------
  {
    id: "wallrun",
    name: "WALLRUN",
    aliases: ["WRUN"],
    label: "Wall run",
    description:
      "Compose a multi-segment architectural wall run from a polyline over the verified P011 BIM primitives — deterministic per-segment names and optional junction openings at the interior vertices (one atomic revision; undo restores exactly).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "storyId", kind: "text", prompt: "Host story id:" },
      { id: "polyline", kind: "text", prompt: "Polyline vertices x,y;x,y;… :" },
      { id: "widthMm", kind: "text", prompt: "Wall width (mm) <200>:", defaultValue: "200" },
      { id: "heightMm", kind: "text", prompt: "Wall height (mm) <3000>:", defaultValue: "3000" },
      { id: "name", kind: "text", prompt: "Run name prefix <WR>:", defaultValue: "WR" },
      {
        id: "junctions",
        kind: "text",
        prompt: "Interior junctions [NONe/OPENings] <none>:",
        defaultValue: "none",
        options: [
          { keyword: "NON", label: "none", flag: true },
          { keyword: "OPEN", label: "openings", flag: true },
        ],
      },
    ],
    build: (values) => {
      const storyId = (textValue(values, "storyId") ?? "").trim();
      if (storyId.length === 0) throw new Error("WALLRUN requires a non-empty host story id.");
      const polyline = polyValue(values, "polyline");
      if (polyline === null) throw new Error("WALLRUN requires a polyline 'x,y;x,y;…' (at least two vertices).");
      const widthMm = numberValue(values, "widthMm", 200);
      const heightMm = numberValue(values, "heightMm", 3000);
      if (widthMm === null || widthMm <= 0) throw new Error("WALLRUN requires a positive wall width.");
      if (heightMm === null || heightMm <= 0) throw new Error("WALLRUN requires a positive wall height.");
      const junctions = optionValue(values, "junctions", "OPEN") !== null ? "openings" : "none";
      const name = (textValue(values, "name", "WR") ?? "WR").trim() || "WR";
      const segments = polyline.length - 1;
      return plan(
        [{ name: "toolset.archWallRun", payload: { storyId, polyline, widthMm, heightMm, name, junctions } }],
        [`WALLRUN: ${segments} wall segment(s) from ${polyline.length} vertices (junctions: ${junctions}).`],
      );
    },
  },

  // --- PLACEOPENING — hosted door/window into a wall ------------------------
  {
    id: "placeopening",
    name: "PLACEOPENING",
    aliases: ["POPN"],
    label: "Hosted opening",
    description:
      "Place a hosted door/window opening into an existing wall (the P011 host binding: the opening's hostId + the fill's openingId, one atomic batch).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "wallId", kind: "text", prompt: "Host wall id:" },
      {
        id: "kind",
        kind: "text",
        prompt: "Opening kind [DOOr/WINDow] <door>:",
        defaultValue: "door",
        options: [
          { keyword: "DOO", label: "door", flag: true },
          { keyword: "WIND", label: "window", flag: true },
        ],
      },
      { id: "tAlongWall", kind: "text", prompt: "Position along the wall (0..1) <0.5>:", defaultValue: "0.5" },
      { id: "widthMm", kind: "text", prompt: "Width (mm) <900>:", defaultValue: "900" },
      { id: "heightMm", kind: "text", prompt: "Height (mm) <2100>:", defaultValue: "2100" },
      { id: "sillMm", kind: "text", prompt: "Sill height (mm) <0>:", defaultValue: "0" },
    ],
    build: (values) => {
      const wallId = (textValue(values, "wallId") ?? "").trim();
      if (wallId.length === 0) throw new Error("PLACEOPENING requires a non-empty host wall id.");
      const kind = optionValue(values, "kind", "WIND") !== null ? "window" : "door";
      const tAlongWall = numberValue(values, "tAlongWall", 0.5);
      if (tAlongWall === null || tAlongWall < 0 || tAlongWall > 1) throw new Error("PLACEOPENING requires a position in 0..1.");
      const widthMm = numberValue(values, "widthMm", 900);
      const heightMm = numberValue(values, "heightMm", 2100);
      const sillMm = numberValue(values, "sillMm", 0);
      if (widthMm === null || widthMm <= 0 || heightMm === null || heightMm <= 0 || sillMm === null || sillMm < 0) {
        throw new Error("PLACEOPENING requires positive width/height and a non-negative sill.");
      }
      return plan(
        [{ name: "toolset.archHostedOpening", payload: { wallId, kind, tAlongWall, widthMm, heightMm, sillMm } }],
        [`PLACEOPENING: ${kind} hosted in '${wallId}' at t=${tAlongWall}.`],
      );
    },
  },

  // --- ROOFCREATE — compose a roof -------------------------------------------
  {
    id: "roofcreate",
    name: "ROOFCREATE",
    aliases: ["RFC"],
    label: "Roof",
    description:
      "Compose a bounded roof over the verified P011 roof primitive (corner-to-corner footprint with a ridge axis and height; one atomic revision).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "storyId", kind: "text", prompt: "Host story id:" },
      { id: "corner1", kind: "text", prompt: "Footprint corner 1 x,y:" },
      { id: "corner2", kind: "text", prompt: "Footprint corner 2 (opposite) x,y:" },
      { id: "ridgeAxis", kind: "text", prompt: "Ridge axis [X/Y] <x>:", defaultValue: "x" },
      { id: "heightMm", kind: "text", prompt: "Roof height (mm) <2000>:", defaultValue: "2000" },
      { id: "baseOffsetMm", kind: "text", prompt: "Base offset (mm) <0>:", defaultValue: "0" },
    ],
    build: (values) => {
      const storyId = (textValue(values, "storyId") ?? "").trim();
      if (storyId.length === 0) throw new Error("ROOFCREATE requires a non-empty host story id.");
      const corner1 = pointValue(values, "corner1", 2);
      const corner2 = pointValue(values, "corner2", 2);
      if (corner1 === null || corner2 === null) throw new Error("ROOFCREATE requires two 'x,y' footprint corners.");
      const heightMm = numberValue(values, "heightMm", 2000);
      if (heightMm === null || heightMm <= 0) throw new Error("ROOFCREATE requires a positive roof height.");
      const ridgeRaw = (textValue(values, "ridgeAxis", "x") ?? "x").trim().toLowerCase();
      const ridgeAxis = ridgeRaw.startsWith("y") ? "y" : "x";
      const baseOffsetMm = numberValue(values, "baseOffsetMm", 0) ?? 0;
      return plan(
        [{ name: "toolset.archRoof", payload: { storyId, corner1, corner2, ridgeAxis, heightMm, baseOffsetMm } }],
        [`ROOFCREATE: roof over ${JSON.stringify(corner1)}–${JSON.stringify(corner2)} (ridge ${ridgeAxis}, ${heightMm}mm).`],
      );
    },
  },

  // --- STAIRRUN — compose a stair run ----------------------------------------
  {
    id: "stairrun",
    name: "STAIRRUN",
    aliases: ["STAI"],
    label: "Stair run",
    description:
      "Compose a stair run between two stories over the P011 stair primitive, with an optional railing pair (deterministic offsets; one atomic revision).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "storyId", kind: "text", prompt: "Base story id:" },
      { id: "topStoryId", kind: "text", prompt: "Top story id:" },
      { id: "start", kind: "text", prompt: "Start x,y:" },
      { id: "directionDeg", kind: "text", prompt: "Run direction (deg) <0>:", defaultValue: "0" },
      { id: "widthMm", kind: "text", prompt: "Stair width (mm) <1200>:", defaultValue: "1200" },
      { id: "stepCount", kind: "text", prompt: "Step count <16>:", defaultValue: "16" },
      { id: "treadMm", kind: "text", prompt: "Tread depth (mm) <280>:", defaultValue: "280" },
      {
        id: "railings",
        kind: "text",
        prompt: "Railings [NONe/BOTH] <both>:",
        defaultValue: "both",
        options: [
          { keyword: "NON", label: "none", flag: true },
          { keyword: "BOTH", label: "both", flag: true },
        ],
      },
    ],
    build: (values) => {
      const storyId = (textValue(values, "storyId") ?? "").trim();
      const topStoryId = (textValue(values, "topStoryId") ?? "").trim();
      if (storyId.length === 0 || topStoryId.length === 0) throw new Error("STAIRRUN requires base and top story ids.");
      const start = pointValue(values, "start", 2);
      if (start === null) throw new Error("STAIRRUN requires a 'x,y' start point.");
      const widthMm = numberValue(values, "widthMm", 1200);
      const stepCount = numberValue(values, "stepCount", 16);
      const treadMm = numberValue(values, "treadMm", 280);
      if (widthMm === null || widthMm <= 0) throw new Error("STAIRRUN requires a positive stair width.");
      if (stepCount === null || !Number.isInteger(stepCount) || stepCount <= 0) throw new Error("STAIRRUN requires a positive integer step count.");
      if (treadMm === null || treadMm <= 0) throw new Error("STAIRRUN requires a positive tread depth.");
      const directionDeg = numberValue(values, "directionDeg", 0) ?? 0;
      const railings = optionValue(values, "railings", "NON") !== null ? "none" : "both";
      return plan(
        [{ name: "toolset.archStairRun", payload: { storyId, topStoryId, start, directionDeg, widthMm, stepCount, treadMm, railings } }],
        [`STAIRRUN: ${stepCount} steps from '${storyId}' to '${topStoryId}' (railings: ${railings}).`],
      );
    },
  },

  // --- SPACEGRID — compose a room/space grid ---------------------------------
  {
    id: "spacegrid",
    name: "SPACEGRID",
    aliases: ["SPGR"],
    label: "Space grid",
    description:
      "Compose a bounded room/space grid over the P011 space primitive — deterministic names prefix-<col>-<row> (one atomic revision).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "storyId", kind: "text", prompt: "Host story id:" },
      { id: "origin", kind: "text", prompt: "Grid origin x,y:" },
      { id: "cols", kind: "text", prompt: "Columns <4>:", defaultValue: "4" },
      { id: "rows", kind: "text", prompt: "Rows <3>:", defaultValue: "3" },
      { id: "cellWidthMm", kind: "text", prompt: "Cell width (mm) <4000>:", defaultValue: "4000" },
      { id: "cellHeightMm", kind: "text", prompt: "Cell height (mm) <3000>:", defaultValue: "3000" },
      { id: "prefix", kind: "text", prompt: "Name prefix <ROOM>:", defaultValue: "ROOM" },
    ],
    build: (values) => {
      const storyId = (textValue(values, "storyId") ?? "").trim();
      if (storyId.length === 0) throw new Error("SPACEGRID requires a non-empty host story id.");
      const origin = pointValue(values, "origin", 2);
      if (origin === null) throw new Error("SPACEGRID requires a 'x,y' grid origin.");
      const cols = numberValue(values, "cols", 4);
      const rows = numberValue(values, "rows", 3);
      const cellWidthMm = numberValue(values, "cellWidthMm", 4000);
      const cellHeightMm = numberValue(values, "cellHeightMm", 3000);
      if (cols === null || rows === null || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        throw new Error("SPACEGRID requires positive integer column/row counts.");
      }
      if (cellWidthMm === null || cellWidthMm <= 0 || cellHeightMm === null || cellHeightMm <= 0) {
        throw new Error("SPACEGRID requires positive cell dimensions.");
      }
      const prefix = (textValue(values, "prefix", "ROOM") ?? "ROOM").trim() || "ROOM";
      return plan(
        [{ name: "toolset.archSpaceGrid", payload: { storyId, origin, cols, rows, cellWidthMm, cellHeightMm, prefix } }],
        [`SPACEGRID: ${cols}×${rows} spaces of ${cellWidthMm}×${cellHeightMm}mm from ${JSON.stringify(origin)}.`],
      );
    },
  },

  // --- DIMCHAIN — architectural dimension chain -------------------------------
  {
    id: "dimchain",
    name: "DIMCHAIN",
    aliases: ["DIMC"],
    label: "Dimension chain",
    description:
      "Compose an architectural dimension chain over the existing annotation primitives (a typed decline is returned where the chain is not representable in the bounded model — no fabricated geometry).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "points", kind: "text", prompt: "Chain points x,y;x,y;… :" },
      { id: "offsetMm", kind: "text", prompt: "Offset (mm) <600>:", defaultValue: "600" },
    ],
    build: (values) => {
      const points = polyValue(values, "points");
      if (points === null) throw new Error("DIMCHAIN requires a points list 'x,y;x,y;…' (at least two points).");
      const offsetMm = numberValue(values, "offsetMm", 600) ?? 600;
      return plan(
        [{ name: "toolset.archDimChain", payload: { points, offsetMm } }],
        [`DIMCHAIN: ${points.length} points at ${offsetMm}mm offset.`],
      );
    },
  },

  // --- COMPARRAY — component instance array ----------------------------------
  {
    id: "comparray",
    name: "COMPARRAY",
    aliases: ["CAR"],
    label: "Component array",
    description:
      "Compose a deterministic component-instance array over the P011 component primitives (cols×rows placement with canonical host/story relationships; one atomic revision).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "definitionId", kind: "text", prompt: "Component definition id:" },
      { id: "storyId", kind: "text", prompt: "Host story id:" },
      { id: "origin", kind: "text", prompt: "Array origin x,y:" },
      { id: "cols", kind: "text", prompt: "Columns <2>:", defaultValue: "2" },
      { id: "rows", kind: "text", prompt: "Rows <2>:", defaultValue: "2" },
      { id: "dxMm", kind: "text", prompt: "Column spacing (mm) <1500>:", defaultValue: "1500" },
      { id: "dyMm", kind: "text", prompt: "Row spacing (mm) <1500>:", defaultValue: "1500" },
    ],
    build: (values) => {
      const definitionId = (textValue(values, "definitionId") ?? "").trim();
      const storyId = (textValue(values, "storyId") ?? "").trim();
      if (definitionId.length === 0 || storyId.length === 0) throw new Error("COMPARRAY requires definition and story ids.");
      const origin = pointValue(values, "origin", 2);
      if (origin === null) throw new Error("COMPARRAY requires a 'x,y' array origin.");
      const cols = numberValue(values, "cols", 2);
      const rows = numberValue(values, "rows", 2);
      const dxMm = numberValue(values, "dxMm", 1500);
      const dyMm = numberValue(values, "dyMm", 1500);
      if (cols === null || rows === null || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        throw new Error("COMPARRAY requires positive integer column/row counts.");
      }
      if (dxMm === null || dxMm <= 0 || dyMm === null || dyMm <= 0) throw new Error("COMPARRAY requires positive spacings.");
      return plan(
        [{ name: "toolset.archComponentArray", payload: { definitionId, storyId, origin, cols, rows, dxMm, dyMm } }],
        [`COMPARRAY: ${cols}×${rows} instances of '${definitionId}'.`],
      );
    },
  },

  // --- MEPRUN — create a bounded routing run ---------------------------------
  {
    id: "meprun",
    name: "MEPRUN",
    aliases: ["MRUN"],
    label: "MEP run",
    description:
      "Create a bounded duct/pipe/conduit routing run record — deterministic route validation (duct orthogonality, segment continuity, nominal bounds; typed route violations otherwise).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      {
        id: "domain",
        kind: "text",
        prompt: "Domain [DUCt/PIP/CONduit] <duct>:",
        defaultValue: "duct",
        options: [
          { keyword: "DUC", label: "duct", flag: true },
          { keyword: "PIP", label: "pipe", flag: true },
          { keyword: "CON", label: "conduit", flag: true },
        ],
      },
      { id: "shape", kind: "text", prompt: "Shape [ROUNd/RECT] <round>:", defaultValue: "round" },
      { id: "nominalSize", kind: "text", prompt: "Nominal size (mm) <300>:", defaultValue: "300" },
      { id: "start", kind: "text", prompt: "Start x,y,z:" },
      { id: "end", kind: "text", prompt: "End x,y,z:" },
      { id: "name", kind: "text", prompt: "Run name <RUN>:", defaultValue: "RUN" },
    ],
    build: (values) => {
      const domain = mepDomainOf(values);
      if (domain === null) throw new Error("MEPRUN domain must be duct | pipe | conduit.");
      const shapeRaw = (textValue(values, "shape", "round") ?? "round").trim().toLowerCase();
      const shape = shapeRaw.startsWith("r") && shapeRaw !== "round" ? "rect" : shapeRaw === "rect" ? "rect" : "round";
      const nominalSize = numberValue(values, "nominalSize", 300);
      if (nominalSize === null || nominalSize <= 0) throw new Error("MEPRUN requires a positive nominal size.");
      const start = pointValue(values, "start", 3);
      const end = pointValue(values, "end", 3);
      if (start === null || end === null) throw new Error("MEPRUN requires 'x,y,z' start and end points.");
      const name = (textValue(values, "name", "RUN") ?? "RUN").trim() || "RUN";
      return plan(
        [{ name: "toolset.mepAddRun", payload: { run: { domain, shape, nominalSize, name, segments: [{ start, end }] } } }],
        [`MEPRUN: ${domain} run '${name}' ${shape} Ø${nominalSize}mm.`],
      );
    },
  },

  // --- MEPCONNECT — connect a run end -----------------------------------------
  {
    id: "mepconnect",
    name: "MEPCONNECT",
    aliases: ["MCON"],
    label: "MEP connect",
    description:
      "Connect a routing run end to a connector — equipment port, another run's end, or a free endpoint (domain-neutral connection semantics; typed declines on domain mismatch).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "runId", kind: "text", prompt: "Run id (tls-…):" },
      {
        id: "at",
        kind: "text",
        prompt: "Connect at [STARt/END] <end>:",
        defaultValue: "end",
        options: [
          { keyword: "STAR", label: "start", flag: true },
          { keyword: "END", label: "end", flag: true },
        ],
      },
      { id: "targetKind", kind: "text", prompt: "Target kind [EQUipment/RUN/POINt] <point>:", defaultValue: "point" },
      { id: "equipmentId", kind: "text", prompt: "Target equipment id (EQU only):" },
      { id: "portId", kind: "text", prompt: "Target port id (EQU only, e.g. p1):" },
      { id: "targetRunId", kind: "text", prompt: "Target run id (RUN only):" },
      { id: "point", kind: "text", prompt: "Target endpoint x,y,z (POIN only):" },
    ],
    build: (values) => {
      const runId = (textValue(values, "runId") ?? "").trim();
      if (runId.length === 0) throw new Error("MEPCONNECT requires a run id.");
      const at = optionValue(values, "at", "STAR") !== null ? "start" : "end";
      const kindRaw = (textValue(values, "targetKind", "point") ?? "point").trim().toLowerCase();
      let target: Record<string, unknown>;
      if (kindRaw.startsWith("equ")) {
        const equipmentId = (textValue(values, "equipmentId") ?? "").trim();
        const portId = (textValue(values, "portId") ?? "").trim();
        if (equipmentId.length === 0 || portId.length === 0) throw new Error("MEPCONNECT EQUipment target requires equipment + port ids.");
        target = { kind: "equipment", equipmentId, portId };
      } else if (kindRaw === "run") {
        const targetRunId = (textValue(values, "targetRunId") ?? "").trim();
        if (targetRunId.length === 0) throw new Error("MEPCONNECT RUN target requires the target run id.");
        target = { kind: "run", runId: targetRunId, end: "start" };
      } else {
        const point = pointValue(values, "point", 3);
        if (point === null) throw new Error("MEPCONNECT POINt target requires an 'x,y,z' endpoint.");
        target = { kind: "endpoint", point };
      }
      return plan(
        [{ name: "toolset.mepConnect", payload: { runId, at, target } }],
        [`MEPCONNECT: '${runId}' ${at} → ${JSON.stringify(target)}.`],
      );
    },
  },

  // --- EQUIPADD — place mechanical equipment -----------------------------------
  {
    id: "equipadd",
    name: "EQUIPADD",
    aliases: ["EQAD"],
    label: "Equipment",
    description:
      "Place a bounded mechanical equipment record with connector/port metadata (deterministic ordinal port ids p1…pN; typed bounds enforcement).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "kind", kind: "text", prompt: "Equipment kind [MACHine/PUMP/FAN/AHU/PANel/TANk] <machine>:", defaultValue: "machine" },
      { id: "name", kind: "text", prompt: "Equipment name <EQ>:", defaultValue: "EQ" },
      { id: "origin", kind: "text", prompt: "Origin x,y,z:" },
      { id: "ports", kind: "text", prompt: "Ports count <0>:", defaultValue: "0" },
    ],
    build: (values) => {
      const kindRaw = (textValue(values, "kind", "machine") ?? "machine").trim().toLowerCase();
      const kind = ["machine", "pump", "fan", "ahu", "panel", "tank"].find((k) => k.startsWith(kindRaw.slice(0, 3))) ?? "machine";
      const origin = pointValue(values, "origin", 3);
      if (origin === null) throw new Error("EQUIPADD requires an 'x,y,z' origin.");
      const portsCount = numberValue(values, "ports", 0) ?? 0;
      if (!Number.isInteger(portsCount) || portsCount < 0 || portsCount > 16) throw new Error("EQUIPADD requires a port count in 0..16.");
      const name = (textValue(values, "name", "EQ") ?? "EQ").trim() || "EQ";
      // Deterministic ports: ordinal ids p1…pN, supply kind, positions offset
      // along +x from the equipment origin (the validator enforces the
      // ordinal id grammar; the user prompt surface stays bounded).
      const ports = Array.from({ length: portsCount }, (_, i) => ({
        id: `p${i + 1}`,
        kind: "supply",
        position: { x: origin.x + 200 * (i + 1), y: origin.y, z: origin.z },
        nominal: 300,
        domain: "duct",
      }));
      return plan(
        [{ name: "toolset.mechAddEquipment", payload: { equipment: { kind, name, origin, ports } } }],
        [`EQUIPADD: ${kind} '${name}' at ${JSON.stringify(origin)} (${portsCount} port(s)).`],
      );
    },
  },

  // --- EQUIPARRAY — deterministic equipment array ------------------------------
  {
    id: "equiparray",
    name: "EQUIPARRAY",
    aliases: ["EQAR"],
    label: "Equipment array",
    description:
      "Compose a deterministic equipment array from an existing equipment record (ports offset with each instance; typed bounds enforcement).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "equipmentId", kind: "text", prompt: "Source equipment id (tls-…):" },
      { id: "cols", kind: "text", prompt: "Columns <2>:", defaultValue: "2" },
      { id: "rows", kind: "text", prompt: "Rows <2>:", defaultValue: "2" },
      { id: "dxMm", kind: "text", prompt: "Column spacing (mm) <2000>:", defaultValue: "2000" },
      { id: "dyMm", kind: "text", prompt: "Row spacing (mm) <2000>:", defaultValue: "2000" },
    ],
    build: (values) => {
      const equipmentId = (textValue(values, "equipmentId") ?? "").trim();
      if (equipmentId.length === 0) throw new Error("EQUIPARRAY requires a source equipment id.");
      const cols = numberValue(values, "cols", 2);
      const rows = numberValue(values, "rows", 2);
      const dxMm = numberValue(values, "dxMm", 2000);
      const dyMm = numberValue(values, "dyMm", 2000);
      if (cols === null || rows === null || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        throw new Error("EQUIPARRAY requires positive integer column/row counts.");
      }
      if (dxMm === null || dxMm <= 0 || dyMm === null || dyMm <= 0) throw new Error("EQUIPARRAY requires positive spacings.");
      return plan(
        [{ name: "toolset.mechArray", payload: { equipmentId, cols, rows, dxMm, dyMm } }],
        [`EQUIPARRAY: ${cols}×${rows} instances of '${equipmentId}'.`],
      );
    },
  },

  // --- RASTERATTACH — attach a raster/underlay reference ------------------------
  {
    id: "rasterattach",
    name: "RASTERATTACH",
    aliases: ["RATT"],
    label: "Raster underlay",
    description:
      "Attach a raster/underlay reference to a registered source (canonical identity, transform, clipping, visibility; typed stale/missing-reference behavior on the source).",
    category: "toolsets",
    ribbonTab: "Toolsets",
    steps: [
      { id: "sourceRef", kind: "text", prompt: "Source reference (e.g. underlay/site-plan.png):" },
      { id: "declaredDigest", kind: "text", prompt: "Declared content digest:" },
      { id: "origin", kind: "text", prompt: "Placement origin x,y <0,0>:", defaultValue: "0,0" },
      { id: "scale", kind: "text", prompt: "Scale <0.1>:", defaultValue: "0.1" },
      { id: "rotationDeg", kind: "text", prompt: "Rotation (deg) <0>:", defaultValue: "0" },
    ],
    build: (values) => {
      const sourceRef = (textValue(values, "sourceRef") ?? "").trim();
      const declaredDigest = (textValue(values, "declaredDigest") ?? "").trim();
      if (sourceRef.length === 0 || declaredDigest.length === 0) throw new Error("RASTERATTACH requires a source reference and digest.");
      const origin = pointValue(values, "origin", 2) ?? { x: 0, y: 0 };
      const scale = numberValue(values, "scale", 0.1) ?? 0.1;
      if (scale <= 0) throw new Error("RASTERATTACH requires a positive scale.");
      const rotationDeg = numberValue(values, "rotationDeg", 0) ?? 0;
      return plan(
        [{ name: "toolset.rasterAttach", payload: { reference: { sourceRef, declaredDigest, transform: { origin, scale, rotationDeg }, visible: true } } }],
        [`RASTERATTACH: '${sourceRef}' at ${JSON.stringify(origin)} scale ${scale}.`],
      );
    },
  },

  // --- Report surfaces (instant, view category) -------------------------------
  {
    id: "toolsetreport",
    name: "TOOLSETREPORT",
    aliases: ["TSR"],
    label: "Toolsets report",
    description:
      "The specialized-toolsets report surface: the capability registry and the specialized-record inventory (id-sorted), rendered through the report.toolsets action — the host renders the REAL toolset.capabilities / toolset.listRecords query results.",
    category: "view",
    ribbonTab: "Toolsets",
    steps: [],
    instant: () =>
      plan([], ["TOOLSETREPORT."], [{ action: "report.toolsets" }, { action: "palette.show", payload: { palette: "toolsets" } }]),
  },
  {
    id: "mepreport",
    name: "MEPREPORT",
    aliases: ["MREP"],
    label: "MEP clash report",
    description:
      "The MEP clash/clearance diagnostics report surface — the deterministic run-vs-element distance checks on the supported representation, rendered through the report.toolsets action.",
    category: "view",
    ribbonTab: "Toolsets",
    steps: [
      { id: "clearanceMm", kind: "text", prompt: "Clearance (mm) <100>:", defaultValue: "100" },
    ],
    build: (values) => {
      const clearanceMm = numberValue(values, "clearanceMm", 100) ?? 100;
      return plan(
        [],
        [`MEPREPORT: clash/clearance diagnostics at ${clearanceMm}mm.`],
        [{ action: "report.toolsets", payload: { report: "mep-clash", clearanceMm } }, { action: "palette.show", payload: { palette: "toolsets" } }],
      );
    },
  },
  {
    id: "rasterstatus",
    name: "RASTERSTATUS",
    aliases: ["RSTAT"],
    label: "Raster status",
    description:
      "The raster/underlay reference status report surface — the fresh ok/stale/missing reference table with reasons, rendered through the report.toolsets action.",
    category: "view",
    ribbonTab: "Toolsets",
    steps: [],
    instant: () =>
      plan([], ["RASTERSTATUS."], [{ action: "report.toolsets", payload: { report: "raster-status" } }, { action: "palette.show", payload: { palette: "toolsets" } }]),
  },
  {
    id: "rastertrace",
    name: "RASTERTRACE",
    aliases: ["RTRA"],
    label: "Raster trace",
    description:
      "The typed non-authoritative trace preview surface — the derived vector candidates from the underlay's declared line work (never canonical geometry unless committed through the governed App API).",
    category: "view",
    ribbonTab: "Toolsets",
    steps: [{ id: "referenceId", kind: "text", prompt: "Reference id (tls-…):" }],
    build: (values) => {
      const referenceId = (textValue(values, "referenceId") ?? "").trim();
      if (referenceId.length === 0) throw new Error("RASTERTRACE requires a reference id.");
      return plan(
        [],
        [`RASTERTRACE: derived vectors for '${referenceId}' (non-authoritative).`],
        [{ action: "report.toolsets", payload: { report: "raster-trace", referenceId } }, { action: "palette.show", payload: { palette: "toolsets" } }],
      );
    },
  },
];
