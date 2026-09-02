/**
 * CAD-PARITY-013 command registry extension (Issue #104) — the documentation
 * production vocabulary: the Navigator (View Map folders + Layout Book
 * subsets), layout-book assignment, master layouts, title blocks,
 * revisions, schedules/indexes and publisher sets.
 *
 * Commands (all ribbonTab "Documentation" — a new tab value the hosts map;
 * the registry is host-agnostic):
 *  - NAVFOLDER (NVF) — create a View Map folder (optional parent folder
 *    name; empty = map root). ONE navigator.createFolder revision.
 *  - SUBSET (SUB) — create a Layout Book subset (optional parent subset
 *    name, sheet-number prefix default "A", numbering none|custom with the
 *    zero-padded counter start). ONE navigator.createSubset revision.
 *  - NAVASSIGN (NA) — file a saved view into a folder (docs.updateView
 *    folderId) or a layout into a subset (layout.update subsetId); "*"
 *    unassigns to the root. Names resolve through the CommandContext.
 *  - LAYOUTMASTER (LMAS) — set/clear a layout's master layout (ONE
 *    layout.update revision; single-level masters are validated at the
 *    document boundary).
 *  - TITLEBLOCK (TB) — create a reusable title block (Project/Layout/Sheet/
 *    Revisions rows + optional Author/Date text rows; 180 mm wide, 12 mm
 *    rows). ONE titleblock.create revision.
 *  - TITLEPLACE (TBP) — place a title block on a layout (x/y mm; ONE
 *    layout.update revision).
 *  - REVISION (REV) — add a document revision record (code, description,
 *    optional comma-separated layout names). ONE revision.add revision.
 *  - REVLIST — the revision report surface (report.revisions ui action +
 *    the Layouts palette — the MATLIST pattern).
 *  - SCHEDULE (SCH) — create a schedule/index definition over one of the
 *    six sources (elements/components/materials/views/layouts/sheets) with
 *    the DEFAULT full per-source column set. ONE schedule.create revision.
 *  - SCHLIST — the schedule report surface (report.schedule + the
 *    Schedules palette).
 *  - PUBSET (PUB) — create a publisher set from a comma/pipe-separated
 *    item list ("subset:Name" / "layout:Name"; strict parse — junk is a
 *    typed builder failure). ONE publisher.create revision.
 *  - PUBLISHBOOK (PBK) — publish a named set (publisher.run — NON-VERSIONED
 *    output automation; the host appends the deterministic run-result line).
 *
 * Echo discipline: the prompt engine's echo lines are BUILD-TIME static
 * (pure builders cannot know the document-minted ids or the run results),
 * so the minted-id tails of the reference echo formats
 * (`… — {id}.`) and the publisher run summary
 * (`… — {n} page(s), pdf {bytes} B, sha256 {first 12}.`) are appended by
 * the HOST from the command response (the plot.export/PLOT download-line
 * precedent — the shell's executePlan already appends result lines). The
 * command's own echo carries the full knowable content deterministically.
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * the dispatch lives in app-api/contract.ts (server-side validation; the
 * document is the single authority). The SAME registry drives ribbon,
 * palette, keyboard and command line on BOTH hosts (LOCK-004).
 */

import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  PromptStep,
  PromptValue,
} from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import { optionValue } from "./prompt-options.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-coordination.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, ui, echo };
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: string): string | null {
  const v = values[id];
  if (v === undefined) return fallback !== undefined ? fallback : null;
  if (v.kind !== "text") return fallback !== undefined ? fallback : null;
  return v.text;
}

function numberValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback: number): number {
  const v = values[id];
  if (v === undefined || v.kind !== "number") return fallback;
  return v.value;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

// ---------------------------------------------------------------------------
// Name resolution through the CommandContext (typed failures — never a
// guess; empty names are the root/unassign form).
// ---------------------------------------------------------------------------

/** Resolve a FOLDER node name (first match in context order). */
function folderByName(ctx: CommandContext, name: string): { id: string; name: string } {
  const node = (ctx.navigatorNodes ?? []).find((n) => n.kind === "folder" && n.name === name);
  if (node === undefined) {
    throw new Error(`folder '${name}' does not exist — NAVFOLDER creates one (navigator folder names resolve through the document navigator tree).`);
  }
  return node;
}

/** Resolve a SUBSET node name (first match in context order). */
function subsetByName(ctx: CommandContext, name: string): { id: string; name: string } {
  const node = (ctx.navigatorNodes ?? []).find((n) => n.kind === "subset" && n.name === name);
  if (node === undefined) {
    throw new Error(`subset '${name}' does not exist — SUBSET creates one (navigator subset names resolve through the document navigator tree).`);
  }
  return node;
}

/** Resolve a layout by name (typed failure when not found). */
function layoutByName(ctx: CommandContext, name: string): { id: string; name: string } {
  const layout = ctx.layouts.find((l) => l.name === name);
  if (layout === undefined) {
    throw new Error(`layout '${name}' does not exist — LAYOUTNEW creates one.`);
  }
  return layout;
}

/** Resolve a saved view by TITLE (first match in document order — the
 * NAVASSIGN target address). */
function viewByTitle(ctx: CommandContext, title: string): { id: string; title: string } {
  const view = (ctx.docsViews ?? []).find((v) => v.title === title);
  if (view === undefined) {
    throw new Error(`view '${title}' does not exist — views are created through the documentation surface (docs.createViews).`);
  }
  return view;
}

/** Resolve a title block by name (typed failure when not found). */
function titleBlockByName(ctx: CommandContext, name: string): { id: string; name: string } {
  const block = (ctx.titleBlocks ?? []).find((t) => t.name === name);
  if (block === undefined) {
    throw new Error(`title block '${name}' does not exist — TITLEBLOCK creates one.`);
  }
  return block;
}

/** Resolve a publisher set by name (typed failure when not found). */
function publisherSetByName(ctx: CommandContext, name: string): { id: string; name: string } {
  const set = (ctx.publisherSets ?? []).find((s) => s.name === name);
  if (set === undefined) {
    throw new Error(`publisher set '${name}' does not exist — PUBSET creates one.`);
  }
  return set;
}

// ---------------------------------------------------------------------------
// The default per-source schedule column sets (the SCHEDULE command's "all
// columns" default — the full closed vocabulary for that source, capped at
// 12, label = the humanized key). The VALIDATED vocabulary is the single
// source of truth in caddocument/workspace.ts (SCHEDULE_COLUMN_KEYS — the
// validator rejects anything else); this is the command-layer presentation
// default kept here so the workspace stays free of the document-layer
// runtime dependency (the browser bundle imports this registry).
// ---------------------------------------------------------------------------

/** Humanize a closed-vocabulary column key ("id" → "Id",
 *  "renovationStatus" → "Renovation Status"). */
function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function columnsOf(keys: readonly string[]): readonly { key: string; label: string }[] {
  return keys.map((key) => ({ key, label: humanizeKey(key) }));
}

/** Default columns per source: the FULL static closed vocabulary for that
 *  source (≤ 12 — every source vocabulary fits), label = humanized key.
 *  Dynamic `ps:<set>.<key>` columns are deliberately NOT defaults (they are
 *  author-chosen references into the property-set overlay). */
export const DEFAULT_SCHEDULE_COLUMNS: Readonly<Record<string, readonly { key: string; label: string }[]>> =
  Object.freeze({
    elements: Object.freeze(columnsOf([
      "id", "type", "name", "story", "layer", "material", "classification", "renovationStatus", "option",
    ])),
    components: Object.freeze(columnsOf([
      "id", "type", "name", "story", "layer", "material", "classification", "renovationStatus", "option",
    ])),
    materials: Object.freeze(columnsOf(["id", "name", "category", "color", "lineweight", "density"])),
    views: Object.freeze(columnsOf(["id", "kind", "title", "scale", "folder", "contentHash", "primitives"])),
    layouts: Object.freeze(columnsOf(["id", "name", "subset", "master", "sheetNumber", "titleBlock", "revisions"])),
    sheets: Object.freeze(columnsOf(["id", "title", "sheetNumber", "projectName", "views"])),
  });

/** The six schedule sources as prompt options (keyword shortcuts). */
const SCHEDULE_SOURCE_OPTIONS = [
  { keyword: "EL", label: "elements", flag: true },
  { keyword: "COM", label: "components", flag: true },
  { keyword: "MAT", label: "materials", flag: true },
  { keyword: "VIE", label: "views", flag: true },
  { keyword: "LAY", label: "layouts", flag: true },
  { keyword: "SHE", label: "sheets", flag: true },
];

const SCHEDULE_SOURCES: readonly string[] = [
  "elements", "components", "materials", "views", "layouts", "sheets",
];

/** Resolve the source step's collected value: a flag keyword wins, else the
 *  typed text (full source name). Returns null when unknown (typed
 *  failure). */
function scheduleSourceOf(values: Readonly<Record<string, PromptValue>>): string | null {
  const byKeyword: Readonly<Record<string, string>> = {
    EL: "elements",
    COM: "components",
    MAT: "materials",
    VIE: "views",
    LAY: "layouts",
    SHE: "sheets",
  };
  for (const [keyword, source] of Object.entries(byKeyword)) {
    if (optionValue(values, "source", keyword) !== null) return source;
  }
  const typed = textValue(values, "source", "elements")!.trim().toLowerCase();
  return SCHEDULE_SOURCES.find((s) => s === typed) ?? null;
}

// --- CAD-PARITY-015 (Issue #110): the property-definition + QTO option
// resolvers (the scheduleSourceOf pattern: a flag keyword wins, else the
// typed text; null = a typed builder failure). -----------------------------

/** The PROPDEF type step: TE/NUM/BO flags or the typed text. */
function propertyTypeOf(values: Readonly<Record<string, PromptValue>>): "text" | "number" | "boolean" | null {
  if (optionValue(values, "type", "TE") !== null) return "text";
  if (optionValue(values, "type", "NUM") !== null) return "number";
  if (optionValue(values, "type", "BO") !== null) return "boolean";
  const typed = (textValue(values, "type", "text") ?? "").trim().toLowerCase();
  if (typed === "text" || typed === "number" || typed === "boolean") return typed;
  return null;
}

const QTO_SOURCES: readonly string[] = ["elements", "components", "materials"];

/** The QTO source step: EL/COM/MAT flags or the typed text. */
function qtoSourceOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "source", "EL") !== null) return "elements";
  if (optionValue(values, "source", "COM") !== null) return "components";
  if (optionValue(values, "source", "MAT") !== null) return "materials";
  const typed = (textValue(values, "source", "elements") ?? "").trim().toLowerCase();
  return QTO_SOURCES.find((s) => s === typed) ?? null;
}

const QTO_GROUPINGS: readonly string[] = ["none", "type", "story", "material"];

/** The QTO group-by step: NONE/TY/ST/MAT flags or the typed text. */
function qtoGroupOf(values: Readonly<Record<string, PromptValue>>): string | null {
  if (optionValue(values, "group", "NONE") !== null) return "none";
  if (optionValue(values, "group", "TY") !== null) return "type";
  if (optionValue(values, "group", "ST") !== null) return "story";
  if (optionValue(values, "group", "MAT") !== null) return "material";
  const typed = (textValue(values, "group", "none") ?? "").trim().toLowerCase();
  return QTO_GROUPINGS.find((g) => g === typed) ?? null;
}

// ---------------------------------------------------------------------------
// The numbering options (SUBSET) as prompt flags.
// ---------------------------------------------------------------------------

const NUMBERING_OPTIONS = [
  { keyword: "NONE", label: "none", flag: true },
  { keyword: "CUSTOM", label: "custom", flag: true },
];

// ---------------------------------------------------------------------------
// The CAD-PARITY-013 registry.
// ---------------------------------------------------------------------------

export const COMMANDS_DOCUMENTATION: readonly WorkspaceCommand[] = [
  // --- NAVFOLDER — create a View Map folder -----------------------------------
  {
    id: "navfolder",
    name: "NAVFOLDER",
    aliases: ["NVF"],
    label: "View folder",
    description:
      "Create a navigator View Map folder (optional parent folder name; Enter at the parent step files it at the map root). Views are filed into folders with NAVASSIGN.",
    category: "view",
    ribbonTab: "Documentation",
    steps: [
      { id: "name", kind: "text", prompt: "Folder name:" },
      { id: "parent", kind: "text", prompt: "Parent folder name <root>:", optional: true },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name")!.trim();
      if (name.length === 0) {
        throw new Error("NAVFOLDER requires a non-empty folder name.");
      }
      const parentText = textValue(values, "parent", "") ?? "";
      const parentName = parentText.trim();
      const payload: Record<string, unknown> = { name };
      let under = "";
      if (parentName.length > 0) {
        const parent = folderByName(ctx, parentName);
        payload.parentId = parent.id;
        under = ` under '${parent.name}'`;
      }
      return plan(
        [{ name: "navigator.createFolder", payload }],
        [`NAVFOLDER: '${name}'${under}.`],
      );
    },
  },

  // --- SUBSET — create a Layout Book subset -----------------------------------
  {
    id: "subset",
    name: "SUBSET",
    aliases: ["SUB"],
    label: "Layout subset",
    description:
      "Create a Layout Book subset (optional parent subset name, sheet-number prefix <A>, numbering none|custom with the zero-padded counter start <01>). Layouts are filed into subsets with NAVASSIGN.",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "name", kind: "text", prompt: "Subset name:" },
      { id: "parent", kind: "text", prompt: "Parent subset name <root>:", optional: true },
      { id: "prefix", kind: "text", prompt: "Sheet number prefix <A>:", optional: true, defaultValue: "A" },
      {
        id: "numbering",
        kind: "text",
        prompt: "Numbering [NONe/CUStom] <none>:",
        optional: true,
        defaultValue: "none",
        options: NUMBERING_OPTIONS,
      },
      { id: "customNumber", kind: "text", prompt: "Custom numbering start <01>:", optional: true, defaultValue: "01" },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name")!.trim();
      if (name.length === 0) {
        throw new Error("SUBSET requires a non-empty subset name.");
      }
      const parentText = textValue(values, "parent", "") ?? "";
      const parentName = parentText.trim();
      const prefix = (textValue(values, "prefix", "A") ?? "A").trim() || "A";
      const payload: Record<string, unknown> = { name, prefix };
      let under = "";
      if (parentName.length > 0) {
        const parent = subsetByName(ctx, parentName);
        payload.parentId = parent.id;
        under = ` under '${parent.name}'`;
      }
      // Numbering: the flags win, else the typed text, else "none".
      let numbering: "none" | "custom" = "none";
      if (optionValue(values, "numbering", "CUSTOM") !== null) {
        numbering = "custom";
      } else if (optionValue(values, "numbering", "NONE") === null) {
        const typed = (textValue(values, "numbering", "none") ?? "none").trim().toLowerCase();
        if (typed === "custom") numbering = "custom";
        else if (typed !== "none" && typed.length > 0) {
          throw new Error(`SUBSET numbering '${typed}' must be none | custom.`);
        }
      }
      let numberingEcho = "none";
      if (numbering === "custom") {
        const customNumber = (textValue(values, "customNumber", "01") ?? "01").trim() || "01";
        payload.numbering = "custom";
        payload.customNumber = customNumber;
        numberingEcho = `custom from ${customNumber}`;
      }
      return plan(
        [{ name: "navigator.createSubset", payload }],
        [`SUBSET: '${name}' [${prefix}] numbering ${numberingEcho}${under}.`],
      );
    },
  },

  // --- NAVASSIGN — file a view/layout into the navigator ----------------------
  {
    id: "navassign",
    name: "NAVASSIGN",
    aliases: ["NA"],
    label: "Assign to navigator",
    description:
      "File a saved view into a View Map folder or a layout into a Layout Book subset (view title / layout name, then the folder/subset name; * = the map/book root). Unknown names fail typed.",
    category: "view",
    ribbonTab: "Documentation",
    steps: [
      {
        id: "kind",
        kind: "text",
        // The keyword-selection default (the MATERIAL category-step pattern):
        // the VIEW/LAYOUT flag sets the answer, Enter advances past the step
        // with the declared default text — the builder's flag check wins, so
        // LAYOUT + Enter still files a layout. Without the default the step
        // could not complete cleanly after the flag (typed keyword matches
        // the option and re-prompts; plain Enter demands a text).
        prompt: "Assign a [View/Layout] <view>:",
        defaultValue: "view",
        options: [
          { keyword: "VIEW", label: "view", flag: true },
          { keyword: "LAYOUT", label: "layout", flag: true },
        ],
      },
      { id: "target", kind: "text", prompt: "View title / layout name:" },
      { id: "node", kind: "text", prompt: "Folder / subset name (* = root):", optional: true },
    ],
    build: (values, ctx) => {
      const isLayout = optionValue(values, "kind", "LAYOUT") !== null;
      const isView = optionValue(values, "kind", "VIEW") !== null;
      let kind: "view" | "layout";
      if (isLayout) kind = "layout";
      else if (isView) kind = "view";
      else {
        const typed = (textValue(values, "kind", "") ?? "").trim().toLowerCase();
        if (typed === "layout") kind = "layout";
        else if (typed === "view") kind = "view";
        else throw new Error("NAVASSIGN requires a kind: view | layout.");
      }
      const targetName = (textValue(values, "target") ?? "").trim();
      if (targetName.length === 0) {
        throw new Error(`NAVASSIGN requires a ${kind} name (the ${kind === "view" ? "view title" : "layout name"}).`);
      }
      const nodeText = (textValue(values, "node", "") ?? "").trim();
      const unassign = nodeText === "*" || nodeText.length === 0;
      if (kind === "view") {
        const view = viewByTitle(ctx, targetName);
        if (unassign) {
          return plan(
            [{ name: "docs.updateView", payload: { viewId: view.id, patch: { folderId: null } } }],
            [`NAVASSIGN: view '${view.title}' → (root).`],
          );
        }
        const folder = folderByName(ctx, nodeText);
        return plan(
          [{ name: "docs.updateView", payload: { viewId: view.id, patch: { folderId: folder.id } } }],
          [`NAVASSIGN: view '${view.title}' → '${folder.name}'.`],
        );
      }
      const layout = layoutByName(ctx, targetName);
      if (unassign) {
        return plan(
          [{ name: "layout.update", payload: { id: layout.id, patch: { subsetId: null } } }],
          [`NAVASSIGN: layout '${layout.name}' → (root).`],
        );
      }
      const subset = subsetByName(ctx, nodeText);
      return plan(
        [{ name: "layout.update", payload: { id: layout.id, patch: { subsetId: subset.id } } }],
        [`NAVASSIGN: layout '${layout.name}' → '${subset.name}'.`],
      );
    },
  },

  // --- LAYOUTMASTER — set/clear a layout's master -----------------------------
  {
    id: "layoutmaster",
    name: "LAYOUTMASTER",
    aliases: ["LMAS"],
    label: "Master layout",
    description:
      "Set the master layout of a layout (the master's sheet furniture + title-block placement render beneath the layout's own content; single-level — a master cannot have a master). * clears the assignment. Enter keeps the active layout.",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "layout", kind: "text", prompt: "Layout name <active>:", optional: true },
      { id: "master", kind: "text", prompt: "Master layout name (* = no master):", optional: true },
    ],
    build: (values, ctx) => {
      const active = ctx.activeLayoutId !== null ? ctx.layouts.find((l) => l.id === ctx.activeLayoutId) ?? null : null;
      const layoutText = (textValue(values, "layout", active?.name ?? "") ?? "").trim();
      if (layoutText.length === 0) {
        throw new Error("LAYOUTMASTER requires a layout name (no layouts exist yet — LAYOUTNEW creates one).");
      }
      const layout = layoutByName(ctx, layoutText);
      const masterText = (textValue(values, "master", "") ?? "").trim();
      if (masterText === "*" || masterText.length === 0) {
        return plan(
          [{ name: "layout.update", payload: { id: layout.id, patch: { masterId: null } } }],
          [`LAYOUTMASTER: '${layout.name}' master ← (none).`],
        );
      }
      const master = layoutByName(ctx, masterText);
      return plan(
        [{ name: "layout.update", payload: { id: layout.id, patch: { masterId: master.id } } }],
        [`LAYOUTMASTER: '${layout.name}' master ← '${master.name}'.`],
      );
    },
  },

  // --- TITLEBLOCK — create a reusable title block -----------------------------
  {
    id: "titleblock",
    name: "TITLEBLOCK",
    aliases: ["TB"],
    label: "Title block",
    description:
      "Create a reusable title block (Project text + derived Layout/Sheet/Revisions rows + optional Author/Date rows; 180 mm wide, 12 mm row height). Place it with TITLEPLACE.",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "name", kind: "text", prompt: "Title block name:" },
      { id: "project", kind: "text", prompt: "Project name (title block text):" },
      { id: "author", kind: "text", prompt: "Author (Enter = omit the row):", optional: true },
      { id: "date", kind: "text", prompt: "Date (Enter = omit the row):", optional: true },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name")!.trim();
      if (name.length === 0) {
        throw new Error("TITLEBLOCK requires a non-empty name.");
      }
      const project = (textValue(values, "project") ?? "").trim();
      if (project.length === 0) {
        throw new Error("TITLEBLOCK requires a project text (a literal value, not derived).");
      }
      const rows: { label: string; field: string; value?: string }[] = [
        { label: "Project", field: "text", value: project },
        { label: "Layout", field: "layoutName" },
        { label: "Sheet", field: "sheetNumber" },
        { label: "Revisions", field: "revisions" },
      ];
      const author = (textValue(values, "author", "") ?? "").trim();
      if (author.length > 0) rows.push({ label: "Author", field: "text", value: author });
      const date = (textValue(values, "date", "") ?? "").trim();
      if (date.length > 0) rows.push({ label: "Date", field: "text", value: date });
      const widthMm = 180;
      const rowHeightMm = 12;
      const heightMm = rows.length * rowHeightMm;
      void ctx;
      return plan(
        [
          {
            name: "titleblock.create",
            payload: { name, widthMm, heightMm, rowHeightMm, rows },
          },
        ],
        [`TITLEBLOCK: '${name}' — ${rows.length} rows, ${widthMm}×${heightMm} mm.`],
      );
    },
  },

  // --- TITLEPLACE — place a title block on a layout ---------------------------
  {
    id: "titleplace",
    name: "TITLEPLACE",
    aliases: ["TBP"],
    label: "Place title block",
    description:
      "Place a title block on a layout at sheet-space mm coordinates (default 10, 10 — the position validates inside the layout's oriented sheet at the document boundary).",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "layout", kind: "text", prompt: "Layout name:" },
      { id: "titleBlock", kind: "text", prompt: "Title block name:" },
      { id: "x", kind: "number", prompt: "X position (mm) <10>:", optional: true, defaultValue: 10 },
      { id: "y", kind: "number", prompt: "Y position (mm) <10>:", optional: true, defaultValue: 10 },
    ],
    build: (values, ctx) => {
      const layoutText = (textValue(values, "layout") ?? "").trim();
      if (layoutText.length === 0) {
        throw new Error("TITLEPLACE requires a layout name.");
      }
      const layout = layoutByName(ctx, layoutText);
      const blockText = (textValue(values, "titleBlock") ?? "").trim();
      if (blockText.length === 0) {
        throw new Error("TITLEPLACE requires a title block name.");
      }
      const block = titleBlockByName(ctx, blockText);
      const x = numberValue(values, "x", 10);
      const y = numberValue(values, "y", 10);
      return plan(
        [
          {
            name: "layout.update",
            payload: {
              id: layout.id,
              patch: { titleBlockPlacement: { titleBlockId: block.id, xMm: x, yMm: y } },
            },
          },
        ],
        [`TITLEPLACE: '${layout.name}' ← '${block.name}' at (${trimNum(x)}, ${trimNum(y)}) mm.`],
      );
    },
  },

  // --- REVISION — add a document revision record ------------------------------
  {
    id: "revision",
    name: "REVISION",
    aliases: ["REV"],
    label: "Revision",
    description:
      "Add a document revision record (unique code, description, optional comma-separated layout names the revision applies to; issued starts false). Layouts carry the revision through layout.update / the book surfaces.",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "code", kind: "text", prompt: "Revision code (e.g. P01):" },
      { id: "description", kind: "text", prompt: "Description (Enter = empty):", optional: true },
      { id: "layouts", kind: "text", prompt: "Layouts, comma-separated (Enter = none):", optional: true },
    ],
    build: (values, ctx) => {
      const code = textValue(values, "code")!.trim();
      if (code.length === 0) {
        throw new Error("REVISION requires a non-empty code (e.g. P01).");
      }
      const description = (textValue(values, "description", "") ?? "").trim();
      const layoutsText = (textValue(values, "layouts", "") ?? "").trim();
      const payload: Record<string, unknown> = { code, description, issued: false };
      if (layoutsText.length > 0) {
        const names = layoutsText.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        const layoutIds = names.map((name) => layoutByName(ctx, name).id);
        payload.layoutIds = layoutIds;
      }
      const layoutCount = Array.isArray(payload.layoutIds) ? (payload.layoutIds as string[]).length : 0;
      return plan(
        [{ name: "revision.add", payload }],
        [`REVISION: '${code}' — ${layoutCount} layout(s).`],
      );
    },
  },

  // --- REVLIST — the revision report surface ----------------------------------
  {
    id: "revlist",
    name: "REVLIST",
    aliases: [],
    label: "Revision list",
    description:
      "List the document revisions (code, description, issued, layouts) — the report action renders the live revisions.list query result in the Layouts palette.",
    category: "view",
    ribbonTab: "Documentation",
    steps: [],
    instant: () =>
      plan([], ["REVLIST."], [{ action: "report.revisions" }, { action: "palette.show", payload: { palette: "layouts" } }]),
  },

  // --- SCHEDULE — create a schedule/index definition --------------------------
  {
    id: "schedule",
    name: "SCHEDULE",
    aliases: ["SCH"],
    label: "Schedule",
    description:
      "Create a schedule/index definition over one of the six sources (ELements/COMponents/MATerials/VIEws/LAYouts/SHEets) with the full default column set for that source; an optional type filter (e.g. bim.wall) scopes the elements/components sources. Run it with SCHLIST/schedules.run.",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "name", kind: "text", prompt: "Schedule name:" },
      {
        id: "source",
        kind: "text",
        prompt: "Source [ELements/COMponents/MATerials/VIEws/LAYouts/SHEets] <elements>:",
        defaultValue: "elements",
        options: SCHEDULE_SOURCE_OPTIONS,
      },
      { id: "type", kind: "text", prompt: "Element type filter (Enter = none, e.g. bim.wall):", optional: true },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name")!.trim();
      if (name.length === 0) {
        throw new Error("SCHEDULE requires a non-empty name.");
      }
      const source = scheduleSourceOf(values);
      if (source === null) {
        const typed = (textValue(values, "source", "elements") ?? "").trim();
        throw new Error(
          `SCHEDULE source '${typed}' is not in the vocabulary [${SCHEDULE_SOURCES.join(", ")}].`,
        );
      }
      const columns = DEFAULT_SCHEDULE_COLUMNS[source]!;
      const payload: Record<string, unknown> = { name, source, columns: columns.map((c) => ({ key: c.key, label: c.label })) };
      const typeText = (textValue(values, "type", "") ?? "").trim();
      if (typeText.length > 0) {
        payload.filter = { type: typeText };
      }
      void ctx;
      return plan(
        [{ name: "schedule.create", payload }],
        [
          `SCHEDULE: '${name}' (${source}${typeText.length > 0 ? `, type ${typeText}` : ""}) — ${columns.length} columns.`,
        ],
      );
    },
  },

  // --- SCHLIST — the schedule report surface -----------------------------------
  {
    id: "schlist",
    name: "SCHLIST",
    aliases: [],
    label: "Schedule list",
    description:
      "List the schedule definitions and run the active one (the report action renders the live schedules.list/schedules.run query results in the Schedules palette).",
    category: "view",
    ribbonTab: "Documentation",
    steps: [],
    instant: () =>
      plan([], ["SCHLIST."], [{ action: "report.schedule" }, { action: "palette.show", payload: { palette: "schedules" } }]),
  },

  // --- PUBSET — create a publisher set ----------------------------------------
  {
    id: "pubset",
    name: "PUBSET",
    aliases: ["PUB"],
    label: "Publisher set",
    description:
      "Create a publisher set from a comma/pipe-separated item list (subset:Name or layout:Name entries; a junk entry is a typed failure — nothing is guessed). All items publish as PDF; run it with PUBLISHBOOK.",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "name", kind: "text", prompt: "Publisher set name:" },
      {
        id: "items",
        kind: "text",
        prompt: "Items, comma/pipe-separated (subset:Name / layout:Name):",
      },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name")!.trim();
      if (name.length === 0) {
        throw new Error("PUBSET requires a non-empty name.");
      }
      const itemsText = textValue(values, "items") ?? "";
      const parts = itemsText.split(/[,|]/).map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length === 0) {
        throw new Error("PUBSET requires at least one item (subset:Name or layout:Name entries).");
      }
      const items: { kind: "layout" | "subset"; id: string; format: "pdf" }[] = [];
      for (const part of parts) {
        const m = /^(subset|layout):(.+)$/.exec(part);
        if (m === null) {
          throw new Error(
            `PUBSET item '${part}' must be subset:Name or layout:Name (strict parse — junk is rejected, never guessed).`,
          );
        }
        const kind = m[1] as "subset" | "layout";
        const targetName = m[2]!.trim();
        const id = kind === "subset" ? subsetByName(ctx, targetName).id : layoutByName(ctx, targetName).id;
        items.push({ kind, id, format: "pdf" });
      }
      return plan(
        [{ name: "publisher.create", payload: { name, items } }],
        [`PUBSET: '${name}' — ${items.length} item(s).`],
      );
    },
  },

  // --- PUBLISHBOOK — publish a named set (NON-VERSIONED) ----------------------
  {
    id: "publishbook",
    name: "PUBLISHBOOK",
    aliases: ["PBK"],
    label: "Publish book",
    description:
      "Publish a publisher set (expand subsets to their layouts in book order; every page's Plot IR + the multi-page PDF are built deterministically; no revision — output automation, the PUBLISH precedent). The host appends the run summary line.",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "set", kind: "text", prompt: "Publisher set name:" },
    ],
    build: (values, ctx) => {
      const setName = (textValue(values, "set") ?? "").trim();
      if (setName.length === 0) {
        throw new Error("PUBLISHBOOK requires a publisher set name.");
      }
      const set = publisherSetByName(ctx, setName);
      return plan(
        [{ name: "publisher.run", payload: { id: set.id } }],
        [`PUBLISHBOOK: '${set.name}'.`],
      );
    },
  },

  // --- CAD-PARITY-015 (additive, Issue #110): the property-definition and
  // --- quantity-workflow command surfaces. -----------------------------------

  // --- PROPDEF — create a property definition ----------------------------------
  {
    id: "propdef",
    name: "PROPDEF",
    aliases: ["PD"],
    label: "Property definition",
    description:
      "Create a document-owned property definition (name, property set, key, the closed TExt/NUMber/BOOLean type, an optional unit on number definitions, an optional comma-separated applies-to type list e.g. bim.wall,bim.slab). Declarations only — values stay on the elements' property sets (no parallel source of truth).",
    category: "document",
    ribbonTab: "Documentation",
    steps: [
      { id: "name", kind: "text", prompt: "Property definition name:" },
      { id: "set", kind: "text", prompt: "Property set name (e.g. PSet_WallCommon):" },
      { id: "key", kind: "text", prompt: "Property key (e.g. FireRating):" },
      {
        id: "type",
        kind: "text",
        prompt: "Type [TExt/NUMber/BOOLean] <text>:",
        defaultValue: "text",
        options: [
          { keyword: "TE", label: "text", flag: true },
          { keyword: "NUM", label: "number", flag: true },
          { keyword: "BO", label: "boolean", flag: true },
        ],
      },
      { id: "unit", kind: "text", prompt: "Unit (number definitions only, Enter = none):", optional: true },
      { id: "applies", kind: "text", prompt: "Applies to types, comma-separated (Enter = all):", optional: true },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name")!.trim();
      if (name.length === 0) {
        throw new Error("PROPDEF requires a non-empty name.");
      }
      const set = textValue(values, "set")!.trim();
      if (set.length === 0) {
        throw new Error("PROPDEF requires a non-empty property set name.");
      }
      const key = textValue(values, "key")!.trim();
      if (key.length === 0) {
        throw new Error("PROPDEF requires a non-empty property key.");
      }
      const type = propertyTypeOf(values);
      if (type === null) {
        const typed = (textValue(values, "type", "text") ?? "").trim();
        throw new Error(`PROPDEF type '${typed}' is not in the vocabulary [text, number, boolean].`);
      }
      const payload: Record<string, unknown> = { name, set, key, type };
      const unitText = (textValue(values, "unit", "") ?? "").trim();
      if (unitText.length > 0) {
        if (type !== "number") {
          throw new Error(`PROPDEF unit is only valid on number definitions (got type '${type}').`);
        }
        payload.unit = unitText;
      }
      const appliesText = (textValue(values, "applies", "") ?? "").trim();
      if (appliesText.length > 0) {
        const appliesTo = appliesText.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (appliesTo.length === 0) {
          throw new Error("PROPDEF applies-to must be a comma-separated element type list (or empty for all).");
        }
        payload.appliesTo = appliesTo;
      }
      void ctx;
      return plan(
        [{ name: "property.create", payload }],
        [
          `PROPDEF: '${name}' ${set}.${key} (${type}${unitText.length > 0 ? `, ${unitText}` : ""}${appliesText.length > 0 ? `, applies to ${appliesText}` : ""}).`,
        ],
      );
    },
  },

  // --- PROPLIST — the property registry report surface --------------------------
  {
    id: "proplist",
    name: "PROPLIST",
    aliases: ["PLS"],
    label: "Property list",
    description:
      "List the property definitions with their live lineage statistics (values counted from the canonical element property-set overlay; type mismatches are reported, never coerced). Renders through the report.properties action + the Schedules palette.",
    category: "view",
    ribbonTab: "Documentation",
    steps: [],
    instant: () =>
      plan([], ["PROPLIST."], [{ action: "report.properties" }, { action: "palette.show", payload: { palette: "schedules" } }]),
  },

  // --- QTO — run the quantity takeoff (NON-MUTATING query surface) --------------
  {
    id: "qto",
    name: "QTO",
    aliases: ["QTY"],
    label: "Quantity takeoff",
    description:
      "Run the deterministic revision-bound quantity takeoff over one of the three sources (ELements/COMponents/MATerials), optionally grouped by TYpe/STory/MATerial and scoped by an element type filter. A query surface — no revision; the host runs quantities.run and renders the report.",
    category: "view",
    ribbonTab: "Documentation",
    steps: [
      {
        id: "source",
        kind: "text",
        prompt: "Source [ELements/COMponents/MATerials] <elements>:",
        defaultValue: "elements",
        options: [
          { keyword: "EL", label: "elements", flag: true },
          { keyword: "COM", label: "components", flag: true },
          { keyword: "MAT", label: "materials", flag: true },
        ],
      },
      {
        id: "group",
        kind: "text",
        prompt: "Group by [NONE/TYpe/STory/MATerial] <none>:",
        defaultValue: "none",
        options: [
          { keyword: "NONE", label: "none", flag: true },
          { keyword: "TY", label: "type", flag: true },
          { keyword: "ST", label: "story", flag: true },
          { keyword: "MAT", label: "material", flag: true },
        ],
      },
      { id: "type", kind: "text", prompt: "Element type filter (Enter = none, e.g. bim.wall):", optional: true },
    ],
    build: (values, ctx) => {
      const source = qtoSourceOf(values);
      if (source === null) {
        const typed = (textValue(values, "source", "elements") ?? "").trim();
        throw new Error(`QTO source '${typed}' is not in the vocabulary [elements, components, materials].`);
      }
      const groupBy = qtoGroupOf(values);
      if (groupBy === null) {
        const typed = (textValue(values, "group", "none") ?? "").trim();
        throw new Error(`QTO group-by '${typed}' is not in the vocabulary [none, type, story, material].`);
      }
      if (source === "materials" && groupBy !== "none") {
        throw new Error("QTO the materials source is the material aggregation itself — group-by must be none.");
      }
      const payload: Record<string, unknown> = { source, groupBy };
      const typeText = (textValue(values, "type", "") ?? "").trim();
      if (typeText.length > 0) {
        if (source === "materials") {
          throw new Error("QTO a type filter is only valid on the elements/components sources.");
        }
        payload.filter = { type: typeText };
      }
      void ctx;
      return plan(
        [],
        [`QTO: ${source} grouped by ${groupBy}${typeText.length > 0 ? `, type ${typeText}` : ""}.`],
        [{ action: "report.quantities", payload }],
      );
    },
  },
];
