/**
 * CAD-PARITY-006 command registry extension (Issue #84) — the blocks,
 * attributes & external-references vocabulary.
 *
 * Commands:
 *  - BLOCK (B) — create a reusable definition from selected entities: name,
 *    insertion base point, object picks. The server converts the picked
 *    elements into canonical inline content and removes the sources — ONE
 *    atomic conversion revision (undo restores both).
 *  - INSERT (I) — place a block instance: name, insertion point, uniform
 *    scale, rotation, then ONE VALUE PROMPT PER attribute definition of the
 *    named block (dynamic steps — the prompts appear once the name is
 *    known; Enter keeps each definition default).
 *  - ATTDEF (ATD) — add an attribute definition to a named block: tag,
 *    prompt, default, position (definition coordinates), height, rotation.
 *    Instances update through the shared expansion (no re-insert needed).
 *  - ATTEDIT (ATE) — edit one attribute value of a picked instance: the
 *    tag options list the instance's definition slots (dynamic steps built
 *    from the pick), then the new value (Enter keeps the current value).
 *  - XATTACH (XA) — attach an external reference by name + path + placement.
 *    The command line CANNOT read external content (engine-free core) — the
 *    reference attaches UNRESOLVED and renders the placeholder box; the
 *    References palette attaches with resolved content (the file dialog
 *    supplies it — the ifc.import payload precedent).
 *  - XDETACH (XD) — detach a reference by name: the record AND its
 *    instances are removed as ONE atomic batch (the explicit cascade).
 *  - XRELOAD — typed decline: reloading requires re-reading the external
 *    file, which only the References palette can do (LOCK-013 capability
 *    honesty, never a silent no-op).
 *  - XLIST — list the reference table with statuses, instance counts and
 *    provenance hashes (the status diagnostics surface, CAD-2D-008).
 *  - XREF (XR) — open the References palette (the manager surface).
 *  - BLOCKLIST (BLI) — list the block table with instance counts + attribute
 *    tags (the ?/list surface AutoCAD exposes through BLOCK dialogues).
 *
 * Honest scope notes surfaced in the command descriptions and echoes
 * (LOCK-007): non-uniform instance scaling, mirrored block content and
 * xref binding/overlay/underlay are unsupported in this build — the
 * surfaces decline with typed messages.
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * `block.*` / `attribute.update` / `xref.*` dispatch to the shared blocks
 * core (server-side validation; the document is the single authority). The
 * SAME registry drives ribbon, palette, keyboard and command line on BOTH
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
import type { WorkspaceCommand } from "./commands.js";
import type { BlockDefinitionRecord } from "../contracts/caddocument.js";
import { attdefTagsOf } from "./blocks/types.js";

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

// INSERT's always-present prompt prefix (the dynamic extension appends one
// value prompt per attribute definition of the named block — prefix-stable).
const INSERT_BASE_STEPS: readonly PromptStep[] = [
  { id: "name", kind: "text", prompt: "Enter block name:", rematerialize: true },
  { id: "at", kind: "point", prompt: "Specify insertion point:" },
  { id: "scale", kind: "number", prompt: "Specify uniform scale factor <1>:", defaultValue: 1 },
  { id: "rotation", kind: "number", prompt: "Specify rotation angle <0>:", defaultValue: 0 },
];

// ATTEDIT's always-present prompt prefix (the dynamic extension inserts the
// tag step between the pick and the value once the instance is known).
const ATTEDIT_BASE_STEPS: readonly PromptStep[] = [
  {
    id: "instance",
    kind: "entity",
    prompt: "Select block instance:",
    validate: validateBlockInstancePick,
    rematerialize: true,
  },
  { id: "value", kind: "text", prompt: "Enter new attribute value (Enter keeps the current value):", optional: true },
];

/** The definition a typed name resolves to (typed failure naming the
 *  available definitions — never a silent guess). */
function blockByName(ctx: CommandContext, name: string): BlockDefinitionRecord {
  const def = ctx.blocks.find((b) => b.name === name);
  if (def === undefined) {
    const available = ctx.blocks.map((b) => b.name);
    throw new Error(
      available.length > 0
        ? `block '${name}' does not exist — available: ${available.join(", ")}`
        : `block '${name}' does not exist — no block definitions in this drawing (create one with BLOCK)`,
    );
  }
  return def;
}

/** The attdef records of a definition (the attribute slots). */
function attdefsOf(def: BlockDefinitionRecord): readonly Record<string, unknown>[] {
  return def.entities.filter((e) => e.type === "attdef");
}

/** BLOCK source-pick validator: canonical drafting geometry (either storage
 *  convention — the bridge resolves), text annotations and block instances
 *  are convertible; BIM/dimensions/xref instances are typed rejections. */
function validateBlockSourcePick(pick: EntityPick): string | null {
  const props = pick.props as Record<string, unknown>;
  if (pick.kind === "bim") {
    return "Block content must be 2D drawing entities (BIM elements cannot be converted).";
  }
  if (props.drafting === true) {
    if (props.type === "block-ref") return null;
    if (props.type === "xref-ref") {
      return "External-reference instances cannot be converted into block content (binding is unsupported in this build).";
    }
    if (typeof props.type === "string" && props.type.startsWith("dim-")) {
      return "Dimensions are associative annotations and cannot become block content.";
    }
    if (props.type === "leader" || props.type === "mleader") {
      return "Leaders are annotations and cannot become block content.";
    }
    if (props.type === "text" || props.type === "mtext") return null;
    // Canonical/legacy drafting geometry (line/polyline/circle/arc/…).
    return null;
  }
  if (pick.kind === "annotation" && props.annotation === true && props.type === "text") return null;
  return "Block content must be 2D drawing entities, text or block instances.";
}

/** ATTEDIT instance-pick validator. */
function validateBlockInstancePick(pick: EntityPick): string | null {
  const props = pick.props as Record<string, unknown>;
  if (props.drafting === true && props.type === "block-ref") return null;
  return "Select a block instance (INSERT).";
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const COMMANDS_BLOCK: readonly WorkspaceCommand[] = [
  {
    id: "block",
    name: "BLOCK",
    aliases: ["B"],
    label: "Block",
    description:
      "Create a reusable block definition from selected entities: name, insertion base point, objects (the sources are converted — removed from the drawing — in one atomic revision).",
    category: "draw",
    ribbonTab: "Insert",
    steps: [
      { id: "name", kind: "text", prompt: "Enter block definition name:" },
      { id: "base", kind: "point", prompt: "Specify insertion base point:" },
      {
        id: "objects",
        kind: "entity",
        prompt: "Select objects for the block:",
        optional: true,
        multiple: true,
        minInputs: 1,
        validate: validateBlockSourcePick,
      },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name");
      const base = pointValue(values, "base");
      const objects = entitiesValue(values, "objects");
      return plan(
        [
          {
            name: "block.create",
            payload: {
              name,
              basePoint: { x: base[0], y: base[1] },
              fromElementIds: objects.map((o) => o.id),
              layer: ctx.activeLayer,
            },
          },
        ],
        [
          `BLOCK '${name}': ${objects.length} entit${objects.length === 1 ? "y" : "ies"} converted into the definition (base (${fmtPoint(base)}), sources removed — one revision; UNDO restores).`,
        ],
      );
    },
  },
  {
    id: "insert",
    name: "INSERT",
    aliases: ["I"],
    label: "Insert Block",
    description:
      "Insert a block instance: name, insertion point, uniform scale, rotation, then a value prompt per attribute definition (Enter keeps each default). Non-uniform scales are unsupported (typed decline).",
    category: "draw",
    ribbonTab: "Insert",
    steps: INSERT_BASE_STEPS,
    dynamicSteps: (ctx, values) => {
      // Prefix-stable: [name, point, scale, rotation, …per-attdef prompts].
      const steps: PromptStep[] = [...INSERT_BASE_STEPS];
      const nameValue = values.name;
      if (nameValue !== undefined && nameValue.kind === "text") {
        const def = ctx.blocks.find((b) => b.name === nameValue.text);
        if (def !== undefined) {
          for (const attdef of attdefsOf(def)) {
            const tag = String(attdef.tag);
            const fallback =
              typeof attdef.default === "string" && attdef.default.length > 0 ? attdef.default : "";
            // Enter SKIPS the slot (the definition default renders — nothing
            // is stored; AutoCAD -INSERT semantics); typing a value stores it.
            steps.push({
              id: `attr:${tag}`,
              kind: "text",
              prompt:
                typeof attdef.prompt === "string" && attdef.prompt.length > 0
                  ? `${attdef.prompt} <${fallback}> (Enter = default):`
                  : `Enter value for attribute '${tag}' <${fallback}> (Enter = default):`,
              optional: true,
            });
          }
        }
      }
      return steps;
    },
    build: (values, ctx) => {
      const name = textValue(values, "name");
      const def = blockByName(ctx, name);
      const at = pointValue(values, "at");
      const scale = numberValue(values, "scale", 1);
      const rotation = numberValue(values, "rotation", 0) * DEG;
      if (!(scale > 0)) {
        throw new Error("scale factor must be positive (non-uniform X/Y/Z scaling is unsupported in this build)");
      }
      const attributes: { tag: string; value: string }[] = [];
      for (const attdef of attdefsOf(def)) {
        const tag = String(attdef.tag);
        const v = values[`attr:${tag}`];
        if (v !== undefined && v.kind === "text" && v.text.length > 0) {
          attributes.push({ tag, value: v.text });
        }
      }
      const attrEcho =
        attributes.length > 0
          ? ` Attributes: ${attributes.map((a) => `${a.tag}='${a.value}'`).join(", ")}.`
          : "";
      return plan(
        [
          {
            name: "block.insert",
            payload: {
              name,
              x: at[0],
              y: at[1],
              scale,
              rotation,
              ...(attributes.length > 0 ? { attributes } : {}),
            },
          },
        ],
        [
          `INSERT '${name}' at (${fmtPoint(at)}), scale ${trimNum(scale)}, rotation ${trimNum(rotation / DEG)}°.${attrEcho}`,
        ],
      );
    },
  },
  {
    id: "attdef",
    name: "ATTDEF",
    aliases: ["ATD"],
    label: "Attribute Definition",
    description:
      "Add an attribute definition to a block: definition name, tag, prompt text, default value, position (definition coordinates), height, rotation. Existing instances render the new slot on their next expansion.",
    category: "draw",
    ribbonTab: "Insert",
    steps: [
      { id: "block", kind: "text", prompt: "Enter block definition name:" },
      { id: "tag", kind: "text", prompt: "Enter attribute tag (A-Z, 0-9, '_', '-', '.'):" },
      { id: "prompt", kind: "text", prompt: "Enter attribute prompt (optional, Enter skips):", optional: true },
      { id: "default", kind: "text", prompt: "Enter default value (optional, Enter skips):", optional: true },
      { id: "at", kind: "point", prompt: "Specify attribute position (definition coordinates):" },
      { id: "height", kind: "number", prompt: "Specify text height <2.5>:", defaultValue: 2.5 },
      { id: "rotation", kind: "number", prompt: "Specify rotation angle <0>:", defaultValue: 0 },
    ],
    build: (values, ctx) => {
      const blockName = textValue(values, "block");
      const def = blockByName(ctx, blockName);
      const tag = textValue(values, "tag").toUpperCase();
      const promptText = values.prompt !== undefined && values.prompt.kind === "text" ? values.prompt.text : undefined;
      const fallback = values.default !== undefined && values.default.kind === "text" ? values.default.text : undefined;
      const at = pointValue(values, "at");
      const height = numberValue(values, "height", 2.5);
      const rotation = numberValue(values, "rotation", 0) * DEG;
      const tags = attdefTagsOf(def.entities);
      if (tags.includes(tag)) {
        throw new Error(`attribute tag '${tag}' already exists in block '${blockName}' — tags must be unique`);
      }
      const attdef: Record<string, unknown> = {
        type: "attdef",
        tag,
        layer: ctx.activeLayer,
        x: at[0],
        y: at[1],
        height,
        rotation,
      };
      if (promptText !== undefined && promptText.length > 0) attdef.prompt = promptText;
      if (fallback !== undefined && fallback.length > 0) attdef.default = fallback;
      return plan(
        [
          {
            name: "block.update",
            payload: {
              name: blockName,
              patch: { entities: [...def.entities, attdef] },
            },
          },
        ],
        [
          `ATTDEF '${tag}' added to block '${blockName}' at (${fmtPoint(at)}), height ${trimNum(height)} — every instance renders the new slot (definition → instance propagation).`,
        ],
      );
    },
  },
  {
    id: "attedit",
    name: "ATTEDIT",
    aliases: ["ATE"],
    label: "Edit Attribute",
    description:
      "Edit an attribute value of a block instance: pick the instance, choose the tag (the definition's slots are listed as options), enter the new value (Enter keeps the current value).",
    category: "modify",
    ribbonTab: "Insert",
    steps: ATTEDIT_BASE_STEPS,
    dynamicSteps: (ctx, values) => {
      // Prefix-stable: [instance, tag (options per slot), value] — the tag
      // step appears once the pick resolves the definition.
      const pick = values.instance;
      if (pick === undefined || pick.kind !== "entities" || pick.entities.length === 0) {
        return ATTEDIT_BASE_STEPS;
      }
      const props = pick.entities[0]!.props as Record<string, unknown>;
      const def = ctx.blocks.find((b) => b.id === props.blockId);
      if (def === undefined) return ATTEDIT_BASE_STEPS;
      const tags = attdefTagsOf(def.entities);
      if (tags.length === 0) return ATTEDIT_BASE_STEPS;
      return [
        ATTEDIT_BASE_STEPS[0]!,
        {
          id: "tag",
          kind: "text",
          prompt: `Enter attribute tag [${tags.join("/")}]:`,
        },
        ATTEDIT_BASE_STEPS[1]!,
      ];
    },
    build: (values, ctx) => {
      const instance = entityValue(values, "instance");
      const props = instance.props as Record<string, unknown>;
      const def = ctx.blocks.find((b) => b.id === props.blockId);
      if (def === undefined) {
        throw new Error(`the picked instance references definition '${String(props.blockId)}' which no longer exists`);
      }
      const tags = attdefTagsOf(def.entities);
      if (tags.length === 0) {
        throw new Error(`block '${def.name}' has no attribute definitions (ATTDEF adds them)`);
      }
      const tag = textValue(values, "tag").toUpperCase();
      if (!tags.includes(tag)) {
        throw new Error(`attribute tag '${tag}' is not a slot of block '${def.name}' — available: ${tags.join(", ")}`);
      }
      const newValue = values.value !== undefined && values.value.kind === "text" ? values.value.text : undefined;
      const id = instance.id;
      return plan(
        [
          {
            name: "attribute.update",
            payload: {
              id,
              tag,
              ...(newValue !== undefined && newValue.length > 0 ? { value: newValue } : {}),
            },
          },
        ],
        [
          newValue !== undefined && newValue.length > 0
            ? `ATTEDIT: '${tag}' of instance '${id}' set to '${newValue}'.`
            : `ATTEDIT: '${tag}' of instance '${id}' unchanged (empty value).`,
        ],
      );
    },
  },
  {
    id: "xattach",
    name: "XATTACH",
    aliases: ["XA"],
    label: "Attach Reference",
    description:
      "Attach an external reference: name, path, insertion point, scale, rotation. The command line cannot read external content — the reference attaches UNRESOLVED (placeholder rendering); attach through the References palette to load resolved content.",
    category: "draw",
    ribbonTab: "Insert",
    steps: [
      { id: "name", kind: "text", prompt: "Enter reference name:" },
      { id: "path", kind: "text", prompt: "Enter external file path (provenance address):" },
      { id: "at", kind: "point", prompt: "Specify insertion point:" },
      { id: "scale", kind: "number", prompt: "Specify uniform scale factor <1>:", defaultValue: 1 },
      { id: "rotation", kind: "number", prompt: "Specify rotation angle <0>:", defaultValue: 0 },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name");
      const path = textValue(values, "path");
      const at = pointValue(values, "at");
      const scale = numberValue(values, "scale", 1);
      const rotation = numberValue(values, "rotation", 0) * DEG;
      if (!(scale > 0)) throw new Error("scale factor must be positive");
      return plan(
        [
          {
            name: "xref.attach",
            payload: { name, path, x: at[0], y: at[1], scale, rotation },
          },
        ],
        [
          `XATTACH '${name}' from '${path}' at (${fmtPoint(at)}) — attached UNRESOLVED (the command line cannot read files); load content through the References palette (XREF).`,
        ],
      );
    },
  },
  {
    id: "xdetach",
    name: "XDETACH",
    aliases: ["XD"],
    label: "Detach Reference",
    description:
      "Detach an external reference by name: the record AND all its instances are removed in ONE atomic revision (the explicit detach cascade — never silent).",
    category: "modify",
    ribbonTab: "Insert",
    steps: [
      { id: "name", kind: "text", prompt: "Enter reference name to detach:" },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name");
      const record = ctx.xrefs.find((x) => x.name === name);
      if (record === undefined) {
        const available = ctx.xrefs.map((x) => x.name);
        throw new Error(
          available.length > 0
            ? `reference '${name}' is not attached — attached: ${available.join(", ")}`
            : `reference '${name}' is not attached — no external references in this drawing`,
        );
      }
      return plan(
        [{ name: "xref.detach", payload: { name } }],
        [`XDETACH '${name}': reference record and instances removed (one atomic revision).`],
      );
    },
  },
  {
    id: "xreload",
    name: "XRELOAD",
    aliases: [],
    label: "Reload Reference",
    description:
      "Typed decline: reloading an external reference re-reads the external file, which only the References palette (with its file dialog) can do — the command line cannot read files.",
    category: "modify",
    ribbonTab: "Insert",
    steps: [],
    instant: () =>
      plan(
        [],
        [
          "XRELOAD requires re-reading the external file — open the References palette (XREF) and use Reload with the refreshed file. The command line cannot read external content (typed unsupported, never a silent no-op).",
        ],
      ),
  },
  {
    id: "xlist",
    name: "XLIST",
    aliases: [],
    label: "Reference Status",
    description:
      "List the external-reference table: name, status (loaded/unresolved), path, instance count and provenance source hash (the reference status diagnostics surface).",
    category: "view",
    ribbonTab: "Insert",
    steps: [],
    instant: (ctx) => {
      if (ctx.xrefs.length === 0) {
        return plan([], ["XLIST: no external references attached (XATTACH attaches one)."]);
      }
      const lines = ["XLIST: external references —"];
      for (const x of ctx.xrefs) {
        lines.push(
          `  ${x.name}: ${x.status}, path '${x.path}', source ${x.sourceHash !== null ? `${x.sourceHash.slice(0, 12)}…` : "none"}`,
        );
      }
      return plan([], lines);
    },
  },
  {
    id: "xref",
    name: "XREF",
    aliases: ["XR"],
    label: "References",
    description: "Open the References palette (the external-reference manager: attach with content, reload, detach).",
    category: "view",
    ribbonTab: "Insert",
    steps: [],
    instant: () =>
      plan([], ["XREF: References palette."], [{ action: "palette.show", payload: { palette: "blocks" } }]),
  },
  {
    id: "blocklist",
    name: "BLOCKLIST",
    aliases: ["BLI"],
    label: "Block List",
    description:
      "List the block-definition table: name, inline entity count, instance count and attribute tags (the ?/list surface of the block dialogue).",
    category: "view",
    ribbonTab: "Insert",
    steps: [],
    instant: (ctx) => {
      if (ctx.blocks.length === 0) {
        return plan([], ["BLOCKLIST: no block definitions (BLOCK creates one)."]);
      }
      const lines = ["BLOCKLIST: block definitions —"];
      for (const b of ctx.blocks) {
        const tags = attdefTagsOf(b.entities);
        lines.push(
          `  ${b.name}: ${b.entities.length} inline entit${b.entities.length === 1 ? "y" : "ies"}, ${tags.length} attribute${tags.length === 1 ? "" : "s"}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`,
        );
      }
      return plan([], lines);
    },
  },
];
