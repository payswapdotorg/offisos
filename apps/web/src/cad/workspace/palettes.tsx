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
  Network,
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
  LayoutTemplate,
  Printer,
  FileOutput,
  Copy,
  // CAD-PARITY-012 (Issue #102): the Coordination palette icons.
  Cloud,
  ClipboardList,
  // CAD-PARITY-013 (Issue #104): the Documentation palette icon (the
  // navigator View Map + Layout Book, title blocks, revisions, schedules
  // and the publisher — the Docs dock tab).
  BookOpen,
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
// CAD-PARITY-013 (Issue #104): the P013 transport mirror types (type-only —
// erased at compile time, the lazy dynamic-import pattern is unchanged).
import type {
  NavigatorBookBranch,
  NavigatorLayoutRow,
  NavigatorNodeRecord,
  NavigatorTree,
  NavigatorViewBranch,
  NavigatorViewRow,
  PublisherRunResult,
  RevisionRecord,
  ScheduleRunResult,
  ScheduleSource,
  SchedulesListRow,
  TitleBlockRow,
} from "@/cad/client/http-transport";
// CAD-PARITY-012 (Issue #102): the shared materials/coordination cores — the
// SAME vocabulary the App API and the canvas run (the constrained category
// list, the materialId readers, the block-instance material resolution and
// the grid-label minting; LOCK-004 parity by construction).
import {
  MATERIAL_CATEGORIES,
  materialIdOf,
  resolvedBlockMaterialId,
} from "@offisos/cad-app-shell/workspace/materials";
import {
  gridULabels,
  gridVLabels,
} from "@offisos/cad-app-shell/workspace/coordination";
// CAD-PARITY-012: the shared material display helpers (swatch colors +
// lineweight resolution — the same module the shell and the canvas run).
import {
  materialColorHex,
  materialLineweight,
  materialViewsOf,
} from "@/cad/workspace/material-display";

export type DockTab =
  | "properties"
  | "layers"
  | "styles"
  | "blocks"
  | "constraints"
  | "layouts"
  | "coordination"
  // CAD-PARITY-013 (Issue #104): the Documentation manager (the navigator
  // View Map + Layout Book, title blocks, revisions, schedules, publisher —
  // the REVLIST/SCHLIST commands' palette target).
  | "documentation"
  | "navigator";

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

/** CAD-PARITY-012 (Issue #102): the Material assignment row — the id-sorted
 *  material select (+ Unassigned) with the RESOLVED color swatch. The
 *  assignment dispatches through material.assign (ONE atomic revision per
 *  change, full-record setProps rewrites — the exact undo inverse). */
function MaterialAssignRow(props: {
  readonly materials: readonly { id: string; name: string; category?: string; color?: readonly number[]; lineweight?: number }[];
  /** The element's OWN assignment (null = unassigned/inherit). */
  readonly value: string | null;
  /** The RESOLVED material (instance ?? definition default ?? null). */
  readonly resolvedId: string | null;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly onAssign: (materialId: string | null) => void;
}): React.JSX.Element {
  const resolved = props.materials.find((m) => m.id === props.resolvedId);
  return (
    <PropRow label="material">
      <select
        aria-label="assigned material"
        className="rounded border bg-background px-1 py-0.5 text-xs"
        value={props.value ?? ""}
        disabled={props.disabled}
        data-testid={props.testId}
        title="Assign (or clear) the material — MATSET semantics, one atomic revision"
        onChange={(e) => props.onAssign(e.target.value.length === 0 ? null : e.target.value)}
      >
        <option value="">Unassigned</option>
        {props.materials.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
      {resolved !== undefined && (
        <span
          className="h-3 w-3 shrink-0 rounded-sm border"
          style={{ background: materialColorHex(resolved) }}
          title={`${resolved.name} — ${materialColorHex(resolved)} · ${materialLineweight(resolved).toFixed(2)} mm`}
          aria-label={`resolved material ${resolved.name}`}
        />
      )}
    </PropRow>
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
  // CAD-PARITY-012 (Issue #102): the material table (id-sorted — the SAME
  // rows the materials.list query serves) for the Material assignment rows.
  const materials = React.useMemo(() => materialViewsOf(elements), [elements]);
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

        {/* CAD-PARITY-012 (Issue #102): the Material assignment row — the
            select dispatches material.assign (ONE atomic revision; the
            resolved swatch + lineweight readout show exactly what the canvas
            paints: entity explicit > material > layer). Geometry elements
            only — annotations carry no material association. */}
        {p.drafting === true && anno === null && blockRef === null && xrefRef === null && (
          <PropSection title="Material">
            <MaterialAssignRow
              materials={materials}
              value={materialIdOf(p)}
              resolvedId={materialIdOf(p)}
              disabled={locked}
              testId="properties-material-select"
              onAssign={(materialId) =>
                commit("material.assign", async () => {
                  const { materialAssign } = await import("@/cad/client/http-transport");
                  return materialAssign([el.id], materialId);
                })
              }
            />
            {materialIdOf(p) !== null && materials.some((m) => m.id === materialIdOf(p)) ? (
              <PropRow label="↳ resolved lw">
                <code className="font-mono text-[11px]">
                  {materialLineweight(materials.find((m) => m.id === materialIdOf(p))!).toFixed(2)} mm
                </code>
              </PropRow>
            ) : (
              <PropRow label="↳ effective lw">
                <code className="font-mono text-[11px]">{(layer?.lineweight ?? 0.25).toFixed(2)} mm (layer)</code>
              </PropRow>
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
            {/* CAD-PARITY-012 (Issue #102): the per-INSTANCE material override
                — material.assign writes the element props (ONE atomic
                revision); the resolved row shows instance ?? definition
                default (exactly what the canvas paints on every piece). */}
            <MaterialAssignRow
              materials={materials}
              value={blockRef.materialId ?? materialIdOf(p)}
              resolvedId={resolvedBlockMaterialId(p, blockDef?.materialId)}
              disabled={locked}
              testId="properties-instance-material-select"
              onAssign={(materialId) =>
                commit("material.assign", async () => {
                  const { materialAssign } = await import("@/cad/client/http-transport");
                  return materialAssign([el.id], materialId);
                })
              }
            />
            {(() => {
              const resolvedMaterial = materials.find(
                (m) => m.id === resolvedBlockMaterialId(p, blockDef?.materialId),
              );
              if (resolvedMaterial === undefined) return null;
              return (
                <PropRow label="↳ resolved">
                  <code className="font-mono text-[11px]">
                    {resolvedMaterial.name} · {materialLineweight(resolvedMaterial).toFixed(2)} mm
                  </code>
                </PropRow>
              );
            })()}
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

/** Flatten the View Map branches to their folder nodes (select options). */
function flattenFolderNodes(branches: readonly NavigatorViewBranch[]): readonly NavigatorNodeRecord[] {
  const out: NavigatorNodeRecord[] = [];
  const walk = (bs: readonly NavigatorViewBranch[]): void => {
    for (const b of bs) {
      out.push(b.node);
      walk(b.children);
    }
  };
  walk(branches);
  return out;
}

/** Flatten the Layout Book branches to their subset nodes (select options). */
function flattenSubsetNodes(branches: readonly NavigatorBookBranch[]): readonly NavigatorNodeRecord[] {
  const out: NavigatorNodeRecord[] = [];
  const walk = (bs: readonly NavigatorBookBranch[]): void => {
    for (const b of bs) {
      out.push(b.node);
      walk(b.children);
    }
  };
  walk(branches);
  return out;
}

/** Flatten the View Map to every view row (root + nested, document order). */
function flattenViewRows(tree: NavigatorTree | null): readonly NavigatorViewRow[] {
  if (tree === null) return [];
  const out: NavigatorViewRow[] = [...tree.viewMap.views];
  const walk = (bs: readonly NavigatorViewBranch[]): void => {
    for (const b of bs) {
      out.push(...b.views);
      walk(b.children);
    }
  };
  walk(tree.viewMap.children);
  return out;
}

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

  // CAD-PARITY-013 (Issue #104): the LOADING/ERROR fallback — the legacy
  // client-derived story/BIM/drafting lists keep the panel from ever
  // blanking while the canonical navigator.tree query loads (or failed).
  const renderLegacyLists = (): React.JSX.Element => (
    <>
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
                data-testid={`navigator-story-${story.id}`}
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
    </>
  );

  // --- CAD-PARITY-013 (Issue #104): the canonical navigator tree ----------
  // Query-backed (fresh on every document version change — the commit path
  // bumps the version); falls back to the client-derived lists above while
  // loading / on query error. Row clicks route through the SAME channels
  // (stories → onActiveStory, views/layouts → onSelection).
  const [tree, setTree] = React.useState<NavigatorTree | null>(null);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const version = props.snapshot?.version?.version_number ?? 0;

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const transport = await import("@/cad/client/http-transport");
      const res = await transport.navigatorTree();
      if (cancelled) return;
      const value = transport.unwrapNavigatorTree(res);
      if (value === null) {
        setQueryError(`[navigator.tree] ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`);
        return;
      }
      setQueryError(null);
      setTree(value);
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  const layouts = props.snapshot?.layouts ?? [];

  const renderNavViewRow = (view: NavigatorViewRow, depth: number): React.JSX.Element => (
    <li key={view.viewId}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-[11px] hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`navigator-view-${view.viewId}`}
        onClick={() => props.onSelection([view.viewId])}
        title={`Select the saved view (kind ${view.kind}${view.scale !== undefined ? `, scale 1:${view.scale}` : ""})`}
      >
        <span className="truncate">{view.title}</span>
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">{view.kind}</Badge>
        {view.scale !== undefined && <span className="shrink-0 text-[9px] text-muted-foreground">1:{view.scale}</span>}
        {view.contentHash !== undefined && (
          <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground" title={view.contentHash}>
            {view.contentHash.slice(0, 8)}
          </span>
        )}
      </button>
    </li>
  );

  const renderNavViewBranch = (branch: NavigatorViewBranch, depth: number): React.JSX.Element => (
    <li key={branch.node.id}>
      <div
        className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`navigator-folder-${branch.node.id}`}
      >
        <span className="truncate">{branch.node.name}</span>
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{branch.views.length} view{branch.views.length === 1 ? "" : "s"}</span>
      </div>
      <ul aria-label={`folder ${branch.node.name}`}>
        {branch.views.map((v) => renderNavViewRow(v, depth + 1))}
        {branch.children.map((c) => renderNavViewBranch(c, depth + 1))}
      </ul>
    </li>
  );

  const renderNavLayoutRow = (row: NavigatorLayoutRow, depth: number): React.JSX.Element => (
    <li key={row.layoutId}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-[11px] hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`navigator-layout-${row.layoutId}`}
        onClick={() => props.onSelection([row.layoutId])}
        title={`Select the layout (sheet ${row.sheetNumber}${row.masterId !== undefined ? `, master ${row.masterId}` : ""})`}
      >
        <span className="truncate">{row.name}</span>
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{row.sheetNumber}</span>
        {row.masterId !== undefined && (
          <span className="shrink-0 text-[9px] text-muted-foreground">→ master</span>
        )}
        {row.revisionCodes.length > 0 && (
          <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{row.revisionCodes.join(",")}</span>
        )}
      </button>
    </li>
  );

  const renderNavBookBranch = (branch: NavigatorBookBranch, depth: number): React.JSX.Element => (
    <li key={branch.node.id}>
      <div
        className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`navigator-subset-${branch.node.id}`}
      >
        <span className="truncate">{branch.node.name}</span>
        {branch.node.prefix !== undefined && <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">[{branch.node.prefix}]</Badge>}
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{branch.layouts.length} sheet{branch.layouts.length === 1 ? "" : "s"}</span>
      </div>
      <ul aria-label={`subset ${branch.node.name}`}>
        {branch.layouts.map((l) => renderNavLayoutRow(l, depth + 1))}
        {branch.children.map((c) => renderNavBookBranch(c, depth + 1))}
      </ul>
    </li>
  );

  return (
    <ScrollArea className="h-full">
      <div className="p-1" data-testid="navigator-panel">
        {queryError !== null && (
          <div className="m-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-800" role="alert">
            {queryError} — showing the client-derived model tree.
          </div>
        )}
        {tree === null || queryError !== null ? (
          renderLegacyLists()
        ) : (
          <>
            {/* The project map (stories + element counts). */}
            <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Project map ({tree.projectMap.stories.length} stor{tree.projectMap.stories.length === 1 ? "y" : "ies"})
            </div>
            <ul aria-label="project map stories">
              {tree.projectMap.stories.map((story) => (
                <li key={story.id}>
                  <button
                    type="button"
                    className={
                      "flex w-full items-center justify-between gap-2 rounded px-2 py-0.5 text-left text-xs " +
                      (props.activeStoryId === story.id ? "bg-muted font-semibold" : "hover:bg-muted/50")
                    }
                    onClick={() => props.onActiveStory(story.id)}
                    aria-pressed={props.activeStoryId === story.id}
                    data-testid={`navigator-story-${story.id}`}
                    title="Set as the active story for BIM authoring"
                  >
                    <span>{story.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      z {story.level} · {story.elementCount} element{story.elementCount === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
              {tree.projectMap.stories.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">No stories — run STORY (ST) to create one.</li>
              )}
            </ul>
            <Separator className="my-1" />
            {/* The View Map (saved views filed under navigator folders). */}
            <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">View Map</div>
            <div data-testid="navigator-viewmap">
              <ul aria-label="view map">
                {tree.viewMap.views.map((v) => renderNavViewRow(v, 0))}
                {tree.viewMap.children.map((c) => renderNavViewBranch(c, 0))}
              </ul>
              {tree.viewMap.views.length === 0 && tree.viewMap.children.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  No saved views — the Documentation workbench (DOCSVIEWS) creates them.
                </div>
              )}
            </div>
            <Separator className="my-1" />
            {/* The Layout Book (layouts filed under navigator subsets). */}
            <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Layout Book</div>
            <div data-testid="navigator-layoutbook">
              <ul aria-label="layout book">
                {tree.layoutBook.layouts.map((l) => renderNavLayoutRow(l, 0))}
                {tree.layoutBook.children.map((c) => renderNavBookBranch(c, 0))}
              </ul>
              {tree.layoutBook.layouts.length === 0 && tree.layoutBook.children.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  No layouts — run LAYOUTNEW to create one.
                </div>
              )}
            </div>
            <Separator className="my-1" />
            {/* The publisher-set registry. */}
            <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Publisher sets ({tree.publisherSets.length})
            </div>
            <ul aria-label="publisher sets">
              {tree.publisherSets.map((set) => (
                <li
                  key={set.id}
                  className="flex items-center justify-between gap-2 rounded px-2 py-0.5 text-[11px] hover:bg-muted/50"
                  data-testid={`navigator-pubset-${set.id}`}
                >
                  <span className="truncate">{set.name}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{set.itemCount} item{set.itemCount === 1 ? "" : "s"}</span>
                </li>
              ))}
              {tree.publisherSets.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">No publisher sets — PUBSET creates one.</li>
              )}
            </ul>
            <div className="px-2 pt-1 text-[10px] text-muted-foreground">
              {layouts.length} layout{layouts.length === 1 ? "" : "s"} · the Documentation dock tab manages the book, schedules and publisher.
            </div>
          </>
        )}
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

// ---------------------------------------------------------------------------
// CAD-PARITY-008: the Layouts manager (Issue #88) — the layout table with
// page setup, the viewport inventory (scale/rotation/lock — the 1:N field IS
// the viewport-scale ZOOM workflow) and the per-viewport layer visibility
// (the VPLAYER surface). Every write is ONE App API command (one atomic
// revision); the layout.activate context switch is non-versioned editor
// state (the activeLayer precedent).
// ---------------------------------------------------------------------------

function LayoutsPanel(props: PalettesProps): React.JSX.Element {
  const commit = props.onCommitEdit;
  const layouts = props.snapshot?.layouts ?? [];
  const viewports = props.snapshot?.viewports ?? [];
  const layers = props.snapshot?.layers ?? [];
  const activeLayoutId = props.snapshot?.draftingSettings?.activeLayout ?? layouts[0]?.id ?? null;
  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? null;
  const layoutViewports = viewports.filter((v) => v.layoutId === activeLayout?.id);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameText, setRenameText] = React.useState("");
  const [newName, setNewName] = React.useState("");
  const [layerVpOpen, setLayerVpOpen] = React.useState<string | null>(null);

  const setActive = (name: string): void => {
    void commit("layout.activate", async () => {
      const { layoutActivate } = await import("@/cad/client/http-transport");
      return layoutActivate({ name });
    });
  };

  const setup = activeLayout?.pageSetup;

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="layouts-panel">
      {/* Header: new layout + the manager actions */}
      <div className="flex items-center gap-1 border-b p-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          title="Create a paper-space layout with the canonical A3 landscape page setup (LAYOUTNEW)"
          onClick={() => props.onRunCommand("layoutnew")}
          data-testid="layouts-new"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> New
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          title="The bounded viewport manager (VPORTS)"
          onClick={() => props.onRunCommand("vports")}
        >
          Viewports
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          title="The deterministic plot preview of the active layout (PREVIEW)"
          onClick={() => props.onRunCommand("preview")}
        >
          <Printer className="h-3.5 w-3.5" aria-hidden /> Preview
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          title="Publish every layout as one multi-page PDF (PUBLISH)"
          onClick={() => props.onRunCommand("publish")}
        >
          <FileOutput className="h-3.5 w-3.5" aria-hidden /> Publish
        </Button>
      </div>

      {layouts.length === 0 && (
        <div className="p-3 text-xs text-muted-foreground" data-testid="layouts-empty">
          No layouts yet — <span className="font-mono text-foreground">LAYOUTNEW</span> creates one with the canonical A3 landscape page setup (10 mm margins, fit, as-displayed plot style).
        </div>
      )}

      {/* The layout table */}
      <PropSection title={`Layouts (${layouts.length})`}>
        {layouts.map((layout) => {
          const vps = viewports.filter((v) => v.layoutId === layout.id);
          const isActive = layout.id === activeLayout?.id;
          return (
            <div
              key={layout.id}
              className={"rounded border px-2 py-1.5 " + (isActive ? "border-foreground/40 bg-muted/40" : "border-border")}
              data-testid={"layout-row-" + layout.id}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={"flex-1 truncate text-left text-xs font-medium " + (isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                  onClick={() => setActive(layout.name)}
                  title="Activate this layout (paper space)"
                >
                  {isActive ? "▸ " : ""}
                  {layout.name}
                </button>
                <span className="font-mono text-[9px] text-muted-foreground">{layout.pageSetup.paperSize}</span>
                <span className="font-mono text-[9px] text-muted-foreground">{vps.length}vp</span>
                <button
                  type="button"
                  className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted"
                  title="Rename layout (LAYOUTRENAME)"
                  onClick={() => {
                    setRenaming(layout.id);
                    setRenameText(layout.name);
                  }}
                >
                  <Wrench className="h-3 w-3" aria-hidden />
                </button>
                <button
                  type="button"
                  className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted"
                  title="Clone layout with its viewports (LAYOUTCLONE)"
                  onClick={() =>
                    void commit("layout.clone", async () => {
                      const { layoutClone } = await import("@/cad/client/http-transport");
                      return layoutClone({ name: layout.name }, `${layout.name}-Copy`);
                    })
                  }
                >
                  <Copy className="h-3 w-3" aria-hidden />
                </button>
                <button
                  type="button"
                  className="rounded px-1 text-[10px] text-red-600/80 hover:bg-red-50"
                  title="Delete layout and its viewports (LAYOUTDELETE)"
                  onClick={() =>
                    void commit("layout.remove", async () => {
                      const { layoutRemove } = await import("@/cad/client/http-transport");
                      return layoutRemove({ name: layout.name });
                    })
                  }
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              </div>
              {renaming === layout.id && (
                <div className="mt-1 flex gap-1">
                  <input
                    className={TEXT_INPUT + " flex-1"}
                    value={renameText}
                    aria-label="new layout name"
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void commit("layout.rename", async () => {
                          const { layoutRename } = await import("@/cad/client/http-transport");
                          return layoutRename({ name: layout.name }, renameText.trim());
                        });
                        setRenaming(null);
                      }
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    autoFocus
                  />
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      void commit("layout.rename", async () => {
                        const { layoutRename } = await import("@/cad/client/http-transport");
                        return layoutRename({ name: layout.name }, renameText.trim());
                      });
                      setRenaming(null);
                    }}
                  >
                    OK
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </PropSection>

      {/* The page setup of the ACTIVE layout */}
      {setup !== undefined && activeLayout !== null && (
        <PropSection title="Page setup (active)">
          <PropRow label="Paper">
            <select
              className={SELECT_INPUT}
              aria-label="paper size"
              value={setup.paperSize === "CUSTOM" ? "CUSTOM" : setup.paperSize}
              onChange={(e) => {
                const size = e.target.value as "A4" | "A3" | "A2" | "A1" | "A0";
                const dims: Record<string, { w: number; h: number }> = {
                  A4: { w: 210, h: 297 },
                  A3: { w: 297, h: 420 },
                  A2: { w: 420, h: 594 },
                  A1: { w: 594, h: 841 },
                  A0: { w: 841, h: 1189 },
                };
                const d = dims[size]!;
                void commit("layout.setPageSetup", async () => {
                  const { layoutSetPageSetup } = await import("@/cad/client/http-transport");
                  return layoutSetPageSetup({ name: activeLayout.name }, { paperSize: size, widthMm: d.w, heightMm: d.h });
                });
              }}
            >
              {["A4", "A3", "A2", "A1", "A0"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
              {setup.paperSize === "CUSTOM" && <option value="CUSTOM">CUSTOM</option>}
            </select>
          </PropRow>
          <PropRow label="Orientation">
            <select
              className={SELECT_INPUT}
              aria-label="orientation"
              value={setup.orientation}
              onChange={(e) => {
                const orientation = e.target.value as "portrait" | "landscape";
                void commit("layout.setPageSetup", async () => {
                  const { layoutSetPageSetup } = await import("@/cad/client/http-transport");
                  return layoutSetPageSetup({ name: activeLayout.name }, { orientation });
                });
              }}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </PropRow>
          <PropRow label="Margin (mm)">
            <NumberField
              value={setup.marginsMm.top}
              step={1}
              ariaLabel="uniform margin mm"
              onCommit={(m) => {
                void commit("layout.setPageSetup", async () => {
                  const { layoutSetPageSetup } = await import("@/cad/client/http-transport");
                  return layoutSetPageSetup({ name: activeLayout.name }, { marginsMm: { top: m, right: m, bottom: m, left: m } });
                });
              }}
            />
          </PropRow>
          <PropRow label="Plot scale">
            <input
              className={TEXT_INPUT + " flex-1"}
              defaultValue={setup.plotScale}
              key={setup.plotScale}
              aria-label="plot scale (fit or N:M)"
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value === setup.plotScale) return;
                void commit("layout.setPageSetup", async () => {
                  const { layoutSetPageSetup } = await import("@/cad/client/http-transport");
                  return layoutSetPageSetup({ name: activeLayout.name }, { plotScale: value });
                });
              }}
            />
          </PropRow>
          <PropRow label="Center plot">
            <input
              type="checkbox"
              checked={setup.centerPlot}
              aria-label="center the plot"
              onChange={(e) => {
                const centerPlot = e.target.checked;
                void commit("layout.setPageSetup", async () => {
                  const { layoutSetPageSetup } = await import("@/cad/client/http-transport");
                  return layoutSetPageSetup({ name: activeLayout.name }, { centerPlot });
                });
              }}
            />
          </PropRow>
          <PropRow label="Plot borders">
            <input
              type="checkbox"
              checked={setup.plotViewports !== false}
              aria-label="plot viewport borders"
              onChange={(e) => {
                const plotViewports = e.target.checked;
                void commit("layout.setPageSetup", async () => {
                  const { layoutSetPageSetup } = await import("@/cad/client/http-transport");
                  return layoutSetPageSetup({ name: activeLayout.name }, { plotViewports });
                });
              }}
            />
          </PropRow>
          <div className="px-1 text-[9px] text-muted-foreground">
            Plot style: {setup.plotStyleKind === "none" ? "none (as displayed)" : `${setup.plotStyleTable} — CTB/STB application is a typed decline`}
          </div>
        </PropSection>
      )}

      {/* The viewport inventory of the active layout */}
      <PropSection title={`Viewports — ${activeLayout?.name ?? "…"} (${layoutViewports.length})`}>
        {layoutViewports.length === 0 && (
          <div className="px-1 text-[10px] text-muted-foreground">
            None yet — <span className="font-mono text-foreground">MVIEW</span> places one (two paper corners + Fit/Scale/Window).
          </div>
        )}
        {layoutViewports.map((vp) => {
          const locked = vp.locked === true;
          return (
            <div key={vp.id} className="rounded border border-border px-2 py-1.5" data-testid={"viewport-row-" + vp.id}>
              <div className="flex items-center gap-1">
                <span className="font-mono text-[10px] font-semibold">{vp.id}</span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                  1:{Number(vp.scaleDenominator.toFixed(3))} · {vp.rotationDeg}°
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                <label className="flex items-center gap-1">
                  1:
                  <NumberField
                    value={vp.scaleDenominator}
                    step={1}
                    ariaLabel={"viewport " + vp.id + " scale denominator"}
                    disabled={locked}
                    onCommit={(d) => {
                      void commit("viewport scale", async () => {
                        const { viewportUpdate } = await import("@/cad/client/http-transport");
                        return viewportUpdate(vp.id, { scaleDenominator: d });
                      });
                    }}
                  />
                </label>
                <label className="flex items-center gap-1">
                  rot°
                  <NumberField
                    value={vp.rotationDeg}
                    step={15}
                    ariaLabel={"viewport " + vp.id + " rotation degrees"}
                    disabled={locked}
                    onCommit={(r) => {
                      void commit("viewport rotation", async () => {
                        const { viewportUpdate } = await import("@/cad/client/http-transport");
                        return viewportUpdate(vp.id, { rotationDeg: r });
                      });
                    }}
                  />
                </label>
                <label className="flex items-center gap-1" title="Display lock: the view (camera/scale/rotation) freezes; the frame still moves">
                  <input
                    type="checkbox"
                    checked={locked}
                    aria-label={"viewport " + vp.id + " display lock"}
                    onChange={(e) => {
                      const value = e.target.checked;
                      void commit("viewport lock", async () => {
                        const { viewportUpdate } = await import("@/cad/client/http-transport");
                        return viewportUpdate(vp.id, { locked: value });
                      });
                    }}
                  />
                  lock
                </label>
                <button
                  type="button"
                  className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted"
                  aria-expanded={layerVpOpen === vp.id}
                  onClick={() => setLayerVpOpen((id) => (id === vp.id ? null : vp.id))}
                >
                  layers
                </button>
                <button
                  type="button"
                  className="ml-auto rounded px-1 text-red-600/80 hover:bg-red-50"
                  title="Delete viewport"
                  onClick={() =>
                    void commit("viewport.remove", async () => {
                      const { viewportRemove } = await import("@/cad/client/http-transport");
                      return viewportRemove(vp.id);
                    })
                  }
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              </div>
              {layerVpOpen === vp.id && (
                <div className="mt-1 max-h-40 overflow-y-auto rounded bg-muted/30 p-1" data-testid={"viewport-layers-" + vp.id}>
                  <div className="mb-1 text-[9px] text-muted-foreground">Per-viewport layer visibility (VPLAYER) — absent = inherit the layer table</div>
                  {layers.map((layer) => {
                    const override = (vp.layerOverrides ?? []).find((o) => o.layerId === layer.id);
                    const effective = override?.visible ?? layer.visible;
                    return (
                      <label key={layer.id} className="flex items-center gap-1 py-0.5 text-[10px]">
                        <input
                          type="checkbox"
                          checked={effective}
                          aria-label={"viewport layer " + layer.name + " visible"}
                          onChange={(e) => {
                            const visible = e.target.checked;
                            const next = layers
                              .map((l2) => {
                                const o = (vp.layerOverrides ?? []).find((x) => x.layerId === l2.id);
                                const eff = o?.visible ?? l2.visible;
                                return { layerId: l2.id, visible: eff };
                              })
                              .filter((o) => o.visible !== layers.find((l2) => l2.id === o.layerId)!.visible || (vp.layerOverrides ?? []).some((x) => x.layerId === o.layerId));
                            // Keep entries only where the override DIFFERS from
                            // the table (canonical-minimal overrides).
                            const entry = next.find((o) => o.layerId === layer.id);
                            if (entry !== undefined) entry.visible = visible;
                            const cleaned = next.filter((o) => o.visible !== layers.find((l2) => l2.id === o.layerId)!.visible);
                            void commit("viewport layer visibility", async () => {
                              const { viewportUpdate } = await import("@/cad/client/http-transport");
                              return viewportUpdate(vp.id, { layerOverrides: cleaned });
                            });
                          }}
                        />
                        <span className="flex-1 truncate">{layer.name}</span>
                        {override !== undefined && <span className="font-mono text-[8px] text-muted-foreground">override</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </PropSection>
      <div className="p-2 text-[10px] text-muted-foreground">
        The layout tabs live above the canvas; the paper canvas edits viewport frames (grip resize/move). PLOT/PUBLISH export deterministic SVG/PDF.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CAD-PARITY-012 (Issue #102): the Coordination manager — materials,
// components and coordination. The MATLIST/BOM/CLASH commands and the
// Materials/Coordination ribbon tabs open this palette.
//
// The tables load through the SAME App API queries the report commands run
// (materials.list / components.list / grids.list — the live document state,
// never a cached copy) and reload whenever the document version changes
// (every commit goes through onCommitEdit → the shell refresh → a new
// version). Every write is ONE atomic App API command (one revision, one
// undo entry; typed failures surface through the shell's error channel —
// e.g. material_in_use on a referenced material).
// ---------------------------------------------------------------------------

/** [r, g, b] 0..255 parsed from a #RRGGBB input (defensive — malformed
 *  values read as the Generic default, never throw). */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex.trim());
  if (m === null) return [161, 161, 170];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** Parse a comma-separated strictly-ascending offset list (the CGRID line
 *  grammar — same rules the server validates). */
function parseAscendingOffsets(text: string): number[] | null {
  const parts = text.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const values: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    if (values[i]! <= values[i - 1]!) return null;
  }
  return values;
}

/** Format a grid's derived labels like "A,B,C / 1,2,3" (bounded preview). */
function gridLabelPreview(labels: readonly string[]): string {
  if (labels.length <= 6) return labels.join(",");
  return `${labels.slice(0, 6).join(",")}…`;
}

/** Describe one failed query response for the palette error surface
 *  (typed code/message on err; honest "unexpected shape" on ok mismatches). */
function describeQueryFailure(res: CommandQueryResponse): string {
  return res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`;
}

function CoordinationPanel(props: PalettesProps): React.JSX.Element {
  const commit = props.onCommitEdit;
  // The live tables (loaded through the App API queries; null = loading).
  const [materials, setMaterials] = React.useState<readonly {
    id: string; name: string; category?: string; color?: readonly number[]; lineweight?: number;
  }[] | null>(null);
  const [components, setComponents] = React.useState<readonly {
    id: string; name: string; materialId: string | null; instanceCount: number; instanceIds: readonly string[];
  }[] | null>(null);
  const [grids, setGrids] = React.useState<readonly {
    id: string; name: string; storyId: string | null; uLines: readonly number[]; vLines: readonly number[];
    uLabels: readonly string[]; vLabels: readonly string[];
  }[] | null>(null);
  // The on-demand coordination reports.
  const [bom, setBom] = React.useState<{ unit: string; rows: readonly { materialId: string | null; name: string; count: number; length: number; area: number }[] } | null>(null);
  const [clash, setClash] = React.useState<{ pairs: readonly { a: string; b: string; points: readonly { x: number; y: number }[] }[]; checked: number; excluded: number } | null>(null);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  // The create-material form (color defaults to the category default — the
  // MATERIAL command's "Enter = category default" semantics).
  const [newName, setNewName] = React.useState("");
  const [newCategory, setNewCategory] = React.useState<string>("Generic");
  const [newColor, setNewColor] = React.useState<string>(materialColorHex({ category: "Generic" }));
  const [newLineweight, setNewLineweight] = React.useState<number>(1.4);
  // The create-grid form (the CGRID grammar).
  const [gridName, setGridName] = React.useState("");
  const [gridU, setGridU] = React.useState("0,6000");
  const [gridV, setGridV] = React.useState("0,4000");
  // The assign-to-selection select (resets after every dispatch).
  const [assignTarget, setAssignTarget] = React.useState<string>("");

  // The document version the loaded tables were read at.
  const version = props.snapshot?.version?.version_number ?? 0;

  // Load the tables through the App API queries (fresh on mount and on every
  // document version change — the commit path bumps the version).
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const transport = await import("@/cad/client/http-transport");
      const [matRes, compRes, gridRes, bomRes, clashRes] = await Promise.all([
        transport.materialsList(),
        transport.componentsList(),
        transport.gridsList(),
        transport.materialsBom(),
        transport.coordinationClash(),
      ]);
      if (cancelled) return;
      const mats = transport.unwrapMaterialsList(matRes);
      const comps = transport.unwrapComponentsList(compRes);
      const grs = transport.unwrapGridsList(gridRes);
      const bomResult = transport.unwrapMaterialsBom(bomRes);
      const clashResult = transport.unwrapCoordinationClash(clashRes);
      if (mats === null || comps === null || grs === null || bomResult === null || clashResult === null) {
        const [label, failure] = mats === null
          ? ["materials.list", matRes]
          : comps === null
            ? ["components.list", compRes]
            : grs === null
              ? ["grids.list", gridRes]
              : bomResult === null
                ? ["materials.bom", bomRes]
                : ["coordination.clash", clashRes];
        setQueryError(`[${label}] ${describeQueryFailure(failure)}`);
        return;
      }
      setQueryError(null);
      setMaterials(mats);
      setComponents(comps);
      setGrids(grs);
      setBom(bomResult);
      setClash(clashResult);
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  /** Re-run the on-demand reports (the Clash/BOM buttons). */
  const runReports = React.useCallback(async (): Promise<void> => {
    const transport = await import("@/cad/client/http-transport");
    const [bomRes, clashRes] = await Promise.all([transport.materialsBom(), transport.coordinationClash()]);
    const bomResult = transport.unwrapMaterialsBom(bomRes);
    const clashResult = transport.unwrapCoordinationClash(clashRes);
    if (bomResult === null || clashResult === null) {
      const [label, failure] = bomResult === null ? ["materials.bom", bomRes] : ["coordination.clash", clashRes];
      setQueryError(`[${label}] ${describeQueryFailure(failure)}`);
      return;
    }
    setBom(bomResult);
    setClash(clashResult);
  }, []);

  const materialRows = materials ?? [];

  const assignSelection = (materialId: string | null): void => {
    if (props.selection.length === 0) return;
    const ids = [...props.selection];
    setAssignTarget("");
    void commit("material.assign", async () => {
      const { materialAssign } = await import("@/cad/client/http-transport");
      return materialAssign(ids, materialId);
    });
  };

  const createMaterial = (): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    void commit("material.create", async () => {
      const { materialCreate } = await import("@/cad/client/http-transport");
      return materialCreate({
        name,
        category: newCategory,
        color: hexToRgb(newColor),
        lineweight: Number.isFinite(newLineweight) ? newLineweight : 1.4,
      });
    });
    setNewName("");
  };

  const createGrid = (): void => {
    const uLines = parseAscendingOffsets(gridU);
    const vLines = parseAscendingOffsets(gridV);
    if (uLines === null || vLines === null) {
      void commit("grid.create", async () =>
        Promise.resolve(
          apiErr(
            "grid_invalid",
            `u/v line offsets must be comma-separated finite strictly-ascending numbers (got '${gridU}' / '${gridV}')`,
            false,
          ),
        ),
      );
      return;
    }
    const payload: { uLines: number[]; vLines: number[]; name?: string; storyId?: string } = { uLines, vLines };
    const name = gridName.trim();
    if (name.length > 0) payload.name = name;
    if (props.activeStoryId !== null) payload.storyId = props.activeStoryId;
    void commit("grid.create", async () => {
      const { gridCreate } = await import("@/cad/client/http-transport");
      return gridCreate(payload);
    });
    setGridName("");
  };

  return (
    <div className="flex h-full flex-col" data-testid="coordination-panel">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          {queryError !== null && (
            <div className="m-1 rounded border border-red-300 bg-red-50 px-2 py-1 text-[10px] text-red-800" role="alert">
              {queryError}
            </div>
          )}

          {/* --- Materials ------------------------------------------------- */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Materials ({materialRows.length})
          </div>
          {/* The create form + the assign-to-selection action. */}
          <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="material-create-form">
            <input
              className={TEXT_INPUT + " !w-24"}
              aria-label="new material name"
              placeholder="name"
              value={newName}
              data-testid="material-create-name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createMaterial();
              }}
            />
            <select
              className="rounded border bg-background px-1 py-0.5 text-xs"
              aria-label="new material category"
              value={newCategory}
              data-testid="material-create-category"
              title="The constrained 8-value category vocabulary"
              onChange={(e) => {
                setNewCategory(e.target.value);
                // The color input follows the category default (Enter =
                // category default — the MATERIAL command semantics).
                setNewColor(materialColorHex({ category: e.target.value }));
              }}
            >
              {MATERIAL_CATEGORIES.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
            <input
              type="color"
              className="h-5 w-7 cursor-pointer rounded border bg-background"
              aria-label="new material color"
              value={newColor}
              data-testid="material-create-color"
              title={`Color #RRGGBB — the category default of ${newCategory}`}
              onChange={(e) => setNewColor(e.target.value)}
            />
            <input
              type="number"
              step="0.1"
              min="0.5"
              max="8"
              className={NUM_INPUT + " !w-14"}
              aria-label="new material lineweight"
              value={newLineweight}
              data-testid="material-create-lineweight"
              title="Display lineweight in mm [0.5..8]"
              onChange={(e) => setNewLineweight(Number(e.target.value))}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[10px]"
              data-testid="material-create"
              title="MATERIAL — create the record (one atomic revision)"
              disabled={newName.trim().length === 0}
              onClick={createMaterial}
            >
              <Plus className="h-3 w-3" aria-hidden /> Add
            </Button>
          </div>
          {/* Assign to selection (MATSET semantics — unassign option). */}
          <div className="flex items-center gap-1 px-2 pb-1">
            <select
              className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
              aria-label="assign material to selection"
              value={assignTarget}
              data-testid="material-assign"
              disabled={props.selection.length === 0}
              title={
                props.selection.length === 0
                  ? "Assign to selection — pick entities in the Model viewport first"
                  : `Assign a material to the ${props.selection.length} selected entit${props.selection.length === 1 ? "y" : "ies"} (MATSET semantics)`
              }
              onChange={(e) => {
                const value = e.target.value;
                if (value === "") return;
                if (value === "__unassign__") assignSelection(null);
                else assignSelection(value);
              }}
            >
              <option value="">
                {props.selection.length === 0 ? "Assign to selection (nothing selected)" : `Assign to selection (${props.selection.length})`}
              </option>
              {materialRows.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
              <option value="__unassign__">Unassign selection</option>
            </select>
          </div>
          <ul aria-label="materials" data-testid="materials-section">
            {materialRows.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-muted/50"
                data-testid={`material-row-${m.name}`}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-sm border"
                  style={{ background: materialColorHex(m) }}
                  title={`${materialColorHex(m)} · lw ${materialLineweight(m).toFixed(2)} mm`}
                  aria-label={`material ${m.name} color`}
                />
                <input
                  className={TEXT_INPUT + " !w-24"}
                  aria-label={`rename material ${m.name}`}
                  defaultValue={m.name}
                  key={`name-${m.id}:${m.name}`}
                  title="Rename (material.update — names are the document-unique exchange key)"
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value.length > 0 && value !== m.name) {
                      void commit("material.update", async () => {
                        const { materialUpdate } = await import("@/cad/client/http-transport");
                        return materialUpdate(m.id, { name: value });
                      });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                  {m.category ?? "—"}
                </Badge>
                <input
                  type="color"
                  className="h-5 w-7 shrink-0 cursor-pointer rounded border bg-background"
                  aria-label={`material ${m.name} color`}
                  defaultValue={materialColorHex(m)}
                  key={`color-${m.id}:${materialColorHex(m)}`}
                  title="Edit the color (material.update)"
                  onBlur={(e) => {
                    if (e.target.value !== materialColorHex(m)) {
                      void commit("material.update", async () => {
                        const { materialUpdate } = await import("@/cad/client/http-transport");
                        return materialUpdate(m.id, { color: hexToRgb(e.target.value) });
                      });
                    }
                  }}
                />
                <input
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="8"
                  className={NUM_INPUT + " !w-14"}
                  aria-label={`material ${m.name} lineweight`}
                  defaultValue={materialLineweight(m)}
                  key={`lw-${m.id}:${materialLineweight(m)}`}
                  title="Display lineweight in mm [0.5..8] (material.update)"
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n !== materialLineweight(m)) {
                      void commit("material.update", async () => {
                        const { materialUpdate } = await import("@/cad/client/http-transport");
                        return materialUpdate(m.id, { lineweight: n });
                      });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                  aria-label={`remove material ${m.name}`}
                  title="Remove (material.remove — reference-checked: material_in_use while elements or block defaults reference it)"
                  onClick={() =>
                    void commit("material.remove", async () => {
                      const { materialRemove } = await import("@/cad/client/http-transport");
                      return materialRemove(m.id);
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </li>
            ))}
            {materials !== null && materialRows.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                No materials — the form above (or the MATERIAL command) creates one.
              </li>
            )}
            {materials === null && (
              <li className="px-2 py-1 text-xs text-muted-foreground">Loading materials…</li>
            )}
          </ul>

          <Separator className="my-1" />

          {/* --- Components ------------------------------------------------ */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Components ({components?.length ?? 0})
          </div>
          <ul aria-label="components" data-testid="components-section">
            {(components ?? []).map((c) => (
              <li
                key={c.id}
                className="rounded px-2 py-1 text-[11px] hover:bg-muted/50"
                data-testid={`component-row-${c.name}`}
              >
                <div className="flex items-center gap-1">
                  <Boxes className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  <input
                    className={TEXT_INPUT + " !w-24"}
                    aria-label={`rename component ${c.name}`}
                    defaultValue={c.name}
                    key={`cname-${c.id}:${c.name}`}
                    title="Rename the block definition (block.update)"
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value.length > 0 && value !== c.name) {
                        void commit("block.update", async () => {
                          const { blockUpdate } = await import("@/cad/client/http-transport");
                          return blockUpdate(c.name, { name: value });
                        });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-1.5 text-[10px]"
                    aria-label={`insert component ${c.name}`}
                    title="INSERT the component (the command line continues with the insertion point)"
                    onClick={() => props.onRunCommand("insert", c.name)}
                  >
                    <PackagePlus className="h-3 w-3" aria-hidden /> Insert
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                    aria-label={`remove component ${c.name}`}
                    title="Remove the definition (block.remove — reference-checked)"
                    onClick={() =>
                      void commit("block.remove", async () => {
                        const { blockRemove } = await import("@/cad/client/http-transport");
                        return blockRemove(c.name);
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
                <div className="truncate text-[10px] text-muted-foreground" title={c.instanceIds.join(", ")}>
                  {c.instanceCount} instance{c.instanceCount === 1 ? "" : "s"}
                  {c.instanceCount > 0 ? ` · ${c.instanceIds.slice(0, 4).join(", ")}${c.instanceIds.length > 4 ? "…" : ""}` : ""}
                  {" · EXPLODE inherits the resolved material"}
                </div>
                <div className="flex items-center gap-1">
                  <span className="shrink-0 text-[10px] text-muted-foreground">material</span>
                  <select
                    className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[10px]"
                    aria-label={`component ${c.name} default material`}
                    value={c.materialId ?? ""}
                    data-testid={`component-material-${c.name}`}
                    title="The definition's DEFAULT material (block.update materialId — instances resolve instance ?? this ?? null)"
                    onChange={(e) => {
                      const value = e.target.value;
                      void commit("block.update", async () => {
                        const { blockUpdate } = await import("@/cad/client/http-transport");
                        return blockUpdate(c.name, { materialId: value.length === 0 ? null : value });
                      });
                    }}
                  >
                    <option value="">(none)</option>
                    {materialRows.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
            {components !== null && components.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                No components — BLOCK (B) creates one from selected entities.
              </li>
            )}
            {components === null && (
              <li className="px-2 py-1 text-xs text-muted-foreground">Loading components…</li>
            )}
          </ul>

          <Separator className="my-1" />

          {/* --- Coordination (grids + clash + BOM + revcloud) -------------- */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Coordination
          </div>
          <div className="flex flex-wrap items-center gap-1 px-2 py-1">
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[10px]"
              data-testid="clash-run"
              title="CLASH — run the pairwise clash detection over the concrete 2D view"
              onClick={() => void runReports()}
            >
              <RefreshCw className="h-3 w-3" aria-hidden /> Clash
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[10px]"
              data-testid="bom-refresh"
              title="BOM — refresh the bill of materials (the deterministic quantity takeoff)"
              onClick={() => void runReports()}
            >
              <ClipboardList className="h-3 w-3" aria-hidden /> BOM
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[10px]"
              data-testid="revcloud-button"
              title="REVCLOUD — draw a revision cloud around two corner picks"
              onClick={() => props.onRunCommand("revcloud")}
            >
              <Cloud className="h-3 w-3" aria-hidden /> Revision cloud
            </Button>
          </div>

          {/* Grids + the create form. */}
          <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="grid-create-form">
            <input
              className={TEXT_INPUT + " !w-20"}
              aria-label="new grid name"
              placeholder="name"
              value={gridName}
              data-testid="grid-create-name"
              onChange={(e) => setGridName(e.target.value)}
            />
            <input
              className={TEXT_INPUT + " !w-24"}
              aria-label="new grid u line offsets"
              placeholder="u offsets"
              value={gridU}
              data-testid="grid-create-u"
              title="U grid line offsets — comma-separated strictly-ascending (the CGRID grammar)"
              onChange={(e) => setGridU(e.target.value)}
            />
            <input
              className={TEXT_INPUT + " !w-24"}
              aria-label="new grid v line offsets"
              placeholder="v offsets"
              value={gridV}
              data-testid="grid-create-v"
              title="V grid line offsets — comma-separated strictly-ascending (the CGRID grammar)"
              onChange={(e) => setGridV(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[10px]"
              data-testid="grid-create"
              title="CGRID — create the coordination grid datum (one atomic revision)"
              onClick={createGrid}
            >
              <Plus className="h-3 w-3" aria-hidden /> Add grid
            </Button>
          </div>
          <ul aria-label="grids" data-testid="grids-section">
            {(grids ?? []).map((g) => (
              <li
                key={g.id}
                className="rounded px-2 py-1 text-[11px] hover:bg-muted/50"
                data-testid={`grid-row-${g.id}`}
              >
                <div className="flex items-center gap-1">
                  <input
                    className={TEXT_INPUT + " !w-20"}
                    aria-label={`rename grid ${g.name}`}
                    defaultValue={g.name}
                    key={`gname-${g.id}:${g.name}`}
                    title="Rename (grid.update)"
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value.length > 0 && value !== g.name) {
                        void commit("grid.update", async () => {
                          const { gridUpdate } = await import("@/cad/client/http-transport");
                          return gridUpdate(g.id, { name: value });
                        });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                    aria-label={`remove grid ${g.name}`}
                    title="Remove the grid datum (bim.delete — one atomic revision)"
                    onClick={() =>
                      void commit("bim.delete", async () => {
                        const { bimOp } = await import("@/cad/client/http-transport");
                        return bimOp("bim.delete", { ids: [g.id] });
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
                <div className="truncate text-[10px] text-muted-foreground" title={g.id}>
                  {g.uLines.length}u × {g.vLines.length}v · labels {gridLabelPreview(g.uLabels)} / {gridLabelPreview(g.vLabels)}
                  {g.storyId !== null ? ` · story ${g.storyId}` : ""}
                </div>
                <div className="flex items-center gap-1">
                  <input
                    className={TEXT_INPUT + " !w-24"}
                    aria-label={`grid ${g.name} u line offsets`}
                    defaultValue={g.uLines.join(",")}
                    key={`gu-${g.id}:${g.uLines.join(",")}`}
                    title="U offsets — comma-separated strictly-ascending (grid.update replaces the whole array)"
                    onBlur={(e) => {
                      const parsed = parseAscendingOffsets(e.target.value);
                      if (parsed === null) return;
                      if (parsed.length === g.uLines.length && parsed.every((v, i) => v === g.uLines[i])) return;
                      void commit("grid.update", async () => {
                        const { gridUpdate } = await import("@/cad/client/http-transport");
                        return gridUpdate(g.id, { uLines: parsed });
                      });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <input
                    className={TEXT_INPUT + " !w-24"}
                    aria-label={`grid ${g.name} v line offsets`}
                    defaultValue={g.vLines.join(",")}
                    key={`gv-${g.id}:${g.vLines.join(",")}`}
                    title="V offsets — comma-separated strictly-ascending (grid.update replaces the whole array)"
                    onBlur={(e) => {
                      const parsed = parseAscendingOffsets(e.target.value);
                      if (parsed === null) return;
                      if (parsed.length === g.vLines.length && parsed.every((v, i) => v === g.vLines[i])) return;
                      void commit("grid.update", async () => {
                        const { gridUpdate } = await import("@/cad/client/http-transport");
                        return gridUpdate(g.id, { vLines: parsed });
                      });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                </div>
              </li>
            ))}
            {grids !== null && grids.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                No grids — the form above (or CGRID) creates one; labels derive A,B,C… / 1,2,3….
              </li>
            )}
            {grids === null && (
              <li className="px-2 py-1 text-xs text-muted-foreground">Loading grids…</li>
            )}
          </ul>

          {/* The clash result — clicking a pair selects BOTH elements. */}
          {clash !== null && (
            <div className="mt-1 px-2" data-testid="clash-result">
              <div className="py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Clash pairs ({clash.pairs.length}) — checked {clash.checked}, excluded {clash.excluded}
              </div>
              <ul aria-label="clash pairs">
                {clash.pairs.map((pair, i) => (
                  <li key={`${pair.a}:${pair.b}`}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] hover:bg-muted/50"
                      data-testid={`clash-row-${i}`}
                      title="Select the clashing pair"
                      onClick={() => props.onSelection([pair.a, pair.b])}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden />
                      <span className="truncate font-mono">{pair.a} ↔ {pair.b}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{pair.points.length} pt</span>
                    </button>
                  </li>
                ))}
                {clash.pairs.length === 0 && (
                  <li className="px-1 py-0.5 text-[10px] text-muted-foreground">
                    No clashes detected (checked {clash.checked}, excluded {clash.excluded}).
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* The bill of materials — the same deterministic takeoff the BOM
              command reports. */}
          {bom !== null && (
            <div className="mt-1 px-2" data-testid="bom-result">
              <div className="py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Bill of materials ({bom.rows.length} rows · {bom.unit})
              </div>
              <table className="w-full text-[10px]" data-testid="bom-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-0.5 pr-1 font-medium">material</th>
                    <th className="py-0.5 pr-1 font-medium">count</th>
                    <th className="py-0.5 pr-1 font-medium">length</th>
                    <th className="py-0.5 font-medium">area</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.rows.map((row) => (
                    <tr
                      key={row.materialId ?? "unassigned"}
                      className="border-b border-border/40"
                      data-testid={`bom-row-${row.materialId ?? "unassigned"}`}
                    >
                      <td className="py-0.5 pr-1">{row.name}</td>
                      <td className="py-0.5 pr-1 text-right font-mono">{row.count}</td>
                      <td className="py-0.5 pr-1 text-right font-mono">{row.length.toFixed(2)}</td>
                      <td className="py-0.5 text-right font-mono">{row.area.toFixed(2)}</td>
                    </tr>
                  ))}
                  {bom.rows.length === 0 && (
                    <tr>
                      <td className="py-0.5 text-muted-foreground" colSpan={4}>
                        No measurable content yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="p-2 text-[10px] text-muted-foreground">
            MATERIAL/MATSET/CGRID/REVCLOUD drive the same commands from the command line; MATLIST/BOM/CLASH echo the reports to the history.
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CAD-PARITY-013 (Issue #104): the Documentation manager — the navigator
// (View Map folders + Layout Book subsets), title blocks, revisions,
// schedules and the publisher. Every table loads through the App API
// queries (fresh on every document version change — the commit path bumps
// the version; null = loading, the empty state still renders the forms so
// the palette never blanks on a P013-field-less legacy document). Every
// write is ONE atomic App API command (one revision, one undo entry; typed
// failures surface through the shell's error channel — e.g.
// navigator_in_use on a referenced folder).
// ---------------------------------------------------------------------------

/** Humanize a closed-vocabulary column key ("id" → "Id",
 *  "renovationStatus" → "Renovation Status"). */
function humanizeScheduleKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function scheduleColumnsOf(keys: readonly string[]): readonly { key: string; label: string }[] {
  return keys.map((key) => ({ key, label: humanizeScheduleKey(key) }));
}

/** The DEFAULT per-source schedule column sets — the SAME closed
 *  vocabularies the P1 SCHEDULE command uses (app/src/workspace/
 *  commands-documentation.ts DEFAULT_SCHEDULE_COLUMNS, mirrored client-side
 *  so the panel form offers the identical default columns without importing
 *  the document-layer runtime into the browser bundle; the server validator
 *  remains the single source of truth). Dynamic `ps:<set>.<key>` columns are
 *  author-chosen (the SCHEDULE command) and deliberately not offered here. */
const SCHEDULE_DEFAULT_COLUMNS: Readonly<Record<ScheduleSource, readonly { key: string; label: string }[]>> = {
  elements: scheduleColumnsOf([
    "id", "type", "name", "story", "layer", "material", "classification", "renovationStatus", "option",
  ]),
  components: scheduleColumnsOf([
    "id", "type", "name", "story", "layer", "material", "classification", "renovationStatus", "option",
  ]),
  materials: scheduleColumnsOf(["id", "name", "category", "color", "lineweight", "density"]),
  views: scheduleColumnsOf(["id", "kind", "title", "scale", "folder", "contentHash", "primitives"]),
  layouts: scheduleColumnsOf(["id", "name", "subset", "master", "sheetNumber", "titleBlock", "revisions"]),
  sheets: scheduleColumnsOf(["id", "title", "sheetNumber", "projectName", "views"]),
};

/** The six schedule sources (the SCHEDULE command's closed vocabulary). */
const SCHEDULE_SOURCES: readonly ScheduleSource[] = [
  "elements", "components", "materials", "views", "layouts", "sheets",
];

function DocumentationPanel(props: PalettesProps): React.JSX.Element {
  const commit = props.onCommitEdit;
  // The live navigator projection + the schedule/revision tables (loaded
  // through the App API queries; null = loading).
  const [tree, setTree] = React.useState<NavigatorTree | null>(null);
  const [schedules, setSchedules] = React.useState<readonly SchedulesListRow[] | null>(null);
  const [revisions, setRevisions] = React.useState<readonly RevisionRecord[] | null>(null);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  // The on-demand run results (schedules.run / publisher.run — queries, no
  // revisions; re-run from the per-row buttons).
  const [scheduleRun, setScheduleRun] = React.useState<ScheduleRunResult | null>(null);
  const [publisherRunResult, setPublisherRunResult] = React.useState<PublisherRunResult | null>(null);

  // Layout Book forms.
  const [subsetName, setSubsetName] = React.useState("");
  const [subsetPrefix, setSubsetPrefix] = React.useState("A");
  const [assignLayoutId, setAssignLayoutId] = React.useState("");
  const [assignSubsetId, setAssignSubsetId] = React.useState("__root__");
  const [masterLayoutId, setMasterLayoutId] = React.useState("");
  const [masterMasterId, setMasterMasterId] = React.useState("__none__");
  // View Map forms.
  const [folderName, setFolderName] = React.useState("");
  const [folderParentId, setFolderParentId] = React.useState("");
  const [viewAssignViewId, setViewAssignViewId] = React.useState("");
  const [viewAssignFolderId, setViewAssignFolderId] = React.useState("*");
  // Title block forms.
  const [titleBlockName, setTitleBlockName] = React.useState("");
  const [titleBlockProject, setTitleBlockProject] = React.useState("");
  const [titleBlockAuthor, setTitleBlockAuthor] = React.useState("");
  const [placeLayoutId, setPlaceLayoutId] = React.useState("");
  const [placeTitleBlockId, setPlaceTitleBlockId] = React.useState("");
  const [placeX, setPlaceX] = React.useState<number>(10);
  const [placeY, setPlaceY] = React.useState<number>(10);
  // Revision / schedule / publisher forms.
  const [revisionCode, setRevisionCode] = React.useState("");
  const [revisionDescription, setRevisionDescription] = React.useState("");
  const [scheduleName, setScheduleName] = React.useState("");
  const [scheduleSource, setScheduleSource] = React.useState<ScheduleSource>("elements");
  const [publisherName, setPublisherName] = React.useState("");
  const [publisherItems, setPublisherItems] = React.useState("");

  // The document version the loaded tables were read at.
  const version = props.snapshot?.version?.version_number ?? 0;

  // Load the tables through the App API queries (fresh on mount and on every
  // document version change — the commit path bumps the version). Partial
  // success still renders (each section falls back to its empty/loading
  // state); the FIRST failed query is surfaced as the typed error banner.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const transport = await import("@/cad/client/http-transport");
      const [treeRes, schRes, revRes] = await Promise.all([
        transport.navigatorTree(),
        transport.schedulesList(),
        transport.revisionsList(),
      ]);
      if (cancelled) return;
      const treeValue = transport.unwrapNavigatorTree(treeRes);
      const scheduleRows = transport.unwrapSchedulesList(schRes);
      const revisionRows = transport.unwrapRevisionsList(revRes);
      if (treeValue === null) {
        setQueryError(`[navigator.tree] ${describeQueryFailure(treeRes)}`);
      } else if (scheduleRows === null) {
        setQueryError(`[schedules.list] ${describeQueryFailure(schRes)}`);
      } else if (revisionRows === null) {
        setQueryError(`[revisions.list] ${describeQueryFailure(revRes)}`);
      } else {
        setQueryError(null);
      }
      if (treeValue !== null) setTree(treeValue);
      if (scheduleRows !== null) setSchedules(scheduleRows);
      if (revisionRows !== null) setRevisions(revisionRows);
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  // The document tables the forms populate from (absent-when-empty optional
  // snapshot fields — a legacy document renders the empty selects safely).
  const layouts = props.snapshot?.layouts ?? [];
  const titleBlocks = props.snapshot?.titleBlocks ?? [];
  const folders = React.useMemo(
    () => flattenFolderNodes(tree?.viewMap.children ?? []),
    [tree],
  );
  const subsets = React.useMemo(
    () => flattenSubsetNodes(tree?.layoutBook.children ?? []),
    [tree],
  );
  const views = React.useMemo(() => flattenViewRows(tree), [tree]);

  /** Run one schedule (query — no revision) and render its result table. */
  const runSchedule = React.useCallback(async (row: SchedulesListRow): Promise<void> => {
    const transport = await import("@/cad/client/http-transport");
    const res = await transport.schedulesRun(row.id);
    const result = transport.unwrapScheduleRun(res);
    if (result === null) {
      setQueryError(`[schedules.run] ${describeQueryFailure(res)}`);
      return;
    }
    setQueryError(null);
    setScheduleRun(result);
  }, []);

  /** Publish one set (query — NON-VERSIONED output automation). */
  const runPublisher = React.useCallback(async (setId: string): Promise<void> => {
    const transport = await import("@/cad/client/http-transport");
    const res = await transport.publisherRun(setId);
    const result = transport.unwrapPublisherRun(res);
    if (result === null) {
      setQueryError(`[publisher.run] ${describeQueryFailure(res)}`);
      return;
    }
    setQueryError(null);
    setPublisherRunResult(result);
  }, []);

  // --- Layout Book mutations -----------------------------------------------

  const createSubset = (): void => {
    const name = subsetName.trim();
    if (name.length === 0) return;
    const payload: { name: string; prefix?: string } = { name };
    const prefix = subsetPrefix.trim();
    if (prefix.length > 0) payload.prefix = prefix;
    void commit("navigator.createSubset", async () => {
      const { navigatorCreateSubset } = await import("@/cad/client/http-transport");
      return navigatorCreateSubset(payload);
    });
    setSubsetName("");
  };

  const assignLayoutToSubset = (): void => {
    if (assignLayoutId.length === 0) return;
    const subsetId = assignSubsetId === "__root__" ? null : assignSubsetId;
    void commit("layout.update", async () => {
      const { layoutUpdate } = await import("@/cad/client/http-transport");
      return layoutUpdate({ id: assignLayoutId, patch: { subsetId } });
    });
    setAssignLayoutId("");
    setAssignSubsetId("__root__");
  };

  const assignMaster = (): void => {
    if (masterLayoutId.length === 0) return;
    const masterId = masterMasterId === "__none__" ? null : masterMasterId;
    void commit("layout.update", async () => {
      const { layoutUpdate } = await import("@/cad/client/http-transport");
      return layoutUpdate({ id: masterLayoutId, patch: { masterId } });
    });
    setMasterLayoutId("");
    setMasterMasterId("__none__");
  };

  // --- View Map mutations ---------------------------------------------------

  const createFolder = (): void => {
    const name = folderName.trim();
    if (name.length === 0) return;
    const payload: { name: string; parentId?: string } = { name };
    if (folderParentId.length > 0) payload.parentId = folderParentId;
    void commit("navigator.createFolder", async () => {
      const { navigatorCreateFolder } = await import("@/cad/client/http-transport");
      return navigatorCreateFolder(payload);
    });
    setFolderName("");
  };

  const assignViewToFolder = (): void => {
    if (viewAssignViewId.length === 0) return;
    const folderId = viewAssignFolderId === "*" || viewAssignFolderId.length === 0 ? null : viewAssignFolderId;
    void commit("docs.updateView", async () => {
      const { docsUpdateViewFolder } = await import("@/cad/client/http-transport");
      return docsUpdateViewFolder(viewAssignViewId, folderId);
    });
    setViewAssignViewId("");
    setViewAssignFolderId("*");
  };

  // --- Title block mutations --------------------------------------------------

  const createTitleBlock = (): void => {
    const name = titleBlockName.trim();
    const project = titleBlockProject.trim();
    if (name.length === 0 || project.length === 0) return;
    // The TITLEBLOCK command's deterministic rows (Project text + the
    // derived Layout/Sheet/Revisions fields + the Author text row when
    // given) and geometry (180 mm wide, 12 mm rows) — mirrored from
    // app/src/workspace/commands-documentation.ts (the P1 constants).
    const rows: TitleBlockRow[] = [
      { label: "Project", field: "text", value: project },
      { label: "Layout", field: "layoutName" },
      { label: "Sheet", field: "sheetNumber" },
      { label: "Revisions", field: "revisions" },
    ];
    const author = titleBlockAuthor.trim();
    if (author.length > 0) rows.push({ label: "Author", field: "text", value: author });
    const rowHeightMm = 12;
    const widthMm = 180;
    void commit("titleblock.create", async () => {
      const { titleblockCreate } = await import("@/cad/client/http-transport");
      return titleblockCreate({
        name,
        widthMm,
        heightMm: rows.length * rowHeightMm,
        rowHeightMm,
        rows,
      });
    });
    setTitleBlockName("");
    setTitleBlockAuthor("");
  };

  const placeTitleBlock = (): void => {
    if (placeLayoutId.length === 0 || placeTitleBlockId.length === 0) return;
    const xMm = Number.isFinite(placeX) ? placeX : 10;
    const yMm = Number.isFinite(placeY) ? placeY : 10;
    void commit("layout.update", async () => {
      const { layoutUpdate } = await import("@/cad/client/http-transport");
      return layoutUpdate({
        id: placeLayoutId,
        patch: { titleBlockPlacement: { titleBlockId: placeTitleBlockId, xMm, yMm } },
      });
    });
  };

  // --- Revision / schedule / publisher mutations ------------------------------

  const createRevision = (): void => {
    const code = revisionCode.trim();
    if (code.length === 0) return;
    void commit("revision.add", async () => {
      const { revisionAdd } = await import("@/cad/client/http-transport");
      return revisionAdd({ code, description: revisionDescription.trim(), issued: false });
    });
    setRevisionCode("");
    setRevisionDescription("");
  };

  const toggleRevisionIssued = (revision: RevisionRecord): void => {
    void commit("revision.update", async () => {
      const { revisionUpdate } = await import("@/cad/client/http-transport");
      return revisionUpdate(revision.id, { issued: !revision.issued });
    });
  };

  const createSchedule = (): void => {
    const name = scheduleName.trim();
    if (name.length === 0) return;
    const columns = SCHEDULE_DEFAULT_COLUMNS[scheduleSource].map((c) => ({ key: c.key, label: c.label }));
    void commit("schedule.create", async () => {
      const { scheduleCreate } = await import("@/cad/client/http-transport");
      return scheduleCreate({ name, source: scheduleSource, columns });
    });
    setScheduleName("");
  };

  const createPublisherSet = (): void => {
    const name = publisherName.trim();
    if (name.length === 0) return;
    // The PUBSET command's strict comma/pipe-separated item grammar
    // (subset:Name / layout:Name), resolved through the tree + snapshot
    // tables client-side; junk/unknown targets fail typed (never guessed).
    const parts = publisherItems.split(/[,|]/).map((s) => s.trim()).filter((s) => s.length > 0);
    const items: { kind: "layout" | "subset"; id: string; format: "pdf" }[] = [];
    for (const part of parts) {
      const m = /^(subset|layout):(.+)$/.exec(part);
      if (m === null) {
        void commit("publisher.create", async () =>
          Promise.resolve(
            apiErr(
              "publisher_invalid",
              `publisher item '${part}' must be subset:Name or layout:Name (strict parse — junk is rejected, never guessed).`,
              false,
            ),
          ),
        );
        return;
      }
      const kind = m[1] as "subset" | "layout";
      const targetName = m[2]!.trim();
      const id =
        kind === "subset"
          ? subsets.find((n) => n.name === targetName)?.id
          : layouts.find((l) => l.name === targetName)?.id;
      if (id === undefined) {
        void commit("publisher.create", async () =>
          Promise.resolve(
            apiErr(
              "publisher_invalid",
              `${kind} '${targetName}' does not exist — SUBSET/LAYOUTNEW create one.`,
              false,
            ),
          ),
        );
        return;
      }
      items.push({ kind, id, format: "pdf" });
    }
    if (items.length === 0) {
      void commit("publisher.create", async () =>
        Promise.resolve(
          apiErr(
            "publisher_invalid",
            "publisher.create requires at least one item (subset:Name or layout:Name entries).",
            false,
          ),
        ),
      );
      return;
    }
    void commit("publisher.create", async () => {
      const { publisherCreate } = await import("@/cad/client/http-transport");
      return publisherCreate({ name, items });
    });
    setPublisherName("");
    setPublisherItems("");
  };

  // --- The tree renderers -----------------------------------------------------

  const renderLayoutRow = (row: NavigatorLayoutRow, depth: number): React.JSX.Element => (
    <li key={row.layoutId}>
      <div
        className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`doc-layout-${row.layoutId}`}
      >
        <span className="truncate">{row.name}</span>
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{row.sheetNumber}</span>
        {row.masterId !== undefined && (
          <span
            className="shrink-0 text-[9px] text-muted-foreground"
            data-testid={`doc-layout-master-${row.layoutId}`}
            title={`master layout ${row.masterId}`}
          >
            → master {layouts.find((l) => l.id === row.masterId)?.name ?? row.masterId}
          </span>
        )}
        <span
          className="shrink-0 text-[9px] text-muted-foreground"
          data-testid={`doc-layout-revisions-${row.layoutId}`}
          title="the layout's revision codes (layout.revisionIds joined in record order)"
        >
          {row.revisionCodes.length > 0 ? row.revisionCodes.join(", ") : "—"}
        </span>
        {row.titleBlockId !== undefined && (
          <span
            className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground"
            title={`placed title block ${row.titleBlockId}`}
          >
            {row.titleBlockId}
          </span>
        )}
      </div>
    </li>
  );

  const renderBookBranch = (branch: NavigatorBookBranch, depth: number): React.JSX.Element => (
    <li key={branch.node.id}>
      <div
        className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`doc-subset-${branch.node.id}`}
        title={`subset node ${branch.node.id} (order ${branch.node.order})`}
      >
        <span className="truncate">{branch.node.name}</span>
        {branch.node.prefix !== undefined && (
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">[{branch.node.prefix}]</Badge>
        )}
        <span className="shrink-0 text-[9px] text-muted-foreground">
          {branch.node.numbering === "custom" ? `custom from ${branch.node.customNumber ?? "01"}` : "numbering none"}
        </span>
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
          {branch.layouts.length} sheet{branch.layouts.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul aria-label={`subset ${branch.node.name}`}>
        {branch.layouts.map((l) => renderLayoutRow(l, depth + 1))}
        {branch.children.map((c) => renderBookBranch(c, depth + 1))}
      </ul>
    </li>
  );

  const renderViewRow = (view: NavigatorViewRow, depth: number): React.JSX.Element => (
    <li key={view.viewId}>
      <div
        className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`doc-view-${view.viewId}`}
        title={`saved view ${view.viewId}`}
      >
        <span className="truncate">{view.title}</span>
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">{view.kind}</Badge>
        {view.scale !== undefined && <span className="shrink-0 text-[9px] text-muted-foreground">1:{view.scale}</span>}
        {view.contentHash !== undefined && (
          <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground" title={view.contentHash}>
            {view.contentHash.slice(0, 8)}
          </span>
        )}
      </div>
    </li>
  );

  const renderViewBranch = (branch: NavigatorViewBranch, depth: number): React.JSX.Element => (
    <li key={branch.node.id}>
      <div
        className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium hover:bg-muted/50"
        style={{ paddingLeft: depth * 10 + 8 }}
        data-testid={`doc-folder-${branch.node.id}`}
        title={`folder node ${branch.node.id} (order ${branch.node.order})`}
      >
        <span className="truncate">{branch.node.name}</span>
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
          {branch.views.length} view{branch.views.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul aria-label={`folder ${branch.node.name}`}>
        {branch.views.map((v) => renderViewRow(v, depth + 1))}
        {branch.children.map((c) => renderViewBranch(c, depth + 1))}
      </ul>
    </li>
  );

  return (
    <div className="flex h-full flex-col" data-testid="documentation-panel">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          {queryError !== null && (
            <div className="m-1 rounded border border-red-300 bg-red-50 px-2 py-1 text-[10px] text-red-800" role="alert">
              {queryError}
            </div>
          )}

          {/* --- Layout Book -------------------------------------------- */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Layout Book ({layouts.length} layout{layouts.length === 1 ? "" : "s"})
          </div>
          <div data-testid="doc-book-section">
            {/* The subset create form (SUBSET semantics — prefix drives the
                deterministic sheet numbering). */}
            <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="doc-subset-form">
              <input
                className={TEXT_INPUT + " !w-24"}
                aria-label="new subset name"
                placeholder="subset name"
                value={subsetName}
                data-testid="doc-subset-name"
                onChange={(e) => setSubsetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createSubset();
                }}
              />
              <input
                className={TEXT_INPUT + " !w-12"}
                aria-label="new subset sheet number prefix"
                placeholder="A"
                value={subsetPrefix}
                data-testid="doc-subset-prefix"
                title="Sheet number prefix (e.g. A → sheet numbers A-01, A-02… for custom numbering)"
                onChange={(e) => setSubsetPrefix(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-[10px]"
                data-testid="doc-subset-create"
                title="SUBSET — create the Layout Book subset (one atomic revision)"
                disabled={subsetName.trim().length === 0}
                onClick={createSubset}
              >
                <Plus className="h-3 w-3" aria-hidden /> Subset
              </Button>
            </div>
            {/* Assign a layout to a subset (NAVASSIGN layout semantics —
                (root) unassigns). */}
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1" data-testid="doc-assign-form">
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="layout to assign"
                value={assignLayoutId}
                data-testid="doc-assign-layout"
                title="The layout to file into the Layout Book"
                onChange={(e) => setAssignLayoutId(e.target.value)}
              >
                <option value="">(layout)</option>
                {layouts.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="target subset"
                value={assignSubsetId}
                data-testid="doc-assign-subset"
                title="The target subset ((root) files the layout at the book root)"
                onChange={(e) => setAssignSubsetId(e.target.value)}
              >
                <option value="__root__">(root)</option>
                {subsets.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                data-testid="doc-assign-button"
                title="NAVASSIGN — file the layout into the subset (layout.update subsetId, one atomic revision)"
                disabled={assignLayoutId.length === 0}
                onClick={assignLayoutToSubset}
              >
                Assign
              </Button>
            </div>
            {/* The master assignment (LAYOUTMASTER semantics — the master's
                furniture + title block render beneath the layout's content). */}
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1" data-testid="doc-master-form">
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="layout for master assignment"
                value={masterLayoutId}
                data-testid="doc-master-layout"
                title="The layout whose master is set"
                onChange={(e) => setMasterLayoutId(e.target.value)}
              >
                <option value="">(layout)</option>
                {layouts.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="master layout"
                value={masterMasterId}
                data-testid="doc-master-master"
                title="The master layout ((none) clears the assignment; single-level — a master cannot have a master)"
                onChange={(e) => setMasterMasterId(e.target.value)}
              >
                <option value="__none__">(none)</option>
                {layouts.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                data-testid="doc-master-button"
                title="LAYOUTMASTER — set the master layout (layout.update masterId, one atomic revision)"
                disabled={masterLayoutId.length === 0}
                onClick={assignMaster}
              >
                Master
              </Button>
            </div>
            {/* The book tree (root-level layouts under "Unassigned"). */}
            <ul aria-label="layout book">
              {(tree?.layoutBook.layouts ?? []).length > 0 && (
                <li>
                  <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Unassigned</div>
                  <ul aria-label="unassigned layouts">
                    {(tree?.layoutBook.layouts ?? []).map((l) => renderLayoutRow(l, 0))}
                  </ul>
                </li>
              )}
              {(tree?.layoutBook.children ?? []).map((c) => renderBookBranch(c, 0))}
            </ul>
            {tree !== null && tree.layoutBook.layouts.length === 0 && tree.layoutBook.children.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">
                No layouts/subsets — LAYOUTNEW creates a layout, the form above a subset.
              </div>
            )}
            {tree === null && (
              <div className="px-2 py-1 text-xs text-muted-foreground">Loading the layout book…</div>
            )}
          </div>

          <Separator className="my-1" />

          {/* --- View Map ------------------------------------------------ */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            View Map ({views.length} view{views.length === 1 ? "" : "s"})
          </div>
          <div data-testid="doc-viewmap-section">
            {/* The folder create form (NAVFOLDER semantics). */}
            <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="doc-folder-form">
              <input
                className={TEXT_INPUT + " !w-24"}
                aria-label="new folder name"
                placeholder="folder name"
                value={folderName}
                data-testid="doc-folder-name"
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createFolder();
                }}
              />
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="parent folder"
                value={folderParentId}
                data-testid="doc-folder-parent"
                title="The parent folder ((root) files the folder at the View Map root)"
                onChange={(e) => setFolderParentId(e.target.value)}
              >
                <option value="">(root)</option>
                {folders.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-[10px]"
                data-testid="doc-folder-create"
                title="NAVFOLDER — create the View Map folder (one atomic revision)"
                disabled={folderName.trim().length === 0}
                onClick={createFolder}
              >
                <Plus className="h-3 w-3" aria-hidden /> Folder
              </Button>
            </div>
            {/* The view → folder assignment (NAVASSIGN view semantics — *
                unassigns to the map root). */}
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1" data-testid="doc-view-assign-form">
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="view to assign"
                value={viewAssignViewId}
                data-testid="doc-view-assign-view"
                title="The saved view to file into a folder"
                onChange={(e) => setViewAssignViewId(e.target.value)}
              >
                <option value="">(view)</option>
                {views.map((v) => (
                  <option key={v.viewId} value={v.viewId}>{v.title}</option>
                ))}
              </select>
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="target folder"
                value={viewAssignFolderId}
                data-testid="doc-view-assign-folder"
                title="The target folder (* = the View Map root)"
                onChange={(e) => setViewAssignFolderId(e.target.value)}
              >
                <option value="*">* (root)</option>
                {folders.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                data-testid="doc-view-assign-button"
                title="NAVASSIGN — file the view into the folder (docs.updateView folderId, one atomic revision)"
                disabled={viewAssignViewId.length === 0}
                onClick={assignViewToFolder}
              >
                Assign
              </Button>
            </div>
            {/* The View Map tree. */}
            <ul aria-label="view map">
              {(tree?.viewMap.views ?? []).map((v) => renderViewRow(v, 0))}
              {(tree?.viewMap.children ?? []).map((c) => renderViewBranch(c, 0))}
            </ul>
            {tree !== null && tree.viewMap.views.length === 0 && tree.viewMap.children.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">
                No saved views — the Documentation workbench creates them (plan/elevation/section/detail).
              </div>
            )}
            {tree === null && (
              <div className="px-2 py-1 text-xs text-muted-foreground">Loading the view map…</div>
            )}
          </div>

          <Separator className="my-1" />

          {/* --- Title blocks --------------------------------------------- */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Title blocks ({titleBlocks.length})
          </div>
          <div data-testid="doc-titleblocks-section">
            {/* The create form (the TITLEBLOCK command's deterministic rows:
                Project text + derived Layout/Sheet/Revisions + the Author
                text row when given; 180×rows×12 mm). */}
            <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="doc-titleblock-form">
              <input
                className={TEXT_INPUT + " !w-20"}
                aria-label="new title block name"
                placeholder="name"
                value={titleBlockName}
                data-testid="doc-titleblock-name"
                onChange={(e) => setTitleBlockName(e.target.value)}
              />
              <input
                className={TEXT_INPUT + " !w-24"}
                aria-label="title block project text"
                placeholder="project"
                value={titleBlockProject}
                data-testid="doc-titleblock-project"
                title="The literal Project text row value"
                onChange={(e) => setTitleBlockProject(e.target.value)}
              />
              <input
                className={TEXT_INPUT + " !w-20"}
                aria-label="title block author (optional)"
                placeholder="author"
                value={titleBlockAuthor}
                data-testid="doc-titleblock-author"
                title="The literal Author text row value (empty = omit the row)"
                onChange={(e) => setTitleBlockAuthor(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-[10px]"
                data-testid="doc-titleblock-create"
                title="TITLEBLOCK — create the reusable title block (Project/Layout/Sheet/Revisions rows + author when given)"
                disabled={titleBlockName.trim().length === 0 || titleBlockProject.trim().length === 0}
                onClick={createTitleBlock}
              >
                <Plus className="h-3 w-3" aria-hidden /> Title block
              </Button>
            </div>
            {/* The placement form (TITLEPLACE semantics — sheet-space mm). */}
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1" data-testid="doc-titleplace-form">
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="layout for title block placement"
                value={placeLayoutId}
                data-testid="doc-titleplace-layout"
                title="The layout the title block is placed on"
                onChange={(e) => setPlaceLayoutId(e.target.value)}
              >
                <option value="">(layout)</option>
                {layouts.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <select
                className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px]"
                aria-label="title block to place"
                value={placeTitleBlockId}
                data-testid="doc-titleplace-titleblock"
                title="The title block definition to place"
                onChange={(e) => setPlaceTitleBlockId(e.target.value)}
              >
                <option value="">(title block)</option>
                {titleBlocks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <input
                type="number"
                step="1"
                className={NUM_INPUT + " !w-12"}
                aria-label="title block x position mm"
                value={placeX}
                data-testid="doc-titleplace-x"
                title="X position on the sheet (mm)"
                onChange={(e) => setPlaceX(Number(e.target.value))}
              />
              <input
                type="number"
                step="1"
                className={NUM_INPUT + " !w-12"}
                aria-label="title block y position mm"
                value={placeY}
                data-testid="doc-titleplace-y"
                title="Y position on the sheet (mm)"
                onChange={(e) => setPlaceY(Number(e.target.value))}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                data-testid="doc-titleplace-button"
                title="TITLEPLACE — place the title block (layout.update titleBlockPlacement, one atomic revision)"
                disabled={placeLayoutId.length === 0 || placeTitleBlockId.length === 0}
                onClick={placeTitleBlock}
              >
                Place
              </Button>
            </div>
            <ul aria-label="title blocks">
              {titleBlocks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] hover:bg-muted/50"
                  data-testid={`doc-titleblock-${t.id}`}
                  title={`${t.rows.length} rows: ${t.rows.map((r) => `${r.label}: ${r.field === "text" ? r.value ?? "" : r.field}`).join(" · ")}`}
                >
                  <span className="truncate">{t.name}</span>
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                    {t.widthMm}×{t.heightMm} mm
                  </span>
                  <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
                    {t.rows.length} row{t.rows.length === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
              {titleBlocks.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">
                  No title blocks — the form above (or the TITLEBLOCK command) creates one.
                </li>
              )}
            </ul>
          </div>

          <Separator className="my-1" />

          {/* --- Revisions ------------------------------------------------- */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Revisions ({revisions?.length ?? 0})
          </div>
          <div data-testid="doc-revisions-section">
            {/* The create form (REVISION semantics — issued starts false). */}
            <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="doc-revision-form">
              <input
                className={TEXT_INPUT + " !w-16"}
                aria-label="new revision code"
                placeholder="P01"
                value={revisionCode}
                data-testid="doc-revision-code"
                title="The unique revision code (max 12 chars)"
                onChange={(e) => setRevisionCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createRevision();
                }}
              />
              <input
                className={TEXT_INPUT + " !w-28"}
                aria-label="new revision description"
                placeholder="description"
                value={revisionDescription}
                data-testid="doc-revision-description"
                title="The revision description (may be empty)"
                onChange={(e) => setRevisionDescription(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-[10px]"
                data-testid="doc-revision-create"
                title="REVISION — add the document revision record (one atomic revision)"
                disabled={revisionCode.trim().length === 0}
                onClick={createRevision}
              >
                <Plus className="h-3 w-3" aria-hidden /> Revision
              </Button>
            </div>
            <ul aria-label="revisions">
              {(revisions ?? []).map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] hover:bg-muted/50"
                  data-testid={`doc-revision-${r.id}`}
                  title={`revision ${r.id} — created ${r.createdAt}${r.layoutIds.length > 0 ? `; layouts ${r.layoutIds.join(", ")}` : ""}`}
                >
                  <span className="shrink-0 font-mono">{r.code}</span>
                  <span className="truncate text-muted-foreground">{r.description.length > 0 ? r.description : "—"}</span>
                  <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                    {r.issued ? "issued" : "draft"}
                  </Badge>
                  <span className="shrink-0 text-[9px] text-muted-foreground">
                    {r.layoutIds.length} layout{r.layoutIds.length === 1 ? "" : "s"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                    aria-label={`toggle revision ${r.code} issued`}
                    data-testid={`doc-revision-issue-${r.id}`}
                    title={`revision.update — mark '${r.code}' ${r.issued ? "draft (issued false)" : "issued (issued true)"}`}
                    onClick={() => toggleRevisionIssued(r)}
                  >
                    {r.issued ? "Un-issue" : "Issue"}
                  </Button>
                </li>
              ))}
              {revisions !== null && revisions.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">
                  No revisions — the form above (or the REVISION command) creates one.
                </li>
              )}
              {revisions === null && (
                <li className="px-2 py-1 text-xs text-muted-foreground">Loading revisions…</li>
              )}
            </ul>
          </div>

          <Separator className="my-1" />

          {/* --- Schedules -------------------------------------------------- */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Schedules ({schedules?.length ?? 0})
          </div>
          <div data-testid="doc-schedules-section">
            {/* The create form (SCHEDULE semantics — the default full
                per-source column set). */}
            <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="doc-schedule-form">
              <input
                className={TEXT_INPUT + " !w-24"}
                aria-label="new schedule name"
                placeholder="name"
                value={scheduleName}
                data-testid="doc-schedule-name"
                onChange={(e) => setScheduleName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createSchedule();
                }}
              />
              <select
                className="rounded border bg-background px-1 py-0.5 text-xs"
                aria-label="new schedule source"
                value={scheduleSource}
                data-testid="doc-schedule-source"
                title="The canonical document state the schedule indexes (the six closed sources)"
                onChange={(e) => setScheduleSource(e.target.value as ScheduleSource)}
              >
                {SCHEDULE_SOURCES.map((source) => (
                  <option key={source} value={source}>{source}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-[10px]"
                data-testid="doc-schedule-create"
                title={`SCHEDULE — create the schedule with the default ${scheduleSource} column set (one atomic revision)`}
                disabled={scheduleName.trim().length === 0}
                onClick={createSchedule}
              >
                <Plus className="h-3 w-3" aria-hidden /> Schedule
              </Button>
            </div>
            <ul aria-label="schedules">
              {(schedules ?? []).map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] hover:bg-muted/50"
                  data-testid={`doc-schedule-${s.id}`}
                >
                  <span className="truncate">{s.name}</span>
                  <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">{s.source}</Badge>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{s.columnCount} column{s.columnCount === 1 ? "" : "s"}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                    aria-label={`run schedule ${s.name}`}
                    data-testid={`doc-schedule-run-${s.id}`}
                    title="schedules.run — compute the rows fresh over the current state (a query — never stored)"
                    onClick={() => void runSchedule(s)}
                  >
                    Run
                  </Button>
                </li>
              ))}
              {schedules !== null && schedules.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">
                  No schedules — the form above (or the SCHEDULE command) creates one.
                </li>
              )}
              {schedules === null && (
                <li className="px-2 py-1 text-xs text-muted-foreground">Loading schedules…</li>
              )}
            </ul>
            {/* The fresh schedule run result (the deterministic rows + the
                canonical sha256 — the same derivation the SCHLIST report
                family reads). */}
            {scheduleRun !== null && (
              <div className="mt-1 px-2">
                <div
                  className="py-0.5 font-mono text-[10px] text-muted-foreground"
                  data-testid="doc-schedule-result"
                  title={`schedules.run ${scheduleRun.sha256}`}
                >
                  {scheduleRun.schedule.name}: {scheduleRun.rowCount} row{scheduleRun.rowCount === 1 ? "" : "s"} · sha256 {scheduleRun.sha256.slice(0, 12)}…
                </div>
                <table className="w-full text-[10px]" data-testid="doc-schedule-table">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      {scheduleRun.schedule.columns.map((column) => (
                        <th key={column.key} className="py-0.5 pr-1 font-medium">{column.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scheduleRun.rows.map((row, i) => (
                      <tr
                        key={i}
                        className="border-b border-border/40"
                        data-testid={`doc-schedule-row-${i}`}
                      >
                        {row.map((cell, j) => (
                          <td key={j} className="py-0.5 pr-1 font-mono">{cell}</td>
                        ))}
                      </tr>
                    ))}
                    {scheduleRun.rows.length === 0 && (
                      <tr>
                        <td className="py-0.5 text-muted-foreground" colSpan={Math.max(1, scheduleRun.schedule.columns.length)}>
                          No rows for the current state.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <Separator className="my-1" />

          {/* --- Publisher ---------------------------------------------------- */}
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Publisher ({tree?.publisherSets.length ?? 0} set{(tree?.publisherSets.length ?? 0) === 1 ? "" : "s"})
          </div>
          <div data-testid="doc-publisher-section">
            {/* The create form (PUBSET semantics — the strict comma/pipe
                subset:Name / layout:Name item grammar, all items pdf). */}
            <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="doc-publisher-form">
              <input
                className={TEXT_INPUT + " !w-24"}
                aria-label="new publisher set name"
                placeholder="name"
                value={publisherName}
                data-testid="doc-publisher-name"
                onChange={(e) => setPublisherName(e.target.value)}
              />
              <input
                className={TEXT_INPUT + " !w-40"}
                aria-label="publisher items"
                placeholder="subset:Name, layout:Name"
                value={publisherItems}
                data-testid="doc-publisher-items"
                title="Items, comma/pipe-separated (subset:Name / layout:Name entries — strict parse, junk is rejected)"
                onChange={(e) => setPublisherItems(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-[10px]"
                data-testid="doc-publisher-create"
                title="PUBSET — create the publisher set (all items publish as PDF; one atomic revision)"
                disabled={publisherName.trim().length === 0}
                onClick={createPublisherSet}
              >
                <Plus className="h-3 w-3" aria-hidden /> Set
              </Button>
            </div>
            <ul aria-label="publisher sets">
              {(tree?.publisherSets ?? []).map((set) => (
                <li
                  key={set.id}
                  className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] hover:bg-muted/50"
                  data-testid={`doc-publisher-${set.id}`}
                >
                  <span className="truncate">{set.name}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">
                    {set.itemCount} item{set.itemCount === 1 ? "" : "s"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                    aria-label={`publish set ${set.name}`}
                    data-testid={`doc-publisher-run-${set.id}`}
                    title="PUBLISHBOOK — publish the set (NON-VERSIONED output automation: per-page sha256 + the multi-page PDF)"
                    onClick={() => void runPublisher(set.id)}
                  >
                    <BookOpen className="h-3 w-3" aria-hidden /> Publish
                  </Button>
                </li>
              ))}
              {tree !== null && tree.publisherSets.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">
                  No publisher sets — the form above (or the PUBSET command) creates one.
                </li>
              )}
              {tree === null && (
                <li className="px-2 py-1 text-xs text-muted-foreground">Loading publisher sets…</li>
              )}
            </ul>
            {/* The deterministic publish result (per-page sha256 + the
                multi-page PDF size/hash when pdf pages exist). */}
            {publisherRunResult !== null && (
              <div className="mt-1 px-2" data-testid="doc-publisher-result">
                <div className="py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Published: {publisherRunResult.set.name} ({publisherRunResult.pages.length} page{publisherRunResult.pages.length === 1 ? "" : "s"})
                </div>
                <ul>
                  {publisherRunResult.pages.map((page, i) => (
                    <li
                      key={page.layoutId}
                      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] hover:bg-muted/50"
                      data-testid={`doc-publisher-page-${i}`}
                      title={`page ${page.layoutId} — sha256 ${page.sha256}`}
                    >
                      <span className="truncate">{page.layoutName}</span>
                      <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">{page.format.toUpperCase()}</Badge>
                      {page.revisions.length > 0 && (
                        <span className="shrink-0 text-[9px] text-muted-foreground">{page.revisions.join(",")}</span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
                        sha256 {page.sha256.slice(0, 12)}
                      </span>
                    </li>
                  ))}
                </ul>
                {publisherRunResult.pdfSize !== undefined && publisherRunResult.pdfSha256 !== undefined && (
                  <div className="px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                    pdf {publisherRunResult.pdfSize} B · sha256 {publisherRunResult.pdfSha256.slice(0, 12)}…
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="p-2 text-[10px] text-muted-foreground">
            NAVFOLDER/SUBSET/NAVASSIGN/TITLEBLOCK/TITLEPLACE/REVISION/SCHEDULE/PUBSET/PUBLISHBOOK drive the same commands; REVLIST/SCHLIST echo the reports to the history.
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

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
    // CAD-PARITY-008 (Issue #88): the layouts manager (the layout table,
    // page setup, viewport scale/rotation/lock + per-viewport layer
    // visibility — the VPLAYER surface).
    { id: "layouts", label: "Layouts", icon: LayoutTemplate },
    // CAD-PARITY-012 (Issue #102): the Coordination manager (materials,
    // components, grids, clash + BOM + revcloud — the MATLIST/BOM/CLASH
    // commands' palette.show target).
    { id: "coordination", label: "Coord", icon: Network },
    // CAD-PARITY-013 (Issue #104): the Documentation manager (the navigator
    // View Map + Layout Book, title blocks, revisions, schedules and the
    // publisher — the REVLIST/SCHLIST commands' palette.show target).
    { id: "documentation", label: "Docs", icon: BookOpen },
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
        {props.activeTab === "layouts" && <LayoutsPanel {...props} />}
        {props.activeTab === "coordination" && <CoordinationPanel {...props} />}
        {/* CAD-PARITY-013 (Issue #104): the Documentation manager. */}
        {props.activeTab === "documentation" && <DocumentationPanel {...props} />}
        {props.activeTab === "navigator" && <NavigatorPanel {...props} />}
      </div>
      <div className="border-t p-2 text-[10px] text-muted-foreground">
        Snap tol {props.snapshot?.draftingSettings?.snap.tolerance ?? 0.5} mm · grid {props.snapshot?.draftingSettings?.grid.size ?? 1} mm · {props.snapshot?.draftingSettings?.units ?? "mm"}
      </div>
    </div>
  );
}

export { setSelection };
