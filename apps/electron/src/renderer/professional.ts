/**
 * CAD-PARITY-002 professional workspace — Electron renderer module
 * (Issue #75; CAD/BIM Product Architecture v1.0 FROZEN under
 * ConstructionOS Architecture v1.1).
 *
 * Adds the professional shell to the Electron host: application menu bar,
 * command-driven 2D Model canvas (SVG plan viewport with crosshair, snap
 * markers, ortho/polar rubber bands, window/crossing selection, cycling,
 * grips), command line with prompt state + history, status bar with
 * drafting-aid toggles, command palette (Ctrl+K) and the keyboard map.
 *
 * EVERYTHING routes through the SAME shared workspace core the Web host
 * uses (`@offisos/cad-app-shell/workspace` — bundled at build time; pure,
 * engine-free, LOCK-003/018). Mutations flow only through App API command
 * plans via `window.cad.send` (§5.3) — Web/Electron semantic parity is the
 * acceptance criterion (LOCK-004), proven by test/smoke-workspace.mjs
 * against the pinned parity fixture (same save sha as the Web smoke).
 *
 * The legacy drafting/BIM/docs/IFC/components surfaces remain untouched and
 * accessible (mode toggles unchanged) — additive integration only.
 */

import type { Command, CommandQueryResponse, Query } from "@offisos/cad-app-shell/contracts/app-api";
import type { CADDocumentSnapshot, Element, LayerRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import { resolveSnap } from "@offisos/cad-app-shell/drafting/snap";
import { elementToDraftEntity, isDraftingElement, type DraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  describePrompt,
  type PromptEngineState,
} from "@offisos/cad-app-shell/workspace/prompt-engine";
import {
  WORKSPACE_COMMANDS,
  commandById,
  resolveCommand,
  searchCommands,
} from "@offisos/cad-app-shell/workspace/commands";
import {
  applyPickModifier,
  cyclePick,
  gripDrag,
  gripsFor,
  hitTest,
  selectionRectangle,
  windowSelect,
  type EntityPick,
  type GripEditResult,
} from "@offisos/cad-app-shell/workspace";
import { constrainCursor, DEFAULT_DRAFTING_AIDS, formatCoordinate, type DraftingAids } from "@offisos/cad-app-shell/workspace/feedback";
import { mapKeyEvent } from "@offisos/cad-app-shell/workspace/keymap";
import { defaultCommandContext, type CommandContext, type CommandPlan } from "@offisos/cad-app-shell/workspace/types";

export interface ProfessionalOptions {
  /** The app root element (#app). */
  readonly root: HTMLElement;
  /** The <main> element hosting the mode cards. */
  readonly main: HTMLElement;
  /** Transport — the SAME window.cad.send bridge the legacy UI uses. */
  readonly send: (req: Command | Query) => Promise<CommandQueryResponse>;
  /** Current legacy mode ("drafting" | "bim" | "docs" | "ifc" | "components"). */
  readonly getMode: () => string;
  /** Legacy refresh — called after professional-side mutations. */
  readonly onLegacyRefresh: () => void;
}

interface ProState {
  snapshot: CADDocumentSnapshot | null;
  selection: string[];
  engine: PromptEngineState;
  history: string[];
  aids: DraftingAids;
  activeLayer: string;
  activeStoryId: string | null;
  pan: { x: number; y: number };
  zoom: number;
  cursor: Vec2 | null;
  busy: boolean;
  paletteOpen: boolean;
}

const SVG_W = 900;
const SVG_H = 620;

function svgNs(tag: string): SVGElement {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  return e;
}

const PRO_CSS = `
.pro-menubar { display:flex; align-items:center; gap:2px; border-bottom:1px solid var(--border); padding:4px 10px; background:var(--bg); flex-wrap:wrap; }
.pro-menubar .brand { font-weight:700; font-size:12px; margin-right:8px; }
.pro-menu { position:relative; }
.pro-menu > button { border:0; background:transparent; font-size:12px; padding:4px 8px; border-radius:4px; cursor:pointer; }
.pro-menu > button:hover, .pro-menu.open > button { background:#f1f5f9; }
.pro-menu .items { display:none; position:absolute; top:100%; left:0; z-index:60; min-width:210px; background:var(--bg); border:1px solid var(--border); border-radius:6px; box-shadow:0 8px 24px rgba(15,23,42,.12); padding:4px 0; }
.pro-menu.open .items { display:block; }
.pro-menu .items button { display:flex; justify-content:space-between; gap:16px; width:100%; border:0; background:transparent; text-align:left; font-size:12px; padding:6px 12px; cursor:pointer; }
.pro-menu .items button:hover { background:#f1f5f9; }
.pro-menu .items .sep { border-top:1px solid var(--border); margin:4px 0; }
.pro-cmdline { border-top:1px solid var(--border); background:var(--bg); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.pro-cmdline .history { max-height:110px; overflow-y:auto; padding:4px 12px; font-size:11px; color:var(--muted); line-height:1.45; }
.pro-cmdline .prompt { padding:0 12px; font-size:11px; font-weight:600; color:var(--fg); }
.pro-cmdline .entry { display:flex; align-items:center; gap:6px; border-top:1px solid var(--border); padding:4px 10px; }
.pro-cmdline .entry input { flex:1; border:0; outline:none; font-family:inherit; font-size:13px; background:transparent; color:var(--fg); }
.pro-statusbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; border-top:1px solid var(--border); background:var(--bg); padding:3px 12px; font-size:11px; color:var(--muted); }
.pro-statusbar .coord { min-width:140px; font-family:ui-monospace,monospace; }
.pro-statusbar .tog { border:1px solid var(--border); border-radius:4px; background:transparent; font-size:10px; font-weight:700; letter-spacing:.04em; padding:2px 6px; cursor:pointer; color:var(--muted); }
.pro-statusbar .tog.on { background:var(--fg); color:var(--bg); border-color:var(--fg); }
.pro-model-card { border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--bg); }
.pro-model-card header { border-bottom:1px solid var(--border); padding:8px 14px; }
.pro-model-card header h2 { font-size:13px; margin:0; }
.pro-model-card header p { margin:2px 0 0; font-size:11px; color:var(--muted); }
.pro-model-card .body { position:relative; }
.pro-model-card svg { display:block; width:100%; height:auto; background:#fff; touch-action:none; cursor:crosshair; outline:none; }
.pro-model-card svg:focus-visible { outline:2px solid #2563eb; }
.pro-mini { position:absolute; display:flex; gap:2px; background:rgba(255,255,255,.96); border:1px solid var(--border); border-radius:6px; padding:2px; box-shadow:0 4px 12px rgba(15,23,42,.15); z-index:20; }
.pro-mini button { border:0; background:transparent; font-size:11px; padding:3px 8px; border-radius:4px; cursor:pointer; }
.pro-mini button:hover { background:#f1f5f9; }
.pro-palette { position:fixed; inset:0; z-index:100; background:rgba(15,23,42,.32); display:none; align-items:flex-start; justify-content:center; padding-top:11vh; }
.pro-palette.open { display:flex; }
.pro-palette .box { width:min(560px,92vw); background:var(--bg); border:1px solid var(--border); border-radius:10px; box-shadow:0 16px 40px rgba(15,23,42,.25); overflow:hidden; }
.pro-palette .search { display:flex; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--border); }
.pro-palette .search input { flex:1; border:0; outline:none; font-size:13px; }
.pro-palette ul { list-style:none; margin:0; padding:4px 0; max-height:320px; overflow-y:auto; }
.pro-palette li button { display:flex; gap:8px; width:100%; border:0; background:transparent; text-align:left; font-size:12px; padding:6px 14px; cursor:pointer; align-items:baseline; }
.pro-palette li button .name { font-family:ui-monospace,monospace; font-weight:700; }
.pro-palette li button .aliases { color:var(--muted); font-size:10px; }
.pro-palette li button .desc { margin-left:auto; color:var(--muted); font-size:10px; max-width:46%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pro-palette li.sel button, .pro-palette li button:hover { background:#f1f5f9; }
`;

/** Public driver surface (used by test/smoke-workspace.mjs — the SAME code
 *  paths the real input/canvas handlers use). */
export interface ProfessionalDriver {
  typedInput(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  pressEscape(): Promise<void>;
  pickPoint(x: number, y: number): Promise<void>;
  setSelection(ids: string[]): Promise<void>;
  refresh(): Promise<void>;
  commandLog(): string[];
  status(): {
    prompt: string | null;
    commandName: string | null;
    history: string[];
    selection: string[];
    elementCount: number;
    aids: DraftingAids;
  };
}

export function mountProfessionalWorkspace(opts: ProfessionalOptions): ProfessionalDriver {
  const style = h("style");
  style.textContent = PRO_CSS;
  document.head.append(style);

  const state: ProState = {
    snapshot: null,
    selection: [],
    engine: IDLE_PROMPT_STATE,
    history: [],
    aids: { ...DEFAULT_DRAFTING_AIDS },
    activeLayer: "0",
    activeStoryId: null,
    pan: { x: -20, y: -20 },
    zoom: 0.14,
    cursor: null,
    busy: false,
    paletteOpen: false,
  };

  // --- transport helpers -----------------------------------------------------

  const commandLog: string[] = [];
  const command = (name: string, payload: unknown): Promise<CommandQueryResponse> => {
    commandLog.push(name);
    return opts.send({ type: "command", name: name as Command["name"], payload });
  };
  const query = (name: string, payload: unknown = {}): Promise<CommandQueryResponse> =>
    opts.send({ type: "query", name: name as Query["name"], payload });

  async function refresh(): Promise<void> {
    const [stateRes, selRes] = await Promise.all([query("document.getState"), query("document.getSelection")]);
    if (stateRes.ok) state.snapshot = stateRes.value as CADDocumentSnapshot;
    if (selRes.ok && Array.isArray(selRes.value)) state.selection = selRes.value as string[];
    const layers = state.snapshot?.layers ?? [];
    if (!layers.some((l: LayerRecord) => l.id === state.activeLayer)) {
      state.activeLayer = layers[0]?.id ?? "0";
    }
    if (state.activeStoryId === null) {
      const story = (state.snapshot?.elements ?? []).find(
        (el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story",
      );
      if (story !== undefined) state.activeStoryId = story.id;
    }
    renderModel();
    renderCommandLine();
    renderStatusBar();
    opts.onLegacyRefresh();
  }

  // --- engine context + plan execution -----------------------------------------

  function engineContext(): CommandContext {
    const elements = state.snapshot?.elements ?? [];
    const stories = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story");
    return defaultCommandContext({
      activeLayer: state.activeLayer,
      activeStoryId:
        state.activeStoryId ?? (stories.length > 0 ? (stories[stories.length - 1] as Element).id : null),
      elementCount: elements.length,
      storyCount: stories.length,
      currentSelection: elements
        .filter((el) => state.selection.includes(el.id))
        .map((el) => ({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> })),
    });
  }

  async function executePlan(plan: CommandPlan): Promise<void> {
    for (const entry of plan.appApi) {
      state.busy = true;
      const res = await command(entry.name, entry.payload);
      if (!res.ok) {
        pushLines([`*ERROR* ${entry.name}: ${res.code} — ${res.message}`]);
      } else if (entry.name === "bim.createElements") {
        const value = res.value as { created?: string[] } | null;
        if (value !== null && Array.isArray(value.created) && value.created.length > 0) {
          const stateRes = await query("document.getState");
          if (stateRes.ok) {
            const snap = stateRes.value as CADDocumentSnapshot;
            const story = (snap.elements ?? []).find(
              (el) => value.created!.includes(el.id) && el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story",
            );
            if (story !== undefined) state.activeStoryId = story.id;
          }
        }
      }
      state.busy = false;
    }
    for (const action of plan.ui) {
      switch (action.action) {
        case "toggle.ortho":
          state.aids = { ...state.aids, ortho: !state.aids.ortho };
          break;
        case "toggle.polar":
          state.aids = { ...state.aids, polar: !state.aids.polar };
          break;
        case "toggle.otrack":
          state.aids = { ...state.aids, otrack: !state.aids.otrack };
          break;
        case "toggle.grid":
        case "toggle.snap": {
          const key = action.action === "toggle.grid" ? "grid" : "snap";
          const settings = state.snapshot?.draftingSettings;
          const enabled = key === "grid" ? !(settings?.grid.enabled ?? true) : !(settings?.snap.enabled ?? true);
          await command("drafting.setSettings", { [key]: { enabled } });
          break;
        }
        case "view.zoomExtents":
          zoomExtents();
          break;
        case "selection.clear":
          await command("document.setSelection", { ids: [] });
          state.selection = [];
          break;
        case "selection.selectAll": {
          const visible = new Set((state.snapshot?.layers ?? []).filter((l: LayerRecord) => l.visible).map((l: LayerRecord) => l.id));
          const ids = (state.snapshot?.elements ?? [])
            .filter((el) => {
              const props = el.props as Record<string, unknown>;
              if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
              return typeof props.layer === "string" && visible.has(props.layer);
            })
            .map((el) => el.id);
          await command("document.setSelection", { ids });
          state.selection = ids;
          break;
        }
        case "file.new":
          await command("document.create", { entityId: `electron-workspace-${Date.now().toString(36)}` });
          state.activeStoryId = null;
          break;
        case "file.save": {
          const res = await command("document.save", {});
          if (res.ok) pushLines(["SAVE: document saved through the App API."]);
          break;
        }
        case "palette.show": {
          const palette = (action.payload as { palette?: string } | undefined)?.palette;
          if (palette === "search") openPalette(true);
          else if (palette === "layers" || palette === "navigator" || palette === "properties") {
            pushLines([`${palette.toUpperCase()} palette: available in the Web host dock; Electron keeps the legacy side panels.`]);
          }
          break;
        }
        default:
          break;
      }
    }
    await refresh();
  }

  function pushLines(lines: readonly string[]): void {
    state.history = [...state.history, ...lines];
  }

  async function dispatchEngine(event: Parameters<typeof applyPromptEvent>[1]): Promise<void> {
    const result = applyPromptEvent(state.engine, event, engineContext());
    state.engine = result.state;
    if (result.output.lines.length > 0) pushLines(result.output.lines);
    renderCommandLine();
    renderModel();
    if (result.output.plan !== null) await executePlan(result.output.plan);
  }

  async function startCommand(commandId: string): Promise<void> {
    await dispatchEngine({ type: "start", commandId });
  }

  // --- menu bar -------------------------------------------------------------------

  const menuBar = h("div", "pro-menubar");
  menuBar.setAttribute("role", "menubar");
  menuBar.setAttribute("aria-label", "application menu");
  const brand = h("span", "brand");
  brand.textContent = "Offisos";
  menuBar.append(brand);

  interface MenuSpec {
    label: string;
    items: readonly { label: string; run: () => void }[];
  }
  const setDraftingMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-drafting"]');
    if (btn !== null) btn.click();
  };
  const setBimMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-bim"]');
    if (btn !== null) btn.click();
  };
  const setDocsMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-docs"]');
    if (btn !== null) btn.click();
  };
  const setIfcMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-ifc"]');
    if (btn !== null) btn.click();
  };
  const setComponentsMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-components"]');
    if (btn !== null) btn.click();
  };
  const runCmd = (id: string) => (): void => {
    void startCommand(id);
  };

  const menus: readonly MenuSpec[] = [
    {
      label: "File",
      items: [
        { label: "New", run: () => void command("document.create", { entityId: `electron-workspace-${Date.now().toString(36)}` }).then(refresh) },
        { label: "Save", run: runCmd("save") },
        { label: "Undo", run: runCmd("undo") },
        { label: "Redo", run: runCmd("redo") },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", run: runCmd("undo") },
        { label: "Redo", run: runCmd("redo") },
        { label: "Erase selection", run: runCmd("erase") },
        { label: "Select all", run: runCmd("selectall") },
        { label: "Deselect", run: runCmd("cancel") },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Drafting (Model)", run: setDraftingMode },
        { label: "BIM", run: setBimMode },
        { label: "Documentation", run: setDocsMode },
        { label: "IFC", run: setIfcMode },
        { label: "Components", run: setComponentsMode },
        { label: "Zoom extents", run: runCmd("zoomextents") },
      ],
    },
    { label: "Insert", items: [{ label: "Door", run: runCmd("door") }, { label: "Window", run: runCmd("window") }, { label: "Slab", run: runCmd("slab") }] },
    { label: "Annotate", items: [{ label: "Linear dimension", run: runCmd("dimlinear") }, { label: "Radius dimension", run: runCmd("dimradius") }] },
    { label: "BIM", items: [{ label: "Story", run: runCmd("story") }, { label: "Wall", run: runCmd("wall") }, { label: "Slab", run: runCmd("slab") }, { label: "Door", run: runCmd("door") }, { label: "Window", run: runCmd("window") }] },
    { label: "Help", items: [{ label: "Command palette", run: () => openPalette(true) }] },
  ];

  for (const spec of menus) {
    const menu = h("div", "pro-menu");
    menu.setAttribute("role", "menu");
    const button = h("button");
    button.type = "button";
    button.textContent = spec.label;
    button.setAttribute("aria-haspopup", "menu");
    const items = h("div", "items");
    for (const item of spec.items) {
      const ib = h("button");
      ib.type = "button";
      ib.textContent = item.label;
      ib.addEventListener("click", () => {
        menu.classList.remove("open");
        item.run();
      });
      items.append(ib);
    }
    button.addEventListener("click", () => {
      document.querySelectorAll(".pro-menu.open").forEach((m) => m.classList.remove("open"));
      menu.classList.toggle("open");
    });
    menu.append(button, items);
    menuBar.append(menu);
  }
  const searchButton = h("button");
  searchButton.type = "button";
  searchButton.textContent = "Search (Ctrl+K)";
  searchButton.style.cssText = "margin-left:auto;border:1px solid var(--border);border-radius:4px;background:transparent;font-size:11px;padding:3px 8px;cursor:pointer;";
  searchButton.addEventListener("click", () => openPalette(true));
  menuBar.append(searchButton);

  opts.root.insertBefore(menuBar, opts.root.firstChild);

  // --- Model canvas (drafting mode card) ---------------------------------------------

  const modelCard = h("div", "pro-model-card");
  modelCard.setAttribute("data-testid", "pro-model-card");
  const modelHead = h("header");
  const modelTitle = h("h2");
  modelTitle.textContent = "Model — command-driven plan viewport";
  const modelDesc = h("p");
  modelDesc.textContent = "Command line + canvas parity surface: crosshair, snaps, ortho/polar, window/crossing selection, cycling, grips. Every pick and typed entry flows through the shared prompt engine.";
  modelHead.append(modelTitle, modelDesc);
  modelCard.append(modelHead);
  const modelBody = h("div", "body");
  const svg = svgNs("svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${SVG_W} ${SVG_H}`);
  svg.setAttribute("role", "application");
  svg.setAttribute("aria-label", "Offisos Model viewport — 2D drafting and BIM plan canvas");
  svg.setAttribute("tabindex", "0");
  svg.setAttribute("data-testid", "pro-model-svg");
  modelBody.append(svg);
  modelCard.append(modelBody);
  opts.main.insertBefore(modelCard, opts.main.firstChild);

  const miniToolbar = h("div", "pro-mini");
  miniToolbar.style.display = "none";
  miniToolbar.setAttribute("role", "toolbar");
  miniToolbar.setAttribute("aria-label", "selection actions");
  modelBody.append(miniToolbar);
  const miniMove = h("button");
  miniMove.textContent = "Move";
  const miniCopy = h("button");
  miniCopy.textContent = "Copy";
  const miniErase = h("button");
  miniErase.textContent = "Erase";
  const miniDeselect = h("button");
  miniDeselect.textContent = "Deselect";
  miniToolbar.append(miniMove, miniCopy, miniErase, miniDeselect);
  miniMove.addEventListener("click", () => void startCommand("move"));
  miniCopy.addEventListener("click", () => void startCommand("copy"));
  miniErase.addEventListener("click", () => void startCommand("erase"));
  miniDeselect.addEventListener("click", () => {
    void command("document.setSelection", { ids: [] }).then(() => {
      state.selection = [];
      renderModel();
    });
  });

  // --- view transform ------------------------------------------------------------------

  const toScreen = (p: Vec2): [number, number] => [(p[0] - state.pan.x) * state.zoom, SVG_H - (p[1] - state.pan.y) * state.zoom];
  const toWorld = (sx: number, sy: number): Vec2 => [sx / state.zoom + state.pan.x, (SVG_H - sy) / state.zoom + state.pan.y];

  function zoomExtents(): void {
    const elements = state.snapshot?.elements ?? [];
    if (elements.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of elements) {
      const entity = parseEntity(el);
      const pts: Vec2[] = [];
      if (entity !== null) {
        if (entity.type === "line") pts.push(entity.from, entity.to);
        else if (entity.type === "polyline") pts.push(...entity.points);
        else if (entity.type === "circle") {
          pts.push([entity.center[0] - entity.radius, entity.center[1] - entity.radius], [entity.center[0] + entity.radius, entity.center[1] + entity.radius]);
        } else if (entity.type === "rectangle") pts.push(entity.corner1, entity.corner2);
      } else {
        const props = el.props as Record<string, unknown>;
        if (props.type === "bim.wall" && Array.isArray(props.start) && Array.isArray(props.end)) {
          pts.push(props.start as unknown as Vec2, props.end as unknown as Vec2);
        } else if (props.type === "bim.slab" && Array.isArray(props.corner1) && Array.isArray(props.corner2)) {
          pts.push(props.corner1 as unknown as Vec2, props.corner2 as unknown as Vec2);
        } else if (props.type === "bim.story") {
          continue;
        } else {
          continue;
        }
      }
      for (const p of pts) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return;
    const pad = 800;
    const w = Math.max(maxX - minX + pad * 2, 1);
    const h = Math.max(maxY - minY + pad * 2, 1);
    state.zoom = Math.min(SVG_W / w, SVG_H / h);
    state.pan = { x: minX - pad - (SVG_W / state.zoom - w) / 2, y: minY - pad - (SVG_H / state.zoom - h) / 2 };
    renderModel();
  }

  function parseEntity(el: Element): DraftEntity | null {
    if (!isDraftingElement(el)) return null;
    try {
      return elementToDraftEntity(el);
    } catch {
      return null;
    }
  }

  // --- visible entities ------------------------------------------------------------------

  function visibleElements(): Element[] {
    const visible = new Set((state.snapshot?.layers ?? []).filter((l: LayerRecord) => l.visible).map((l: LayerRecord) => l.id));
    return (state.snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      return typeof props.layer === "string" && visible.has(props.layer);
    });
  }

  function constrainSnap(world: Vec2, shift: boolean): { point: Vec2; snapped: boolean } {
    const cmd = commandById(state.engine.commandId ?? "");
    const step = cmd !== null && cmd.steps.length > 0 ? (cmd.steps[state.engine.stepIndex] ?? null) : null;
    let base: Vec2 | null = state.engine.lastPoint;
    if (step !== null && step.baseStep !== undefined) {
      const v = state.engine.values[step.baseStep];
      if (v !== undefined && v.kind === "point") base = v.point;
    }
    const aids: DraftingAids = shift ? { ...state.aids, ortho: true } : state.aids;
    const constrained = constrainCursor(base, world, aids).point;
    const settings = state.snapshot?.draftingSettings;
    if (settings?.snap.enabled !== true) return { point: constrained, snapped: false };
    const r = resolveSnap({
      point: constrained,
      tolerance: settings.snap.tolerance,
      kinds: settings.snap.kinds,
      gridSize: settings.grid.size,
      entities: visibleElements(),
    });
    if (r.best === null) return { point: constrained, snapped: false };
    return { point: [r.best.point[0], r.best.point[1]], snapped: true };
  }

  // --- canvas pointer interaction ------------------------------------------------------------

  let dragKind: "pan" | "selection" | null = null;
  let dragStart: Vec2 = [0, 0];
  let dragStartScreen: [number, number] = [0, 0];
  let dragPan = { x: 0, y: 0 };
  let selRect: { a: Vec2; b: Vec2 } | null = null;
  let lastClick: { screen: [number, number]; at: number; index: number } | null = null;
  let gripDragState: { id: string; element: Element } | null = null;

  function svgPoint(e: MouseEvent): Vec2 {
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * SVG_W;
    const sy = ((e.clientY - rect.top) / rect.height) * SVG_H;
    return toWorld(sx, sy);
  }

  svg.addEventListener("mousedown", (e) => {
    svg.focus();
    const world = svgPoint(e);
    if (e.button === 1) {
      dragKind = "pan";
      const rect0 = svg.getBoundingClientRect();
      dragStartScreen = [((e.clientX - rect0.left) / rect0.width) * SVG_W, ((e.clientY - rect0.top) / rect0.height) * SVG_H];
      dragPan = { ...state.pan };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    // Grip drag start.
    const cmd = commandById(state.engine.commandId ?? "");
    const stepActive = cmd !== null && cmd.steps.length > 0;
    if (!stepActive && state.selection.length === 1) {
      const el = (state.snapshot?.elements ?? []).find((x) => x.id === state.selection[0]);
      if (el !== undefined) {
        for (const grip of gripsFor(el)) {
          const gs = toScreen(grip.point);
          const rect = svg.getBoundingClientRect();
          const px = (gs[0] / SVG_W) * rect.width + rect.left;
          const py = (gs[1] / SVG_H) * rect.height + rect.top;
          if (Math.hypot(px - e.clientX, py - e.clientY) <= 8) {
            gripDragState = { id: grip.id, element: el };
            e.preventDefault();
            return;
          }
        }
      }
    }

    if (stepActive && cmd !== null) {
      const step = cmd.steps[state.engine.stepIndex] ?? null;
      if (step !== null && step.kind === "entity") {
        const hits = hitTest(world, 8 / state.zoom, visibleElements());
        const hit = hits.length > 0 ? (state.snapshot?.elements ?? []).find((el) => el.id === hits[0]!.id) : undefined;
        if (hit !== undefined) {
          void dispatchEngine({ type: "entity", entity: { id: hit.id, kind: hit.kind, props: hit.props as Record<string, unknown> } });
        }
        return;
      }
      const { point } = constrainSnap(world, e.shiftKey);
      void dispatchEngine({ type: "pick", point });
      return;
    }

    // Selection mode.
    const hits = hitTest(world, 8 / state.zoom, visibleElements());
    if (hits.length > 0) {
      const now = Date.now();
      let chosen = hits[0]!.id;
      let index = 0;
      if (lastClick !== null && now - lastClick.at < 700) {
        const cycled = cyclePick(world, 8 / state.zoom, visibleElements(), lastClick.index);
        if (cycled !== null) {
          chosen = cycled.id;
          index = cycled.index;
        }
      }
      lastClick = { screen: [e.clientX, e.clientY], at: now, index };
      const next = applyPickModifier(state.selection, chosen, e.shiftKey ? "toggle" : "replace");
      void command("document.setSelection", { ids: next }).then(() => {
        state.selection = [...next];
        renderModel();
      });
      return;
    }
    lastClick = null;
    dragKind = "selection";
    dragStart = world;
    selRect = { a: world, b: world };
    renderModel();
  });

  svg.addEventListener("mousemove", (e) => {
    const world = svgPoint(e);
    state.cursor = world;
    if (dragKind === "pan") {
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * SVG_W;
      const sy = ((e.clientY - rect.top) / rect.height) * SVG_H;
      state.pan = {
        x: dragPan.x - (sx - dragStartScreen[0]) / state.zoom,
        y: dragPan.y + (sy - dragStartScreen[1]) / state.zoom,
      };
      renderModel();
      return;
    }
    if (dragKind === "selection" && selRect !== null) {
      selRect = { a: dragStart, b: world };
      renderModel();
      return;
    }
    renderModel();
    renderStatusBar();
  });

  svg.addEventListener("mouseup", (e) => {
    if (dragKind === "pan") {
      dragKind = null;
      return;
    }
    if (dragKind === "selection" && selRect !== null) {
      const rect = selectionRectangle(selRect.a, selRect.b);
      const moved = Math.hypot(selRect.b[0] - selRect.a[0], selRect.b[1] - selRect.a[1]);
      dragKind = null;
      selRect = null;
      if (moved < 4 / state.zoom) {
        if (state.selection.length > 0) {
          void command("document.setSelection", { ids: [] }).then(() => {
            state.selection = [];
            renderModel();
          });
        }
        return;
      }
      const ids = windowSelect(rect, visibleElements());
      const next = e.shiftKey ? Array.from(new Set([...state.selection, ...ids])) : ids;
      void command("document.setSelection", { ids: next }).then(() => {
        state.selection = [...next];
        renderModel();
      });
      return;
    }
    if (gripDragState !== null) {
      const world = svgPoint(e);
      const snapped = constrainSnap(world, e.shiftKey).point;
      const result: GripEditResult | null = gripDrag(gripDragState.element, gripDragState.id, snapped);
      gripDragState = null;
      if (result !== null && result.appApi.length > 0) {
        pushLines(result.echo);
        void (async () => {
          for (const entry of result.appApi) {
            await command(entry.name, entry.payload);
          }
          await refresh();
        })();
      }
    }
  });

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.zoom = Math.min(20, Math.max(0.005, state.zoom * factor));
    renderModel();
  }, { passive: false });

  svg.addEventListener("dblclick", () => {
    void dispatchEngine({ type: "enter" });
  });

  // --- model rendering -----------------------------------------------------------------------

  function renderModel(): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const settings = state.snapshot?.draftingSettings;
    if (settings?.grid.enabled === true && settings.grid.size > 0) {
      const size = settings.grid.size * Math.max(1, Math.round(10 / (settings.grid.size * state.zoom)));
      const startX = Math.floor(state.pan.x / size) * size;
      const startY = Math.floor(state.pan.y / size) * size;
      for (let x = startX; x <= state.pan.x + SVG_W / state.zoom; x += size) {
        const l = svgNs("line");
        const [sx] = toScreen([x, 0]);
        l.setAttribute("x1", String(sx)); l.setAttribute("y1", "0");
        l.setAttribute("x2", String(sx)); l.setAttribute("y2", String(SVG_H));
        l.setAttribute("stroke", "#e5e7eb");
        svg.append(l);
      }
      for (let y = startY; y <= state.pan.y + SVG_H / state.zoom; y += size) {
        const l = svgNs("line");
        const [, sy] = toScreen([0, y]);
        l.setAttribute("x1", "0"); l.setAttribute("y1", String(sy));
        l.setAttribute("x2", String(SVG_W)); l.setAttribute("y2", String(sy));
        l.setAttribute("stroke", "#e5e7eb");
        svg.append(l);
      }
    }

    const selectedSet = new Set(state.selection);
    const layerById = new Map<string, LayerRecord>((state.snapshot?.layers ?? []).map((l: LayerRecord) => [l.id, l] as const));

    for (const el of visibleElements()) {
      const selected = selectedSet.has(el.id);
      const entity = parseEntity(el);
      if (entity !== null) {
        const layer = layerById.get(entity.layer);
        const color = selected ? "#0ea5e9" : (layer?.color ?? "#111827");
        const g = svgNs("g");
        g.setAttribute("stroke", color);
        g.setAttribute("fill", "none");
        g.setAttribute("stroke-width", selected ? "2.4" : "1.6");
        if (entity.type === "line") {
          const a = toScreen(entity.from);
          const b = toScreen(entity.to);
          const l = svgNs("line");
          l.setAttribute("x1", String(a[0])); l.setAttribute("y1", String(a[1]));
          l.setAttribute("x2", String(b[0])); l.setAttribute("y2", String(b[1]));
          g.append(l);
        } else if (entity.type === "polyline") {
          const pl = svgNs("polyline");
          pl.setAttribute("points", entity.points.map((p) => toScreen(p).join(",")).join(" "));
          g.append(pl);
        } else if (entity.type === "circle") {
          const c = toScreen(entity.center);
          const circle = svgNs("circle");
          circle.setAttribute("cx", String(c[0]));
          circle.setAttribute("cy", String(c[1]));
          circle.setAttribute("r", String(entity.radius * state.zoom));
          g.append(circle);
        } else if (entity.type === "arc") {
          const c = toScreen(entity.center);
          const arc = svgNs("path");
          const sweep = entity.endAngle - entity.startAngle;
          const p0: Vec2 = [entity.center[0] + entity.radius * Math.cos(entity.startAngle), entity.center[1] + entity.radius * Math.sin(entity.startAngle)];
          const p1: Vec2 = [entity.center[0] + entity.radius * Math.cos(entity.endAngle), entity.center[1] + entity.radius * Math.sin(entity.endAngle)];
          const s0 = toScreen(p0);
          const s1 = toScreen(p1);
          arc.setAttribute("d", `M ${s0[0]} ${s0[1]} A ${entity.radius * state.zoom} ${entity.radius * state.zoom} 0 ${sweep > Math.PI ? 1 : 0} 1 ${s1[0]} ${s1[1]}`);
          g.append(arc);
        } else if (entity.type === "rectangle") {
          const a = toScreen(entity.corner1);
          const b = toScreen(entity.corner2);
          const r = svgNs("rect");
          r.setAttribute("x", String(Math.min(a[0], b[0])));
          r.setAttribute("y", String(Math.min(a[1], b[1])));
          r.setAttribute("width", String(Math.abs(b[0] - a[0])));
          r.setAttribute("height", String(Math.abs(b[1] - a[1])));
          g.append(r);
        } else if (entity.type === "dim-linear") {
          const a = toScreen(entity.p1);
          const b = toScreen(entity.p2);
          const l = svgNs("line");
          l.setAttribute("x1", String(a[0])); l.setAttribute("y1", String(a[1]));
          l.setAttribute("x2", String(b[0])); l.setAttribute("y2", String(b[1]));
          l.setAttribute("stroke-dasharray", "4 3");
          g.append(l);
          const t = svgNs("text");
          t.setAttribute("x", String((a[0] + b[0]) / 2 + 4));
          t.setAttribute("y", String((a[1] + b[1]) / 2 - 4));
          t.setAttribute("fill", "#374151");
          t.setAttribute("font-size", "11");
          t.setAttribute("font-family", "ui-monospace, monospace");
          t.textContent = entity.measured.toFixed(1);
          g.append(t);
        } else if (entity.type === "dim-radius") {
          const t = svgNs("text");
          t.setAttribute("x", "10");
          t.setAttribute("y", "18");
          t.setAttribute("fill", "#374151");
          t.setAttribute("font-size", "11");
          t.setAttribute("font-family", "ui-monospace, monospace");
          t.textContent = `R${entity.measured.toFixed(2)} → ${entity.target}`;
          g.append(t);
        }
        svg.append(g);
        continue;
      }

      // BIM plan footprints.
      const props = el.props as Record<string, unknown>;
      if (props.type === "bim.wall" && Array.isArray(props.start) && Array.isArray(props.end) && typeof props.width === "number") {
        const start = props.start as unknown as Vec2;
        const end = props.end as unknown as Vec2;
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const half = (props.width as number) / 2;
        const corners: Vec2[] = [
          [start[0] + nx * half, start[1] + ny * half],
          [end[0] + nx * half, end[1] + ny * half],
          [end[0] - nx * half, end[1] - ny * half],
          [start[0] - nx * half, start[1] - ny * half],
        ];
        const poly = svgNs("polygon");
        poly.setAttribute("points", corners.map((p) => toScreen(p).join(",")).join(" "));
        poly.setAttribute("fill", selected ? "rgba(14,165,233,.28)" : "rgba(120,113,108,.16)");
        poly.setAttribute("stroke", selected ? "#0ea5e9" : "#57534e");
        poly.setAttribute("stroke-width", selected ? "2.2" : "1.4");
        svg.append(poly);
      } else if (props.type === "bim.slab" && Array.isArray(props.corner1) && Array.isArray(props.corner2)) {
        const a = toScreen(props.corner1 as unknown as Vec2);
        const b = toScreen(props.corner2 as unknown as Vec2);
        const r = svgNs("rect");
        r.setAttribute("x", String(Math.min(a[0], b[0])));
        r.setAttribute("y", String(Math.min(a[1], b[1])));
        r.setAttribute("width", String(Math.abs(b[0] - a[0])));
        r.setAttribute("height", String(Math.abs(b[1] - a[1])));
        r.setAttribute("fill", selected ? "rgba(14,165,233,.15)" : "rgba(161,98,7,.10)");
        r.setAttribute("stroke", selected ? "#0ea5e9" : "#a16207");
        svg.append(r);
      }
    }

    // Rubber band for the active point step.
    const cmd = commandById(state.engine.commandId ?? "");
    if (cmd !== null && state.cursor !== null && cmd.steps.length > 0) {
      const step = cmd.steps[state.engine.stepIndex] ?? null;
      if (step !== null && (step.kind === "point" || step.kind === "distance" || step.kind === "displacement") && state.engine.lastPoint !== null) {
        const from = toScreen(state.engine.lastPoint);
        const to = toScreen(constrainSnap(state.cursor, false).point);
        const l = svgNs("line");
        l.setAttribute("x1", String(from[0])); l.setAttribute("y1", String(from[1]));
        l.setAttribute("x2", String(to[0])); l.setAttribute("y2", String(to[1]));
        l.setAttribute("stroke", "#f59e0b");
        l.setAttribute("stroke-dasharray", "6 4");
        l.setAttribute("stroke-width", "1.4");
        svg.append(l);
        const snapPoint = constrainSnap(state.cursor, false);
        if (snapPoint.snapped) {
          const m = svgNs("rect");
          const s = toScreen(snapPoint.point);
          m.setAttribute("x", String(s[0] - 5)); m.setAttribute("y", String(s[1] - 5));
          m.setAttribute("width", "10"); m.setAttribute("height", "10");
          m.setAttribute("fill", "none");
          m.setAttribute("stroke", "#0d9488");
          m.setAttribute("stroke-width", "1.6");
          svg.append(m);
        }
      }
    }

    // Selection rectangle.
    if (selRect !== null) {
      const a = toScreen(selRect.a);
      const b = toScreen(selRect.b);
      const mode = selRect.b[0] >= selRect.a[0] ? "window" : "crossing";
      const r = svgNs("rect");
      r.setAttribute("x", String(Math.min(a[0], b[0])));
      r.setAttribute("y", String(Math.min(a[1], b[1])));
      r.setAttribute("width", String(Math.abs(b[0] - a[0])));
      r.setAttribute("height", String(Math.abs(b[1] - a[1])));
      r.setAttribute("fill", mode === "window" ? "rgba(37,99,235,.07)" : "rgba(22,163,74,.07)");
      r.setAttribute("stroke", mode === "window" ? "#2563eb" : "#16a34a");
      r.setAttribute("stroke-dasharray", mode === "crossing" ? "5 3" : "");
      svg.append(r);
    }

    // Grips for the single selection.
    if (state.selection.length === 1) {
      const el = (state.snapshot?.elements ?? []).find((x) => x.id === state.selection[0]);
      if (el !== undefined) {
        for (const grip of gripsFor(el)) {
          const s = toScreen(grip.point);
          const r = svgNs("rect");
          r.setAttribute("x", String(s[0] - 4)); r.setAttribute("y", String(s[1] - 4));
          r.setAttribute("width", "8"); r.setAttribute("height", "8");
          r.setAttribute("fill", "#fff");
          r.setAttribute("stroke", "#2563eb");
          r.setAttribute("stroke-width", "1.2");
          svg.append(r);
        }
        // Mini-toolbar near the selection.
        const grips = gripsFor(el);
        if (grips.length > 0) {
          const s = toScreen(grips[0]!.point);
          miniToolbar.style.display = "flex";
          miniToolbar.style.left = `${Math.max(4, (s[0] / SVG_W) * 100)}%`;
          miniToolbar.style.top = `${Math.max(2, (s[1] / SVG_H) * 100 - 8)}%`;
        }
      }
    } else {
      miniToolbar.style.display = "none";
    }

    // Crosshair.
    if (state.cursor !== null) {
      const s = toScreen(state.cursor);
      const lx = svgNs("line");
      lx.setAttribute("x1", String(s[0])); lx.setAttribute("y1", "0");
      lx.setAttribute("x2", String(s[0])); lx.setAttribute("y2", String(SVG_H));
      lx.setAttribute("stroke", "rgba(37,99,235,.5)");
      lx.setAttribute("stroke-width", "1");
      const ly = svgNs("line");
      ly.setAttribute("x1", "0"); ly.setAttribute("y1", String(s[1]));
      ly.setAttribute("x2", String(SVG_W)); ly.setAttribute("y2", String(s[1]));
      ly.setAttribute("stroke", "rgba(37,99,235,.5)");
      ly.setAttribute("stroke-width", "1");
      svg.append(lx, ly);
    }
  }

  // --- command line + status bar ------------------------------------------------------------

  const cmdLine = h("div", "pro-cmdline");
  cmdLine.setAttribute("data-testid", "pro-command-line");
  const history = h("div", "history");
  history.setAttribute("data-testid", "pro-command-history");
  history.setAttribute("aria-live", "polite");
  const prompt = h("div", "prompt");
  prompt.setAttribute("data-testid", "pro-command-prompt");
  const entry = h("div", "entry");
  const promptChar = h("span");
  promptChar.textContent = "▸";
  promptChar.style.color = "var(--muted)";
  const input = h("input");
  input.setAttribute("type", "text");
  input.setAttribute("aria-label", "command input");
  input.setAttribute("data-testid", "pro-command-input");
  input.setAttribute("placeholder", "Type a command or alias (L, C, WA, ST…) — Ctrl+K searches");
  entry.append(promptChar, input);
  cmdLine.append(history, prompt, entry);

  const statusBar = h("div", "pro-statusbar");
  statusBar.setAttribute("role", "status");
  statusBar.setAttribute("data-testid", "pro-status-bar");
  const coord = h("span", "coord");
  coord.setAttribute("data-testid", "pro-coordinate-readout");
  const toggleButtons = new Map<string, HTMLButtonElement>();
  const makeToggle = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = h("button", "tog");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    statusBar.append(b);
    toggleButtons.set(label, b);
    return b;
  };
  makeToggle("SNAP", "Grid snap stepping (F9)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.snap" }], echo: [] }));
  makeToggle("GRID", "Grid display (F7)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.grid" }], echo: [] }));
  makeToggle("ORTHO", "Orthogonal constraint (F8)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.ortho" }], echo: [] }));
  makeToggle("POLAR", "Polar tracking (F10)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.polar" }], echo: [] }));
  makeToggle("OTRACK", "Object tracking (F11)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.otrack" }], echo: [] }));
  const info = h("span");
  info.style.marginLeft = "auto";
  statusBar.append(coord, info);

  document.body.append(cmdLine, statusBar);

  function renderCommandLine(): void {
    while (history.firstChild) history.removeChild(history.firstChild);
    const MAX = 400;
    const lines = state.history.slice(-MAX);
    for (const line of lines) {
      const d = h("div");
      d.textContent = line;
      history.append(d);
    }
    history.scrollTop = history.scrollHeight;
    const described = describePrompt(state.engine);
    prompt.textContent = described.prompt !== null ? `${described.commandName !== null ? described.commandName + ": " : ""}${described.prompt}` : "";
  }

  function renderStatusBar(): void {
    coord.textContent = state.cursor !== null ? formatCoordinate(state.cursor) : "—";
    const settings = state.snapshot?.draftingSettings;
    const snapOn = toggleButtons.get("SNAP");
    if (snapOn !== undefined) snapOn.classList.toggle("on", settings?.snap.enabled ?? true);
    const gridOn = toggleButtons.get("GRID");
    if (gridOn !== undefined) gridOn.classList.toggle("on", settings?.grid.enabled ?? true);
    const orthoOn = toggleButtons.get("ORTHO");
    if (orthoOn !== undefined) orthoOn.classList.toggle("on", state.aids.ortho);
    const polarOn = toggleButtons.get("POLAR");
    if (polarOn !== undefined) polarOn.classList.toggle("on", state.aids.polar);
    const otrackOn = toggleButtons.get("OTRACK");
    if (otrackOn !== undefined) otrackOn.classList.toggle("on", state.aids.otrack);
    const elements = state.snapshot?.elements ?? [];
    const story = elements.find((el) => el.id === state.activeStoryId);
    const storyName = story !== undefined ? ((story.props as Record<string, unknown>).name as string | undefined) ?? "—" : "—";
    info.textContent = `Layer ${state.activeLayer} · Story ${storyName} · Sel ${state.selection.length} · v${state.snapshot?.version?.version_number ?? 0} · ${settings?.units ?? "mm"}`;
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const text = input.value.trim();
      input.value = "";
      void dispatchEngine(text.length === 0 ? { type: "enter" } : { type: "typed", text, cursor: state.cursor });
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      void dispatchEngine({ type: "cancel" });
    }
  });

  // --- command palette --------------------------------------------------------------------------

  const palette = h("div", "pro-palette");
  palette.setAttribute("role", "dialog");
  palette.setAttribute("aria-modal", "true");
  palette.setAttribute("aria-label", "Command search");
  palette.setAttribute("data-testid", "pro-command-palette");
  const paletteBox = h("div", "box");
  const paletteSearch = h("div", "search");
  const paletteInput = h("input");
  paletteInput.setAttribute("type", "text");
  paletteInput.setAttribute("aria-label", "command search input");
  paletteInput.setAttribute("placeholder", "Search commands by name, alias or description…");
  const paletteList = h("ul");
  paletteList.setAttribute("role", "listbox");
  paletteSearch.append(paletteInput);
  paletteBox.append(paletteSearch, paletteList);
  palette.append(paletteBox);
  document.body.append(palette);

  let paletteIndex = 0;
  function renderPalette(): void {
    const hits = searchCommands(paletteInput.value).slice(0, 40);
    while (paletteList.firstChild) paletteList.removeChild(paletteList.firstChild);
    hits.forEach((hit, i) => {
      const li = h("li");
      if (i === paletteIndex) li.className = "sel";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === paletteIndex));
      const b = h("button");
      b.type = "button";
      const name = h("span", "name");
      name.textContent = hit.command.name;
      const aliases = h("span", "aliases");
      aliases.textContent = hit.command.aliases.filter((a) => a !== hit.command.name).join(", ");
      const desc = h("span", "desc");
      desc.textContent = hit.command.description;
      b.append(name, aliases, desc);
      b.addEventListener("click", () => {
        openPalette(false);
        void startCommand(hit.command.id);
      });
      li.append(b);
      paletteList.append(li);
    });
  }

  function openPalette(open: boolean): void {
    state.paletteOpen = open;
    palette.classList.toggle("open", open);
    if (open) {
      paletteInput.value = "";
      paletteIndex = 0;
      renderPalette();
      paletteInput.focus();
    }
  }
  palette.addEventListener("click", (e) => {
    if (e.target === palette) openPalette(false);
  });
  paletteInput.addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette();
  });
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      openPalette(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      paletteIndex = Math.min(39, paletteIndex + 1);
      renderPalette();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      paletteIndex = Math.max(0, paletteIndex - 1);
      renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = searchCommands(paletteInput.value).slice(0, 40)[paletteIndex];
      if (hit !== undefined) {
        openPalette(false);
        void startCommand(hit.command.id);
      }
    }
  });

  // --- global keyboard (shared keymap) --------------------------------------------------------------

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (state.paletteOpen && !inInput) {
      if (e.key === "Escape") openPalette(false);
      return;
    }
    const action = mapKeyEvent(
      { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey },
      inInput ? "commandLine" : "canvas",
    );
    if (action === null) return;
    e.preventDefault();
    switch (action.type) {
      case "command":
        void startCommand(action.commandId);
        break;
      case "toggle":
        if (action.aid === "ortho" || action.aid === "polar" || action.aid === "otrack") {
          state.aids = { ...state.aids, [action.aid]: !state.aids[action.aid] };
          renderStatusBar();
        } else if (action.aid === "grid" || action.aid === "snap") {
          void executePlan({ appApi: [], ui: [{ action: `toggle.${action.aid}` }], echo: [] });
        }
        break;
      case "palette":
        if (action.palette === "search") openPalette(true);
        break;
      case "cancel":
        if (state.engine.commandId !== null) void dispatchEngine({ type: "cancel" });
        else if (state.selection.length > 0) {
          void command("document.setSelection", { ids: [] }).then(() => {
            state.selection = [];
            renderModel();
          });
        }
        break;
      case "enter":
        void dispatchEngine({ type: "enter" });
        break;
      case "zoomExtents":
        zoomExtents();
        break;
      case "selectionAll":
        void executePlan({ appApi: [], ui: [{ action: "selection.selectAll" }], echo: [] });
        break;
      default:
        break;
    }
  });

  // --- mode visibility (the professional Model card shows in drafting mode) --------------------------

  function syncMode(): void {
    const drafting = opts.getMode() === "drafting";
    modelCard.style.display = drafting ? "" : "none";
  }
  const modeObserver = new MutationObserver(syncMode);
  modeObserver.observe(opts.root, { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
  syncMode();

  // --- boot + driver ---------------------------------------------------------------------------------

  void refresh();

  const driver: ProfessionalDriver = {
    async typedInput(text: string): Promise<void> {
      await dispatchEngine(text.length === 0 ? { type: "enter" } : { type: "typed", text, cursor: state.cursor });
    },
    async pressEnter(): Promise<void> {
      await dispatchEngine({ type: "enter" });
    },
    async pressEscape(): Promise<void> {
      await dispatchEngine({ type: "cancel" });
    },
    async pickPoint(x: number, y: number): Promise<void> {
      state.cursor = [x, y];
      const { point } = constrainSnap([x, y], false);
      await dispatchEngine({ type: "pick", point });
    },
    async setSelection(ids: string[]): Promise<void> {
      await command("document.setSelection", { ids });
      state.selection = [...ids];
      renderModel();
    },
    async refresh(): Promise<void> {
      await refresh();
    },
    commandLog(): string[] {
      return [...commandLog];
    },
    status() {
      const described = describePrompt(state.engine);
      return {
        prompt: described.prompt,
        commandName: described.commandName,
        history: [...state.history],
        selection: [...state.selection],
        elementCount: state.snapshot?.elements.length ?? 0,
        aids: { ...state.aids },
      };
    },
  };
  (window as unknown as { __offisosWorkspace: ProfessionalDriver }).__offisosWorkspace = driver;

  return driver;
}

export { resolveCommand, WORKSPACE_COMMANDS };
