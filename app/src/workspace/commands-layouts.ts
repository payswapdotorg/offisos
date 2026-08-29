/**
 * CAD-PARITY-008 command registry extension (Issue #88) — the layouts,
 * viewports, page setup, plot preview & publishing vocabulary.
 *
 * Commands:
 *  - LAYOUT (LO) — the layout manager: echo the layout/viewport inventory
 *    and open the Layouts palette (the manager surface).
 *  - LAYOUTNEW — create a paper-space layout (name, Enter = the next
 *    LayoutN) with the canonical default page setup, then activate it.
 *  - LAYOUTRENAME — rename a layout (names unique; viewports reference the
 *    immutable id — reference-safe by construction).
 *  - LAYOUTCLONE — deep-copy a layout AND its viewports with fresh
 *    document-minted identities in ONE atomic revision.
 *  - LAYOUTDELETE — remove a layout and its viewports as ONE atomic
 *    revision (the last layout is a typed rejection).
 *  - TILEMODE (TM) — the bounded model/paper context switch (1 = model
 *    space, 0 = the active layout — paper space).
 *  - MSPACE (MS) / PSPACE (PS) — switch the editing context (non-versioned
 *    editor state, the activeLayer precedent).
 *  - MVIEW (MV) — create ONE rectangular layout viewport: two paper-space
 *    corners, then the view [Fit (the deterministic model extents) /
 *    Scale (1:N + view center) / Window (an explicit model window)].
 *  - VPORTS — the viewport manager surface: echo the active layout's
 *    viewports (scale/rotation/lock) and open the Layouts palette (scale,
 *    rotation, lock and per-viewport layer visibility editing live there).
 *  - PAGESETUP — the bounded page-setup editor: paper size, orientation,
 *    uniform margins, plot scale ("fit"/"N:M"), plot style table — every
 *    step defaults to the layout's CURRENT value (Enter keeps it).
 *  - PREVIEW (PLOTPREVIEW) — the deterministic plot preview of the active
 *    layout (the shared Plot IR — the exact plot semantics).
 *  - PLOT — export ONE layout (SVG default / PDF — the deterministic
 *    writers; other formats are typed declines).
 *  - PUBLISH — the bounded batch: every layout into ONE multi-page PDF.
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * `layout.*`/`viewport.*`/`plot.*` dispatch to the shared layouts core
 * (server-side validation; the document is the single authority). The SAME
 * registry drives ribbon, palette, keyboard and command line on BOTH hosts
 * (LOCK-004).
 */

import type { Vec2 } from "../drafting/precision.js";
import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  PromptStep,
  PromptValue,
} from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import type { LayoutRecord, ViewportRecord } from "../contracts/caddocument.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-parametrics.ts).
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

/** Resolve the ACTIVE layout record (activeLayoutId wins; the first table
 *  entry is the fallback default — the layouts.list semantics). */
function activeLayout(ctx: CommandContext): LayoutRecord | null {
  if (ctx.activeLayoutId !== null) {
    const found = ctx.layouts.find((l) => l.id === ctx.activeLayoutId);
    if (found !== undefined) return found;
  }
  return ctx.layouts.length > 0 ? ctx.layouts[0]! : null;
}

/** Resolve a layout by NAME (case-sensitive, the user-facing address);
 *  throws the actionable message when unknown. */
function layoutByName(ctx: CommandContext, name: string): LayoutRecord {
  const found = ctx.layouts.find((l) => l.name === name);
  if (found === undefined) {
    const names = ctx.layouts.map((l) => l.name).join(", ");
    throw new Error(`unknown layout '${name}'${names.length > 0 ? ` — available: ${names}` : " (no layouts exist yet)"}`);
  }
  return found;
}

/** Parse a paper-size token (A4/A3/A2/A1/A0 — bounded named set). */
function parsePaperSize(text: string): "A4" | "A3" | "A2" | "A1" | "A0" {
  const t = text.trim().toUpperCase();
  if (t === "A4" || t === "A3" || t === "A2" || t === "A1" || t === "A0") return t;
  throw new Error(`unknown paper size '${text}' — valid: A4, A3, A2, A1, A0 (named ISO sizes; CUSTOM sheets come through the API)`);
}

/** Parse a plot-scale token ("fit" or "N:M"). */
function parseScaleToken(text: string): string {
  const t = text.trim();
  if (t.toLowerCase() === "fit") return "fit";
  if (/^[1-9][0-9]*:[1-9][0-9]*$/.test(t)) return t;
  throw new Error(`plot scale '${text}' is not valid — use "fit" or "N:M" (e.g. 1:50, 2:1)`);
}

const PAPER_SIZES: readonly ("A4" | "A3" | "A2" | "A1" | "A0")[] = ["A4", "A3", "A2", "A1", "A0"];

// ---------------------------------------------------------------------------
// The command registry extension.
// ---------------------------------------------------------------------------

export const COMMANDS_LAYOUTS: readonly WorkspaceCommand[] = [
  {
    id: "layout",
    name: "LAYOUT",
    aliases: ["LO"],
    label: "Layout Manager",
    description:
      "List the paper-space layouts and their viewports, and open the Layouts palette (the manager surface: page setup, viewport scale/rotation/lock, per-viewport layer visibility).",
    category: "document",
    ribbonTab: "Layout",
    steps: [],
    instant: (ctx) => {
      const echo: string[] = [];
      if (ctx.layouts.length === 0) {
        echo.push("No layouts yet — LAYOUTNEW creates one (A3 landscape default page setup).");
      } else {
        echo.push(`Layouts (${ctx.layouts.length}):`);
        for (const layout of ctx.layouts) {
          const viewports = ctx.viewports.filter((v) => v.layoutId === layout.id);
          const active = activeLayout(ctx)?.id === layout.id ? " (active)" : "";
          echo.push(
            `  ${layout.name}${active} — ${layout.pageSetup.paperSize} ${layout.pageSetup.orientation}, ${viewports.length} viewport${viewports.length === 1 ? "" : "s"}`,
          );
        }
      }
      return plan([], echo, [{ action: "palette.show", payload: { palette: "layouts" } }]);
    },
  },
  {
    id: "layoutnew",
    name: "LAYOUTNEW",
    aliases: [],
    label: "New Layout",
    description:
      "Create a paper-space layout (Enter keeps the next LayoutN name) with the canonical default page setup: A3 landscape, 10 mm margins, \"fit\" plot scale, as-displayed plot style, viewport borders plotted. The new layout becomes active.",
    category: "document",
    ribbonTab: "Layout",
    steps: [
      { id: "name", kind: "text", prompt: "Enter layout name:", optional: true },
    ],
    build: (values, ctx) => {
      const fallback = `Layout${ctx.layouts.length + 1}`;
      const name = textValue(values, "name", fallback).trim();
      if (name.length === 0) throw new Error("layout name must be a non-empty string");
      if (ctx.layouts.some((l) => l.name === name)) {
        throw new Error(`layout name '${name}' already exists — layout names are unique`);
      }
      return plan(
        [
          { name: "layout.create", payload: { name } },
          { name: "layout.activate", payload: { name } },
        ],
        [`Layout '${name}' created (A3 landscape, 10 mm margins, fit) and activated.`],
        [{ action: "space.paper" }],
      );
    },
  },
  {
    id: "layoutrename",
    name: "LAYOUTRENAME",
    aliases: [],
    label: "Rename Layout",
    description:
      "Rename a layout (names are unique; viewports reference the immutable id — a rename is reference-safe by construction). Enter keeps the active layout.",
    category: "document",
    ribbonTab: "Layout",
    steps: [
      { id: "layout", kind: "text", prompt: "Enter layout to rename <active>:", optional: true },
      { id: "newName", kind: "text", prompt: "Enter new name:" },
    ],
    build: (values, ctx) => {
      const current = activeLayout(ctx);
      if (current === null) throw new Error("no layouts exist yet — LAYOUTNEW creates one");
      const source = textValue(values, "layout", current.name).trim();
      const layout = layoutByName(ctx, source);
      const newName = textValue(values, "newName").trim();
      if (newName.length === 0) throw new Error("the new layout name must be a non-empty string");
      return plan(
        [{ name: "layout.rename", payload: { name: layout.name, newName } }],
        [`Layout '${layout.name}' renamed to '${newName}'.`],
      );
    },
  },
  {
    id: "layoutclone",
    name: "LAYOUTCLONE",
    aliases: [],
    label: "Clone Layout",
    description:
      "Deep-copy a layout AND its viewports with fresh document-minted identities in ONE atomic revision (one undo entry). Enter clones the active layout.",
    category: "document",
    ribbonTab: "Layout",
    steps: [
      { id: "layout", kind: "text", prompt: "Enter layout to clone <active>:", optional: true },
      { id: "newName", kind: "text", prompt: "Enter name for the copy:" },
    ],
    build: (values, ctx) => {
      const current = activeLayout(ctx);
      if (current === null) throw new Error("no layouts exist yet — LAYOUTNEW creates one");
      const source = textValue(values, "layout", current.name).trim();
      const layout = layoutByName(ctx, source);
      const newName = textValue(values, "newName").trim();
      if (newName.length === 0) throw new Error("the clone name must be a non-empty string");
      return plan(
        [{ name: "layout.clone", payload: { name: layout.name, newName } }],
        [`Layout '${layout.name}' cloned to '${newName}' (viewports copied with fresh identities).`],
      );
    },
  },
  {
    id: "layoutdelete",
    name: "LAYOUTDELETE",
    aliases: [],
    label: "Delete Layout",
    description:
      "Remove a layout and its viewports as ONE atomic revision (the explicit cascade). The LAST remaining layout is a typed rejection — a document that has layouts keeps one.",
    category: "document",
    ribbonTab: "Layout",
    steps: [
      { id: "layout", kind: "text", prompt: "Enter layout to delete <active>:", optional: true },
    ],
    build: (values, ctx) => {
      const current = activeLayout(ctx);
      if (current === null) throw new Error("no layouts exist yet");
      if (ctx.layouts.length <= 1) {
        throw new Error(`'${current.name}' is the last remaining layout — a document that has layouts keeps at least one`);
      }
      const source = textValue(values, "layout", current.name).trim();
      const layout = layoutByName(ctx, source);
      return plan(
        [{ name: "layout.remove", payload: { name: layout.name } }],
        [`Layout '${layout.name}' deleted (its viewports went with it — one undo entry).`],
      );
    },
  },
  {
    id: "tilemode",
    name: "TILEMODE",
    aliases: ["TM"],
    label: "Tile Mode",
    description:
      "The bounded model/paper context switch: 1 = model space (the Model view), 0 = the active layout (paper space). MSPACE/PSPACE are the direct switches.",
    category: "document",
    ribbonTab: "Layout",
    steps: [
      {
        id: "value",
        kind: "number",
        prompt: "Enter TILEMODE [0/1] <1>:",
        optional: true,
        defaultValue: 1,
      },
    ],
    build: (values) => {
      const value = numberValue(values, "value", 1);
      if (value !== 0 && value !== 1) throw new Error("TILEMODE accepts 0 (paper space) or 1 (model space) only");
      const space = value === 1 ? "model" : "paper";
      return plan(
        [{ name: "layout.setSpace", payload: { space } }],
        [`TILEMODE = ${value} (${space === "model" ? "model space" : "paper space — the active layout"}).`],
        space === "paper" ? [{ action: "space.paper" }] : [{ action: "space.model" }],
      );
    },
  },
  {
    id: "mspace",
    name: "MSPACE",
    aliases: ["MS"],
    label: "Model Space",
    description: "Switch the editing context to model space (the Model view).",
    category: "view",
    ribbonTab: "Layout",
    steps: [],
    instant: () =>
      plan(
        [{ name: "layout.setSpace", payload: { space: "model" } }],
        ["Model space active."],
        [{ action: "space.model" }],
      ),
  },
  {
    id: "pspace",
    name: "PSPACE",
    aliases: ["PS"],
    label: "Paper Space",
    description: "Switch the editing context to paper space (the active layout).",
    category: "view",
    ribbonTab: "Layout",
    steps: [],
    instant: () =>
      plan(
        [{ name: "layout.setSpace", payload: { space: "paper" } }],
        ["Paper space active (the active layout)."],
        [{ action: "space.paper" }],
      ),
  },
  {
    id: "mview",
    name: "MVIEW",
    aliases: ["MV"],
    label: "Create Viewport",
    description:
      "Create ONE rectangular layout viewport on the active layout: two paper-space corners, then the view — Fit (the deterministic model extents), Scale (1:N + the model view center) or Window (an explicit model window). The viewport clips its model content to the rectangle.",
    category: "draw",
    ribbonTab: "Layout",
    steps: [
      { id: "corner1", kind: "point", prompt: "Specify first corner of viewport (paper space mm):" },
      { id: "corner2", kind: "point", prompt: "Specify opposite corner (paper space mm):", baseStep: "corner1" },
      {
        id: "view",
        kind: "text",
        prompt: "Enter view mode [Fit/Scale/Window] <Fit>:",
        optional: true,
        defaultValue: "Fit",
        rematerialize: true,
      },
    ],
    dynamicSteps: (ctx, values) => {
      const base: PromptStep[] = [
        { id: "corner1", kind: "point", prompt: "Specify first corner of viewport (paper space mm):" },
        { id: "corner2", kind: "point", prompt: "Specify opposite corner (paper space mm):", baseStep: "corner1" },
        {
          id: "view",
          kind: "text",
          prompt: "Enter view mode [Fit/Scale/Window] <Fit>:",
          optional: true,
          defaultValue: "Fit",
          rematerialize: true,
        },
      ];
      const v = values.view;
      if (v === undefined || v.kind !== "text") return base;
      const mode = v.text.trim().toLowerCase();
      if (mode === "scale") {
        return [
          ...base,
          { id: "denominator", kind: "number", prompt: "Enter viewport scale denominator (1:N, e.g. 50):", defaultValue: 50 },
          { id: "center", kind: "point", prompt: "Enter model view center point (model units, e.g. 5000,3000):" },
        ];
      }
      if (mode === "window") {
        return [
          ...base,
          { id: "win1", kind: "point", prompt: "Enter first corner of the model view window:" },
          { id: "win2", kind: "point", prompt: "Enter opposite corner of the model view window:", baseStep: "win1" },
        ];
      }
      return base;
    },
    build: (values, ctx) => {
      const layout = activeLayout(ctx);
      if (layout === null) throw new Error("no layouts exist yet — LAYOUTNEW creates one before placing viewports");
      const c1 = pointValue(values, "corner1");
      const c2 = pointValue(values, "corner2");
      if (Math.abs(c1[0] - c2[0]) < 1e-9 || Math.abs(c1[1] - c2[1]) < 1e-9) {
        throw new Error("the viewport rectangle is degenerate — the corners must differ in X and Y");
      }
      const modeToken = textValue(values, "view", "Fit").trim().toLowerCase();
      let view: Record<string, unknown>;
      if (modeToken === "fit" || modeToken === "f" || modeToken === "") {
        view = { mode: "fit" };
      } else if (modeToken === "scale" || modeToken === "s") {
        const denominator = numberValue(values, "denominator", 50);
        if (denominator <= 0) throw new Error("the scale denominator must be positive");
        const center = pointValue(values, "center");
        view = { mode: "scale", denominator, centerX: center[0], centerY: center[1] };
      } else if (modeToken === "window" || modeToken === "w") {
        const w1 = pointValue(values, "win1");
        const w2 = pointValue(values, "win2");
        view = { mode: "window", x1: w1[0], y1: w1[1], x2: w2[0], y2: w2[1] };
      } else {
        throw new Error(`unknown view mode '${modeToken}' — valid: Fit, Scale, Window`);
      }
      const scaleEcho =
        view.mode === "fit" ? "fit to the model extents" : view.mode === "scale" ? `1:${String(view.denominator)}` : "the given model window";
      return plan(
        [
          {
            name: "viewport.create",
            payload: {
              layoutName: layout.name,
              corner1: [c1[0], c1[1]],
              corner2: [c2[0], c2[1]],
              view,
            },
          },
        ],
        [`Viewport placed on '${layout.name}' from ${fmtPoint(c1)} to ${fmtPoint(c2)} (${scaleEcho}).`],
      );
    },
  },
  {
    id: "vports",
    name: "VPORTS",
    aliases: [],
    label: "Viewports Manager",
    description:
      "The bounded viewport manager: echo the active layout's viewports (scale, rotation, lock) and open the Layouts palette — viewport scale/rotation/lock editing and per-viewport layer visibility (VPLAYER) live there. The viewport-scale ZOOM workflow is the panel's 1:N field.",
    category: "view",
    ribbonTab: "Layout",
    steps: [],
    instant: (ctx) => {
      const layout = activeLayout(ctx);
      const echo: string[] = [];
      if (layout === null) {
        echo.push("No layouts exist yet — LAYOUTNEW creates one.");
      } else {
        const viewports: readonly ViewportRecord[] = ctx.viewports.filter((v) => v.layoutId === layout.id);
        echo.push(`Viewports of '${layout.name}' (${viewports.length}):`);
        for (const vp of viewports) {
          echo.push(
            `  ${vp.id} — 1:${trimNum(vp.scaleDenominator)}, rotation ${trimNum(vp.rotationDeg)}°${vp.locked === true ? ", LOCKED" : ""}`,
          );
        }
        if (viewports.length === 0) echo.push("  (none — MVIEW places one)");
      }
      return plan([], echo, [{ action: "palette.show", payload: { palette: "layouts" } }]);
    },
  },
  {
    id: "pagesetup",
    name: "PAGESETUP",
    aliases: [],
    label: "Page Setup",
    description:
      "The bounded page-setup editor for the active (or named) layout: paper size, orientation, uniform margins, plot scale (\"fit\"/\"N:M\"), plot style table and the viewport-border plot toggle. Every step defaults to the layout's CURRENT value — Enter keeps it.",
    category: "document",
    ribbonTab: "Layout",
    steps: [
      { id: "layout", kind: "text", prompt: "Enter layout <active>:", optional: true, rematerialize: true },
    ],
    dynamicSteps: (ctx, values) => {
      const base: PromptStep[] = [
        { id: "layout", kind: "text", prompt: "Enter layout <active>:", optional: true, rematerialize: true },
      ];
      const current = activeLayout(ctx);
      let layout: LayoutRecord | null = current;
      const v = values.layout;
      if (v !== undefined && v.kind === "text" && v.text.trim().length > 0) {
        const found = ctx.layouts.find((l) => l.name === v.text.trim());
        if (found === undefined) return base;
        layout = found;
      }
      if (layout === null) return base;
      const setup = layout.pageSetup;
      return [
        ...base,
        {
          id: "paperSize",
          kind: "text",
          prompt: `Enter paper size [${PAPER_SIZES.join("/")}] <${setup.paperSize}>:`,
          optional: true,
          defaultValue: setup.paperSize,
        },
        {
          id: "orientation",
          kind: "text",
          prompt: `Enter orientation [Portrait/Landscape] <${setup.orientation === "portrait" ? "Portrait" : "Landscape"}>:`,
          optional: true,
          defaultValue: setup.orientation === "portrait" ? "Portrait" : "Landscape",
        },
        {
          id: "margins",
          kind: "number",
          prompt: `Enter uniform margin (mm) <${setup.marginsMm.top}>:`,
          optional: true,
          defaultValue: setup.marginsMm.top,
        },
        {
          id: "plotScale",
          kind: "text",
          prompt: `Enter plot scale [fit or N:M] <${setup.plotScale}>:`,
          optional: true,
          defaultValue: setup.plotScale,
        },
        {
          id: "plotStyle",
          kind: "text",
          prompt: `Enter plot style table [None or a name — CTB/STB application is a typed decline] <${setup.plotStyleTable ?? "None"}>:`,
          optional: true,
          defaultValue: setup.plotStyleTable ?? "None",
        },
        {
          id: "plotViewports",
          kind: "text",
          prompt: `Plot viewport borders [Yes/No] <${setup.plotViewports !== false ? "Yes" : "No"}>:`,
          optional: true,
          defaultValue: setup.plotViewports !== false ? "Yes" : "No",
        },
      ];
    },
    build: (values, ctx) => {
      const current = activeLayout(ctx);
      if (current === null) throw new Error("no layouts exist yet — LAYOUTNEW creates one");
      const layoutName = textValue(values, "layout", current.name).trim();
      const layout = layoutByName(ctx, layoutName);
      const setup = layout.pageSetup;
      const patch: Record<string, unknown> = {};
      const paperToken = textValue(values, "paperSize", setup.paperSize).trim().toUpperCase();
      patch.paperSize = parsePaperSize(paperToken);
      // Named sizes fix the portrait dimensions (the canonical table).
      const DIMENSIONS: Record<"A4" | "A3" | "A2" | "A1" | "A0", [number, number]> = {
        A4: [210, 297],
        A3: [297, 420],
        A2: [420, 594],
        A1: [594, 841],
        A0: [841, 1189],
      };
      if (patch.paperSize !== "CUSTOM") {
        const [w, h] = DIMENSIONS[patch.paperSize as "A4" | "A3" | "A2" | "A1" | "A0"];
        patch.widthMm = w;
        patch.heightMm = h;
      }
      const orientToken = textValue(values, "orientation", setup.orientation === "portrait" ? "Portrait" : "Landscape").trim().toLowerCase();
      if (orientToken.startsWith("p")) patch.orientation = "portrait";
      else if (orientToken.startsWith("l")) patch.orientation = "landscape";
      else throw new Error(`unknown orientation '${orientToken}' — valid: Portrait, Landscape`);
      const margins = numberValue(values, "margins", setup.marginsMm.top);
      if (margins < 0) throw new Error("margins cannot be negative");
      patch.marginsMm = { top: margins, right: margins, bottom: margins, left: margins };
      patch.plotScale = parseScaleToken(textValue(values, "plotScale", setup.plotScale));
      const styleToken = textValue(values, "plotStyle", setup.plotStyleTable ?? "None").trim();
      if (styleToken.toLowerCase() === "none" || styleToken.length === 0) {
        patch.plotStyleTable = null;
        patch.plotStyleKind = "none";
      } else {
        // The named reference persists; applying proprietary CTB/STB is a
        // typed decline at plot time (documented bounded rule).
        patch.plotStyleTable = styleToken;
        patch.plotStyleKind = styleToken.toLowerCase().endsWith(".stb") ? "stb" : "ctb";
      }
      const bordersToken = textValue(values, "plotViewports", setup.plotViewports !== false ? "Yes" : "No").trim().toLowerCase();
      if (bordersToken.startsWith("y")) patch.plotViewports = true;
      else if (bordersToken.startsWith("n")) patch.plotViewports = false;
      else throw new Error(`unknown answer '${bordersToken}' — valid: Yes, No`);
      return plan(
        [{ name: "layout.setPageSetup", payload: { name: layout.name, patch } }],
        [
          `Page setup of '${layout.name}': ${String(patch.paperSize)} ${String(patch.orientation)}, ${trimNum(margins)} mm margins, plot scale ${String(patch.plotScale)}, plot style ${styleToken.length === 0 || styleToken.toLowerCase() === "none" ? "none (as displayed)" : styleToken}.`,
        ],
      );
    },
  },
  {
    id: "preview",
    name: "PREVIEW",
    aliases: ["PLOTPREVIEW"],
    label: "Plot Preview",
    description:
      "The deterministic plot preview of the active layout: the shared Plot IR rendered exactly as the export path plots it (sheet frame, printable area, clipped viewport content).",
    category: "view",
    ribbonTab: "Layout",
    steps: [],
    instant: (ctx) => {
      const layout = activeLayout(ctx);
      if (layout === null) throw new Error("no layouts exist yet — LAYOUTNEW creates one");
      return plan(
        [],
        [`Plot preview of '${layout.name}' (${layout.pageSetup.paperSize} ${layout.pageSetup.orientation}).`],
        [{ action: "plot.preview" }],
      );
    },
  },
  {
    id: "plot",
    name: "PLOT",
    aliases: [],
    label: "Plot",
    description:
      "Export ONE layout deterministically: SVG (the standalone deterministic SVG) or PDF (the minimal deterministic PDF writer — byte-identical repeated exports). Enter keeps the active layout.",
    category: "document",
    ribbonTab: "Layout",
    steps: [
      { id: "layout", kind: "text", prompt: "Enter layout to plot <active>:", optional: true },
      {
        id: "format",
        kind: "text",
        prompt: "Enter plot format [SVG/PDF] <SVG>:",
        optional: true,
        defaultValue: "SVG",
      },
    ],
    build: (values, ctx) => {
      const current = activeLayout(ctx);
      if (current === null) throw new Error("no layouts exist yet — LAYOUTNEW creates one");
      const layoutName = textValue(values, "layout", current.name).trim();
      const layout = layoutByName(ctx, layoutName);
      const formatToken = textValue(values, "format", "SVG").trim().toUpperCase();
      if (formatToken !== "SVG" && formatToken !== "PDF") {
        throw new Error(`plot format '${formatToken}' is not supported — this slice plots SVG and PDF (proprietary formats are typed declines)`);
      }
      return plan(
        [{ name: "plot.export", payload: { name: layout.name, format: formatToken.toLowerCase() } }],
        [`Plotting '${layout.name}' as ${formatToken} (deterministic — repeated exports are byte-identical).`],
        [{ action: "plot.download" }],
      );
    },
  },
  {
    id: "publish",
    name: "PUBLISH",
    aliases: [],
    label: "Publish",
    description:
      "The bounded batch publish: EVERY layout into ONE deterministic multi-page PDF (layout table order). Batch automation across external project sets is an explicit non-goal of this slice.",
    category: "document",
    ribbonTab: "Layout",
    steps: [],
    instant: (ctx) => {
      if (ctx.layouts.length === 0) throw new Error("no layouts exist to publish — LAYOUTNEW creates one");
      return plan(
        [{ name: "plot.publish", payload: { format: "pdf" } }],
        [`Publishing ${ctx.layouts.length} layout${ctx.layouts.length === 1 ? "" : "s"} as one multi-page PDF (deterministic).`],
        [{ action: "plot.download" }],
      );
    },
  },
];
