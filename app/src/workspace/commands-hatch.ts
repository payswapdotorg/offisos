/**
 * COMPAT-CAD-010 (Issue #18) command registry extension — the hatch,
 * hatch-edit and bounded inspection vocabulary.
 *
 * Commands:
 *  - HATCH (H) — associative hatch: select the boundary objects (closed
 *    polylines/rectangles/circles — the bounded CC010 boundary set;
 *    everything else is typed-declined at the pick step), pattern
 *    (SOLID/ANSI31/ANSI32/ANSI37/NET/DOTS), scale, angle. The boundary
 *    loops resolve SERVER-side from the referenced geometry.
 *  - HATCHEDIT (HE) — patch an existing hatch's pattern/scale/angle
 *    (HATCHEDIT-class; boundary re-association is a typed decline — out
 *    of the bounded scope).
 *  - LIST (LI, LS) — the bounded entity inspection: select objects, the
 *    deterministic semantic summaries render to the command-line history
 *    through the inspection.list query (non-mutating; the report
 *    ui-action precedent). The OSNAP/OTRACK/measurement program stays
 *    CC018's scope — LIST never recomputes a measurement, it reports the
 *    canonical stored state.
 *
 * Every command is pure data + a pure builder emitting App API commands
 * (hatch.create / hatch.update) or the inspection ui action. The SAME
 * registry drives ribbon, palette, keyboard and command line on BOTH
 * hosts (LOCK-004).
 */

import type { Vec2 } from "../drafting/precision.js";
import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";
import { layerNameOrId } from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import { HATCH_PATTERN_IDS } from "./hatch/types.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-anno.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, ui, echo };
}

function entitiesValue(values: Readonly<Record<string, PromptValue>>, id: string): readonly EntityPick[] {
  const v = values[id];
  if (v === undefined || v.kind !== "entities") throw new Error(`command builder: step '${id}' has no entities`);
  return v.entities;
}

function firstEntityValue(values: Readonly<Record<string, PromptValue>>, id: string): EntityPick {
  const v = values[id];
  if (v === undefined || v.kind !== "entities") throw new Error(`command builder: step '${id}' has no entity`);
  const first = v.entities[0];
  if (first === undefined) throw new Error(`command builder: step '${id}' collected no entity`);
  return first;
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

const DEG = Math.PI / 180;

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/** The bounded CC010 boundary-candidate predicate: closed polylines (both
 *  storage conventions), rectangles and circles. */
function isBoundaryCandidate(pick: EntityPick): boolean {
  const props = pick.props as Record<string, unknown>;
  if (props.hatch === true) return false; // nested hatch boundaries: typed decline
  if (props.drafting === true) {
    switch (props.type) {
      case "rectangle":
        return true;
      case "polyline":
        return props.closed === true || (Array.isArray(props.vertices) && props.closed === true);
      case "circle":
        return true;
      default:
        return false;
    }
  }
  return false;
}

/** Entity-step validator: a boundary candidate or the typed rejection. */
function validateBoundaryPick(pick: EntityPick): string | null {
  if (isBoundaryCandidate(pick)) return null;
  const props = pick.props as Record<string, unknown>;
  if (props.type === "polyline") {
    return "Boundary must be a CLOSED polyline, rectangle or circle (open geometry is a typed decline — close it first).";
  }
  return "Boundary must be a closed polyline, rectangle or circle — the bounded CC010 boundary set (open geometry, annotations, blocks and hatches are typed declines).";
}

function validateHatchPick(pick: EntityPick): string | null {
  const props = pick.props as Record<string, unknown>;
  if (pick.kind === "annotation" && props.hatch === true && props.type === "hatch") return null;
  return "HATCHEDIT requires a hatch entity — pick a hatch.";
}

/** Validate a pattern token (typed decline at the command boundary). */
function patternOf(raw: string): string {
  const token = raw.trim().toUpperCase();
  if ((HATCH_PATTERN_IDS as readonly string[]).includes(token)) return token;
  throw new Error(
    `HATCH pattern '${raw.trim()}' is not in the bounded CC010 registry (${HATCH_PATTERN_IDS.join(", ")}) — the unsupported pattern is a typed decline (no fallback pattern is guessed).`,
  );
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const COMMANDS_HATCH: readonly WorkspaceCommand[] = [
  {
    id: "hatch",
    name: "HATCH",
    aliases: ["H", "BH", "BHATCH"],
    label: "Hatch",
    description:
      "Create an associative hatch: select the boundary objects (closed polylines/rectangles/circles), then pattern (SOLID/ANSI31/ANSI32/ANSI37/NET/DOTS), scale and angle. The boundary loops resolve server-side.",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      {
        id: "boundary",
        kind: "entity",
        prompt: "Select boundary objects (closed polylines, rectangles, circles — Enter to finish):",
        multiple: true,
        optional: true,
        minInputs: 1,
        validate: validateBoundaryPick,
      },
      {
        id: "pattern",
        kind: "text",
        prompt: "Enter hatch pattern <ANSI31> (SOLID, ANSI31, ANSI32, ANSI37, NET, DOTS):",
        defaultValue: "ANSI31",
      },
      { id: "scale", kind: "number", prompt: "Specify pattern scale <1>:", defaultValue: 1 },
      { id: "angle", kind: "number", prompt: "Specify pattern angle <0> (degrees):", defaultValue: 0 },
    ],
    build: (values, ctx) => {
      const boundaries = entitiesValue(values, "boundary");
      const ids = boundaries.map((b) => b.id);
      if (ids.length === 0) throw new Error("HATCH requires at least one boundary object.");
      const pattern = patternOf(textValue(values, "pattern", "ANSI31"));
      const scale = numberValue(values, "scale", 1);
      if (!(scale > 0)) throw new Error("HATCH scale must be > 0 (a non-positive pattern scale is rejected).");
      const angle = numberValue(values, "angle", 0) * DEG;
      return plan(
        [
          {
            name: "hatch.create",
            payload: {
              entities: [
                {
                  type: "hatch",
                  layer: ctx.activeLayer,
                  pattern,
                  scale,
                  angle,
                  boundary: ids,
                },
              ],
            },
          },
        ],
        [
          `HATCH: pattern ${pattern}, scale ${trimNum(scale)}, angle ${trimNum(angle / DEG)}°, ${ids.length} boundary loop(s) on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`,
        ],
      );
    },
  },
  {
    id: "hatchedit",
    name: "HATCHEDIT",
    aliases: ["HE"],
    label: "Edit hatch",
    description:
      "Edit an existing hatch: pattern, scale, angle (Enter keeps each current value). Boundary re-association is out of the bounded scope (typed decline).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      { id: "target", kind: "entity", prompt: "Select a hatch to edit:", validate: validateHatchPick },
      {
        id: "pattern",
        kind: "text",
        prompt: "Enter new pattern (Enter keeps current; SOLID, ANSI31, ANSI32, ANSI37, NET, DOTS):",
        optional: true,
      },
      { id: "scale", kind: "number", prompt: "Specify new pattern scale (Enter keeps current):", optional: true },
      { id: "angle", kind: "number", prompt: "Specify new pattern angle in degrees (Enter keeps current):", optional: true },
    ],
    build: (values) => {
      const target = firstEntityValue(values, "target");
      const patch: Record<string, unknown> = {};
      const patternRaw = textValue(values, "pattern", "");
      if (patternRaw.trim().length > 0) {
        patch.pattern = patternOf(patternRaw);
      }
      const scale = numberValue(values, "scale", Number.NaN);
      if (!Number.isNaN(scale)) {
        if (!(scale > 0)) throw new Error("HATCHEDIT scale must be > 0 (a non-positive pattern scale is rejected).");
        patch.scale = scale;
      }
      const angle = numberValue(values, "angle", Number.NaN);
      if (!Number.isNaN(angle)) {
        patch.angle = angle * DEG;
      }
      if (Object.keys(patch).length === 0) {
        throw new Error("HATCHEDIT received no changes — enter at least one new pattern, scale or angle.");
      }
      return plan(
        [{ name: "hatch.update", payload: { ids: [target.id], patch } }],
        [
          `HATCHEDIT: ${target.id} → ${Object.entries(patch)
            .map(([k, v]) =>
              typeof v === "number"
                ? `${k} ${k === "angle" ? `${trimNum(v / DEG)}°` : trimNum(v)}`
                : `${k} ${String(v)}`,
            )
            .join(", ")}.`,
        ],
      );
    },
  },
  {
    id: "list",
    name: "LIST",
    aliases: ["LI"],
    label: "List entity data",
    description:
      "Inspect selected objects: the deterministic canonical semantic summary (type, layer, key geometry, stored measurements, hatch pattern/loops, references) renders to the command line. Non-mutating.",
    category: "view",
    ribbonTab: "Home",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select objects to inspect:",
        multiple: true,
        optional: true,
        minInputs: 1,
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const ids = objects.map((o) => o.id);
      if (ids.length === 0) throw new Error("LIST requires at least one object.");
      return plan(
        [],
        [`LIST: ${ids.length} object${ids.length === 1 ? "" : "s"} — canonical inspection follows.`],
        [{ action: "inspection.list", payload: { ids } }],
      );
    },
  },
];
