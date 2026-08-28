/**
 * CAD-PARITY-004 command registry extension (Issue #80) — the layers,
 * properties, styles & palettes vocabulary (CAD-2D-004).
 *
 * Commands:
 *  - CHPROP — change display properties of a selection through the typed
 *    command line (Color/LAyer/LType/LWeight/Transparency sub-prompts; one
 *    atomic entity.setDisplay application on completion).
 *  - MATCHPROP (MA) — copy the display properties + layer of a source
 *    entity onto destination objects (entity.setDisplay batch).
 *  - -LAYER — the typed layer manager (Make/New/Set/ON/OFF/Freeze/Thaw/
 *    Lock/Unlock; ops apply in the listed fixed order — deterministic
 *    regardless of entry order; "*" wildcards apply to every layer).
 *  - CLAYER — switch the active layer by name (persisted editor state).
 *  - LAYISO / LAYUNISO — layer isolation with exact restore (the reserved
 *    *ISOLATE* layer state carries the pre-isolation table).
 *  - LAYON — turn every layer on (one atomic versioned batch).
 *  - LAYERSTATE (LAS) / STYLE (ST) / DIMSTYLE (D) / LTYPE (LT) — open the
 *    professional managers (ui actions; the palettes carry the writes).
 *  - LTSCALE (LTS) — the linetype scale standard (drafting settings).
 *  - LWEIGHT (LW) — toggle lineweight display.
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * the SAME registry drives ribbon, palette, keyboard and command line on
 * BOTH hosts (LOCK-004; no host-specific command implementations).
 *
 * Honest scope notes surfaced in the command descriptions and the command
 * line itself (typed declines/echoes — LOCK-007):
 *  - -LAYER's Color/LType assignment lives in the Layers manager (palette);
 *    the typed surface carries the state operations only;
 *  - OFF with "*" is declined (the active layer must stay reachable);
 *  - CHPROP/LAyer resolves NAMES through the command context layer table —
 *    unknown names echo a skip (nothing half-applied).
 */

import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";
import { optionValue } from "./prompt-engine.js";
import { isDraftingGeometry } from "./geometry/bridge.js";
import type { LayerRecord } from "../contracts/caddocument.js";
import type { WorkspaceCommand } from "./commands.js";
import type { ElementKind } from "../contracts/caddocument.js";

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

function entitiesValue(values: Readonly<Record<string, PromptValue>>, id: string): readonly EntityPick[] {
  const v = values[id];
  if (v === undefined || v.kind !== "entities") return [];
  return v.entities;
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string): string | null {
  const v = values[id];
  if (v === undefined || v.kind !== "text") return null;
  return v.text;
}

/** Validate a drafting pick (same rules as the CAD-PARITY-003 modify set). */
function validate2dPick(pick: EntityPick): string | null {
  if (pick.kind === "bim") {
    return "BIM elements are authored through the BIM commands — CAD-2D modify operations accept 2D drawing entities.";
  }
  const pickKind: ElementKind = pick.kind === "geometry" || pick.kind === "bim" || pick.kind === "annotation" ? pick.kind : "geometry";
  if (!isDraftingGeometry({ id: pick.id, kind: pickKind, engineId: null, props: pick.props })) {
    if (pick.kind === "annotation" || (pick.props as Record<string, unknown>).type === "dim-linear" || (pick.props as Record<string, unknown>).type === "dim-radius") {
      return "Annotations are not part of the CAD-2D modify vocabulary.";
    }
    return "Select a 2D drawing entity.";
  }
  return null;
}

const OBJECTS_STEP: PromptStep = {
  id: "objects",
  kind: "entity",
  prompt: "Select objects:",
  optional: true,
  multiple: true,
  minInputs: 1,
  validate: validate2dPick,
};

/** Resolve a layer NAME (case-sensitive) to its record through the context. */
function layerByName(ctx: CommandContext, name: string): LayerRecord | null {
  return ctx.layers.find((l) => l.name === name) ?? null;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------
// The CAD-PARITY-004 registry.
// ---------------------------------------------------------------------------

export const COMMANDS_PROPS: readonly WorkspaceCommand[] = [
  // --- CHPROP — the typed property-change command ---------------------------
  {
    id: "chprop",
    name: "CHPROP",
    aliases: [],
    label: "Change properties",
    description:
      "Change the display properties of selected objects: Color, LAyer, LType, LWeight or Transparency (typed values; 'ByLayer' resets a property to inherit the layer).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      OBJECTS_STEP,
      {
        id: "property",
        kind: "text",
        prompt: "Enter property to change [Color/LAyer/LType/LWeight/Transparency] <eXit>:",
        optional: true,
        options: [
          { keyword: "C", label: "Color", input: "text", optionPrompt: "New color (#RRGGBB) or ByLayer:" },
          { keyword: "LA", label: "LAyer", input: "text", optionPrompt: "New layer name:" },
          { keyword: "LT", label: "LType", input: "text", optionPrompt: "New linetype name or ByLayer:" },
          { keyword: "LW", label: "LWeight", input: "text", optionPrompt: "New lineweight (mm, standard set) or ByLayer:" },
          { keyword: "T", label: "Transparency", input: "text", optionPrompt: "New transparency percent (0–90) or ByLayer:" },
        ],
      },
    ],
    build: (values, ctx) => {
      const objects = entitiesValue(values, "objects");
      if (objects.length === 0) {
        return plan([], ["CHPROP: no objects selected — nothing changed."]);
      }
      const patch: Record<string, unknown> = {};
      const echo: string[] = [];
      const ids = objects.map((o) => o.id);
      const color = optionValue(values, "property", "C");
      if (color !== null && color.kind === "text") {
        if (color.text.trim() === "ByLayer" || HEX_COLOR.test(color.text.trim())) {
          patch.color = color.text.trim();
        } else {
          echo.push(`CHPROP: '${color.text}' is not a color — use #RRGGBB or ByLayer (skipped).`);
        }
      }
      const layer = optionValue(values, "property", "LA");
      if (layer !== null && layer.kind === "text") {
        const resolved = layerByName(ctx, layer.text.trim());
        if (resolved !== null) {
          patch.layer = resolved.id;
        } else {
          echo.push(`CHPROP: layer '${layer.text}' not found (skipped).`);
        }
      }
      const linetype = optionValue(values, "property", "LT");
      if (linetype !== null && linetype.kind === "text") {
        const name = linetype.text.trim();
        if (name.length > 0) patch.linetype = name;
        else echo.push("CHPROP: empty linetype name (skipped).");
      }
      const lineweight = optionValue(values, "property", "LW");
      if (lineweight !== null && lineweight.kind === "text") {
        const text = lineweight.text.trim();
        if (text === "ByLayer") {
          patch.lineweight = "ByLayer";
        } else {
          const n = Number(text);
          if (Number.isFinite(n) && n > 0) patch.lineweight = n;
          else echo.push(`CHPROP: '${text}' is not a lineweight — use a standard mm value or ByLayer (skipped).`);
        }
      }
      const transparency = optionValue(values, "property", "T");
      if (transparency !== null && transparency.kind === "text") {
        const text = transparency.text.trim();
        if (text === "ByLayer") {
          patch.transparency = "ByLayer";
        } else {
          const n = Number(text);
          if (Number.isInteger(n) && n >= 0 && n <= 90) patch.transparency = n;
          else echo.push(`CHPROP: '${text}' is not a transparency percent (0–90) (skipped).`);
        }
      }
      if (Object.keys(patch).length === 0) {
        return plan([], [...echo, `CHPROP: no valid property specified — ${ids.length} object(s) unchanged.`]);
      }
      const applied = Object.entries(patch).map(([k, v]) => `${k} ${String(v)}`).join(", ");
      return plan(
        [{ name: "entity.setDisplay", payload: { ids, patch } }],
        [...echo, `CHPROP: ${ids.length} object(s) — ${applied}.`],
      );
    },
  },

  // --- MATCHPROP — property painter ------------------------------------------
  {
    id: "matchprop",
    name: "MATCHPROP",
    aliases: ["MA", "PAINTER"],
    label: "Match properties",
    description:
      "Copy the display properties (color, linetype, lineweight, transparency) and the layer of a source object onto destination objects.",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      { id: "source", kind: "entity", prompt: "Select source object:", validate: validate2dPick },
      {
        id: "targets",
        kind: "entity",
        prompt: "Select destination object(s):",
        multiple: true,
        minInputs: 1,
        validate: validate2dPick,
      },
    ],
    build: (values) => {
      const source = entitiesValue(values, "source")[0];
      const targets = entitiesValue(values, "targets");
      if (source === undefined || targets.length === 0) {
        return plan([], ["MATCHPROP: source and destination objects are required."]);
      }
      const props = source.props as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      patch.color = typeof props.color === "string" && HEX_COLOR.test(props.color) ? props.color : "ByLayer";
      patch.linetype = typeof props.linetype === "string" && props.linetype.length > 0 ? props.linetype : "ByLayer";
      patch.lineweight = typeof props.lineweight === "number" && Number.isFinite(props.lineweight) ? props.lineweight : "ByLayer";
      patch.transparency =
        typeof props.transparency === "number" && Number.isInteger(props.transparency) ? props.transparency : "ByLayer";
      if (typeof props.layer === "string" && props.layer.length > 0) patch.layer = props.layer;
      const ids = targets.map((t) => t.id);
      return plan(
        [{ name: "entity.setDisplay", payload: { ids, patch } }],
        [`MATCHPROP: ${ids.length} object(s) matched from '${source.id}'.`],
      );
    },
  },

  // --- -LAYER — the typed layer manager --------------------------------------
  {
    id: "layercli",
    name: "-LAYER",
    aliases: ["-LA"],
    label: "Layer manager (command line)",
    description:
      "Typed layer management: Make (create + set current), New, Set current, ON/OFF, Freeze/Thaw, Lock/Unlock. A name or '*' (all layers) per option; OFF '*' is declined (the active layer must stay reachable). Color/linetype assignment lives in the Layers manager (LAYER).",
    category: "settings",
    ribbonTab: "Home",
    steps: [
      {
        id: "op",
        kind: "text",
        prompt: "Enter layer option [Make/New/Set/ON/OFF/Freeze/Thaw/Lock/Unlock] <eXit>:",
        optional: true,
        options: [
          { keyword: "M", label: "Make — create a layer and make it current", input: "text", optionPrompt: "Enter name for new layer (becomes the current layer):" },
          { keyword: "N", label: "New — create a layer", input: "text", optionPrompt: "Enter name for new layer:" },
          { keyword: "S", label: "Set — make a layer current", input: "text", optionPrompt: "Enter layer name to make current:" },
          { keyword: "ON", label: "Turn layers on", input: "text", optionPrompt: "Enter layer name(s) to turn on (* for all):" },
          { keyword: "OFF", label: "Turn layers off", input: "text", optionPrompt: "Enter layer name(s) to turn off:" },
          { keyword: "F", label: "Freeze layers", input: "text", optionPrompt: "Enter layer name(s) to freeze (* for all):" },
          { keyword: "T", label: "Thaw layers", input: "text", optionPrompt: "Enter layer name(s) to thaw (* for all):" },
          { keyword: "L", label: "Lock layers", input: "text", optionPrompt: "Enter layer name(s) to lock (* for all):" },
          { keyword: "U", label: "Unlock layers", input: "text", optionPrompt: "Enter layer name(s) to unlock (* for all):" },
        ],
      },
    ],
    build: (values, ctx) => {
      const appApi: AppApiCommandPlanEntry[] = [];
      const echo: string[] = [];
      const updateEdits: { type: "updateLayer"; layerId: string; patch: Record<string, unknown> }[] = [];

      const resolveNames = (raw: string): { layers: readonly LayerRecord[]; skipped: string } => {
        const text = raw.trim();
        if (text === "*") return { layers: ctx.layers, skipped: "" };
        const names = text.split(/[,\s]+/).filter((n) => n.length > 0);
        const found: LayerRecord[] = [];
        const missing: string[] = [];
        for (const name of names) {
          const layer = layerByName(ctx, name);
          if (layer !== null) found.push(layer);
          else missing.push(name);
        }
        return { layers: found, skipped: missing.join(", ") };
      };

      // Ops apply in the FIXED listed order (deterministic regardless of
      // entry order — documented).
      const make = optionValue(values, "op", "M");
      if (make !== null && make.kind === "text" && make.text.trim().length > 0) {
        appApi.push({ name: "drafting.addLayer", payload: { name: make.text.trim(), makeActive: true } });
        echo.push(`-LAYER: layer '${make.text.trim()}' created and set current.`);
      }
      const newLayer = optionValue(values, "op", "N");
      if (newLayer !== null && newLayer.kind === "text" && newLayer.text.trim().length > 0) {
        appApi.push({ name: "drafting.addLayer", payload: { name: newLayer.text.trim() } });
        echo.push(`-LAYER: layer '${newLayer.text.trim()}' created.`);
      }
      const set = optionValue(values, "op", "S");
      if (set !== null && set.kind === "text") {
        const resolved = layerByName(ctx, set.text.trim());
        if (resolved !== null) {
          appApi.push({ name: "layer.setActive", payload: { layerId: resolved.id } });
          echo.push(`-LAYER: layer '${resolved.name}' set current.`);
        } else {
          echo.push(`-LAYER: layer '${set.text.trim()}' not found (Set skipped).`);
        }
      }
      const stateOps: readonly { keyword: string; field: "visible" | "frozen" | "locked"; value: boolean; verb: string; allowStar: boolean }[] = [
        { keyword: "ON", field: "visible", value: true, verb: "on", allowStar: true },
        { keyword: "OFF", field: "visible", value: false, verb: "off", allowStar: false },
        { keyword: "F", field: "frozen", value: true, verb: "frozen", allowStar: true },
        { keyword: "T", field: "frozen", value: false, verb: "thawed", allowStar: true },
        { keyword: "L", field: "locked", value: true, verb: "locked", allowStar: true },
        { keyword: "U", field: "locked", value: false, verb: "unlocked", allowStar: true },
      ];
      for (const op of stateOps) {
        const captured = optionValue(values, "op", op.keyword);
        if (captured === null || captured.kind !== "text") continue;
        const text = captured.text.trim();
        if (text.length === 0) continue;
        if (text === "*" && !op.allowStar) {
          echo.push("-LAYER: cannot turn off every layer — the active layer must stay reachable (OFF '*' declined).");
          continue;
        }
        const { layers, skipped } = resolveNames(text);
        if (skipped.length > 0) echo.push(`-LAYER: layer(s) '${skipped}' not found (skipped).`);
        for (const layer of layers) {
          if (op.field === "frozen" && op.value === true && layer.id === (ctx.activeLayer ?? "0")) {
            echo.push(`-LAYER: layer '${layer.name}' is the active layer — freeze it after switching (skipped).`);
            continue;
          }
          updateEdits.push({ type: "updateLayer", layerId: layer.id, patch: { [op.field]: op.value } });
          echo.push(`-LAYER: layer '${layer.name}' ${op.verb}.`);
        }
      }

      if (updateEdits.length > 0) {
        appApi.push({ name: "document.applyEdit", payload: { edit: { type: "applyEdits", edits: updateEdits } } });
      }
      if (appApi.length === 0) {
        return plan([], [...echo, "-LAYER: no layer operation specified — nothing changed."]);
      }
      return plan(appApi, echo);
    },
  },

  // --- CLAYER — switch the active layer by name ------------------------------
  {
    id: "clayer",
    name: "CLAYER",
    aliases: [],
    label: "Set active layer",
    description: "Make a named layer the active layer for new drafting entities (persisted editor state).",
    category: "settings",
    ribbonTab: "Home",
    steps: [{ id: "name", kind: "text", prompt: "Enter layer name to make current:" }],
    build: (values, ctx) => {
      const name = textValue(values, "name");
      if (name === null || name.trim().length === 0) {
        return plan([], ["CLAYER: a layer name is required."]);
      }
      const resolved = layerByName(ctx, name.trim());
      if (resolved === null) {
        return plan([], [`CLAYER: layer '${name.trim()}' not found.`]);
      }
      return plan(
        [{ name: "layer.setActive", payload: { layerId: resolved.id } }],
        [`CLAYER: active layer is now '${resolved.name}'.`],
      );
    },
  },

  // --- LAYISO / LAYUNISO / LAYON ---------------------------------------------
  {
    id: "layiso",
    name: "LAYISO",
    aliases: [],
    label: "Isolate layers",
    description:
      "Hide every layer except the layers of the selected objects (the previous layer table state is saved — LAYUNISO restores it exactly; both are single undoable revisions).",
    category: "settings",
    ribbonTab: "Home",
    steps: [OBJECTS_STEP],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      if (objects.length === 0) {
        return plan([], ["LAYISO: select objects on the layers to keep."]);
      }
      const keep = [...new Set(objects.map((o) => (o.props as Record<string, unknown>).layer).filter((l): l is string => typeof l === "string"))];
      if (keep.length === 0) {
        return plan([], ["LAYISO: the selection carries no layer assignment."]);
      }
      return plan(
        [{ name: "layer.isolate", payload: { layerIds: keep } }],
        [`LAYISO: ${keep.length} layer(s) isolated (${objects.length} object(s) selected). LAYUNISO restores.`],
      );
    },
  },
  {
    id: "layuniso",
    name: "LAYUNISO",
    aliases: [],
    label: "Unisolate layers",
    description: "Restore the layer table state saved by LAYISO (exact restore — visibility, freeze, lock and display fields).",
    category: "settings",
    ribbonTab: "Home",
    steps: [],
    instant: () =>
      plan([{ name: "layer.unisolate", payload: {} }], ["LAYUNISO: layer table restored (no isolation active → typed failure)."]),
  },
  {
    id: "layon",
    name: "LAYON",
    aliases: [],
    label: "All layers on",
    description: "Turn every layer on (one atomic versioned revision).",
    category: "settings",
    ribbonTab: "Home",
    steps: [],
    instant: (ctx) => {
      if (ctx.layers.length === 0) {
        return plan([], ["LAYON: no layer table available in this context."]);
      }
      const edits = ctx.layers.map((l) => ({ type: "updateLayer" as const, layerId: l.id, patch: { visible: true } }));
      return plan(
        [{ name: "document.applyEdit", payload: { edit: { type: "applyEdits", edits } } }],
        [`LAYON: ${ctx.layers.length} layer(s) turned on.`],
      );
    },
  },

  // --- Managers (ui actions — the palettes carry the writes) ------------------
  {
    id: "layerstate",
    name: "LAYERSTATE",
    aliases: ["LAS"],
    label: "Layer states manager",
    description: "Open the layer states manager (save/restore/delete named layer table snapshots).",
    category: "settings",
    ribbonTab: "Home",
    steps: [],
    instant: () => plan([], ["LAYERSTATE."], [{ action: "palette.show", payload: { palette: "layerStates" } }]),
  },
  {
    id: "linetype",
    name: "LINETYPE",
    aliases: ["LT", "LTYPE"],
    label: "Linetype manager",
    description: "Open the linetype manager (built-in catalog + user-defined dash patterns).",
    category: "settings",
    ribbonTab: "Home",
    steps: [],
    instant: () => plan([], ["LINETYPE."], [{ action: "palette.show", payload: { palette: "linetypes" } }]),
  },
  {
    id: "textstyle",
    name: "STYLE",
    // NOTE: AutoCAD's classic STYLE alias is "ST", but STORY owns "ST" in
    // this registry's vocabulary (registry-unique aliases; honest divergence
    // documented in the work-item record).
    aliases: [],
    label: "Text styles manager",
    description: "Open the text style manager (fonts, fixed height, width factor, oblique angle; Standard is built in).",
    category: "settings",
    ribbonTab: "Annotate",
    steps: [],
    instant: () => plan([], ["STYLE."], [{ action: "palette.show", payload: { palette: "textStyles" } }]),
  },
  {
    id: "dimstyle",
    name: "DIMSTYLE",
    aliases: ["D", "DST"],
    label: "Dimension styles manager",
    description: "Open the dimension style manager (text height, arrow size, scale, precision; Standard is built in).",
    category: "settings",
    ribbonTab: "Annotate",
    steps: [],
    instant: () => plan([], ["DIMSTYLE."], [{ action: "palette.show", payload: { palette: "dimStyles" } }]),
  },

  // --- Standards + display toggles --------------------------------------------
  {
    id: "ltscale",
    name: "LTSCALE",
    aliases: ["LTS"],
    label: "Linetype scale",
    description: "Set the global linetype scale standard (dash/gap lengths multiply by this factor; persisted drawing standard).",
    category: "settings",
    ribbonTab: "Home",
    steps: [{ id: "factor", kind: "number", prompt: "Enter new linetype scale factor <1>:", defaultValue: 1 }],
    build: (values) => {
      const v = values["factor"];
      const factor = v !== undefined && v.kind === "number" ? v.value : 1;
      if (!(factor > 0)) {
        return plan([], ["LTSCALE: the scale factor must be positive."]);
      }
      return plan(
        [{ name: "drafting.setSettings", payload: { settings: { standards: { linetypeScale: factor } } } }],
        [`LTSCALE: linetype scale set to ${factor}.`],
      );
    },
  },
  {
    id: "lweight",
    name: "LWEIGHT",
    aliases: ["LW", "LWDISPLAY"],
    label: "Lineweight display",
    description: "Toggle the display of lineweights in the viewport (hairline 1px rendering when off).",
    category: "settings",
    ribbonTab: "View",
    steps: [],
    instant: () => plan([], ["LWEIGHT display toggled."], [{ action: "toggle.lweight" }]),
  },
];
