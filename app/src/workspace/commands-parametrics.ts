/**
 * CAD-PARITY-007 command registry extension (Issue #86) — the parametric
 * constraints & associative editing vocabulary.
 *
 * Commands:
 *  - GEOMCONSTRAINT (GC) — declare ONE geometric constraint: type, then the
 *    per-type picks (horizontal/vertical/equal/fixed: one entity;
 *    coincident: two anchor picks — the anchor resolves to the pick point's
 *    NEAREST anchor of the picked entity; parallel/perpendicular/tangent:
 *    two entities). The server validates the vocabulary and applies the
 *    constraint through the deterministic solver (one atomic revision).
 *  - DIMCONSTRAINT (DC) — declare ONE dimensional constraint: type
 *    (Length/Distance/Angle/Radius), the picks, then the value (Enter keeps
 *    the CURRENT measurement — the dynamic default is computed from the
 *    picked geometry, pure data). Angles are prompted in degrees and stored
 *    in radians (the document convention).
 *  - CONSTRAINTLIST (CLIST) — list the declared graph (id, type, targets,
 *    values — the palette shows the live satisfaction diagnostics).
 *  - DELCONSTRAINT (DCON) — remove every constraint referencing the picked
 *    entities (one atomic batch of removals).
 *  - CONSTRAINTS (CS) — open the Constraints palette (the manager surface:
 *    live diagnostics, dimensional value editing, removal).
 *  - ARRAY (AR) — the deterministic pattern family: Rectangular (rows,
 *    columns, spacings) or Polar (center, items, span, rotate-items). Path
 *    arrays are a typed decline (the bounded pattern surface). Copies carry
 *    document-minted identities in ONE atomic revision; constraint bindings
 *    do NOT travel to the copies (they bind the source identities — the
 *    bounded rule, echoed).
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * `constraint.*` dispatches to the shared constraints core (server-side
 * validation; the document is the single authority). The SAME registry
 * drives ribbon, palette, keyboard and command line on BOTH hosts
 * (LOCK-004).
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
import type { WorkspaceCommand } from "./commands.js";
import type { ConstraintRecord } from "../contracts/caddocument.js";
import { geomFromElement } from "./geometry/bridge.js";
import { nearestAnchor } from "./constraints/types.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-blocks.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, ui, echo };
}

function pointValue(values: Readonly<Record<string, PromptValue>>, id: string): Vec2 {
  const v = values[id];
  if (v === undefined || v.kind !== "point") throw new Error(`command builder: step '${id}' has no point`);
  return v.point;
}

function entitiesValue(values: Readonly<Record<string, PromptValue>>, id: string): readonly EntityPick[] {
  const v = values[id];
  if (v === undefined || v.kind !== "entities") throw new Error(`command builder: step '${id}' has no entities`);
  return v.entities;
}

function entityValue(values: Readonly<Record<string, PromptValue>>, id: string): EntityPick {
  const picks = entitiesValue(values, id);
  if (picks.length === 0) throw new Error(`command builder: step '${id}' has no entity pick`);
  return picks[0]!;
}

function entityPointValue(values: Readonly<Record<string, PromptValue>>, id: string): { entity: EntityPick; point: Vec2 } {
  const v = values[id];
  if (v === undefined || v.kind !== "entityPoints" || v.picks.length === 0) {
    throw new Error(`command builder: step '${id}' has no entity-point pick`);
  }
  return v.picks[0]!;
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

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: string): string {
  const v = values[id];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`command builder: step '${id}' has no text`);
  }
  if (v.kind !== "text") throw new Error(`command builder: step '${id}' is not text`);
  return v.text;
}

function fmtPoint(p: Vec2): string {
  return `${trimNum(p[0])},${trimNum(p[1])}`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

const DEG = Math.PI / 180;

/** The GEOMCONSTRAINT type vocabulary (the prompt lists these). */
const GEOM_KINDS: readonly string[] = [
  "Horizontal",
  "Vertical",
  "Coincident",
  "Parallel",
  "Perpendicular",
  "Equal",
  "Tangent",
  "Fixed",
];

/** The DIMCONSTRAINT type vocabulary. */
const DIM_KINDS: readonly string[] = ["Length", "Distance", "Angle", "Radius"];

function parseGeomKind(raw: string): string {
  const kind = raw.trim().toLowerCase();
  const match = GEOM_KINDS.find((k) => k.toLowerCase() === kind);
  if (match === undefined) {
    throw new Error(`unknown constraint type '${raw}' — valid: ${GEOM_KINDS.join("/")}`);
  }
  return match.toLowerCase();
}

function parseDimKind(raw: string): string {
  const kind = raw.trim().toLowerCase();
  const match = DIM_KINDS.find((k) => k.toLowerCase() === kind);
  if (match === undefined) {
    throw new Error(`unknown dimensional type '${raw}' — valid: ${DIM_KINDS.join("/")}`);
  }
  return match.toLowerCase();
}

/** Constrainable-pick validator: lines, circles, arcs and points only (the
 *  bounded constrained vocabulary — typed rejection naming the vocabulary). */
function validateConstrainablePick(pick: EntityPick): string | null {
  const el = { id: pick.id, kind: pick.kind === "geometry" ? "geometry" : pick.kind, engineId: null, props: pick.props };
  const geom = geomFromElement(el as never);
  if (geom === null) {
    return "Constraints apply to 2D drawing entities (lines, circles, arcs, points).";
  }
  if (geom.type !== "line" && geom.type !== "circle" && geom.type !== "arc" && geom.type !== "point") {
    return `Constraints do not apply to ${geom.type} entities in this build — the constrained vocabulary is line, circle, arc, point (typed unsupported, never approximated).`;
  }
  return null;
}

/** Line-pick validator (horizontal/vertical/parallel/perpendicular/angle). */
function validateLinePick(pick: EntityPick): string | null {
  const base = validateConstrainablePick(pick);
  if (base !== null) return base;
  const geom = geomFromElement({ id: pick.id, kind: "geometry", engineId: null, props: pick.props } as never);
  if (geom === null || geom.type !== "line") {
    return "This constraint applies to lines — pick a line entity.";
  }
  return null;
}

/** Circle-like-pick validator (radius / tangent). */
function validateCirclePick(pick: EntityPick): string | null {
  const base = validateConstrainablePick(pick);
  if (base !== null) return base;
  const geom = geomFromElement({ id: pick.id, kind: "geometry", engineId: null, props: pick.props } as never);
  if (geom === null || (geom.type !== "circle" && geom.type !== "arc")) {
    return "This constraint applies to circles and arcs — pick a circle/arc entity.";
  }
  return null;
}

/** Resolve the nearest anchor of a picked entity at a pick point (the
 *  entityPoint semantics — server-agnostic pure resolution from the pick
 *  snapshot). Throws a typed message when the entity carries no anchors. */
function anchorOfPick(entity: EntityPick, point: Vec2): { id: string; anchor: string } {
  const geom = geomFromElement({ id: entity.id, kind: "geometry", engineId: null, props: entity.props } as never);
  if (geom === null) {
    throw new Error("constraints apply to 2D drawing entities (line, circle, arc, point)");
  }
  const anchor = nearestAnchor(geom, { x: point[0], y: point[1] });
  if (anchor === null) {
    throw new Error(`a ${geom.type} entity carries no constraint anchors`);
  }
  return { id: entity.id, anchor };
}

/** The current length of a picked line (the DIMCONSTRAINT Length default). */
function lineLengthOf(pick: EntityPick): number | null {
  const geom = geomFromElement({ id: pick.id, kind: "geometry", engineId: null, props: pick.props } as never);
  if (geom === null || geom.type !== "line") return null;
  return Math.hypot(geom.x2 - geom.x1, geom.y2 - geom.y1);
}

/** The current radius of a picked circle/arc (the Radius default). */
function radiusOf(pick: EntityPick): number | null {
  const geom = geomFromElement({ id: pick.id, kind: "geometry", engineId: null, props: pick.props } as never);
  if (geom === null || (geom.type !== "circle" && geom.type !== "arc")) return null;
  return geom.r;
}

/** The current CCW angle between two picked lines, in degrees (the Angle
 *  default). Null on degenerate lines. */
function angleDegBetween(a: EntityPick, b: EntityPick): number | null {
  const ga = geomFromElement({ id: a.id, kind: "geometry", engineId: null, props: a.props } as never);
  const gb = geomFromElement({ id: b.id, kind: "geometry", engineId: null, props: b.props } as never);
  if (ga === null || gb === null || ga.type !== "line" || gb.type !== "line") return null;
  const la = Math.hypot(ga.x2 - ga.x1, ga.y2 - ga.y1);
  const lb = Math.hypot(gb.x2 - gb.x1, gb.y2 - gb.y1);
  if (la <= 1e-9 || lb <= 1e-9) return null;
  const aa = Math.atan2(ga.y2 - ga.y1, ga.x2 - ga.x1);
  const ab = Math.atan2(gb.y2 - gb.y1, gb.x2 - gb.x1);
  let ccw = ab - aa;
  ccw = ((ccw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return (ccw / DEG);
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

/** GEOMCONSTRAINT's kind step (dynamic per-kind steps follow). */
const GC_BASE_STEPS: readonly PromptStep[] = [
  { id: "kind", kind: "text", prompt: `Enter constraint type [${GEOM_KINDS.join("/")}] :`, rematerialize: true },
];

/** DIMCONSTRAINT's kind step. */
const DC_BASE_STEPS: readonly PromptStep[] = [
  { id: "kind", kind: "text", prompt: `Enter dimensional type [${DIM_KINDS.join("/")}] :`, rematerialize: true },
];

/** Per-kind GEOMCONSTRAINT pick steps (prefix-stable after the kind). */
function geomPickSteps(kind: string): readonly PromptStep[] {
  switch (kind) {
    case "horizontal":
    case "vertical":
      return [{ id: "target", kind: "entity", prompt: "Select line:", validate: validateLinePick }];
    case "coincident":
      return [
        { id: "first", kind: "entityPoint", prompt: "Select first point (pick near the endpoint/center):", validate: validateConstrainablePick },
        { id: "second", kind: "entityPoint", prompt: "Select second point (pick near the endpoint/center):", validate: validateConstrainablePick },
      ];
    case "parallel":
    case "perpendicular":
      return [
        { id: "first", kind: "entity", prompt: "Select first line:", validate: validateLinePick },
        { id: "second", kind: "entity", prompt: "Select second line:", validate: validateLinePick },
      ];
    case "equal":
      return [
        { id: "first", kind: "entity", prompt: "Select first entity (line or circle/arc):", validate: validateConstrainablePick },
        { id: "second", kind: "entity", prompt: "Select second entity (same class — two lines or two circles/arcs):", validate: validateConstrainablePick },
      ];
    case "tangent":
      return [
        { id: "first", kind: "entity", prompt: "Select first entity (line or circle/arc):", validate: validateConstrainablePick },
        { id: "second", kind: "entity", prompt: "Select second entity (line+circle/arc or circle/arc+circle/arc):", validate: validateConstrainablePick },
      ];
    case "fixed":
      return [
        {
          id: "target",
          kind: "entity",
          prompt: "Select entity to fix (the whole entity; anchor-level fixing is available through the API):",
          validate: validateConstrainablePick,
        },
      ];
    default:
      return [];
  }
}

/** Per-kind DIMCONSTRAINT steps (prefix-stable after the kind; the value
 *  step defaults to the CURRENT measurement — computed from the pick
 *  snapshot, pure data). */
function dimPickSteps(kind: string): readonly PromptStep[] {
  switch (kind) {
    case "length":
      return [
        { id: "line", kind: "entity", prompt: "Select line for length constraint:", validate: validateLinePick, rematerialize: true },
        { id: "value", kind: "number", prompt: "Enter length value <current> (Enter keeps the current length):" },
      ];
    case "distance":
      return [
        { id: "first", kind: "entityPoint", prompt: "Select first point:", validate: validateConstrainablePick },
        { id: "second", kind: "entityPoint", prompt: "Select second point:", validate: validateConstrainablePick, rematerialize: true },
        { id: "value", kind: "number", prompt: "Enter distance value <current> (Enter keeps the current distance):" },
      ];
    case "angle":
      return [
        { id: "first", kind: "entity", prompt: "Select first line:", validate: validateLinePick },
        { id: "second", kind: "entity", prompt: "Select second line:", validate: validateLinePick, rematerialize: true },
        { id: "value", kind: "number", prompt: "Enter angle value in degrees <current> (Enter keeps the current angle):" },
      ];
    case "radius":
      return [
        { id: "circle", kind: "entity", prompt: "Select circle or arc:", validate: validateCirclePick, rematerialize: true },
        { id: "value", kind: "number", prompt: "Enter radius value <current> (Enter keeps the current radius):" },
      ];
    default:
      return [];
  }
}

/** Fill a DIMCONSTRAINT value step's default from the collected picks. */
function withDimDefault(steps: readonly PromptStep[], values: Readonly<Record<string, PromptValue>>): readonly PromptStep[] {
  const kindValue = values.kind;
  if (kindValue === undefined || kindValue.kind !== "text") return steps;
  const kind = kindValue.text.trim().toLowerCase();
  let current: number | null = null;
  if (kind === "length") {
    const line = values.line;
    if (line !== undefined && line.kind === "entities" && line.entities.length > 0) current = lineLengthOf(line.entities[0]!);
  } else if (kind === "radius") {
    const circle = values.circle;
    if (circle !== undefined && circle.kind === "entities" && circle.entities.length > 0) current = radiusOf(circle.entities[0]!);
  } else if (kind === "angle") {
    const first = values.first;
    const second = values.second;
    if (
      first !== undefined && first.kind === "entities" && first.entities.length > 0 &&
      second !== undefined && second.kind === "entities" && second.entities.length > 0
    ) {
      current = angleDegBetween(first.entities[0]!, second.entities[0]!);
    }
  } else if (kind === "distance") {
    const first = values.first;
    const second = values.second;
    if (
      first !== undefined && first.kind === "entityPoints" && first.picks.length > 0 &&
      second !== undefined && second.kind === "entityPoints" && second.picks.length > 0
    ) {
      const p1 = first.picks[0]!.point;
      const p2 = second.picks[0]!.point;
      current = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    }
  }
  if (current === null || !Number.isFinite(current) || current <= 0) return steps;
  const rounded = Number(current.toFixed(6));
  return steps.map((s) =>
    s.id === "value" && s.kind === "number"
      ? { ...s, defaultValue: rounded, prompt: s.prompt.replace("<current>", `<${trimNum(rounded)}>`) }
      : s,
  );
}

export const COMMANDS_PARAMETRICS: readonly WorkspaceCommand[] = [
  {
    id: "geomconstraint",
    name: "GEOMCONSTRAINT",
    aliases: ["GC"],
    label: "Geometric Constraint",
    description:
      "Declare a geometric constraint (Horizontal, Vertical, Coincident, Parallel, Perpendicular, Equal, Tangent, Fixed) on lines, circles, arcs and points. The solver applies it deterministically and propagates to dependent geometry in the same revision.",
    category: "modify",
    ribbonTab: "Parametric",
    steps: GC_BASE_STEPS,
    dynamicSteps: (ctx, values) => {
      const kindValue = values.kind;
      if (kindValue === undefined || kindValue.kind !== "text") return GC_BASE_STEPS;
      try {
        return [...GC_BASE_STEPS, ...geomPickSteps(parseGeomKind(kindValue.text))];
      } catch {
        return GC_BASE_STEPS;
      }
    },
    build: (values) => {
      const kind = parseGeomKind(textValue(values, "kind"));
      let payload: Record<string, unknown>;
      let echo: string;
      switch (kind) {
        case "horizontal":
        case "vertical": {
          const target = entityValue(values, "target");
          payload = { kind, targets: [{ id: target.id }] };
          echo = `${kind.toUpperCase()} constraint on line '${target.id}'.`;
          break;
        }
        case "coincident": {
          const first = entityPointValue(values, "first");
          const second = entityPointValue(values, "second");
          const t1 = anchorOfPick(first.entity, first.point);
          const t2 = anchorOfPick(second.entity, second.point);
          payload = { kind, targets: [t1, t2] };
          echo = `COINCIDENT: ${t1.id}:${t1.anchor} = ${t2.id}:${t2.anchor}.`;
          break;
        }
        case "parallel":
        case "perpendicular": {
          const first = entityValue(values, "first");
          const second = entityValue(values, "second");
          payload = { kind, targets: [{ id: first.id }, { id: second.id }] };
          echo = `${kind.toUpperCase()}: lines '${first.id}' and '${second.id}'.`;
          break;
        }
        case "equal": {
          const first = entityValue(values, "first");
          const second = entityValue(values, "second");
          payload = { kind, targets: [{ id: first.id }, { id: second.id }] };
          echo = `EQUAL: '${first.id}' and '${second.id}'.`;
          break;
        }
        case "tangent": {
          const first = entityValue(values, "first");
          const second = entityValue(values, "second");
          payload = { kind, targets: [{ id: first.id }, { id: second.id }] };
          echo = `TANGENT: '${first.id}' and '${second.id}' (external for circle pairs — the palette/API can set internal).`;
          break;
        }
        case "fixed": {
          const target = entityValue(values, "target");
          payload = { kind, targets: [{ id: target.id }] };
          echo = `FIXED: entity '${target.id}' pinned (the solver never moves it).`;
          break;
        }
        default:
          throw new Error(`unknown constraint type '${kind}'`);
      }
      return plan([{ name: "constraint.create", payload }], [echo]);
    },
  },
  {
    id: "dimconstraint",
    name: "DIMCONSTRAINT",
    aliases: ["DC"],
    label: "Dimensional Constraint",
    description:
      "Declare a dimensional constraint (Length, Distance, Angle in degrees, Radius) with a value. Enter keeps the current measurement. The solver re-applies the declared value and propagates in the same revision.",
    category: "modify",
    ribbonTab: "Parametric",
    steps: DC_BASE_STEPS,
    dynamicSteps: (ctx, values) => {
      const kindValue = values.kind;
      if (kindValue === undefined || kindValue.kind !== "text") return DC_BASE_STEPS;
      try {
        return withDimDefault([...DC_BASE_STEPS, ...dimPickSteps(parseDimKind(kindValue.text))], values);
      } catch {
        return DC_BASE_STEPS;
      }
    },
    build: (values) => {
      const kind = parseDimKind(textValue(values, "kind"));
      switch (kind) {
        case "length": {
          const line = entityValue(values, "line");
          const current = lineLengthOf(line);
          const value = numberValue(values, "value", current ?? undefined);
          if (!(value > 0)) throw new Error("length value must be > 0");
          return plan(
            [{ name: "constraint.create", payload: { kind: "distance", targets: [{ id: line.id }], value } }],
            [`LENGTH: line '${line.id}' = ${trimNum(value)}.`],
          );
        }
        case "distance": {
          const first = entityPointValue(values, "first");
          const second = entityPointValue(values, "second");
          const t1 = anchorOfPick(first.entity, first.point);
          const t2 = anchorOfPick(second.entity, second.point);
          const current = Math.hypot(second.point[0] - first.point[0], second.point[1] - first.point[1]);
          const value = numberValue(values, "value", current);
          if (!(value > 0)) throw new Error("distance value must be > 0");
          return plan(
            [{ name: "constraint.create", payload: { kind: "distance", targets: [t1, t2], value } }],
            [`DISTANCE: ${t1.id}:${t1.anchor} to ${t2.id}:${t2.anchor} = ${trimNum(value)}.`],
          );
        }
        case "angle": {
          const first = entityValue(values, "first");
          const second = entityValue(values, "second");
          const currentDeg = angleDegBetween(first, second);
          const deg = numberValue(values, "value", currentDeg ?? undefined);
          if (!(deg > 0) || deg >= 360) throw new Error("angle value must be in (0, 360) degrees");
          const value = deg * DEG;
          return plan(
            [{ name: "constraint.create", payload: { kind: "angle", targets: [{ id: first.id }, { id: second.id }], value } }],
            [`ANGLE: lines '${first.id}' and '${second.id}' at ${trimNum(deg)}°.`],
          );
        }
        case "radius": {
          const circle = entityValue(values, "circle");
          const current = radiusOf(circle);
          const value = numberValue(values, "value", current ?? undefined);
          if (!(value > 0)) throw new Error("radius value must be > 0");
          return plan(
            [{ name: "constraint.create", payload: { kind: "radius", targets: [{ id: circle.id }], value } }],
            [`RADIUS: '${circle.id}' = ${trimNum(value)}.`],
          );
        }
        default:
          throw new Error(`unknown dimensional type '${kind}'`);
      }
    },
  },
  {
    id: "constraintlist",
    name: "CONSTRAINTLIST",
    aliases: ["CLIST"],
    label: "Constraint List",
    description:
      "List the declared constraint graph: id, type, targets (with anchors) and dimensional values. Live satisfaction diagnostics are shown in the Constraints palette (CONSTRAINTS).",
    category: "view",
    ribbonTab: "Parametric",
    steps: [],
    instant: (ctx) => {
      if (ctx.constraints.length === 0) {
        return plan([], ["CONSTRAINTLIST: no constraints declared (GEOMCONSTRAINT/DIMCONSTRAINT add them)."]);
      }
      const lines = ["CONSTRAINTLIST: declared constraints —"];
      for (const c of ctx.constraints) {
        const targets = c.targets
          .map((t) => (t.anchor !== undefined ? `${t.id}:${t.anchor}` : t.id))
          .join(", ");
        const value = c.value !== undefined ? ` = ${trimNum(c.value)}${c.kind === "angle" ? " rad" : ""}` : "";
        lines.push(`  ${c.id}: ${c.kind} (${targets})${value}`);
      }
      return plan([], lines);
    },
  },
  {
    id: "delconstraint",
    name: "DELCONSTRAINT",
    aliases: ["DCON"],
    label: "Remove Constraints",
    description:
      "Remove every constraint referencing the selected entities (one atomic batch — the geometry stays at its current solved state).",
    category: "modify",
    ribbonTab: "Parametric",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select entities to release from constraints:",
        optional: true,
        multiple: true,
        minInputs: 1,
        validate: validateConstrainablePick,
      },
    ],
    build: (values, ctx) => {
      const objects = entitiesValue(values, "objects");
      const ids = new Set(objects.map((o) => o.id));
      const bound: ConstraintRecord[] = ctx.constraints.filter((c) =>
        c.targets.some((t) => ids.has(t.id)),
      );
      if (bound.length === 0) {
        throw new Error(
          "the selection carries no constraints — nothing to remove (CONSTRAINTLIST lists the declared graph)",
        );
      }
      return plan(
        bound.map((c) => ({ name: "constraint.remove", payload: { id: c.id } })),
        [
          `DELCONSTRAINT: ${bound.length} constraint${bound.length === 1 ? "" : "s"} removed (${bound.map((c) => c.id).join(", ")}) — geometry stays at its solved state.`,
        ],
      );
    },
  },
  {
    id: "constraints",
    name: "CONSTRAINTS",
    aliases: ["CS"],
    label: "Constraints",
    description:
      "Open the Constraints palette (the parametric manager: live satisfaction diagnostics with the six typed outcomes, degrees-of-freedom accounting, dimensional value editing and removal).",
    category: "view",
    ribbonTab: "Parametric",
    steps: [],
    instant: () =>
      plan([], ["CONSTRAINTS: palette."], [{ action: "palette.show", payload: { palette: "constraints" } }]),
  },
  {
    id: "array",
    name: "ARRAY",
    aliases: ["AR"],
    label: "Array",
    description:
      "Create a deterministic pattern of copies: Rectangular (rows, columns, spacings) or Polar (center, item count, angle span, rotate items). Path arrays are unsupported in this build (typed decline). Copies are minted in ONE atomic revision; constraints bind the sources only.",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select objects to array:",
        optional: true,
        multiple: true,
        minInputs: 1,
      },
      { id: "mode", kind: "text", prompt: "Enter array type [Rectangular/Polar] (Path is unsupported):", rematerialize: true },
    ],
    dynamicSteps: (ctx, values) => {
      const base: PromptStep[] = [
        {
          id: "objects",
          kind: "entity",
          prompt: "Select objects to array:",
          optional: true,
          multiple: true,
          minInputs: 1,
        },
        { id: "mode", kind: "text", prompt: "Enter array type [Rectangular/Polar] (Path is unsupported):", rematerialize: true },
      ];
      const modeValue = values.mode;
      if (modeValue === undefined || modeValue.kind !== "text") return base;
      const mode = modeValue.text.trim().toLowerCase();
      if (mode === "rectangular" || mode === "r") {
        return [
          ...base,
          { id: "rows", kind: "number", prompt: "Enter number of rows <3>:", defaultValue: 3 },
          { id: "columns", kind: "number", prompt: "Enter number of columns <3>:", defaultValue: 3 },
          { id: "rowSpacing", kind: "number", prompt: "Specify row spacing (between levels):", baseStep: "base" },
          { id: "columnSpacing", kind: "number", prompt: "Specify column spacing (between items):" },
        ];
      }
      if (mode === "polar" || mode === "p") {
        return [
          ...base,
          { id: "center", kind: "point", prompt: "Specify center point of array:" },
          { id: "items", kind: "number", prompt: "Enter number of items <6>:", defaultValue: 6 },
          { id: "span", kind: "number", prompt: "Enter angle to fill in degrees <360>:", defaultValue: 360 },
        ];
      }
      // Path (or any unknown type): no further steps — the BUILDER declines
      // with the typed message when the command completes (LOCK-013 honesty).
      return base;
    },
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const ids = objects.map((o) => o.id);
      const modeRaw = textValue(values, "mode").trim().toLowerCase();
      if (modeRaw === "path") {
        throw new Error("Path arrays are not supported in this build — Rectangular and Polar only (typed decline, never a silent approximation).");
      }
      if (modeRaw === "rectangular" || modeRaw === "r") {
        const rows = numberValue(values, "rows", 3);
        const columns = numberValue(values, "columns", 3);
        const rowSpacing = numberValue(values, "rowSpacing");
        const columnSpacing = numberValue(values, "columnSpacing");
        if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1) {
          throw new Error("rows and columns must be integers >= 1");
        }
        if (!Number.isFinite(rowSpacing) || !Number.isFinite(columnSpacing)) {
          throw new Error("row/column spacings must be finite numbers");
        }
        const copies = rows * columns - 1;
        if (copies <= 0) {
          throw new Error("a 1x1 array creates nothing — rows x columns must exceed one item");
        }
        return plan(
          [
            {
              name: "entity.modify",
              payload: { op: "array", mode: "rectangular", ids, rows, columns, rowSpacing, columnSpacing },
            },
          ],
          [
            `ARRAY Rectangular: ${copies} cop${copies === 1 ? "y" : "ies"} of ${ids.length} object(s) (${rows} x ${columns}, spacing (${trimNum(columnSpacing)}, ${trimNum(rowSpacing)})) — one atomic revision; constraints bind the sources only.`,
          ],
        );
      }
      if (modeRaw === "polar" || modeRaw === "p") {
        const center = pointValue(values, "center");
        const items = numberValue(values, "items", 6);
        const spanDeg = numberValue(values, "span", 360);
        if (!Number.isInteger(items) || items < 2) {
          throw new Error("item count must be an integer >= 2 (including the source)");
        }
        if (!Number.isFinite(spanDeg) || spanDeg <= 0) {
          throw new Error("angle to fill must be > 0 degrees");
        }
        const angleSpan = spanDeg * DEG;
        return plan(
          [
            {
              name: "entity.modify",
              payload: { op: "array", mode: "polar", ids, center: { x: center[0], y: center[1] }, items, angleSpan, rotateItems: true },
            },
          ],
          [
            `ARRAY Polar: ${items - 1} cop${items === 2 ? "y" : "ies"} of ${ids.length} object(s) about (${fmtPoint(center)}), ${trimNum(spanDeg)}° fill, items rotated — one atomic revision.`,
          ],
        );
      }
      throw new Error(`unknown array type '${modeRaw}' — Rectangular or Polar (Path is unsupported)`);
    },
  },
];
