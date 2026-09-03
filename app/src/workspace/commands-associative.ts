/**
 * COMPAT-CAD-004 command registry extension (Issue #121) — the consolidated
 * parametrics/associative/patterns vocabulary.
 *
 * Commands:
 *  - PATTERNMIRROR (PMIR) — the bounded deterministic mirror over drafting
 *    geometry AND symbol instances: objects, two axis points, then keep or
 *    erase the source (Y/N, default keep). Geometry mirrors exactly through
 *    the verified kernel (with the constraint/associative cascade); block
 *    instances flip the handedness through the reflected placement
 *    (rotation' = 2φ − θ, the additive `mirrored` state); external
 *    references decline typed (reload mirrored instead). ONE atomic
 *    revision; the MIRROR (MI) command stays the pure-geometry surface
 *    (its instance decline is the documented bounded rule — PMIR is the
 *    pattern-family extension that covers instances).
 *  - ASSOCREFRESH (AREF) — the ONE-revision atomic associative refresh:
 *    every associative annotation re-measures AND the documentation
 *    values regenerate in the same atomic batch; dangling references
 *    disassociate honestly (never a silent re-target) and every outcome
 *    is reported typed (the workbench renders the outcome rows).
 *  - PARAMETRICS (PAR) — open the Parametrics workbench (the consolidated
 *    manager surface: the capability discovery table, the typed
 *    associative report, the pattern surfaces).
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * the SAME registry drives ribbon, palette, keyboard and command line on
 * BOTH hosts (LOCK-004).
 */

import type { Vec2 } from "../drafting/precision.js";
import type {
  AppApiCommandPlanEntry,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";
import type { WorkspaceCommand } from "./commands.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-2d.ts).
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
  if (v === undefined || v.kind !== "entities") throw new Error(`command builder: step '${id}' has no entity picks`);
  return v.entities;
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback = ""): string {
  const v = values[id];
  if (v === undefined || v.kind !== "text") return fallback;
  return v.text;
}

function toPt(v: Vec2): { x: number; y: number } {
  return { x: v[0], y: v[1] };
}

function fmtPoint(p: Vec2): string {
  return `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;
}

function distPts(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const COMMANDS_ASSOCIATIVE: readonly WorkspaceCommand[] = [
  {
    id: "pattern-mirror",
    name: "PATTERNMIRROR",
    aliases: ["PMIR"],
    label: "Pattern Mirror",
    description:
      "Mirror drafting geometry AND block instances across a two-point axis in ONE atomic revision. Geometry mirrors exactly (with the constraint/associative cascade); symbol instances flip their handedness through the deterministic reflected placement; external references decline typed. Keep or erase the source (Y/N, default keep).",
    category: "modify",
    ribbonTab: "Parametric",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select objects to mirror (geometry and/or block instances):",
        optional: true,
        multiple: true,
        minInputs: 1,
      },
      { id: "p1", kind: "point", prompt: "Specify first point of mirror axis:" },
      { id: "p2", kind: "point", prompt: "Specify second point of mirror axis:" },
      {
        id: "eraseSource",
        kind: "text",
        prompt: "Erase source objects? [Yes/No] <No>:",
        defaultValue: "N",
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const p1 = pointValue(values, "p1");
      const p2 = pointValue(values, "p2");
      const answer = textValue(values, "eraseSource", "N").toUpperCase();
      if (answer !== "Y" && answer !== "N" && answer !== "YES" && answer !== "NO") {
        throw new Error("PATTERNMIRROR: answer Y (erase source) or N (keep source).");
      }
      const eraseSource = answer === "Y" || answer === "YES";
      if (distPts(p1, p2) <= 1e-9) throw new Error("PATTERNMIRROR: axis needs two distinct points.");
      return plan(
        [
          {
            name: "pattern.mirror",
            payload: { ids: objects.map((o) => o.id), p1: toPt(p1), p2: toPt(p2), eraseSource },
          },
        ],
        [
          `PATTERNMIRROR: ${objects.length} object(s) across ${fmtPoint(p1)}–${fmtPoint(p2)}${eraseSource ? " (source erased)" : " (source kept)"} — geometry mirrors exactly; symbol instances flip the handedness.`,
        ],
      );
    },
  },
  {
    id: "assoc-refresh",
    name: "ASSOCREFRESH",
    aliases: ["AREF"],
    label: "Associative Refresh",
    description:
      "Re-measure every associative annotation AND regenerate the documentation values in ONE atomic revision. Dangling references disassociate honestly (the last known value survives — never a silent re-target); the typed outcome report renders in the Parametrics workbench.",
    category: "modify",
    ribbonTab: "Parametric",
    steps: [],
    instant: () =>
      plan([{ name: "assoc.refresh", payload: {} }], [
        "ASSOCREFRESH: the one-revision associative refresh (annotations re-measured, documentation regenerated).",
      ]),
  },
  {
    id: "parametrics",
    name: "PARAMETRICS",
    aliases: ["PAR"],
    label: "Parametrics",
    description:
      "Open the Parametrics workbench (the consolidated manager: the versioned capability discovery table, the typed associative report with ok/dangling/source_loss/missing/stale outcomes, the pattern surfaces over constraints, symbols and associations).",
    category: "view",
    ribbonTab: "Parametric",
    steps: [],
    instant: () =>
      plan([], ["PARAMETRICS: workbench."], [
        { action: "report.parametrics" },
        { action: "palette.show", payload: { palette: "parametrics" } },
      ]),
  },
];
