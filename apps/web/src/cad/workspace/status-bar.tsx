"use client";

/**
 * CAD-PARITY-002 status bar (Web host) — coordinates, drafting-aid toggles,
 * active layer/story, units and selection feedback (CAD-P-003/CAD-P-004).
 * The aid toggles (SNAP/GRID/ORTHO/POLAR/OTRACK) are the professional
 * equivalents of the AutoCAD status toggles; grid/snap persist through
 * drafting.setSettings (document workspace state) while ortho/polar/otrack
 * stay host-local (LOCK-015).
 */

import * as React from "react";
import type { DraftingAids } from "@offisos/cad-app-shell/workspace/feedback";
import { formatCoordinate } from "@offisos/cad-app-shell/workspace/feedback";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";

export interface StatusBarProps {
  readonly cursor: Vec2 | null;
  readonly aids: DraftingAids;
  readonly gridEnabled: boolean;
  readonly snapEnabled: boolean;
  readonly units: string;
  readonly activeLayer: string;
  readonly activeStoryName: string | null;
  readonly selectionCount: number;
  readonly version: number;
  /** CAD-PARITY-004: the lineweight display toggle (LWDISPLAY class). */
  readonly lineweightDisplay: boolean;
  /** CAD-PARITY-008: the TILEMODE-class context ("Model" | "Paper · layout"). */
  readonly spaceLabel: string | null;
  readonly onToggle: (aid: "osnap" | "grid" | "ortho" | "snap" | "polar" | "otrack" | "lweight") => void;
  readonly onActiveLayerClick: () => void;
}

function Toggle(
  props: { label: string; active: boolean; title: string; onClick: () => void; },
): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      aria-pressed={props.active}
      className={
        "rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide transition-colors " +
        (props.active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-muted")
      }
    >
      {props.label}
    </button>
  );
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-background px-3 py-1 text-[11px] text-muted-foreground"
      role="status"
      aria-label="workspace status bar"
      data-testid="status-bar"
    >
      <span className="min-w-[150px] font-mono" data-testid="coordinate-readout">
        {props.cursor !== null ? formatCoordinate(props.cursor) : "—"}
      </span>
      <span className="font-mono" title="Active workplane: World XY (mm)">UCS ▸ World</span>
      {props.spaceLabel !== null && (
        <span className="font-mono" title="Editing context (TILEMODE/MSPACE/PSPACE — layout.setSpace)" data-testid="space-indicator">
          {props.spaceLabel}
        </span>
      )}
      <Toggle label="SNAP" active={props.snapEnabled} title="Grid snap stepping (F9)" onClick={() => props.onToggle("snap")} />
      <Toggle label="GRID" active={props.gridEnabled} title="Grid display (F7)" onClick={() => props.onToggle("grid")} />
      <Toggle label="ORTHO" active={props.aids.ortho} title="Orthogonal constraint (F8)" onClick={() => props.onToggle("ortho")} />
      <Toggle label="POLAR" active={props.aids.polar} title="Polar tracking (F10)" onClick={() => props.onToggle("polar")} />
      <Toggle label="OTRACK" active={props.aids.otrack} title="Object tracking (F11)" onClick={() => props.onToggle("otrack")} />
      <Toggle label="OSNAP" active title="Object snap modes (F3) — configured in settings" onClick={() => props.onToggle("osnap")} />
      <Toggle
        label="LWT"
        active={props.lineweightDisplay}
        title="Lineweight display (LWEIGHT/LW) — lineweights render at weight × zoom when on"
        onClick={() => props.onToggle("lweight")}
      />
      <span className="ml-auto flex items-center gap-x-3">
        <button
          type="button"
          title="Active drafting layer — click to open the Layers manager"
          onClick={props.onActiveLayerClick}
          className="rounded px-1 hover:bg-muted"
        >
          Layer <strong className="text-foreground">{props.activeLayer}</strong>
        </button>
        <span title="Active BIM story">
          Story <strong className="text-foreground">{props.activeStoryName ?? "—"}</strong>
        </span>
        <span title="Selected entities">
          Sel <strong className="text-foreground">{props.selectionCount}</strong>
        </span>
        <span title="Document version">
          v<strong className="text-foreground">{props.version}</strong>
        </span>
        <span>{props.units}</span>
      </span>
    </div>
  );
}
