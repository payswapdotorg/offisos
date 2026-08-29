"use client";

/**
 * CAD-PARITY-004 right-dock palettes (Web host): the professional Properties
 * inspector, the full Layers manager and the Styles managers (linetypes, text
 * styles, dimension styles) + the project Navigator (CAD-P-003 "tool
 * palettes, properties/inspector, layers palette, navigator/project browser").
 *
 * Every write goes through the App API with explicit validation (LOCK-007):
 * display/property edits through entity.setDisplay, layer-table edits through
 * drafting.* commands, styles through ltype/textStyle/dimStyle commands,
 * layer states through layerState.* commands — one atomic revision per
 * interaction, typed failures surfaced by the shell's error channel.
 *
 * The display resolution (ByLayer chain, dash/lineweight/transparency) runs
 * through the SAME shared standards module the canvas and the App API use
 * (LOCK-004 parity by construction).
 *
 * CAD-PARITY-005 (Issue #82): the Properties inspector gained the per-type
 * ANNOTATION section (text/mtext/dimensions/leaders — value/height/rotation/
 * alignment/attachment/measured readout/text override/style through
 * annotation.update), the dim-style editor gained arrowStyle + unitSuffix and
 * the standards section gained the document annotation scale (DIMSCALE-class).
 *
 * CAD-PARITY-006 (Issue #84): the per-type BLOCK INSTANCE / REFERENCE
 * INSTANCE inspector sections (definition read-only + editable placement
 * through the updateElement transport + attribute slots through
 * attribute.update) and the Blocks dock tab — the definition inventory with
 * per-definition Insert (the INSERT command pre-filled with the name) and
 * the external-reference manager (attach with resolved content, reload,
 * detach — the XREF command's palette target).
 */

import * as React from "react";
import {
  Boxes,
  Eye,
  EyeOff,
  Layers as LayersIcon,
  Lock,
  LockOpen,
  Navigation,
  PackagePlus,
  Paperclip,
  Plus,
  RefreshCw,
  Snowflake,
  Trash2,
  Unlink,
  Wrench,
  Save,
  RotateCcw,
  Type,
  Ruler,
  Waves,
  Waypoints,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type {
  BlockDefinitionRecord,
  CADDocumentSnapshot,
  ConstraintRecord,
  DimStyleRecord,
  Element,
  LayerRecord,
  LayerStateRecord,
  LtypeRecord,
  TextStyleRecord,
  XrefRecord,
} from "@offisos/cad-app-shell/contracts/caddocument";
import type { CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import { err as apiErr } from "@offisos/cad-app-shell/contracts/app-api";
import { geomFromElement } from "@offisos/cad-app-shell/workspace/geometry/bridge";
import { GEOM_LABEL } from "@offisos/cad-app-shell/workspace/geometry/types";
// CAD-PARITY-006: the shared blocks core (Issue #84) — the soft instance
// loaders + the attribute-slot resolution (the SAME vocabulary the canvas
// expansion and the App API run; LOCK-004 parity by construction).
import {
  attributeValue,
  blockRefFromElement,
  xrefRefFromElement,
} from "@offisos/cad-app-shell/workspace/blocks";
// CAD-PARITY-005: the shared annotation core (Issue #82) — the type label
// vocabulary, the soft element loader and the SAME style-driven label
// formatting the canvas runs (LOCK-004 parity by construction).
import {
  ANNOTATION_LABEL,
  annotationFromElement,
  annotationStyleContext,
  dimensionLabel,
  type Annotation,
  type AnnotationStyleContext,
} from "@offisos/cad-app-shell/workspace/annotation";
// CAD-PARITY-004: the shared standards module (display resolution, filters,
// the built-in linetype catalog + style records).
import {
  BUILT_IN_LTYPES,
  filterLayers,
  LAYER_FILTER_MODES,
  LAYER_STANDARDS,
  resolveDisplay,
  displayOverridesOf,
  STANDARD_DIM_STYLE,
  STANDARD_LINEWEIGHTS,
  STANDARD_TEXT_STYLE,
  type LayerFilterMode,
} from "@offisos/cad-app-shell/workspace/standards";
import { setSelection } from "@/cad/client/http-transport";

export type DockTab = "properties" | "layers" | "styles" | "blocks" | "constraints" | "navigator";

export interface PalettesProps {
  readonly snapshot: CADDocumentSnapshot | null;
  readonly selection: readonly string[];
  readonly activeTab: DockTab;
  readonly onTab: (tab: DockTab) => void;
  readonly activeLayer: string;
  readonly onActiveLayer: (layer: string) => void;
  readonly activeStoryId: string | null;
  readonly onActiveStory: (id: string) => void;
  readonly onSelection: (ids: readonly string[]) => void;
  readonly onCommitEdit: (label: string, fn: () => Promise<CommandQueryResponse>) => void;
  /** CAD-PARITY-006: start a command from a palette, optionally with a
   *  PRE-TYPED first text answer (the Blocks tab's Insert button starts
   *  INSERT with the definition name — the same prompt-engine path the
   *  command line runs, so the dynamic attribute prompts appear). */
  readonly onRunCommand: (commandId: string, typed?: string) => void;
  readonly visible: boolean;
}

// ---------------------------------------------------------------------------
// Shared transport helpers (lazy imports keep the module graph unchanged).
// ---------------------------------------------------------------------------

async function api(name: string, payload: unknown): Promise<CommandQueryResponse> {
  const { send } = await import("@/cad/client/http-transport");
  return send({ type: "command", name: name as never, payload }) as Promise<CommandQueryResponse>;
}

/** CAD-PARITY-005: annotation.update transport — content/style/placement
 *  patches over a batch of annotations as ONE atomic revision (per-type field
 *  vocabulary validated server-side; null RESETS an optional field — the
 *  canonical-minimal record convention). Same lazy-send pattern as the other
 *  wrappers; display/layer edits keep flowing through entity.setDisplay. */
function annotationUpdate(ids: readonly string[], patch: Record<string, unknown>): Promise<CommandQueryResponse> {
  return api("annotation.update", { ids: [...ids], patch });
}

// ---------------------------------------------------------------------------
// CAD-PARITY-006 (Issue #84): blocks/reuse helpers.
// ---------------------------------------------------------------------------

/** The attribute-definition slots of a block definition (inline attdef
 *  entities — the per-instance editable value fields). */
function attdefRecordsOf(def: BlockDefinitionRecord): readonly Record<string, unknown>[] {
  return def.entities.filter((e) => e.type === "attdef");
}

// ---------------------------------------------------------------------------
// Properties inspector (CAD-PARITY-004 professional).
// ---------------------------------------------------------------------------

function PropRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="flex items-center gap-1">{props.children}</span>
    </label>
  );
}

function PropSection(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-2">
      <div className="mb-0.5 mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</div>
      {props.children}
    </div>
  );
}

const NUM_INPUT =
  "w-20 rounded border bg-background px-1 py-0.5 text-right font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function NumberField(
  props: { value: number; onCommit: (v: number) => void; step?: number; ariaLabel: string; disabled?: boolean },
): React.JSX.Element {
  const [editing, setEditing] = React.useState<string | null>(null);
  const text = editing ?? String(props.value);
  const commit = () => {
    const n = Number(text);
    if (editing !== null && Number.isFinite(n) && n !== props.value) props.onCommit(n);
    setEditing(null);
  };
  return (
    <input
      type="number"
      step={props.step ?? "any"}
      aria-label={props.ariaLabel}
      className={NUM_INPUT}
      value={text}
      disabled={props.disabled}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(null);
      }}
    />
  );
}

const TEXT_INPUT =
  "w-32 rounded border bg-background px-1 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// ---------------------------------------------------------------------------
// CAD-PARITY-005: the annotation inspector (Issue #82) — the per-type field
// vocabulary of the professional Properties panel. Every write goes through
// the annotation.update transport (one atomic revision per field; null RESETS
// an optional field to its default, keeping records canonical-minimal).
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

const SELECT_INPUT =
  "rounded border bg-background px-1 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** The 9 MTEXT attachment corners (AutoCAD vocabulary). */
const MTEXT_ATTACHMENTS: readonly string[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

/** The annotation types carrying a text-content value. */
const CONTENT_TYPES: readonly string[] = ["text", "mtext", "leader", "mleader"];

/** The style select shared by every annotation type ("Standard" = the
 *  built-in, resolved code-side; selecting it RESETS the reference; the
 *  empty value is the multi-selection "choose a style" placeholder). */
function AnnotationStyleSelect(props: {
  value: string;
  dim: boolean;
  textStyles: readonly TextStyleRecord[];
  dimStyles: readonly DimStyleRecord[];
  locked: boolean;
  onPatch: (patch: Record<string, unknown>, label: string) => void;
}): React.JSX.Element {
  const styles = props.dim ? props.dimStyles : props.textStyles;
  return (
    <select
      aria-label={props.dim ? "annotation dim style" : "annotation text style"}
      className={SELECT_INPUT}
      value={props.value}
      disabled={props.locked}
      onChange={(e) => {
        const name = e.target.value;
        if (name.length === 0) return;
        props.onPatch({ style: name === "Standard" ? null : name }, "set annotation style");
      }}
    >
      {props.value.length === 0 && <option value="">(set…)</option>}
      <option value="Standard">Standard (built-in)</option>
      {styles.map((s) => (
        <option key={s.name} value={s.name}>{s.name}</option>
      ))}
    </select>
  );
}

/** The single-selection annotation fields (text, mtext, the dimension
 *  family, leaders and multileaders). */
function AnnotationRows(props: {
  anno: Annotation;
  locked: boolean;
  textStyles: readonly TextStyleRecord[];
  dimStyles: readonly DimStyleRecord[];
  styleCtx: AnnotationStyleContext;
  onPatch: (patch: Record<string, unknown>, label: string) => void;
}): React.JSX.Element {
  const { anno, locked, onPatch } = props;
  const isDim = anno.type.startsWith("dim-");
  const styleName = anno.style ?? "Standard";
  const rows: React.JSX.Element[] = [];
  rows.push(
    <PropRow key="type" label="type">
      <Badge variant="secondary">{ANNOTATION_LABEL[anno.type]}</Badge>
    </PropRow>,
  );

  // --- Content entities (text / mtext): value, height, rotation, style. ----
  if (anno.type === "text" || anno.type === "mtext") {
    rows.push(
      <PropRow key="value" label="value">
        {anno.type === "text" ? (
          <input
            aria-label="annotation value"
            className={TEXT_INPUT}
            defaultValue={anno.value}
            disabled={locked}
            onBlur={(e) => {
              if (e.target.value !== anno.value && e.target.value.length > 0) onPatch({ value: e.target.value }, "set annotation value");
            }}
          />
        ) : (
          <textarea
            aria-label="annotation value"
            className="w-32 rounded border bg-background px-1 py-0.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            rows={3}
            defaultValue={anno.value}
            disabled={locked}
            onBlur={(e) => {
              if (e.target.value !== anno.value && e.target.value.length > 0) onPatch({ value: e.target.value }, "set annotation value");
            }}
          />
        )}
      </PropRow>,
    );
    rows.push(
      <PropRow key="height" label="height">
        <NumberField
          ariaLabel="annotation height"
          value={anno.height}
          disabled={locked}
          onCommit={(v) => {
            if (v > 0) onPatch({ height: v }, "set annotation height");
          }}
        />
      </PropRow>,
      <PropRow key="rotation" label="rotation (°)">
        <NumberField
          ariaLabel="annotation rotation degrees"
          value={Number((anno.rotation / DEG).toFixed(4))}
          disabled={locked}
          onCommit={(v) => onPatch({ rotation: v * DEG }, "set annotation rotation")}
        />
      </PropRow>,
    );
  }
  if (anno.type === "text") {
    rows.push(
      <PropRow key="hAlign" label="horizontal">
        <select
          aria-label="annotation horizontal alignment"
          className={SELECT_INPUT}
          value={anno.hAlign ?? "left"}
          disabled={locked}
          onChange={(e) => onPatch({ hAlign: e.target.value === "left" ? null : e.target.value }, "set annotation alignment")}
        >
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
      </PropRow>,
      <PropRow key="vAlign" label="vertical">
        <select
          aria-label="annotation vertical alignment"
          className={SELECT_INPUT}
          value={anno.vAlign ?? "baseline"}
          disabled={locked}
          onChange={(e) => onPatch({ vAlign: e.target.value === "baseline" ? null : e.target.value }, "set annotation alignment")}
        >
          <option value="baseline">baseline</option>
          <option value="bottom">bottom</option>
          <option value="middle">middle</option>
          <option value="top">top</option>
        </select>
      </PropRow>,
    );
  }
  if (anno.type === "mtext") {
    rows.push(
      <PropRow key="attachment" label="attachment">
        <select
          aria-label="annotation attachment corner"
          className={SELECT_INPUT}
          value={anno.attachment ?? "top-left"}
          disabled={locked}
          onChange={(e) => onPatch({ attachment: e.target.value === "top-left" ? null : e.target.value }, "set annotation attachment")}
        >
          {MTEXT_ATTACHMENTS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </PropRow>,
    );
  }

  // --- Dimensions: measured (read-only document truth) + text override. ----
  if (anno.type === "dim-linear" || anno.type === "dim-radius" || anno.type === "dim-diameter" || anno.type === "dim-angular") {
    rows.push(
      <PropRow key="measured" label="measured">
        <code className="font-mono text-[11px]">{dimensionLabel(anno, props.styleCtx)}</code>
      </PropRow>,
      <PropRow key="override" label="text override">
        <input
          aria-label="annotation text override"
          className={TEXT_INPUT}
          defaultValue={anno.textOverride ?? ""}
          placeholder="(none)"
          disabled={locked}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (anno.textOverride ?? "")) onPatch({ textOverride: v.length === 0 ? null : v }, "set annotation text override");
          }}
        />
      </PropRow>,
    );
  }

  // --- Leaders / multileaders: content + the optional text height. ---------
  if (anno.type === "leader" || anno.type === "mleader") {
    rows.push(
      <PropRow key="value" label={anno.type === "leader" ? "value" : "content"}>
        <input
          aria-label="annotation content"
          className={TEXT_INPUT}
          defaultValue={anno.value ?? ""}
          placeholder="(none)"
          disabled={locked}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (anno.value ?? "")) onPatch({ value: v.length === 0 ? null : v }, "set annotation content");
          }}
        />
      </PropRow>,
      <PropRow key="height" label="height">
        <input
          type="number"
          aria-label="annotation height"
          title="Text height (blank = the Standard dim text height)"
          className={NUM_INPUT}
          defaultValue={anno.height ?? ""}
          placeholder="2.5"
          disabled={locked}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (raw.length === 0) {
              if (anno.height !== undefined) onPatch({ height: null }, "reset annotation height");
              return;
            }
            const v = Number(raw);
            if (Number.isFinite(v) && v > 0 && v !== anno.height) onPatch({ height: v }, "set annotation height");
          }}
        />
      </PropRow>,
    );
  }

  // --- Style reference (every annotation type). ----------------------------
  rows.push(
    <PropRow key="style" label="style">
      <AnnotationStyleSelect
        value={styleName}
        dim={isDim}
        textStyles={props.textStyles}
        dimStyles={props.dimStyles}
        locked={locked}
        onPatch={onPatch}
      />
    </PropRow>,
  );
  return <>{rows}</>;
}

/** The multi-selection annotation fields — only the fields that apply to
 *  EVERY selected annotation (the server validates the per-type vocabulary;
 *  mixed dim/content selections show a note instead). */
function AnnotationMultiRows(props: {
  annos: readonly Annotation[];
  locked: boolean;
  textStyles: readonly TextStyleRecord[];
  dimStyles: readonly DimStyleRecord[];
  onPatch: (patch: Record<string, unknown>, label: string) => void;
}): React.JSX.Element {
  const allDims = props.annos.every((a) => a.type.startsWith("dim-"));
  const allContent = props.annos.every((a) => CONTENT_TYPES.includes(a.type));
  if (!allDims && !allContent) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Mixed annotation types — shared-field editing needs one kind (all dimensions or all text/leaders); edit individually with a single selection.
      </p>
    );
  }
  return (
    <>
      {allDims ? (
        <PropRow label="text override">
          <input
            aria-label="annotation text override"
            className={TEXT_INPUT}
            defaultValue=""
            placeholder="(none)"
            disabled={props.locked}
            onBlur={(e) => {
              const v = e.target.value;
              if (v.length > 0) props.onPatch({ textOverride: v }, "set annotation text override");
            }}
          />
        </PropRow>
      ) : (
        <PropRow label="value">
          <input
            aria-label="annotation value"
            className={TEXT_INPUT}
            defaultValue=""
            disabled={props.locked}
            onBlur={(e) => {
              const v = e.target.value;
              if (v.length > 0) props.onPatch({ value: v }, "set annotation value");
            }}
          />
        </PropRow>
      )}
      <PropRow label="style">
        <AnnotationStyleSelect
          value=""
          dim={allDims}
          textStyles={props.textStyles}
          dimStyles={props.dimStyles}
          locked={props.locked}
          onPatch={props.onPatch}
        />
      </PropRow>
    </>
  );
}

/** The display-property editors shared by the single- and multi-selection
 *  views (CHPROP-class writes through entity.setDisplay). */
function DisplayEditors(props: {
  p: PalettesProps;
  ids: readonly string[];
  color: string | null;
  linetype: string | null;
  lineweight: number | null;
  transparency: number | null;
  layerId?: string;
  locked: boolean;
}): React.JSX.Element {
  const { p, ids } = props;
  const setDisplay = (patch: Record<string, unknown>, label: string) =>
    p.onCommitEdit(label, () => api("entity.setDisplay", { ids, patch }));
  const ltypeOptions = [...BUILT_IN_LTYPES.map((l) => l.name), ...(p.snapshot?.ltypes ?? []).map((l) => l.name)];
  return (
    <>
      <PropRow label="color">
        <input
          type="color"
          aria-label="entity color override"
          className="h-5 w-8 cursor-pointer rounded border bg-background p-0"
          value={props.color ?? "#111827"}
          disabled={props.locked}
          onChange={(e) => setDisplay({ color: e.target.value }, "set color")}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-5 px-1.5 text-[10px]"
          disabled={props.locked}
          title="Reset to ByLayer"
          onClick={() => setDisplay({ color: "ByLayer" }, "reset color")}
        >
          ByLayer
        </Button>
      </PropRow>
      <PropRow label="linetype">
        <select
          aria-label="entity linetype override"
          className="rounded border bg-background px-1 py-0.5 text-xs"
          value={props.linetype ?? "ByLayer"}
          disabled={props.locked}
          onChange={(e) => setDisplay({ linetype: e.target.value }, "set linetype")}
        >
          <option value="ByLayer">ByLayer</option>
          {ltypeOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </PropRow>
      <PropRow label="lineweight">
        <select
          aria-label="entity lineweight override"
          className="rounded border bg-background px-1 py-0.5 text-xs"
          value={props.lineweight !== null ? String(props.lineweight) : "ByLayer"}
          disabled={props.locked}
          onChange={(e) =>
            setDisplay(
              { lineweight: e.target.value === "ByLayer" ? "ByLayer" : Number(e.target.value) },
              "set lineweight",
            )
          }
        >
          <option value="ByLayer">ByLayer</option>
          {STANDARD_LINEWEIGHTS.map((w) => (
            <option key={w} value={w}>{w.toFixed(2)}</option>
          ))}
        </select>
      </PropRow>
      <PropRow label="transparency">
        <select
          aria-label="entity transparency override"
          className="rounded border bg-background px-1 py-0.5 text-xs"
          value={props.transparency !== null ? String(props.transparency) : "ByLayer"}
          disabled={props.locked}
          onChange={(e) =>
            setDisplay(
              { transparency: e.target.value === "ByLayer" ? "ByLayer" : Number(e.target.value) },
              "set transparency",
            )
          }
        >
          <option value="ByLayer">ByLayer</option>
          {Array.from({ length: 10 }, (_, i) => (i + 1) * 10).map((t) => (
            <option key={t} value={t}>{t}%</option>
          ))}
        </select>
      </PropRow>
      <PropRow label="layer">
        <select
          aria-label="entity layer"
          className="rounded border bg-background px-1 py-0.5 text-xs"
          value={props.layerId ?? ""}
          disabled={props.locked}
          onChange={(e) => setDisplay({ layer: e.target.value }, "set layer")}
        >
          {(p.snapshot?.layers ?? []).map((l: LayerRecord) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </PropRow>
    </>
  );
}

function PropertiesPanel(props: PalettesProps): React.JSX.Element {
  const elements = props.snapshot?.elements ?? [];
  const layers = props.snapshot?.layers ?? [];
  const layerById = React.useMemo(() => new Map(layers.map((l) => [l.id, l] as const)), [layers]);
  const selected = React.useMemo(
    () => elements.filter((el) => props.selection.includes(el.id)),
    [elements, props.selection],
  );
  // CAD-PARITY-005: the annotation style context — the SAME style tables +
  // document annotation scale the canvas and the render core run (the
  // measured readout formats identically to the painted label).
  const annotationStyleCtx = React.useMemo(
    () => annotationStyleContext(
      props.snapshot?.textStyles ?? [],
      props.snapshot?.dimStyles ?? [],
      props.snapshot?.draftingSettings?.standards?.annotationScale,
    ),
    [props.snapshot],
  );

  // --- No selection: the current drafting environment (AutoCAD-class). ----
  if (selected.length === 0) {
    const layer = layerById.get(props.activeLayer);
    const overrides = { color: null, linetype: null, lineweight: null, transparency: null };
    const resolved =
      layer !== undefined
        ? resolveDisplay(overrides, layer, props.snapshot?.draftingSettings?.standards, props.snapshot?.ltypes ?? [])
        : null;
    return (
      <ScrollArea className="h-full">
        <div className="p-3">
          <PropSection title="Current drafting environment">
            <PropRow label="active layer">
              <select
                aria-label="active layer"
                className="rounded border bg-background px-1 py-0.5 text-xs"
                value={props.activeLayer}
                onChange={(e) => props.onActiveLayer(e.target.value)}
              >
                {layers.map((l: LayerRecord) => (
                  <option key={l.id} value={l.id} disabled={l.frozen === true}>{l.name}{l.frozen === true ? " (frozen)" : ""}</option>
                ))}
              </select>
            </PropRow>
            {resolved !== null && (
              <>
                <PropRow label="effective color">
                  <span className="h-3 w-3 rounded-sm border" style={{ background: resolved.color }} aria-hidden />
                  <code className="font-mono text-[11px]">{resolved.color}</code>
                </PropRow>
                <PropRow label="effective linetype"><code className="font-mono text-[11px]">{resolved.linetype}</code></PropRow>
                <PropRow label="effective lineweight"><code className="font-mono text-[11px]">{resolved.lineweight.toFixed(2)} mm</code></PropRow>
              </>
            )}
            <PropRow label="current text style">
              <code className="font-mono text-[11px]">{props.snapshot?.draftingSettings?.textStyle ?? "Standard"}</code>
            </PropRow>
            <PropRow label="current dim style">
              <code className="font-mono text-[11px]">{props.snapshot?.draftingSettings?.dimStyle ?? "Standard"}</code>
            </PropRow>
            <PropRow label="linetype scale">
              <code className="font-mono text-[11px]">{props.snapshot?.draftingSettings?.standards?.linetypeScale ?? 1}</code>
            </PropRow>
          </PropSection>
          <p className="text-xs text-muted-foreground">
            No selection. Pick an entity in the Model viewport or the Navigator — or draw with LINE, CIRCLE, PLINE…
          </p>
        </div>
      </ScrollArea>
    );
  }

  // --- Multi-selection: common-property editing (CHPROP-class). ------------
  if (selected.length > 1) {
    const drafting = selected.filter((el) => (el.props as Record<string, unknown>).drafting === true);
    const locked = drafting.some((el) => {
      const layerId = (el.props as Record<string, unknown>).layer;
      return typeof layerId === "string" && layerById.get(layerId)?.locked === true;
    });
    // CAD-PARITY-005: the annotation subset (soft load — legacy dims too);
    // annotation.update patches apply to the annotation ids only.
    const annoViews: { el: Element; anno: Annotation }[] = [];
    for (const el of selected) {
      const anno = annotationFromElement(el);
      if (anno !== null) annoViews.push({ el, anno });
    }
    const first = drafting[0];
    const fo = first !== undefined ? displayOverridesOf(first.props as Record<string, unknown>) : null;
    const commonLayer =
      drafting.length > 0 &&
      drafting.every((el) => (el.props as Record<string, unknown>).layer === (drafting[0]!.props as Record<string, unknown>).layer)
        ? ((drafting[0]!.props as Record<string, unknown>).layer as string)
        : undefined;
    return (
      <ScrollArea className="h-full">
        <div className="p-3">
          <PropSection title={`Selection — ${selected.length} entities`}>
            <PropRow label="drafting entities"><span>{drafting.length}</span></PropRow>
            {annoViews.length > 0 && <PropRow label="annotations"><span>{annoViews.length}</span></PropRow>}
            {locked && <PropRow label="state"><Badge variant="destructive" className="h-4 px-1 text-[9px]">locked layer — read-only</Badge></PropRow>}
          </PropSection>
          {drafting.length > 0 && fo !== null && (
            <PropSection title="Common display properties">
              <DisplayEditors
                p={props}
                ids={drafting.map((el) => el.id)}
                color={null}
                linetype={null}
                lineweight={null}
                transparency={null}
                layerId={commonLayer}
                locked={locked}
              />
            </PropSection>
          )}
          {annoViews.length > 0 && (
            <PropSection title={`Common annotation properties — ${annoViews.length}`}>
              <AnnotationMultiRows
                annos={annoViews.map((v) => v.anno)}
                locked={locked}
                textStyles={props.snapshot?.textStyles ?? []}
                dimStyles={props.snapshot?.dimStyles ?? []}
                onPatch={(patch, label) =>
                  props.onCommitEdit(label, () => annotationUpdate(annoViews.map((v) => v.el.id), patch))
                }
              />
            </PropSection>
          )}
          <p className="text-xs text-muted-foreground">
            Display edits apply to the {drafting.length} drafting entities atomically (CHPROP semantics); mixed values show ByLayer defaults.
          </p>
        </div>
      </ScrollArea>
    );
  }

  // --- Single selection: the full professional inspector. -------------------
  const el: Element = selected[0]!;
  const p = el.props as Record<string, unknown>;
  const commit = props.onCommitEdit;
  const patchBim = (patch: Record<string, unknown>) =>
    commit("bim.setProperties", async () => {
      const { bimSetProperties } = await import("@/cad/client/http-transport");
      return bimSetProperties(el.id, patch);
    });
  const canonicalGeom = el.kind === "geometry" && p.drafting === true ? geomFromElement(el) : null;
  // CAD-PARITY-005: the annotation view of the selected element (soft load —
  // the 8-type canonical vocabulary AND the legacy COMPAT-CAD-001 dims).
  const anno = annotationFromElement(el);
  // CAD-PARITY-006: the block/xref instance views (soft load — malformed
  // props read as null) + the definition/reference records the snapshot
  // tables resolve (the read-only names + the attribute slots).
  const blockRef = blockRefFromElement(el);
  const xrefRef = xrefRefFromElement(el);
  const blockDef =
    blockRef !== null ? (props.snapshot?.blockDefs ?? []).find((b) => b.id === blockRef.blockId) : undefined;
  const xrefRecord =
    xrefRef !== null ? (props.snapshot?.xrefs ?? []).find((x) => x.id === xrefRef.xrefId) : undefined;
  const layerId = typeof p.layer === "string" ? p.layer : null;
  const layer = layerId !== null ? layerById.get(layerId) : undefined;
  const locked = layer?.locked === true && p.drafting === true;
  const overrides = displayOverridesOf(p);
  const setDraft = (patch: Record<string, unknown>) =>
    commit("update entity", async () => {
      const { applyEdit } = await import("@/cad/client/http-transport");
      return applyEdit({ type: "updateElement", elementId: el.id, patch: { ...p, ...patch } });
    });

  const rows: React.JSX.Element[] = [];
  const idRow = (
    <PropRow key="id" label="id">
      <code className="font-mono text-[11px]">{el.id}</code>
    </PropRow>
  );
  const kindRow = (
    <PropRow key="kind" label="kind">
      <Badge variant="secondary">{el.kind}</Badge>
    </PropRow>
  );
  const typeRow =
    canonicalGeom !== null ? (
      <PropRow key="type" label="type">
        <Badge variant="secondary">{GEOM_LABEL[canonicalGeom.type]}</Badge>
      </PropRow>
    ) : p.type === "block-ref" ? (
      // CAD-PARITY-006: the professional type label of a block instance.
      <PropRow key="type" label="type">
        <Badge variant="secondary">Block Instance</Badge>
      </PropRow>
    ) : p.type === "xref-ref" ? (
      // CAD-PARITY-006: the professional type label of a reference instance.
      <PropRow key="type" label="type">
        <Badge variant="secondary">Reference Instance</Badge>
      </PropRow>
    ) : typeof p.type === "string" ? (
      <PropRow key="type" label="type">
        <code className="font-mono text-[11px]">{p.type}</code>
      </PropRow>
    ) : null;

  return (
    <ScrollArea className="h-full">
      <div className="p-3">
        <PropSection title="General">{idRow}{kindRow}{typeRow}</PropSection>

        {p.drafting === true && (
          <PropSection title="Display (ByLayer chain)">
            {locked && (
              <PropRow label="state">
                <Badge variant="destructive" className="h-4 px-1 text-[9px]">layer “{layer?.name}” locked — read-only</Badge>
              </PropRow>
            )}
            <DisplayEditors
              p={props}
              ids={[el.id]}
              color={overrides.color}
              linetype={overrides.linetype}
              lineweight={overrides.lineweight}
              transparency={overrides.transparency}
              layerId={layerId ?? undefined}
              locked={locked}
            />
            {layer !== undefined && (
              <>
                <PropRow label="↳ layer color"><code className="font-mono text-[11px]">{layer.color}</code></PropRow>
                <PropRow label="↳ layer linetype"><code className="font-mono text-[11px]">{layer.linetype ?? "Continuous"}</code></PropRow>
                <PropRow label="↳ layer lineweight"><code className="font-mono text-[11px]">{(layer.lineweight ?? 0.25).toFixed(2)}</code></PropRow>
              </>
            )}
          </PropSection>
        )}

        {p.drafting === true && anno === null && blockRef === null && xrefRef === null && (
          <PropSection title="Geometry">
            {p.type === "circle" && Array.isArray(p.center) && (
              <PropRow label="radius">
                <NumberField ariaLabel="circle radius" value={p.radius as number} onCommit={(v) => setDraft({ radius: v })} />
              </PropRow>
            )}
            {p.type === "line" && Array.isArray(p.from) && Array.isArray(p.to) && (
              <>
                <PropRow label="from x,y">
                  <NumberField ariaLabel="line from x" value={(p.from as number[])[0]} onCommit={(v) => setDraft({ from: [v, (p.from as number[])[1]] })} />
                  <NumberField ariaLabel="line from y" value={(p.from as number[])[1]} onCommit={(v) => setDraft({ from: [(p.from as number[])[0], v] })} />
                </PropRow>
                <PropRow label="to x,y">
                  <NumberField ariaLabel="line to x" value={(p.to as number[])[0]} onCommit={(v) => setDraft({ to: [v, (p.to as number[])[1]] })} />
                  <NumberField ariaLabel="line to y" value={(p.to as number[])[1]} onCommit={(v) => setDraft({ to: [(p.to as number[])[0], v] })} />
                </PropRow>
              </>
            )}
            {p.type === "polyline" && Array.isArray(p.points) && (
              <PropRow label="vertices"><span>{(p.points as unknown[]).length}</span></PropRow>
            )}
            {canonicalGeom !== null && <CanonicalGeometryRows geom={canonicalGeom} p={p} setDraft={setDraft} />}
          </PropSection>
        )}

        {/* CAD-PARITY-006 (Issue #84): the BLOCK INSTANCE section — the
            definition resolves read-only from the snapshot table; the
            placement fields edit through the SAME updateElement transport
            the classic geometry editors use (one atomic revision per field;
            the locked-layer gate applies server-side); the attribute slots
            edit through attribute.update (an empty value clears the stored
            value — the definition default renders again). */}
        {blockRef !== null && (
          <PropSection title="Block Instance">
            {locked && (
              <PropRow label="state">
                <Badge variant="destructive" className="h-4 px-1 text-[9px]">layer “{layer?.name}” locked — read-only</Badge>
              </PropRow>
            )}
            <PropRow label="definition">
              <code className="font-mono text-[11px]">{blockDef?.name ?? blockRef.blockId}</code>
            </PropRow>
            {blockDef !== undefined && (
              <PropRow label="base point">
                <code className="font-mono text-[11px]">
                  {Number(blockDef.basePoint.x.toFixed(3))}, {Number(blockDef.basePoint.y.toFixed(3))}
                </code>
              </PropRow>
            )}
            <PropRow label="insertion x,y">
              <NumberField ariaLabel="instance insertion x" value={blockRef.x} disabled={locked} onCommit={(v) => setDraft({ x: v })} />
              <NumberField ariaLabel="instance insertion y" value={blockRef.y} disabled={locked} onCommit={(v) => setDraft({ y: v })} />
            </PropRow>
            <PropRow label="scale">
              <NumberField
                ariaLabel="instance scale"
                step={0.1}
                value={blockRef.scale}
                disabled={locked}
                onCommit={(v) => {
                  // LOCK-007 honesty: uniform positive scales only — the
                  // typed decline happens here, never a silent write.
                  if (v > 0) setDraft({ scale: v });
                }}
              />
            </PropRow>
            <PropRow label="rotation (°)">
              <NumberField
                ariaLabel="instance rotation degrees"
                value={Number((blockRef.rotation / DEG).toFixed(4))}
                disabled={locked}
                onCommit={(v) => setDraft({ rotation: v * DEG })}
              />
            </PropRow>
            {blockDef !== undefined && (
              <>
                <div className="mb-0.5 mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Attributes
                </div>
                {attdefRecordsOf(blockDef).map((attdef) => {
                  const tag = String(attdef.tag);
                  const current = attributeValue(
                    blockRef.attributes ?? [],
                    tag,
                    typeof attdef.default === "string" ? attdef.default : undefined,
                  );
                  return (
                    <PropRow key={`attr-${tag}`} label={tag}>
                      <input
                        aria-label={`attribute ${tag} value`}
                        className={TEXT_INPUT}
                        defaultValue={current ?? ""}
                        placeholder="(empty)"
                        disabled={locked}
                        title={
                          typeof attdef.prompt === "string" && attdef.prompt.length > 0
                            ? attdef.prompt
                            : `Attribute ‘${tag}’ — empty clears to the definition default`
                        }
                        onBlur={(e) => {
                          const v = e.target.value;
                          if (v === (current ?? "")) return;
                          props.onCommitEdit(`set attribute ${tag}`, async () => {
                            const { attributeUpdate } = await import("@/cad/client/http-transport");
                            return attributeUpdate(el.id, tag, v.length === 0 ? null : v);
                          });
                        }}
                      />
                    </PropRow>
                  );
                })}
                {attdefRecordsOf(blockDef).length === 0 && (
                  <p className="text-[10px] text-muted-foreground">No attribute definitions — ATTDEF (ATD) adds them.</p>
                )}
              </>
            )}
          </PropSection>
        )}

        {/* CAD-PARITY-006 (Issue #84): the REFERENCE INSTANCE section — the
            reference name + status resolve read-only from the snapshot
            table; placement edits go through the same updateElement
            transport. */}
        {xrefRef !== null && (
          <PropSection title="Reference Instance">
            {locked && (
              <PropRow label="state">
                <Badge variant="destructive" className="h-4 px-1 text-[9px]">layer “{layer?.name}” locked — read-only</Badge>
              </PropRow>
            )}
            <PropRow label="reference">
              <code className="font-mono text-[11px]">{xrefRecord?.name ?? xrefRef.xrefId}</code>
            </PropRow>
            <PropRow label="status">
              {xrefRecord === undefined ? (
                <Badge variant="destructive" className="h-4 px-1 text-[9px]">missing record</Badge>
              ) : xrefRecord.status === "loaded" ? (
                <Badge variant="secondary" className="h-4 gap-1 px-1 text-[9px]">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden /> loaded
                </Badge>
              ) : (
                <Badge variant="outline" className="h-4 border-amber-400 bg-amber-50 px-1 text-[9px] text-amber-700">unresolved</Badge>
              )}
            </PropRow>
            {xrefRecord !== undefined && xrefRecord.sourceHash !== null && (
              <PropRow label="source hash">
                <code className="font-mono text-[11px]">{xrefRecord.sourceHash.slice(0, 12)}…</code>
              </PropRow>
            )}
            {xrefRecord?.status !== "loaded" && (
              <p className="text-[10px] text-amber-700">
                Unresolved — the canvas renders the dashed placeholder box. Reload through the Blocks tab (XREF) with the refreshed file.
              </p>
            )}
            <PropRow label="insertion x,y">
              <NumberField ariaLabel="reference insertion x" value={xrefRef.x} disabled={locked} onCommit={(v) => setDraft({ x: v })} />
              <NumberField ariaLabel="reference insertion y" value={xrefRef.y} disabled={locked} onCommit={(v) => setDraft({ y: v })} />
            </PropRow>
            <PropRow label="scale">
              <NumberField
                ariaLabel="reference scale"
                step={0.1}
                value={xrefRef.scale}
                disabled={locked}
                onCommit={(v) => {
                  if (v > 0) setDraft({ scale: v });
                }}
              />
            </PropRow>
            <PropRow label="rotation (°)">
              <NumberField
                ariaLabel="reference rotation degrees"
                value={Number((xrefRef.rotation / DEG).toFixed(4))}
                disabled={locked}
                onCommit={(v) => setDraft({ rotation: v * DEG })}
              />
            </PropRow>
          </PropSection>
        )}

        {/* CAD-PARITY-005: the per-type annotation fields (content/placement/
            style — annotation.update, one atomic revision per field; the
            measured value is the READ-ONLY stored document truth, formatted
            through the SAME style context the canvas paints). */}
        {anno !== null && (
          <PropSection title="Annotation">
            {locked && (
              <PropRow label="state">
                <Badge variant="destructive" className="h-4 px-1 text-[9px]">layer “{layer?.name}” locked — read-only</Badge>
              </PropRow>
            )}
            <AnnotationRows
              anno={anno}
              locked={locked}
              textStyles={props.snapshot?.textStyles ?? []}
              dimStyles={props.snapshot?.dimStyles ?? []}
              styleCtx={annotationStyleCtx}
              onPatch={(patch, label) => props.onCommitEdit(label, () => annotationUpdate([el.id], patch))}
            />
          </PropSection>
        )}

        {el.kind === "bim" && (
          <PropSection title="BIM properties">
            {[
              { key: "width", label: "width" },
              { key: "height", label: "height" },
              { key: "thickness", label: "thickness" },
              { key: "level", label: "level" },
              { key: "baseOffset", label: "base offset" },
              { key: "sill", label: "sill" },
            ].map(({ key, label }) =>
              typeof p[key] === "number" ? (
                <PropRow key={key} label={label}>
                  <NumberField ariaLabel={`${el.id} ${label}`} value={p[key] as number} onCommit={(v) => patchBim({ [key]: v })} />
                </PropRow>
              ) : null,
            )}
            {typeof p.name === "string" && (
              <PropRow label="name">
                <input
                  aria-label={`${el.id} name`}
                  className={TEXT_INPUT}
                  defaultValue={p.name}
                  onBlur={(e) => {
                    if (e.target.value !== p.name) patchBim({ name: e.target.value });
                  }}
                />
              </PropRow>
            )}
          </PropSection>
        )}
      </div>
    </ScrollArea>
  );
}

/** Read-only key geometry of the canonical vocabulary (same data the
 *  status-bar readout shows; editable numeric fields for the classic set). */
function CanonicalGeometryRows(props: {
  geom: NonNullable<ReturnType<typeof geomFromElement>>;
  p: Record<string, unknown>;
  setDraft: (patch: Record<string, unknown>) => void;
}): React.JSX.Element[] {
  const g = props.geom;
  const num = (v: number): string => String(Number(v.toFixed(3)));
  const value = (text: string): React.JSX.Element => <code className="font-mono text-[11px]">{text}</code>;
  const rows: React.JSX.Element[] = [];
  switch (g.type) {
    case "ellipse":
      rows.push(<PropRow key="axes" label="axes">{value(`${num(g.rx)} × ${num(g.ry)}`)}</PropRow>);
      rows.push(<PropRow key="rotation" label="rotation">{value(`${num((g.rotation * 180) / Math.PI)}°`)}</PropRow>);
      rows.push(<PropRow key="center" label="center">{value(`${num(g.cx)}, ${num(g.cy)}`)}</PropRow>);
      break;
    case "spline":
      rows.push(<PropRow key="cpts" label="control points">{value(String(g.controlPoints.length))}</PropRow>);
      rows.push(<PropRow key="degree" label="degree">{value(String(g.degree))}</PropRow>);
      break;
    case "point":
      rows.push(<PropRow key="position" label="position">{value(`${num(g.x)}, ${num(g.y)}`)}</PropRow>);
      break;
    case "ray":
    case "xline": {
      const dirDeg = (((Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI + 360) % 360);
      rows.push(<PropRow key="base" label="base">{value(`${num(g.x1)}, ${num(g.y1)}`)}</PropRow>);
      rows.push(<PropRow key="through" label="through">{value(`${num(g.x2)}, ${num(g.y2)}`)}</PropRow>);
      rows.push(<PropRow key="direction" label="direction">{value(`${num(dirDeg)}°`)}</PropRow>);
      break;
    }
    case "region":
      rows.push(<PropRow key="boundary" label="boundary">{value(g.boundary.kind)}</PropRow>);
      rows.push(<PropRow key="area" label="area">{value(num(g.area))}</PropRow>);
      rows.push(<PropRow key="perimeter" label="perimeter">{value(num(g.perimeter))}</PropRow>);
      rows.push(<PropRow key="centroid" label="centroid">{value(`${num(g.centroid.x)}, ${num(g.centroid.y)}`)}</PropRow>);
      break;
    case "line":
      if (!Array.isArray(props.p.from)) {
        rows.push(<PropRow key="from" label="from">{value(`${num(g.x1)}, ${num(g.y1)}`)}</PropRow>);
        rows.push(<PropRow key="to" label="to">{value(`${num(g.x2)}, ${num(g.y2)}`)}</PropRow>);
      }
      break;
    case "circle":
      if (!Array.isArray(props.p.center)) {
        rows.push(<PropRow key="center" label="center">{value(`${num(g.cx)}, ${num(g.cy)}`)}</PropRow>);
        rows.push(<PropRow key="radius" label="radius">{value(num(g.r))}</PropRow>);
      }
      break;
    case "arc":
      if (!Array.isArray(props.p.center)) {
        rows.push(<PropRow key="center" label="center">{value(`${num(g.cx)}, ${num(g.cy)}`)}</PropRow>);
        rows.push(<PropRow key="radius" label="radius">{value(num(g.r))}</PropRow>);
        rows.push(
          <PropRow key="sweep" label="sweep">
            {value(`${num((((g.endAngle - g.startAngle) * 180) / Math.PI + 360) % 360)}°`)}
          </PropRow>,
        );
      }
      break;
    case "polyline":
      if (!Array.isArray(props.p.points)) {
        rows.push(<PropRow key="pts" label="vertices">{value(String(g.vertices.length))}</PropRow>);
        rows.push(<PropRow key="closed" label="closed">{value(g.closed ? "yes" : "no")}</PropRow>);
      }
      break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Layers manager (CAD-PARITY-004 full palette).
// ---------------------------------------------------------------------------

function LayersPanel(props: PalettesProps): React.JSX.Element {
  const layers = props.snapshot?.layers ?? [];
  const elements = props.snapshot?.elements ?? [];
  const settings = props.snapshot?.draftingSettings;
  const states = props.snapshot?.layerStates ?? [];
  const [newName, setNewName] = React.useState("");
  const [filterText, setFilterText] = React.useState("");
  const [filterMode, setFilterMode] = React.useState<LayerFilterMode>("all");
  const [editingName, setEditingName] = React.useState<string | null>(null);
  const [stateName, setStateName] = React.useState("");
  const [showStates, setShowStates] = React.useState(false);

  const usedLayerIds = React.useMemo(() => {
    const used = new Set<string>();
    for (const el of elements) {
      const layer = (el.props as Record<string, unknown>).layer;
      if (typeof layer === "string") used.add(layer);
    }
    return used;
  }, [elements]);

  const filtered = React.useMemo(
    () => filterLayers(layers, filterMode, filterText, usedLayerIds),
    [layers, filterMode, filterText, usedLayerIds],
  );

  const commit = props.onCommitEdit;
  const updateLayer = (layerId: string, patch: Record<string, unknown>, label: string) =>
    commit(label, () => api("drafting.updateLayer", { layerId, patch }));

  const ltypeOptions = [...BUILT_IN_LTYPES.map((l) => l.name), ...(props.snapshot?.ltypes ?? []).map((l) => l.name)];

  return (
    <div className="flex h-full flex-col">
      {/* New layer + standards */}
      <div className="flex items-center gap-1 border-b p-2">
        <input
          aria-label="new layer name"
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
          placeholder="New layer name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim().length > 0) {
              const name = newName.trim();
              commit("add layer", () => api("drafting.addLayer", { name }));
              setNewName("");
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0"
          aria-label="add layer"
          title="Add layer"
          disabled={newName.trim().length === 0}
          onClick={() => {
            const name = newName.trim();
            if (name.length === 0) return;
            commit("add layer", () => api("drafting.addLayer", { name }));
            setNewName("");
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <select
          aria-label="apply layer standard"
          className="w-24 rounded border bg-background px-1 py-1 text-[10px]"
          value=""
          onChange={(e) => {
            if (e.target.value.length > 0) {
              commit("apply layer standard", () => api("layer.applyStandard", { standard: e.target.value }));
            }
          }}
          title="Apply a named drawing standard (creates the standard layer set)"
        >
          <option value="">Standard…</option>
          {LAYER_STANDARDS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1 border-b p-2">
        <input
          aria-label="layer name filter"
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
          placeholder="Filter layers…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <select
          aria-label="layer state filter"
          className="rounded border bg-background px-1 py-1 text-[10px]"
          value={filterMode}
          onChange={(e) => setFilterMode(e.target.value as LayerFilterMode)}
        >
          {LAYER_FILTER_MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* The layer table */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1" aria-label="layers list">
          <div className="flex items-center gap-2 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="w-4" title="Active" />
            <span className="flex-1">Name</span>
            <span className="w-5 text-center" title="On/Off">On</span>
            <span className="w-5 text-center" title="Freeze">Frz</span>
            <span className="w-5 text-center" title="Lock">Lck</span>
            <span className="w-6" title="Color" />
            <span className="w-16">Linetype</span>
            <span className="w-12 text-right">Weight</span>
            <span className="w-8 text-center" title="Plot">Plt</span>
          </div>
          {filtered.map((layer: LayerRecord) => {
            const active = props.activeLayer === layer.id;
            const used = usedLayerIds.has(layer.id);
            return (
              <div
                key={layer.id}
                className={
                  "flex items-center gap-2 rounded px-2 py-1 text-xs " +
                  (active ? "bg-muted font-medium" : "hover:bg-muted/50")
                }
              >
                <button
                  type="button"
                  aria-label={`${layer.name} set active`}
                  title="Set active layer"
                  className={"h-2.5 w-2.5 shrink-0 rounded-full border " + (active ? "border-foreground bg-foreground" : "border-muted-foreground/40")}
                  onClick={() => props.onActiveLayer(layer.id)}
                  disabled={layer.frozen === true}
                />
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  {editingName === layer.id ? (
                    <input
                      autoFocus
                      aria-label="rename layer"
                      className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-xs"
                      defaultValue={layer.name}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const v = (e.target as HTMLInputElement).value.trim();
                          if (v.length > 0 && v !== layer.name) updateLayer(layer.id, { name: v }, "rename layer");
                          setEditingName(null);
                        }
                        if (e.key === "Escape") setEditingName(null);
                      }}
                      onBlur={() => setEditingName(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      title={layer.description ?? layer.name}
                      onDoubleClick={() => setEditingName(layer.id)}
                      onClick={() => props.onActiveLayer(layer.id)}
                      disabled={layer.frozen === true}
                    >
                      {layer.name}
                      {!used && <span className="ml-1 text-[9px] text-muted-foreground/60">(unused)</span>}
                    </button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-4 w-4 p-0 text-muted-foreground/60"
                    aria-label={`delete layer ${layer.name}`}
                    title="Delete layer (blocked while entities reference it)"
                    disabled={used || layer.id === "0"}
                    onClick={() => commit("remove layer", () => api("drafting.removeLayer", { layerId: layer.id }))}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </Button>
                </span>
                <button
                  type="button"
                  aria-label={`${layer.name} ${layer.visible ? "hide" : "show"}`}
                  title={layer.visible ? "Hide layer" : "Show layer"}
                  className="flex w-5 items-center justify-center"
                  onClick={() => updateLayer(layer.id, { visible: !layer.visible }, "layer visibility")}
                >
                  {layer.visible ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
                </button>
                <button
                  type="button"
                  aria-label={`${layer.name} ${layer.frozen === true ? "thaw" : "freeze"}`}
                  title={layer.frozen === true ? "Thaw layer" : "Freeze layer (suppresses display, creation and snap)"}
                  className="flex w-5 items-center justify-center disabled:opacity-30"
                  disabled={active && layer.frozen !== true}
                  onClick={() => updateLayer(layer.id, { frozen: layer.frozen !== true }, "layer freeze")}
                >
                  <Snowflake className={"h-3.5 w-3.5 " + (layer.frozen === true ? "text-sky-600" : "text-muted-foreground")} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`${layer.name} ${layer.locked === true ? "unlock" : "lock"}`}
                  title={layer.locked === true ? "Unlock layer" : "Lock layer (entities become read-only)"}
                  className="flex w-5 items-center justify-center"
                  onClick={() => updateLayer(layer.id, { locked: layer.locked !== true }, "layer lock")}
                >
                  {layer.locked === true ? <Lock className="h-3.5 w-3.5 text-amber-600" aria-hidden /> : <LockOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
                </button>
                <input
                  type="color"
                  aria-label={`${layer.name} color`}
                  title="Layer color"
                  className="h-4 w-6 shrink-0 cursor-pointer rounded border bg-background p-0"
                  value={layer.color}
                  onChange={(e) => updateLayer(layer.id, { color: e.target.value }, "layer color")}
                />
                <select
                  aria-label={`${layer.name} linetype`}
                  title="Layer linetype"
                  className="w-16 rounded border bg-background px-0.5 py-0.5 text-[10px]"
                  value={layer.linetype ?? "Continuous"}
                  onChange={(e) => updateLayer(layer.id, { linetype: e.target.value }, "layer linetype")}
                >
                  {ltypeOptions.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <select
                  aria-label={`${layer.name} lineweight`}
                  title="Layer lineweight (mm)"
                  className="w-12 rounded border bg-background px-0.5 py-0.5 text-[10px]"
                  value={String(layer.lineweight ?? settings?.standards?.defaultLineweight ?? 0.25)}
                  onChange={(e) => updateLayer(layer.id, { lineweight: Number(e.target.value) }, "layer lineweight")}
                >
                  {STANDARD_LINEWEIGHTS.map((w) => (
                    <option key={w} value={w}>{w.toFixed(2)}</option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`${layer.name} plot ${layer.plot !== false ? "off" : "on"}`}
                  title={layer.plot !== false ? "Exclude from plotting" : "Include in plotting"}
                  className="flex w-8 items-center justify-center text-[10px] text-muted-foreground"
                  onClick={() => updateLayer(layer.id, { plot: layer.plot === false }, "layer plot")}
                >
                  {layer.plot !== false ? "✓" : "–"}
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">No layers match the filter.</div>
          )}
        </div>
      </ScrollArea>

      {/* Layer states */}
      <div className="border-t">
        <button
          type="button"
          className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50"
          aria-expanded={showStates}
          onClick={() => setShowStates((s) => !s)}
        >
          <Save className="h-3 w-3" aria-hidden /> Layer states ({states.length})
        </button>
        {showStates && (
          <div className="max-h-32 overflow-y-auto p-1">
            <div className="mb-1 flex items-center gap-1">
              <input
                aria-label="new layer state name"
                className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px]"
                placeholder="State name…"
                value={stateName}
                onChange={(e) => setStateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && stateName.trim().length > 0) {
                    const name = stateName.trim();
                    commit("save layer state", () => api("layerState.save", { name }));
                    setStateName("");
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                disabled={stateName.trim().length === 0}
                onClick={() => {
                  const name = stateName.trim();
                  if (name.length === 0) return;
                  commit("save layer state", () => api("layerState.save", { name }));
                  setStateName("");
                }}
              >
                Save
              </Button>
            </div>
            {states.map((state: LayerStateRecord) => (
              <div key={state.name} className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50">
                <span className="min-w-0 flex-1 truncate font-mono">{state.name}</span>
                <span className="text-[9px] text-muted-foreground">{state.layers.length} layers</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  aria-label={`restore layer state ${state.name}`}
                  title="Restore state"
                  onClick={() => commit("restore layer state", () => api("layerState.restore", { name: state.name }))}
                >
                  <RotateCcw className="h-3 w-3" aria-hidden />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  aria-label={`delete layer state ${state.name}`}
                  title="Delete state"
                  onClick={() => commit("remove layer state", () => api("layerState.remove", { name: state.name }))}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </Button>
              </div>
            ))}
            {states.length === 0 && <div className="px-1 py-1 text-[11px] text-muted-foreground">No saved states.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles managers (linetypes, text styles, dimension styles).
// ---------------------------------------------------------------------------

function StylesPanel(props: PalettesProps): React.JSX.Element {
  const settings = props.snapshot?.draftingSettings;
  const ltypes = props.snapshot?.ltypes ?? [];
  const textStyles = props.snapshot?.textStyles ?? [];
  const dimStyles = props.snapshot?.dimStyles ?? [];
  const commit = props.onCommitEdit;

  const [newLtypeName, setNewLtypeName] = React.useState("");
  const [newLtypePattern, setNewLtypePattern] = React.useState("8,4");
  const [newTextStyleName, setNewTextStyleName] = React.useState("");
  const [newDimStyleName, setNewDimStyleName] = React.useState("");

  const setSettings = (patch: Record<string, unknown>, label: string) =>
    commit(label, () => api("drafting.setSettings", { settings: patch }));

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        {/* Current styles + standards */}
        <div className="mb-2">
          <div className="px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Current</div>
          <PropRow label="text style">
            <select
              aria-label="current text style"
              className="rounded border bg-background px-1 py-0.5 text-xs"
              value={settings?.textStyle ?? "Standard"}
              onChange={(e) => setSettings({ textStyle: e.target.value }, "set current text style")}
            >
              <option value="Standard">Standard (built-in)</option>
              {textStyles.map((s: TextStyleRecord) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          </PropRow>
          <PropRow label="dim style">
            <select
              aria-label="current dim style"
              className="rounded border bg-background px-1 py-0.5 text-xs"
              value={settings?.dimStyle ?? "Standard"}
              onChange={(e) => setSettings({ dimStyle: e.target.value }, "set current dim style")}
            >
              <option value="Standard">Standard (built-in)</option>
              {dimStyles.map((s: DimStyleRecord) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          </PropRow>
          <PropRow label="linetype scale">
            <NumberField
              ariaLabel="linetype scale"
              value={settings?.standards?.linetypeScale ?? 1}
              onCommit={(v) => setSettings({ standards: { linetypeScale: v } }, "set linetype scale")}
            />
          </PropRow>
          {/* CAD-PARITY-005: the document annotation scale (DIMSCALE-class —
              multiplies every dimension annotation's text height and arrow
              size: field × style.scale × this). Positive values only;
              empty/invalid entries never write. */}
          <PropRow label="annotation scale">
            <NumberField
              ariaLabel="annotation scale"
              value={settings?.standards?.annotationScale ?? 1}
              onCommit={(v) => {
                if (v > 0) setSettings({ standards: { annotationScale: v } }, "set annotation scale");
              }}
            />
          </PropRow>
          <PropRow label="default lineweight">
            <select
              aria-label="default lineweight"
              className="rounded border bg-background px-1 py-0.5 text-xs"
              value={String(settings?.standards?.defaultLineweight ?? 0.25)}
              onChange={(e) => setSettings({ standards: { defaultLineweight: Number(e.target.value) } }, "set default lineweight")}
            >
              {STANDARD_LINEWEIGHTS.map((w) => (
                <option key={w} value={w}>{w.toFixed(2)}</option>
              ))}
            </select>
          </PropRow>
        </div>

        <Separator className="my-1" />

        {/* Linetypes */}
        <div className="mb-2">
          <div className="flex items-center gap-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Waves className="h-3 w-3" aria-hidden /> Linetypes
          </div>
          <div className="flex items-center gap-1 px-1 py-1">
            <input
              aria-label="new linetype name"
              className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px]"
              placeholder="Name…"
              value={newLtypeName}
              onChange={(e) => setNewLtypeName(e.target.value)}
            />
            <input
              aria-label="new linetype pattern"
              className="w-16 rounded border bg-background px-1.5 py-0.5 text-[11px] font-mono"
              placeholder="8,4"
              value={newLtypePattern}
              onChange={(e) => setNewLtypePattern(e.target.value)}
              title="Dash/gap lengths in mm, comma separated (even count)"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-1.5 text-[10px]"
              disabled={newLtypeName.trim().length === 0}
              onClick={() => {
                const pattern = newLtypePattern.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
                if (newLtypeName.trim().length > 0) {
                  commit("create linetype", () =>
                    api("ltype.create", { name: newLtypeName.trim(), description: "user-defined", pattern }));
                  setNewLtypeName("");
                }
              }}
            >
              <Plus className="h-3 w-3" aria-hidden />
            </Button>
          </div>
          <ul aria-label="linetypes list" className="px-1">
            {BUILT_IN_LTYPES.map((lt) => (
              <li key={lt.name} className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px]">
                <span className="min-w-0 flex-1 truncate">{lt.name}</span>
                <span className="truncate text-[9px] text-muted-foreground">{lt.description}</span>
                <svg width="42" height="8" aria-hidden className="shrink-0">
                  <line x1="0" y1="4" x2="42" y2="4" stroke="currentColor" strokeWidth="1" strokeDasharray={lt.pattern.length > 0 ? lt.pattern.join(",") : undefined} />
                </svg>
                <Badge variant="secondary" className="h-4 px-1 text-[8px]">built-in</Badge>
              </li>
            ))}
            {ltypes.map((lt: LtypeRecord) => (
              <li key={lt.name} className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50">
                <span className="min-w-0 flex-1 truncate">{lt.name}</span>
                <svg width="42" height="8" aria-hidden className="shrink-0">
                  <line x1="0" y1="4" x2="42" y2="4" stroke="currentColor" strokeWidth="1" strokeDasharray={lt.pattern.join(",")} />
                </svg>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  aria-label={`delete linetype ${lt.name}`}
                  title="Delete linetype (blocked while referenced)"
                  onClick={() => commit("remove linetype", () => api("ltype.remove", { name: lt.name }))}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <Separator className="my-1" />

        {/* Text styles */}
        <div className="mb-2">
          <div className="flex items-center gap-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Type className="h-3 w-3" aria-hidden /> Text styles
          </div>
          <div className="px-1 py-0.5 text-[11px] text-muted-foreground">
            Standard — {STANDARD_TEXT_STYLE.font}, height {STANDARD_TEXT_STYLE.height || "auto"}, width {STANDARD_TEXT_STYLE.widthFactor} (built-in)
          </div>
          <div className="flex items-center gap-1 px-1 py-1">
            <input
              aria-label="new text style name"
              className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px]"
              placeholder="New text style name…"
              value={newTextStyleName}
              onChange={(e) => setNewTextStyleName(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-1.5 text-[10px]"
              disabled={newTextStyleName.trim().length === 0}
              onClick={() => {
                if (newTextStyleName.trim().length > 0) {
                  commit("create text style", () => api("textStyle.create", { name: newTextStyleName.trim() }));
                  setNewTextStyleName("");
                }
              }}
            >
              <Plus className="h-3 w-3" aria-hidden />
            </Button>
          </div>
          <ul aria-label="text styles list" className="px-1">
            {textStyles.map((s: TextStyleRecord) => (
              <li key={s.name} className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50">
                <span className="min-w-0 w-20 truncate">{s.name}</span>
                <select
                  aria-label={`${s.name} font`}
                  className="w-14 rounded border bg-background px-0.5 py-0.5 text-[10px]"
                  value={s.font}
                  onChange={(e) => commit("update text style", () => api("textStyle.update", { name: s.name, patch: { font: e.target.value } }))}
                >
                  <option value="sans">sans</option>
                  <option value="mono">mono</option>
                  <option value="serif">serif</option>
                </select>
                <input
                  type="number"
                  aria-label={`${s.name} height`}
                  title="Fixed height (0 = not fixed)"
                  className="w-12 rounded border bg-background px-0.5 py-0.5 text-right text-[10px]"
                  defaultValue={s.height}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0 && v !== s.height) {
                      commit("update text style", () => api("textStyle.update", { name: s.name, patch: { height: v } }));
                    }
                  }}
                />
                <input
                  type="number"
                  step="0.05"
                  aria-label={`${s.name} width factor`}
                  title="Width factor"
                  className="w-12 rounded border bg-background px-0.5 py-0.5 text-right text-[10px]"
                  defaultValue={s.widthFactor}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0 && v !== s.widthFactor) {
                      commit("update text style", () => api("textStyle.update", { name: s.name, patch: { widthFactor: v } }));
                    }
                  }}
                />
                <input
                  type="number"
                  aria-label={`${s.name} oblique angle`}
                  title="Oblique angle (°)"
                  className="w-12 rounded border bg-background px-0.5 py-0.5 text-right text-[10px]"
                  defaultValue={s.obliqueAngle}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v !== s.obliqueAngle) {
                      commit("update text style", () => api("textStyle.update", { name: s.name, patch: { obliqueAngle: v } }));
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  aria-label={`delete text style ${s.name}`}
                  onClick={() => commit("remove text style", () => api("textStyle.remove", { name: s.name }))}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <Separator className="my-1" />

        {/* Dimension styles */}
        <div className="mb-2">
          <div className="flex items-center gap-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Ruler className="h-3 w-3" aria-hidden /> Dimension styles
          </div>
          <div className="px-1 py-0.5 text-[11px] text-muted-foreground">
            Standard — text {STANDARD_DIM_STYLE.textHeight}, arrows {STANDARD_DIM_STYLE.arrowSize}, scale {STANDARD_DIM_STYLE.scale}, precision {STANDARD_DIM_STYLE.precision} (built-in)
          </div>
          <div className="flex items-center gap-1 px-1 py-1">
            <input
              aria-label="new dim style name"
              className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px]"
              placeholder="New dimension style name…"
              value={newDimStyleName}
              onChange={(e) => setNewDimStyleName(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-1.5 text-[10px]"
              disabled={newDimStyleName.trim().length === 0}
              onClick={() => {
                if (newDimStyleName.trim().length > 0) {
                  commit("create dim style", () => api("dimStyle.create", { name: newDimStyleName.trim() }));
                  setNewDimStyleName("");
                }
              }}
            >
              <Plus className="h-3 w-3" aria-hidden />
            </Button>
          </div>
          <ul aria-label="dimension styles list" className="px-1">
            {dimStyles.map((s: DimStyleRecord) => (
              <li key={s.name} className="flex flex-wrap items-center gap-1 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50">
                <span className="min-w-0 w-20 truncate">{s.name}</span>
                {([
                  { key: "textHeight", label: "text", step: 0.1 },
                  { key: "arrowSize", label: "arrow", step: 0.1 },
                  { key: "scale", label: "scale", step: 0.1 },
                ] as const).map((f) => (
                  <input
                    key={f.key}
                    type="number"
                    step={f.step}
                    aria-label={`${s.name} ${f.label}`}
                    title={`${f.label} (${s.name})`}
                    className="w-12 rounded border bg-background px-0.5 py-0.5 text-right text-[10px]"
                    defaultValue={s[f.key]}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > 0 && v !== s[f.key]) {
                        commit("update dim style", () => api("dimStyle.update", { name: s.name, patch: { [f.key]: v } }));
                      }
                    }}
                  />
                ))}
                <select
                  aria-label={`${s.name} precision`}
                  title="Measurement precision"
                  className="w-10 rounded border bg-background px-0.5 py-0.5 text-[10px]"
                  value={String(s.precision)}
                  onChange={(e) => commit("update dim style", () => api("dimStyle.update", { name: s.name, patch: { precision: Number(e.target.value) } }))}
                >
                  {[0, 1, 2, 3].map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                {/* CAD-PARITY-005: the rendered arrowhead kind ("closed" is
                    the default — selecting it sends the null RESET so records
                    stay canonical-minimal) and the measurement unit suffix
                    (empty sends the null RESET). */}
                <select
                  aria-label={`${s.name} arrow style`}
                  title="Arrowhead kind (closed filled / architectural tick / none)"
                  className="w-14 rounded border bg-background px-0.5 py-0.5 text-[10px]"
                  value={s.arrowStyle ?? "closed"}
                  onChange={(e) =>
                    commit("update dim style", () =>
                      api("dimStyle.update", { name: s.name, patch: { arrowStyle: e.target.value === "closed" ? null : e.target.value } }))}
                >
                  <option value="closed">closed</option>
                  <option value="tick">tick</option>
                  <option value="none">none</option>
                </select>
                <input
                  aria-label={`${s.name} unit suffix`}
                  title={'Unit suffix appended to formatted measurements (e.g. " mm")'}
                  className="w-14 rounded border bg-background px-0.5 py-0.5 text-[10px]"
                  defaultValue={s.unitSuffix ?? ""}
                  placeholder="(none)"
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v !== (s.unitSuffix ?? "")) {
                      commit("update dim style", () =>
                        api("dimStyle.update", { name: s.name, patch: { unitSuffix: v.length === 0 ? null : v } }));
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  aria-label={`delete dim style ${s.name}`}
                  onClick={() => commit("remove dim style", () => api("dimStyle.remove", { name: s.name }))}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// CAD-PARITY-006 (Issue #84): the Blocks & References manager.
// ---------------------------------------------------------------------------

function BlocksPanel(props: PalettesProps): React.JSX.Element {
  const blockDefs = props.snapshot?.blockDefs ?? [];
  const xrefs = props.snapshot?.xrefs ?? [];
  const elements = props.snapshot?.elements ?? [];
  const commit = props.onCommitEdit;

  const instanceCountOf = React.useCallback(
    (defId: string): number =>
      elements.filter((el) => {
        const p = el.props as Record<string, unknown>;
        return p.drafting === true && p.type === "block-ref" && p.blockId === defId;
      }).length,
    [elements],
  );
  const xrefInstanceCountOf = React.useCallback(
    (xrefId: string): number =>
      elements.filter((el) => {
        const p = el.props as Record<string, unknown>;
        return p.drafting === true && p.type === "xref-ref" && p.xrefId === xrefId;
      }).length,
    [elements],
  );

  // The hidden file inputs (Attach/Reload read offisos snapshots — the host
  // re-reads the external file and supplies the content, exactly the
  // ifc.import payload precedent; the command line cannot read files).
  const attachInputRef = React.useRef<HTMLInputElement | null>(null);
  const reloadInputRef = React.useRef<HTMLInputElement | null>(null);
  const reloadTargetRef = React.useRef<string | null>(null);

  /** Read + parse one offisos snapshot file inside the commit (parse failures
   *  surface through the shell's error channel as typed bad_payload
   *  responses — the commit wrapper never sees a rejection). */
  const parseSnapshotFile = async (
    file: File,
  ): Promise<{ ok: true; value: unknown } | { ok: false; response: CommandQueryResponse }> => {
    const text = await file.text();
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (e) {
      return { ok: false, response: apiErr("bad_payload", `could not parse '${file.name}' as JSON: ${(e as Error).message}`) };
    }
  };

  const onAttachFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (attachInputRef.current !== null) attachInputRef.current.value = "";
    if (file === undefined) return;
    const base = file.name.replace(/\.[^.]*$/, "");
    void commit("attach reference", async () => {
      const parsed = await parseSnapshotFile(file);
      if (!parsed.ok) return parsed.response;
      const { xrefAttach } = await import("@/cad/client/http-transport");
      return xrefAttach({ name: base, path: file.name, content: parsed.value, x: 0, y: 0 });
    });
  };

  const onReloadFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    const name = reloadTargetRef.current;
    reloadTargetRef.current = null;
    if (reloadInputRef.current !== null) reloadInputRef.current.value = "";
    if (file === undefined || name === null) return;
    void commit("reload reference", async () => {
      const parsed = await parseSnapshotFile(file);
      if (!parsed.ok) return parsed.response;
      const { xrefReload } = await import("@/cad/client/http-transport");
      return xrefReload(name, parsed.value);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <input
        ref={attachInputRef}
        type="file"
        accept=".offisos,.json"
        className="hidden"
        aria-hidden
        data-testid="xref-attach-input"
        onChange={onAttachFile}
      />
      <input
        ref={reloadInputRef}
        type="file"
        accept=".offisos,.json"
        className="hidden"
        aria-hidden
        aria-label="reload reference file"
        data-testid="xref-reload-input"
        onChange={onReloadFile}
      />

      {/* Attach action */}
      <div className="flex items-center gap-1 border-b p-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          title="Attach an external reference from an offisos snapshot (loaded, with a placement instance at the origin)"
          onClick={() => attachInputRef.current?.click()}
        >
          <Paperclip className="h-3.5 w-3.5" aria-hidden /> Attach…
        </Button>
        <span className="truncate text-[10px] text-muted-foreground">snapshot → loaded reference</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          {/* Definitions */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Block definitions ({blockDefs.length})
          </div>
          <ul aria-label="block definitions">
            {blockDefs.map((def) => {
              const tags = attdefRecordsOf(def);
              const instances = instanceCountOf(def.id);
              return (
                <li key={def.id} className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-muted/50">
                  <Boxes className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{def.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground" title={def.id}>
                      {def.entities.length} entit{def.entities.length === 1 ? "y" : "ies"} · {instances} instance{instances === 1 ? "" : "s"}
                      {tags.length > 0 ? ` · attrs: ${tags.map((t) => String(t.tag)).join(", ")}` : ""}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-1.5 text-[10px]"
                    aria-label={`insert block ${def.name}`}
                    title={`INSERT ‘${def.name}’ (I) — the command line continues with the insertion point, then the attribute prompts`}
                    onClick={() => props.onRunCommand("insert", def.name)}
                  >
                    <PackagePlus className="h-3 w-3" aria-hidden /> Insert
                  </Button>
                </li>
              );
            })}
            {blockDefs.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No block definitions — BLOCK (B) creates one from selected entities.</li>
            )}
          </ul>

          <Separator className="my-1" />

          {/* References */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            External references ({xrefs.length})
          </div>
          <ul aria-label="external references">
            {xrefs.map((x: XrefRecord) => {
              const instances = xrefInstanceCountOf(x.id);
              const loaded = x.status === "loaded";
              return (
                <li key={x.id} className="rounded px-2 py-1 text-[11px] hover:bg-muted/50" data-testid={`xref-row-${x.name}`}>
                  <div className="flex items-center gap-1">
                    {loaded ? (
                      <Badge variant="secondary" className="h-4 gap-1 px-1 text-[9px]">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden /> loaded
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="h-4 border-amber-400 bg-amber-50 px-1 text-[9px] text-amber-700">unresolved</Badge>
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{x.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground" title="Instances of this reference">{instances}×</span>
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground" title={x.path}>
                    {x.path}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {x.entities.length} resolved entit{x.entities.length === 1 ? "y" : "ies"}
                    {x.sourceHash !== null ? ` · source ${x.sourceHash.slice(0, 12)}…` : " · no source hash"}
                  </div>
                  {!loaded && (
                    <p className="text-[10px] text-amber-700">
                      Unresolved — the canvas renders the dashed placeholder box. Reload with the refreshed file to load content.
                    </p>
                  )}
                  <div className="mt-0.5 flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-5 px-1.5 text-[10px]"
                      aria-label={`reload reference ${x.name}`}
                      title="Re-read the external file (XRELOAD) — the reference + every instance pick up the fresh content"
                      onClick={() => {
                        reloadTargetRef.current = x.name;
                        reloadInputRef.current?.click();
                      }}
                    >
                      <RefreshCw className="h-3 w-3" aria-hidden /> Reload
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[10px]"
                      aria-label={`detach reference ${x.name}`}
                      title="Detach (XD) — removes the record AND its instances in ONE atomic revision"
                      onClick={() =>
                        commit("detach reference", async () => {
                          const { xrefDetach } = await import("@/cad/client/http-transport");
                          return xrefDetach(x.name);
                        })
                      }
                    >
                      <Unlink className="h-3 w-3" aria-hidden /> Detach
                    </Button>
                  </div>
                </li>
              );
            })}
            {xrefs.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No external references — XATTACH (XA) or Attach… adds one.</li>
            )}
          </ul>
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigator / project browser.
// ---------------------------------------------------------------------------

function NavigatorPanel(props: PalettesProps): React.JSX.Element {
  const elements = props.snapshot?.elements ?? [];
  const stories = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story");
  const drafting = elements.filter((el) => el.kind === "geometry" && (el.props as Record<string, unknown>).drafting === true);
  const bim = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type !== "bim.story");

  const elementLabel = (el: Element): string => {
    const p = el.props as Record<string, unknown>;
    if (typeof p.name === "string") return p.name;
    // CAD-PARITY-006: the professional type labels of the instance entities.
    if (p.type === "block-ref") return "Block Instance";
    if (p.type === "xref-ref") return "Reference Instance";
    if (typeof p.type === "string") return p.type;
    return el.kind;
  };

  const renderElementList = (title: string, items: readonly Element[]) => (
    <div className="mb-2">
      <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title} ({items.length})</div>
      <ul aria-label={title}>
        {items.slice(0, 200).map((el) => (
          <li key={el.id}>
            <button
              type="button"
              className={
                "flex w-full items-center gap-2 rounded px-2 py-0.5 text-left text-xs " +
                (props.selection.includes(el.id) ? "bg-muted font-medium" : "hover:bg-muted/50")
              }
              onClick={() => props.onSelection(props.selection.includes(el.id) ? props.selection.filter((id) => id !== el.id) : [...props.selection, el.id])}
              aria-pressed={props.selection.includes(el.id)}
            >
              <span className="truncate font-mono text-[10px] text-muted-foreground">{el.id}</span>
              <span className="truncate">{elementLabel(el)}</span>
            </button>
          </li>
        ))}
        {items.length > 200 && <li className="px-2 text-[10px] text-muted-foreground">… {items.length - 200} more</li>}
      </ul>
    </div>
  );

  return (
    <ScrollArea className="h-full">
      <div className="p-1">
        <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Stories ({stories.length})</div>
        <ul aria-label="stories">
          {stories.map((story) => {
            const p = story.props as Record<string, unknown>;
            const active = props.activeStoryId === story.id;
            return (
              <li key={story.id}>
                <button
                  type="button"
                  className={
                    "flex w-full items-center justify-between gap-2 rounded px-2 py-0.5 text-left text-xs " +
                    (active ? "bg-muted font-semibold" : "hover:bg-muted/50")
                  }
                  onClick={() => props.onActiveStory(story.id)}
                  aria-pressed={active}
                  title="Set as the active story for BIM authoring"
                >
                  <span>{typeof p.name === "string" ? p.name : story.id}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {typeof p.level === "number" ? `z ${p.level}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
          {stories.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground">No stories — run STORY (ST) to create one.</li>
          )}
        </ul>
        <Separator className="my-1" />
        {renderElementList("BIM elements", bim)}
        <Separator className="my-1" />
        {renderElementList("Drafting entities", drafting)}
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// CAD-PARITY-007 (Issue #86): the Constraints manager — the parametric
// diagnostics + editing surface.
// ---------------------------------------------------------------------------

/** The shared constraints core (the SAME diagnostics the Electron renderer
 *  and the App API run — LOCK-004 parity by construction). */
import {
  CONSTRAINT_LABEL,
  diagnoseConstraints,
} from "@offisos/cad-app-shell/workspace/constraints";

const OUTCOME_BADGE: Readonly<Record<string, string>> = {
  solved: "bg-emerald-100 text-emerald-800 border-emerald-300",
  "under-constrained": "bg-amber-100 text-amber-800 border-amber-300",
  "over-constrained": "bg-red-100 text-red-800 border-red-300",
  unsatisfied: "bg-orange-100 text-orange-800 border-orange-300",
  ambiguous: "bg-purple-100 text-purple-800 border-purple-300",
  unsupported: "bg-zinc-100 text-zinc-800 border-zinc-300",
};

function ConstraintsPanel(props: PalettesProps): React.JSX.Element {
  const constraints = props.snapshot?.constraints ?? [];
  const elements = props.snapshot?.elements ?? [];
  const commit = props.onCommitEdit;
  // The diagnostics run CLIENT-SIDE through the SHARED solver (verify-only —
  // no mutation; the SAME module the App API's constraints.diagnostics query
  // runs server-side — parity by construction).
  const diagnostics = React.useMemo(
    () => (constraints.length > 0 ? diagnoseConstraints(elements, constraints) : null),
    [constraints, elements],
  );
  const statusById = React.useMemo(
    () => new Map((diagnostics?.statuses ?? []).map((s) => [s.id, s])),
    [diagnostics],
  );
  const [dofOpen, setDofOpen] = React.useState(false);

  const formatTarget = (t: { id: string; anchor?: string }): string =>
    t.anchor !== undefined ? `${t.id}:${t.anchor}` : t.id;

  return (
    <div className="flex h-full flex-col" data-testid="constraints-panel">
      {/* Header: the typed outcome + the explicit solve */}
      <div className="flex items-center gap-1 border-b p-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          title="Re-run the deterministic solve over the whole declared graph (constraint.solve)"
          onClick={() => void commit("solve constraints", async () => {
            const { constraintSolve } = await import("@/cad/client/http-transport");
            return constraintSolve();
          })}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Solve
        </Button>
        {diagnostics === null ? (
          <span className="truncate text-[10px] text-muted-foreground">no constraints declared</span>
        ) : (
          <span
            className={
              "truncate rounded border px-1.5 py-0.5 text-[10px] font-medium " +
              (OUTCOME_BADGE[diagnostics.outcome] ?? "bg-muted text-muted-foreground border-border")
            }
            data-testid="constraints-outcome"
          >
            {diagnostics.outcome}
          </span>
        )}
        {diagnostics !== null && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-1.5 text-[10px] text-muted-foreground"
            aria-expanded={dofOpen}
            onClick={() => setDofOpen((v) => !v)}
            title="Per-component degrees-of-freedom accounting"
          >
            DoF {diagnostics.dof.reduce((sum, c) => sum + c.dof, 0)}
          </Button>
        )}
      </div>
      {dofOpen && diagnostics !== null && (
        <div className="border-b bg-muted/30 p-2 text-[10px] text-muted-foreground">
          {diagnostics.dof.map((c) => (
            <div key={c.entities[0]} className="flex justify-between gap-2 py-0.5">
              <span className="truncate" title={c.entities.join(", ")}>
                {c.entities.length} {c.entities.length === 1 ? "entity" : "entities"} · {c.constraints.length}{" "}
                {c.constraints.length === 1 ? "constraint" : "constraints"}
              </span>
              <span className={c.dof < 0 ? "font-medium text-red-700" : c.dof === 0 ? "font-medium text-emerald-700" : ""}>
                DoF {c.dof}
              </span>
            </div>
          ))}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          {constraints.length === 0 && (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              No constraints declared. Use GEOMCONSTRAINT (GC) / DIMCONSTRAINT (DC) or the Parametric ribbon tab.
            </div>
          )}
          <ul aria-label="declared constraints">
            {constraints.map((c: ConstraintRecord) => {
              const status = statusById.get(c.id);
              const satisfied = status?.satisfied ?? false;
              const dimensional = c.value !== undefined;
              return (
                <li
                  key={c.id}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-muted/50"
                  data-testid={`constraint-row-${c.id}`}
                >
                  <span
                    className={
                      "h-2 w-2 shrink-0 rounded-full " + (satisfied ? "bg-emerald-500" : "bg-red-500")
                    }
                    title={satisfied ? "satisfied" : `not satisfied — ${status?.note ?? "unknown"}`}
                    aria-label={satisfied ? "satisfied" : "violated"}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{CONSTRAINT_LABEL[c.kind] ?? c.kind}</span>
                    <span className="block truncate text-[10px] text-muted-foreground" title={c.id}>
                      {c.targets.map(formatTarget).join(" → ")}
                      {c.mode !== undefined ? ` · ${c.mode}` : ""}
                    </span>
                    {status !== undefined && !satisfied && status.note !== null && (
                      <span className="block truncate text-[10px] text-red-700" title={status.note}>
                        {status.note}
                      </span>
                    )}
                  </span>
                  {dimensional && (
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className={NUM_INPUT + " !w-16"}
                      defaultValue={c.value}
                      key={`${c.id}:${c.value}`}
                      aria-label={`value of constraint ${c.id}`}
                      title="Re-declare the dimensional value and re-solve (constraint.update)"
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n > 0 && n !== c.value) {
                          void commit("update constraint", async () => {
                            const { constraintUpdate } = await import("@/cad/client/http-transport");
                            return constraintUpdate(c.id, { value: n });
                          });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                    aria-label={`remove constraint ${c.id}`}
                    title="Remove the constraint (the geometry stays at its solved state)"
                    onClick={() => void commit("remove constraint", async () => {
                      const { constraintRemove } = await import("@/cad/client/http-transport");
                      return constraintRemove(c.id);
                    })}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dock.
// ---------------------------------------------------------------------------

export function RightDock(props: PalettesProps): React.JSX.Element | null {
  if (!props.visible) return null;
  const tabs: readonly { id: DockTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "properties", label: "Props", icon: Wrench },
    { id: "layers", label: "Layers", icon: LayersIcon },
    { id: "styles", label: "Styles", icon: Type },
    // CAD-PARITY-006: the Blocks & References manager (BLOCKLIST + XREF
    // surfaces — the XREF command's palette.show target).
    { id: "blocks", label: "Blocks", icon: Boxes },
    // CAD-PARITY-007: the Constraints manager (CONSTRAINTS — live solver
    // diagnostics with the six typed outcomes, DoF accounting, dimensional
    // value editing + removal).
    { id: "constraints", label: "Constr", icon: Waypoints },
    { id: "navigator", label: "Nav", icon: Navigation },
  ];
  return (
    <div className="flex w-72 shrink-0 flex-col border-l bg-background" role="complementary" aria-label="palettes">
      <div className="flex border-b" role="tablist" aria-label="palette tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={props.activeTab === tab.id}
            className={
              "flex flex-1 items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium " +
              (props.activeTab === tab.id
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:bg-muted/50")
            }
            onClick={() => props.onTab(tab.id)}
          >
            <tab.icon className="h-3.5 w-3.5" aria-hidden />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {props.activeTab === "properties" && <PropertiesPanel {...props} />}
        {props.activeTab === "layers" && <LayersPanel {...props} />}
        {props.activeTab === "styles" && <StylesPanel {...props} />}
        {props.activeTab === "blocks" && <BlocksPanel {...props} />}
        {props.activeTab === "constraints" && <ConstraintsPanel {...props} />}
        {props.activeTab === "navigator" && <NavigatorPanel {...props} />}
      </div>
      <div className="border-t p-2 text-[10px] text-muted-foreground">
        Snap tol {props.snapshot?.draftingSettings?.snap.tolerance ?? 0.5} mm · grid {props.snapshot?.draftingSettings?.grid.size ?? 1} mm · {props.snapshot?.draftingSettings?.units ?? "mm"}
      </div>
    </div>
  );
}

export { setSelection };
