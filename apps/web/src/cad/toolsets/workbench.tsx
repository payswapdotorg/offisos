"use client";

/**
 * Offisos Specialized Toolsets Workbench — Web host surface
 * (CAD-PARITY-018 / Issue #118).
 *
 * A REAL workflow, not a mockup: the versioned typed capability discovery
 * table (the closed 26-entry registry, bound to the current canonical
 * revision); the specialized-record inventory (the document-owned
 * `tls-NNNNNN` rows of the CADDocument specialized table — id-sorted,
 * filterable); the architecture composition workflows (wall runs, hosted
 * openings, roofs, stair runs, space grids, dimension chains, component
 * arrays — every command emits EXACTLY the element batches the verified
 * bim.createElements / drafting.createEntities paths produce); the bounded
 * MEP routing workflows (run records, in-record connections, the
 * deterministic route validation + clash/clearance diagnostics); the
 * bounded mechanical equipment workflows (equipment records with ordinal
 * ports, deterministic arrays); and the canonical raster/underlay
 * workflows (source + reference records, the fresh status derivation, the
 * typed NON-AUTHORITATIVE trace and the commit-to-canonical path). The
 * CADDocument remains the canonical system of record (LOCK-019) — the
 * toolsets are clients of the governed semantic App API.
 */

import * as React from "react";
import {
  Building2,
  RefreshCw,
  Radar,
  Boxes,
  Workflow,
  Fan,
  Image as ImageIcon,
  Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  bimCreate,
  toolsetArchWallRun,
  toolsetArchHostedOpening,
  toolsetArchRoof,
  toolsetArchStairRun,
  toolsetArchSpaceGrid,
  toolsetArchDimChain,
  toolsetArchComponentArray,
  toolsetMepAddRun,
  toolsetMepConnect,
  toolsetMepRemoveRun,
  toolsetMechAddEquipment,
  toolsetMechArray,
  toolsetMechRemoveEquipment,
  toolsetRasterAddSource,
  toolsetRasterAttach,
  toolsetRasterRemoveReference,
  toolsetRasterCommitTrace,
  toolsetCapabilities,
  toolsetListRecords,
  toolsetMepValidateRoute,
  toolsetMepClashReport,
  toolsetRasterStatus,
  toolsetRasterTrace,
  unwrapToolsetCapabilities,
  unwrapToolsetListRecords,
  unwrapMepRouteReport,
  unwrapMepClashReport,
  unwrapRasterStatus,
  unwrapRasterTrace,
  type SpecializedRecordRow,
  type ToolsetCapabilitiesView,
} from "@/cad/client/http-transport";

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

const TOOLSET_BADGE: Record<string, string> = {
  arch: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  mep: "rounded border border-teal-300 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:border-teal-700 dark:bg-teal-950 dark:text-teal-300",
  mechanical: "rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
  raster: "rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

const KIND_BADGE: Record<string, string> = {
  command: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  query: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
};

const STATUS_BADGE: Record<string, string> = {
  ok: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  stale: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  missing: "rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

const SECTIONS = ["capabilities", "records", "architecture", "mep", "mechanical", "raster"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABEL: Record<Section, string> = {
  capabilities: "Capability Discovery",
  records: "Specialized Records",
  architecture: "Architecture",
  mep: "MEP Routing",
  mechanical: "Mechanical",
  raster: "Raster / Underlay",
};

/** The seed host context the architecture workflows need (the P011 BIM
 *  primitives — composed through the SAME governed bim.createElements
 *  path, never fabricated): two stories, one wall and one component
 *  definition. */
const SEED_ENTITIES = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000, name: "South wall" },
  { type: "bim.story", id: "story-1", name: "First Floor", level: 3000, height: 3000 },
  { type: "bim.componentDef", id: "def-desk", name: "Workstation Desk", category: "furniture", parameters: { width: 1600, depth: 800, height: 750 } },
];

const SEED_MECHANICAL_PORTS = `[
  { "id": "p1", "kind": "supply", "position": { "x": 100, "y": 0, "z": 0 }, "nominal": 32, "domain": "pipe" },
  { "id": "p2", "kind": "return", "position": { "x": -100, "y": 0, "z": 0 }, "nominal": 32, "domain": "pipe" }
]`;

const SEED_LINEWORK = `[
  { "x1": 100, "y1": 100, "x2": 900, "y2": 100 },
  { "x1": 100, "y1": 300, "x2": 900, "y2": 300 }
]`;

/** The connection target JSON the mep connect form prefills. */
const SEED_TARGET_JSON = `{
  "kind": "equipment",
  "equipmentId": "tls-000002",
  "portId": "p1"
}`;

// --- the deterministic form parsers (fixed grammar, typed errors) ------------

function parsePoint2(text: string): { x: number; y: number } | null {
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function parsePoint3(text: string): { x: number; y: number; z: number } | null {
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== 3) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function parsePoints2(text: string): { x: number; y: number }[] | null {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return null;
  const points: { x: number; y: number }[] = [];
  for (const token of tokens) {
    const p = parsePoint2(token);
    if (p === null) return null;
    points.push(p);
  }
  return points;
}

function parseSegments(text: string): { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }[] | null {
  const lines = text.trim().split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const segments: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }[] = [];
  for (const line of lines) {
    const [from, to] = line.split("->").map((s) => s.trim());
    if (from === undefined || to === undefined) return null;
    const start = parsePoint3(from);
    const end = parsePoint3(to);
    if (start === null || end === null) return null;
    segments.push({ start, end });
  }
  return segments;
}

const num = (text: string): number | null => {
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
};

/** The command-outcome summary (the snapshot is stripped — it is the whole
 *  document; the summary shows the created ids / the record / the counts). */
function summarize(res: { ok: boolean; value?: unknown }): string {
  if (!res.ok || typeof res.value !== "object" || res.value === null) return "unexpected response shape";
  const { snapshot: _snapshot, ...rest } = res.value as Record<string, unknown>;
  void _snapshot;
  return JSON.stringify(rest, null, 1);
}

/** The command-outcome block (the snapshot is stripped — it is the whole
 *  document; the summary shows the created ids / the record / the counts). */
function ResultBlock({ label, result, error }: { label: string; result: string | null; error: string | null }): React.JSX.Element | null {
  if (result === null && error === null) return null;
  return (
    <div className="pt-1">
      {error !== null && <p className="text-xs text-rose-600">{error}</p>}
      {result !== null && (
        <pre className="max-h-40 overflow-auto rounded border bg-stone-50 p-2 font-mono text-[10px] leading-4 dark:border-stone-800 dark:bg-stone-900" aria-label={`${label} outcome`}>
          {result}
        </pre>
      )}
    </div>
  );
}

export function ToolsetsWorkbench(): React.JSX.Element {
  const [section, setSection] = React.useState<Section>("capabilities");

  // --- capabilities -------------------------------------------------------------
  const [capabilities, setCapabilities] = React.useState<ToolsetCapabilitiesView | null>(null);
  const [capabilityFilter, setCapabilityFilter] = React.useState("");
  const [capabilityError, setCapabilityError] = React.useState<string | null>(null);
  const [capabilityBusy, setCapabilityBusy] = React.useState(false);

  // --- records -------------------------------------------------------------------
  const [records, setRecords] = React.useState<readonly SpecializedRecordRow[] | null>(null);
  const [recordFilter, setRecordFilter] = React.useState<string>("");
  const [recordError, setRecordError] = React.useState<string | null>(null);
  const [recordBusy, setRecordBusy] = React.useState(false);

  // --- architecture -----------------------------------------------------------------
  const [archResult, setArchResult] = React.useState<string | null>(null);
  const [archError, setArchError] = React.useState<string | null>(null);
  const [archBusy, setArchBusy] = React.useState(false);
  const [wallRunForm, setWallRunForm] = React.useState({ storyId: "story-gf", polyline: "0,0 6000,0 6000,5000", widthMm: "300", heightMm: "3000", name: "run", junctions: "none" });
  const [openingForm, setOpeningForm] = React.useState({ wallId: "wall-south", kind: "door", tAlongWall: "2500", widthMm: "900", heightMm: "2100", sillMm: "0" });
  const [roofForm, setRoofForm] = React.useState({ storyId: "story-gf", corner1: "0,0", corner2: "6000,5000", ridgeAxis: "x", heightMm: "1500" });
  const [stairForm, setStairForm] = React.useState({ storyId: "story-gf", topStoryId: "story-1", start: "1000,1000", widthMm: "1200", stepCount: "16", treadMm: "280", railings: "both" });
  const [gridForm, setGridForm] = React.useState({ storyId: "story-gf", origin: "0,0", cols: "4", rows: "3", cellWidthMm: "1500", cellHeightMm: "1500", prefix: "grid" });
  const [dimChainForm, setDimChainForm] = React.useState({ points: "0,0 6000,0 6000,5000", offsetMm: "600" });
  const [compArrayForm, setCompArrayForm] = React.useState({ definitionId: "def-desk", storyId: "story-gf", origin: "0,0", cols: "3", rows: "2", dxMm: "2000", dyMm: "2000" });

  // --- mep ----------------------------------------------------------------------------
  const [mepResult, setMepResult] = React.useState<string | null>(null);
  const [mepError, setMepError] = React.useState<string | null>(null);
  const [mepBusy, setMepBusy] = React.useState(false);
  const [runForm, setRunForm] = React.useState({ domain: "duct", shape: "round", nominalSize: "300", name: "sa-1", segments: "0,500,0 -> 3000,500,0" });
  const [connectForm, setConnectForm] = React.useState({ runId: "tls-000001", at: "start", target: SEED_TARGET_JSON });
  const [routeForm, setRouteForm] = React.useState({ id: "tls-000001" });
  const [routeReport, setRouteReport] = React.useState<{ id: string; domain: string; violations: readonly { code: string; message: string; segmentIndex?: number }[] } | null>(null);
  const [clashForm, setClashForm] = React.useState({ clearanceMm: "100" });
  const [clashReport, setClashReport] = React.useState<{ clearanceMm: number; runCount: number; diagnostics: readonly { runId: string; segmentIndex: number; elementId: string; kindOfClash: string; distanceMm: number; clearanceMm: number; message: string }[] } | null>(null);

  // --- mechanical -----------------------------------------------------------------------
  const [mechResult, setMechResult] = React.useState<string | null>(null);
  const [mechError, setMechError] = React.useState<string | null>(null);
  const [mechBusy, setMechBusy] = React.useState(false);
  const [equipmentForm, setEquipmentForm] = React.useState({ kind: "pump", name: "pump-a", origin: "-500,0,0", ports: SEED_MECHANICAL_PORTS });
  const [arrayForm, setArrayForm] = React.useState({ equipmentId: "tls-000002", cols: "2", rows: "2", dxMm: "2000", dyMm: "2000" });

  // --- raster ------------------------------------------------------------------------------
  const [rasterResult, setRasterResult] = React.useState<string | null>(null);
  const [rasterError, setRasterError] = React.useState<string | null>(null);
  const [rasterBusy, setRasterBusy] = React.useState(false);
  const [sourceForm, setSourceForm] = React.useState({ sourceRef: "underlay/site-plan.png", contentDigest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", widthPx: "1000", heightPx: "600", lineWork: SEED_LINEWORK });
  const [attachForm, setAttachForm] = React.useState({ sourceRef: "underlay/site-plan.png", declaredDigest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", origin: "0,0", scale: "0.5", rotationDeg: "0" });
  const [statusView, setStatusView] = React.useState<{ statuses: readonly { referenceId: string; sourceRef: string; status: string; reason: string }[]; referenceCount: number } | null>(null);
  const [traceForm, setTraceForm] = React.useState({ referenceId: "tls-000004" });
  const [traceView, setTraceView] = React.useState<{ referenceId: string; sourceRef: string; vectors: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[]; authoritative: false; notice: string } | null>(null);

  const describeFailure = (res: { ok: boolean; code?: string; message?: string }): string =>
    res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`;

  const refresh = React.useCallback(async (): Promise<void> => {
    const [capsRes, recordsRes] = await Promise.all([toolsetCapabilities(), toolsetListRecords()]);
    setCapabilities(unwrapToolsetCapabilities(capsRes));
    setRecords(unwrapToolsetListRecords(recordsRes)?.records ?? null);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      void cancelled;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // --- record actions (the shared remove dispatch by kind) ------------------------------

  const onRemoveRecord = React.useCallback(async (row: SpecializedRecordRow): Promise<void> => {
    setRecordBusy(true);
    setRecordError(null);
    try {
      let res: { ok: boolean; code?: string; message?: string };
      if (row.kind === "mep.run") res = await toolsetMepRemoveRun(row.id);
      else if (row.kind === "mech.equipment") res = await toolsetMechRemoveEquipment(row.id);
      else if (row.kind === "raster.reference") res = await toolsetRasterRemoveReference(row.id);
      else {
        setRecordError(`the ${row.kind} rows are replaced through their set commands (no remove)`);
        return;
      }
      if (!res.ok) setRecordError(describeFailure(res));
      else await refresh();
    } finally {
      setRecordBusy(false);
    }
  }, [refresh]);

  // --- architecture actions -----------------------------------------------------------

  const onSeedHosts = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const res = await bimCreate(SEED_ENTITIES);
      if (!res.ok) setArchError(describeFailure(res));
      else setArchResult(summarize(res));
    } finally {
      setArchBusy(false);
    }
  }, []);

  const onWallRun = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const polyline = parsePoints2(wallRunForm.polyline);
      const widthMm = num(wallRunForm.widthMm);
      const heightMm = num(wallRunForm.heightMm);
      if (polyline === null || widthMm === null || heightMm === null) {
        setArchError("wall run requires a polyline ('x,y x,y …', ≥ 2 points) and numeric width/height");
        return;
      }
      const res = await toolsetArchWallRun({
        storyId: wallRunForm.storyId.trim(),
        polyline,
        widthMm,
        heightMm,
        ...(wallRunForm.name.trim() !== "" ? { name: wallRunForm.name.trim() } : {}),
        junctions: wallRunForm.junctions as "none" | "openings",
      });
      if (!res.ok) setArchError(describeFailure(res));
      else {
        setArchResult(summarize(res));
        await refresh();
      }
    } finally {
      setArchBusy(false);
    }
  }, [wallRunForm, refresh]);

  const onHostedOpening = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const tAlongWall = num(openingForm.tAlongWall);
      const widthMm = num(openingForm.widthMm);
      const heightMm = num(openingForm.heightMm);
      const sillMm = num(openingForm.sillMm);
      if (tAlongWall === null || widthMm === null || heightMm === null) {
        setArchError("hosted opening requires numeric tAlongWall/widthMm/heightMm");
        return;
      }
      const res = await toolsetArchHostedOpening({
        wallId: openingForm.wallId.trim(),
        kind: openingForm.kind as "door" | "window",
        tAlongWall,
        widthMm,
        heightMm,
        ...(sillMm !== null ? { sillMm } : {}),
      });
      if (!res.ok) setArchError(describeFailure(res));
      else {
        setArchResult(summarize(res));
        await refresh();
      }
    } finally {
      setArchBusy(false);
    }
  }, [openingForm, refresh]);

  const onRoof = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const corner1 = parsePoint2(roofForm.corner1);
      const corner2 = parsePoint2(roofForm.corner2);
      const heightMm = num(roofForm.heightMm);
      if (corner1 === null || corner2 === null || heightMm === null) {
        setArchError("roof requires corners ('x,y') and a numeric height");
        return;
      }
      const res = await toolsetArchRoof({
        storyId: roofForm.storyId.trim(),
        corner1,
        corner2,
        ridgeAxis: roofForm.ridgeAxis as "x" | "y",
        heightMm,
      });
      if (!res.ok) setArchError(describeFailure(res));
      else {
        setArchResult(summarize(res));
        await refresh();
      }
    } finally {
      setArchBusy(false);
    }
  }, [roofForm, refresh]);

  const onStairRun = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const start = parsePoint2(stairForm.start);
      const widthMm = num(stairForm.widthMm);
      const stepCount = num(stairForm.stepCount);
      const treadMm = num(stairForm.treadMm);
      if (start === null || widthMm === null || stepCount === null || treadMm === null) {
        setArchError("stair run requires a numeric start ('x,y'), width, stepCount and tread");
        return;
      }
      const res = await toolsetArchStairRun({
        storyId: stairForm.storyId.trim(),
        topStoryId: stairForm.topStoryId.trim(),
        start,
        widthMm,
        stepCount,
        treadMm,
        railings: stairForm.railings as "none" | "left" | "right" | "both",
      });
      if (!res.ok) setArchError(describeFailure(res));
      else {
        setArchResult(summarize(res));
        await refresh();
      }
    } finally {
      setArchBusy(false);
    }
  }, [stairForm, refresh]);

  const onSpaceGrid = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const origin = parsePoint2(gridForm.origin);
      const cols = num(gridForm.cols);
      const rows = num(gridForm.rows);
      const cellWidthMm = num(gridForm.cellWidthMm);
      const cellHeightMm = num(gridForm.cellHeightMm);
      if (origin === null || cols === null || rows === null || cellWidthMm === null || cellHeightMm === null) {
        setArchError("space grid requires a numeric origin, cols, rows and cell sizes");
        return;
      }
      const res = await toolsetArchSpaceGrid({
        storyId: gridForm.storyId.trim(),
        origin,
        cols,
        rows,
        cellWidthMm,
        cellHeightMm,
        ...(gridForm.prefix.trim() !== "" ? { prefix: gridForm.prefix.trim() } : {}),
      });
      if (!res.ok) setArchError(describeFailure(res));
      else {
        setArchResult(summarize(res));
        await refresh();
      }
    } finally {
      setArchBusy(false);
    }
  }, [gridForm, refresh]);

  const onDimChain = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const points = parsePoints2(dimChainForm.points);
      const offsetMm = num(dimChainForm.offsetMm);
      if (points === null) {
        setArchError("dimension chain requires points ('x,y x,y …')");
        return;
      }
      const res = await toolsetArchDimChain({
        points,
        ...(offsetMm !== null ? { offsetMm } : {}),
      });
      if (!res.ok) setArchError(describeFailure(res));
      else {
        setArchResult(summarize(res));
        await refresh();
      }
    } finally {
      setArchBusy(false);
    }
  }, [dimChainForm, refresh]);

  const onComponentArray = React.useCallback(async (): Promise<void> => {
    setArchBusy(true);
    setArchError(null);
    try {
      const origin = parsePoint2(compArrayForm.origin);
      const cols = num(compArrayForm.cols);
      const rows = num(compArrayForm.rows);
      const dxMm = num(compArrayForm.dxMm);
      const dyMm = num(compArrayForm.dyMm);
      if (origin === null || cols === null || rows === null || dxMm === null || dyMm === null) {
        setArchError("component array requires a numeric origin, cols, rows and spacings");
        return;
      }
      const res = await toolsetArchComponentArray({
        definitionId: compArrayForm.definitionId.trim(),
        storyId: compArrayForm.storyId.trim(),
        origin,
        cols,
        rows,
        dxMm,
        dyMm,
      });
      if (!res.ok) setArchError(describeFailure(res));
      else {
        setArchResult(summarize(res));
        await refresh();
      }
    } finally {
      setArchBusy(false);
    }
  }, [compArrayForm, refresh]);

  // --- mep actions -----------------------------------------------------------------------

  const onAddRun = React.useCallback(async (): Promise<void> => {
    setMepBusy(true);
    setMepError(null);
    try {
      const segments = parseSegments(runForm.segments);
      const nominalSize = num(runForm.nominalSize);
      if (segments === null || nominalSize === null) {
        setMepError("MEP run requires segments ('x,y,z -> x,y,z' per line) and a numeric nominal size");
        return;
      }
      const res = await toolsetMepAddRun({
        domain: runForm.domain as "duct" | "pipe" | "conduit",
        shape: runForm.shape as "round" | "rect",
        nominalSize,
        ...(runForm.name.trim() !== "" ? { name: runForm.name.trim() } : {}),
        segments,
      });
      if (!res.ok) setMepError(describeFailure(res));
      else {
        setMepResult(summarize(res));
        await refresh();
      }
    } finally {
      setMepBusy(false);
    }
  }, [runForm, refresh]);

  const onConnect = React.useCallback(async (): Promise<void> => {
    setMepBusy(true);
    setMepError(null);
    try {
      let target: Record<string, unknown>;
      try {
        target = JSON.parse(connectForm.target) as Record<string, unknown>;
      } catch (e) {
        setMepError(`invalid target JSON — ${(e as Error).message}`);
        return;
      }
      const res = await toolsetMepConnect(
        connectForm.runId.trim(),
        connectForm.at as "start" | "end",
        target as never,
      );
      if (!res.ok) setMepError(describeFailure(res));
      else {
        setMepResult(summarize(res));
        await refresh();
      }
    } finally {
      setMepBusy(false);
    }
  }, [connectForm, refresh]);

  const onValidateRoute = React.useCallback(async (): Promise<void> => {
    setMepBusy(true);
    setMepError(null);
    try {
      const res = await toolsetMepValidateRoute(routeForm.id.trim());
      const report = unwrapMepRouteReport(res);
      if (report === null) setMepError(describeFailure(res));
      else setRouteReport(report);
    } finally {
      setMepBusy(false);
    }
  }, [routeForm]);

  const onClashReport = React.useCallback(async (): Promise<void> => {
    setMepBusy(true);
    setMepError(null);
    try {
      const clearanceMm = num(clashForm.clearanceMm);
      const res = await toolsetMepClashReport(clearanceMm ?? undefined);
      const report = unwrapMepClashReport(res);
      if (report === null) setMepError(describeFailure(res));
      else setClashReport(report);
    } finally {
      setMepBusy(false);
    }
  }, [clashForm]);

  // --- mechanical actions --------------------------------------------------------------------

  const onAddEquipment = React.useCallback(async (): Promise<void> => {
    setMechBusy(true);
    setMechError(null);
    try {
      const origin = parsePoint3(equipmentForm.origin);
      if (origin === null) {
        setMechError("equipment origin must be 'x,y,z'");
        return;
      }
      let ports: unknown;
      try {
        ports = JSON.parse(equipmentForm.ports);
      } catch (e) {
        setMechError(`invalid ports JSON — ${(e as Error).message}`);
        return;
      }
      const res = await toolsetMechAddEquipment({
        kind: equipmentForm.kind as "machine" | "pump" | "fan" | "ahu" | "panel" | "tank",
        ...(equipmentForm.name.trim() !== "" ? { name: equipmentForm.name.trim() } : {}),
        origin,
        ports: ports as never,
      });
      if (!res.ok) setMechError(describeFailure(res));
      else {
        setMechResult(summarize(res));
        await refresh();
      }
    } finally {
      setMechBusy(false);
    }
  }, [equipmentForm, refresh]);

  const onEquipmentArray = React.useCallback(async (): Promise<void> => {
    setMechBusy(true);
    setMechError(null);
    try {
      const cols = num(arrayForm.cols);
      const rows = num(arrayForm.rows);
      const dxMm = num(arrayForm.dxMm);
      const dyMm = num(arrayForm.dyMm);
      if (cols === null || rows === null || dxMm === null || dyMm === null) {
        setMechError("equipment array requires numeric cols, rows and spacings");
        return;
      }
      const res = await toolsetMechArray(arrayForm.equipmentId.trim(), cols, rows, dxMm, dyMm);
      if (!res.ok) setMechError(describeFailure(res));
      else {
        setMechResult(summarize(res));
        await refresh();
      }
    } finally {
      setMechBusy(false);
    }
  }, [arrayForm, refresh]);

  // --- raster actions ---------------------------------------------------------------------------

  const onAddSource = React.useCallback(async (): Promise<void> => {
    setRasterBusy(true);
    setRasterError(null);
    try {
      let lineWork: unknown;
      try {
        lineWork = JSON.parse(sourceForm.lineWork);
      } catch (e) {
        setRasterError(`invalid lineWork JSON — ${(e as Error).message}`);
        return;
      }
      const widthPx = num(sourceForm.widthPx);
      const heightPx = num(sourceForm.heightPx);
      if (widthPx === null || heightPx === null) {
        setRasterError("raster source requires numeric pixel dimensions");
        return;
      }
      const res = await toolsetRasterAddSource({
        sourceRef: sourceForm.sourceRef.trim(),
        contentDigest: sourceForm.contentDigest.trim(),
        widthPx,
        heightPx,
        lineWork: lineWork as never,
      });
      if (!res.ok) setRasterError(describeFailure(res));
      else {
        setRasterResult(summarize(res));
        await refresh();
      }
    } finally {
      setRasterBusy(false);
    }
  }, [sourceForm, refresh]);

  const onAttach = React.useCallback(async (): Promise<void> => {
    setRasterBusy(true);
    setRasterError(null);
    try {
      const origin = parsePoint2(attachForm.origin);
      const scale = num(attachForm.scale);
      const rotationDeg = num(attachForm.rotationDeg);
      if (origin === null || scale === null || rotationDeg === null) {
        setRasterError("raster reference requires a numeric origin ('x,y'), scale and rotation");
        return;
      }
      const res = await toolsetRasterAttach({
        sourceRef: attachForm.sourceRef.trim(),
        declaredDigest: attachForm.declaredDigest.trim(),
        transform: { origin, scale, rotationDeg },
        visible: true,
      });
      if (!res.ok) setRasterError(describeFailure(res));
      else {
        setRasterResult(summarize(res));
        await refresh();
      }
    } finally {
      setRasterBusy(false);
    }
  }, [attachForm, refresh]);

  const onStatusRefresh = React.useCallback(async (): Promise<void> => {
    setRasterBusy(true);
    setRasterError(null);
    try {
      const res = await toolsetRasterStatus();
      const view = unwrapRasterStatus(res);
      if (view === null) setRasterError(describeFailure(res));
      else setStatusView(view);
    } finally {
      setRasterBusy(false);
    }
  }, []);

  const onTrace = React.useCallback(async (): Promise<void> => {
    setRasterBusy(true);
    setRasterError(null);
    try {
      const res = await toolsetRasterTrace(traceForm.referenceId.trim());
      const view = unwrapRasterTrace(res);
      if (view === null) setRasterError(describeFailure(res));
      else setTraceView(view);
    } finally {
      setRasterBusy(false);
    }
  }, [traceForm]);

  const onCommitTrace = React.useCallback(async (): Promise<void> => {
    setRasterBusy(true);
    setRasterError(null);
    try {
      const res = await toolsetRasterCommitTrace(traceForm.referenceId.trim());
      if (!res.ok) setRasterError(describeFailure(res));
      else {
        setRasterResult(summarize(res));
        await refresh();
      }
    } finally {
      setRasterBusy(false);
    }
  }, [traceForm, refresh]);

  const visibleCapabilities = React.useMemo(() => {
    if (capabilities === null) return [];
    const needle = capabilityFilter.trim().toLowerCase();
    if (needle === "") return [...capabilities.capabilities];
    return capabilities.capabilities.filter((c) => c.name.toLowerCase().includes(needle));
  }, [capabilities, capabilityFilter]);

  const visibleRecords = React.useMemo(() => {
    if (records === null) return [];
    const needle = recordFilter.trim();
    if (needle === "") return [...records];
    return records.filter((r) => r.toolset === needle || r.kind === needle || r.id.includes(needle));
  }, [records, recordFilter]);

  // --- render ----------------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Boxes className="h-4 w-4" aria-hidden="true" />
              <CardTitle className="text-base">Specialized Toolsets</CardTitle>
              {capabilities !== null && (
                <Badge variant="outline" className="font-mono text-[10px]" aria-label={`toolsets API version ${capabilities.apiVersion}`}>
                  api v{capabilities.apiVersion}
                </Badge>
              )}
              {capabilities !== null && (
                <Badge variant="outline" className="font-mono text-[10px]" aria-label={`${capabilities.capabilities.length} capabilities in the closed registry`}>
                  {capabilities.capabilities.length} capabilities
                </Badge>
              )}
              {capabilities !== null && (
                <Badge variant="outline" className="font-mono text-[10px]" aria-label={`the toolsets surface is bound to document version ${capabilities.documentVersion}`}>
                  doc v{capabilities.documentVersion}
                </Badge>
              )}
              {records !== null && (
                <Badge variant="outline" className="font-mono text-[10px]" aria-label={`${records.length} document-owned specialized records`}>
                  {records.length} tls- records
                </Badge>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh()} aria-label="Refresh the toolsets surfaces">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
            </Button>
          </div>
          <CardDescription className="text-xs">
            The four professional toolsets composed over the governed App API: architecture composition emits exactly the verified BIM
            element batches; MEP/mechanical/raster records are document-owned rows of the specialized table. The CADDocument stays the
            canonical system of record — every mutation is one atomic revision.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Toolsets workbench sections">
            {SECTIONS.map((s) => (
              <Button
                key={s}
                variant={section === s ? "default" : "outline"}
                size="sm"
                onClick={() => setSection(s)}
                role="tab"
                aria-selected={section === s}
              >
                {SECTION_LABEL[s]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {section === "capabilities" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Radar className="h-4 w-4" aria-hidden="true" /> Capability discovery (toolset.capabilities)</CardTitle>
            <CardDescription className="text-xs">
              {capabilities !== null
                ? `The closed v${capabilities.apiVersion} registry — 20 commands + 6 queries across arch/mep/mechanical/raster. Anything not listed is the App API's own typed decline, never a fabricated semantic. Bound to doc v${capabilities.documentVersion} (sha ${capabilities.contentHash.slice(0, 12)}…).`
                : "loading…"}
            </CardDescription>
            <div className="flex items-center gap-2 pt-1">
              <input
                className={INP + " max-w-72"}
                placeholder="filter by capability name…"
                value={capabilityFilter}
                onChange={(e) => setCapabilityFilter(e.target.value)}
                aria-label="Filter capabilities by name"
              />
              <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={capabilityBusy} aria-label="Refresh the capability table">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> reload
              </Button>
            </div>
            {capabilityError !== null && <p className="text-xs text-rose-600">{capabilityError}</p>}
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left font-mono">capability</th>
                    <th className="px-2 py-1 text-left">type</th>
                    <th className="px-2 py-1 text-left">toolset</th>
                    <th className="px-2 py-1 text-left">summary</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCapabilities.map((c) => (
                    <tr key={c.name} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1 font-mono">{c.name}</td>
                      <td className="px-2 py-1"><span className={KIND_BADGE[c.kind]}>{c.kind}</span></td>
                      <td className="px-2 py-1"><span className={TOOLSET_BADGE[c.toolset]}>{c.toolset}</span></td>
                      <td className="px-2 py-1 text-stone-600 dark:text-stone-400">{c.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "records" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Table2 className="h-4 w-4" aria-hidden="true" /> Specialized-record inventory (toolset.listRecords)</CardTitle>
            <CardDescription className="text-xs">
              The document-owned specialized table — `tls-NNNNNN` identities minted by the CADDocument (monotonic, never reused),
              id-sorted. Every row mutates only through doc.execute (one atomic revision per command, exact undo/redo/replay).
            </CardDescription>
            <div className="flex items-center gap-2 pt-1">
              <input
                className={INP + " max-w-48"}
                placeholder="filter by toolset/kind/id…"
                value={recordFilter}
                onChange={(e) => setRecordFilter(e.target.value)}
                aria-label="Filter specialized records"
              />
            </div>
            {recordError !== null && <p className="text-xs text-rose-600">{recordError}</p>}
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72 rounded border dark:border-stone-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                  <tr>
                    <th className="px-2 py-1 text-left font-mono">record id</th>
                    <th className="px-2 py-1 text-left">toolset</th>
                    <th className="px-2 py-1 text-left">kind</th>
                    <th className="px-2 py-1 text-right">remove</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.map((r) => (
                    <tr key={r.id} className="border-t dark:border-stone-800">
                      <td className="px-2 py-1 font-mono">{r.id}</td>
                      <td className="px-2 py-1"><span className={TOOLSET_BADGE[r.toolset] ?? KIND_BADGE.query}>{r.toolset}</span></td>
                      <td className="px-2 py-1 font-mono">{r.kind}</td>
                      <td className="px-2 py-1 text-right">
                        <Button variant="outline" size="sm" onClick={() => void onRemoveRecord(r)} disabled={recordBusy || r.kind === "raster.source"} aria-label={`Remove the specialized record ${r.id}`}>
                          remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {records !== null && records.length === 0 && (
                    <tr><td colSpan={4} className="px-2 py-2 text-stone-500">No specialized records in this document yet — add MEP/mechanical/raster records below.</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "architecture" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Building2 className="h-4 w-4" aria-hidden="true" /> Architecture composition (toolset.arch*)</CardTitle>
            <CardDescription className="text-xs">
              Wall runs, hosted openings, roofs, stair runs, space grids, dimension chains and component arrays — each command composes
              EXACTLY the element batch the verified bim.createElements / drafting.createEntities paths produce (one atomic revision,
              document-minted element ids, typed host-not-found declines).
            </CardDescription>
            <div className="flex items-center gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => void onSeedHosts()} disabled={archBusy} aria-label="Seed the host context (two stories, a wall, a component definition) through bim.createElements">
                seed host context (stories + wall + componentDef)
              </Button>
            </div>
            <ResultBlock label="architecture" result={archResult} error={archError} />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.archWallRun — the multi-segment wall run</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-32"} placeholder="story id" value={wallRunForm.storyId} onChange={(e) => setWallRunForm({ ...wallRunForm, storyId: e.target.value })} aria-label="Wall run story id" />
                <input className={INP + " max-w-72"} placeholder="polyline (x,y x,y …)" value={wallRunForm.polyline} onChange={(e) => setWallRunForm({ ...wallRunForm, polyline: e.target.value })} aria-label="Wall run polyline" />
                <input className={INP + " max-w-24"} placeholder="width mm" value={wallRunForm.widthMm} onChange={(e) => setWallRunForm({ ...wallRunForm, widthMm: e.target.value })} aria-label="Wall width mm" />
                <input className={INP + " max-w-24"} placeholder="height mm" value={wallRunForm.heightMm} onChange={(e) => setWallRunForm({ ...wallRunForm, heightMm: e.target.value })} aria-label="Wall height mm" />
                <input className={INP + " max-w-32"} placeholder="name prefix" value={wallRunForm.name} onChange={(e) => setWallRunForm({ ...wallRunForm, name: e.target.value })} aria-label="Wall run name prefix" />
                <select className={INP + " max-w-32"} value={wallRunForm.junctions} onChange={(e) => setWallRunForm({ ...wallRunForm, junctions: e.target.value })} aria-label="Junction mode">
                  <option value="none">junctions: none</option>
                  <option value="openings">junctions: openings</option>
                </select>
                <Button size="sm" onClick={() => void onWallRun()} disabled={archBusy} aria-label="Compose the wall run">wall run</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.archHostedOpening — the hosted door/window</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-32"} placeholder="host wall id" value={openingForm.wallId} onChange={(e) => setOpeningForm({ ...openingForm, wallId: e.target.value })} aria-label="Host wall id" />
                <select className={INP + " max-w-24"} value={openingForm.kind} onChange={(e) => setOpeningForm({ ...openingForm, kind: e.target.value })} aria-label="Opening kind">
                  <option value="door">door</option>
                  <option value="window">window</option>
                </select>
                <input className={INP + " max-w-28"} placeholder="t along wall" value={openingForm.tAlongWall} onChange={(e) => setOpeningForm({ ...openingForm, tAlongWall: e.target.value })} aria-label="Distance along wall" />
                <input className={INP + " max-w-24"} placeholder="width mm" value={openingForm.widthMm} onChange={(e) => setOpeningForm({ ...openingForm, widthMm: e.target.value })} aria-label="Opening width mm" />
                <input className={INP + " max-w-24"} placeholder="height mm" value={openingForm.heightMm} onChange={(e) => setOpeningForm({ ...openingForm, heightMm: e.target.value })} aria-label="Opening height mm" />
                <input className={INP + " max-w-24"} placeholder="sill mm" value={openingForm.sillMm} onChange={(e) => setOpeningForm({ ...openingForm, sillMm: e.target.value })} aria-label="Opening sill mm" />
                <Button size="sm" onClick={() => void onHostedOpening()} disabled={archBusy} aria-label="Place the hosted opening">hosted opening</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.archRoof — the parametric gable roof</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-32"} placeholder="story id" value={roofForm.storyId} onChange={(e) => setRoofForm({ ...roofForm, storyId: e.target.value })} aria-label="Roof story id" />
                <input className={INP + " max-w-28"} placeholder="corner1 x,y" value={roofForm.corner1} onChange={(e) => setRoofForm({ ...roofForm, corner1: e.target.value })} aria-label="Roof corner 1" />
                <input className={INP + " max-w-28"} placeholder="corner2 x,y" value={roofForm.corner2} onChange={(e) => setRoofForm({ ...roofForm, corner2: e.target.value })} aria-label="Roof corner 2" />
                <select className={INP + " max-w-28"} value={roofForm.ridgeAxis} onChange={(e) => setRoofForm({ ...roofForm, ridgeAxis: e.target.value })} aria-label="Ridge axis">
                  <option value="x">ridge: x</option>
                  <option value="y">ridge: y</option>
                </select>
                <input className={INP + " max-w-24"} placeholder="height mm" value={roofForm.heightMm} onChange={(e) => setRoofForm({ ...roofForm, heightMm: e.target.value })} aria-label="Roof height mm" />
                <Button size="sm" onClick={() => void onRoof()} disabled={archBusy} aria-label="Place the roof">roof</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.archStairRun — the single-flight stair</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-32"} placeholder="story id" value={stairForm.storyId} onChange={(e) => setStairForm({ ...stairForm, storyId: e.target.value })} aria-label="Stair story id" />
                <input className={INP + " max-w-32"} placeholder="top story id" value={stairForm.topStoryId} onChange={(e) => setStairForm({ ...stairForm, topStoryId: e.target.value })} aria-label="Stair top story id" />
                <input className={INP + " max-w-28"} placeholder="start x,y" value={stairForm.start} onChange={(e) => setStairForm({ ...stairForm, start: e.target.value })} aria-label="Stair start" />
                <input className={INP + " max-w-24"} placeholder="width mm" value={stairForm.widthMm} onChange={(e) => setStairForm({ ...stairForm, widthMm: e.target.value })} aria-label="Stair width mm" />
                <input className={INP + " max-w-24"} placeholder="steps" value={stairForm.stepCount} onChange={(e) => setStairForm({ ...stairForm, stepCount: e.target.value })} aria-label="Stair step count" />
                <input className={INP + " max-w-24"} placeholder="tread mm" value={stairForm.treadMm} onChange={(e) => setStairForm({ ...stairForm, treadMm: e.target.value })} aria-label="Stair tread mm" />
                <select className={INP + " max-w-28"} value={stairForm.railings} onChange={(e) => setStairForm({ ...stairForm, railings: e.target.value })} aria-label="Railings">
                  <option value="none">railings: none</option>
                  <option value="left">railings: left</option>
                  <option value="right">railings: right</option>
                  <option value="both">railings: both</option>
                </select>
                <Button size="sm" onClick={() => void onStairRun()} disabled={archBusy} aria-label="Place the stair run">stair run</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.archSpaceGrid — the rectangular space grid</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-32"} placeholder="story id" value={gridForm.storyId} onChange={(e) => setGridForm({ ...gridForm, storyId: e.target.value })} aria-label="Grid story id" />
                <input className={INP + " max-w-28"} placeholder="origin x,y" value={gridForm.origin} onChange={(e) => setGridForm({ ...gridForm, origin: e.target.value })} aria-label="Grid origin" />
                <input className={INP + " max-w-20"} placeholder="cols" value={gridForm.cols} onChange={(e) => setGridForm({ ...gridForm, cols: e.target.value })} aria-label="Grid columns" />
                <input className={INP + " max-w-20"} placeholder="rows" value={gridForm.rows} onChange={(e) => setGridForm({ ...gridForm, rows: e.target.value })} aria-label="Grid rows" />
                <input className={INP + " max-w-28"} placeholder="cell w mm" value={gridForm.cellWidthMm} onChange={(e) => setGridForm({ ...gridForm, cellWidthMm: e.target.value })} aria-label="Grid cell width mm" />
                <input className={INP + " max-w-28"} placeholder="cell h mm" value={gridForm.cellHeightMm} onChange={(e) => setGridForm({ ...gridForm, cellHeightMm: e.target.value })} aria-label="Grid cell height mm" />
                <input className={INP + " max-w-32"} placeholder="name prefix" value={gridForm.prefix} onChange={(e) => setGridForm({ ...gridForm, prefix: e.target.value })} aria-label="Grid name prefix" />
                <Button size="sm" onClick={() => void onSpaceGrid()} disabled={archBusy} aria-label="Compose the space grid">space grid</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.archDimChain — the aligned dimension chain</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-72"} placeholder="points (x,y x,y …)" value={dimChainForm.points} onChange={(e) => setDimChainForm({ ...dimChainForm, points: e.target.value })} aria-label="Dimension chain points" />
                <input className={INP + " max-w-28"} placeholder="offset mm" value={dimChainForm.offsetMm} onChange={(e) => setDimChainForm({ ...dimChainForm, offsetMm: e.target.value })} aria-label="Dimension offset mm" />
                <Button size="sm" onClick={() => void onDimChain()} disabled={archBusy} aria-label="Compose the dimension chain">dim chain</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.archComponentArray — the component-instance array</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-32"} placeholder="definition id" value={compArrayForm.definitionId} onChange={(e) => setCompArrayForm({ ...compArrayForm, definitionId: e.target.value })} aria-label="Component definition id" />
                <input className={INP + " max-w-32"} placeholder="story id" value={compArrayForm.storyId} onChange={(e) => setCompArrayForm({ ...compArrayForm, storyId: e.target.value })} aria-label="Array story id" />
                <input className={INP + " max-w-28"} placeholder="origin x,y" value={compArrayForm.origin} onChange={(e) => setCompArrayForm({ ...compArrayForm, origin: e.target.value })} aria-label="Array origin" />
                <input className={INP + " max-w-20"} placeholder="cols" value={compArrayForm.cols} onChange={(e) => setCompArrayForm({ ...compArrayForm, cols: e.target.value })} aria-label="Array columns" />
                <input className={INP + " max-w-20"} placeholder="rows" value={compArrayForm.rows} onChange={(e) => setCompArrayForm({ ...compArrayForm, rows: e.target.value })} aria-label="Array rows" />
                <input className={INP + " max-w-24"} placeholder="dx mm" value={compArrayForm.dxMm} onChange={(e) => setCompArrayForm({ ...compArrayForm, dxMm: e.target.value })} aria-label="Array column spacing mm" />
                <input className={INP + " max-w-24"} placeholder="dy mm" value={compArrayForm.dyMm} onChange={(e) => setCompArrayForm({ ...compArrayForm, dyMm: e.target.value })} aria-label="Array row spacing mm" />
                <Button size="sm" onClick={() => void onComponentArray()} disabled={archBusy} aria-label="Compose the component array">component array</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {section === "mep" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Workflow className="h-4 w-4" aria-hidden="true" /> MEP routing (toolset.mep*)</CardTitle>
            <CardDescription className="text-xs">
              Bounded duct/pipe/conduit run records (document-minted tls- identities), in-record connections (equipment ports, run ends,
              free endpoints — typed domain mismatches), the deterministic route validation and the clash/clearance diagnostics against
              the canonical wall/slab bodies.
            </CardDescription>
            <ResultBlock label="mep" result={mepResult} error={mepError} />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.mepAddRun — the bounded run record</p>
              <div className="flex flex-wrap items-center gap-2">
                <select className={INP + " max-w-24"} value={runForm.domain} onChange={(e) => setRunForm({ ...runForm, domain: e.target.value })} aria-label="MEP domain">
                  <option value="duct">duct</option>
                  <option value="pipe">pipe</option>
                  <option value="conduit">conduit</option>
                </select>
                <select className={INP + " max-w-24"} value={runForm.shape} onChange={(e) => setRunForm({ ...runForm, shape: e.target.value })} aria-label="MEP run shape">
                  <option value="round">round</option>
                  <option value="rect">rect</option>
                </select>
                <input className={INP + " max-w-28"} placeholder="nominal mm" value={runForm.nominalSize} onChange={(e) => setRunForm({ ...runForm, nominalSize: e.target.value })} aria-label="Nominal size mm" />
                <input className={INP + " max-w-32"} placeholder="name" value={runForm.name} onChange={(e) => setRunForm({ ...runForm, name: e.target.value })} aria-label="Run name" />
                <input className={INP + " max-w-72"} placeholder="segments (x,y,z -> x,y,z per line)" value={runForm.segments} onChange={(e) => setRunForm({ ...runForm, segments: e.target.value })} aria-label="Run segments" />
                <Button size="sm" onClick={() => void onAddRun()} disabled={mepBusy} aria-label="Add the MEP run record">add run</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.mepConnect — the in-record connection</p>
              <div className="flex flex-wrap items-start gap-2">
                <input className={INP + " max-w-36"} placeholder="run id (tls-…)" value={connectForm.runId} onChange={(e) => setConnectForm({ ...connectForm, runId: e.target.value })} aria-label="Run id" />
                <select className={INP + " max-w-24"} value={connectForm.at} onChange={(e) => setConnectForm({ ...connectForm, at: e.target.value })} aria-label="Connection end">
                  <option value="start">at: start</option>
                  <option value="end">at: end</option>
                </select>
                <textarea
                  className={INP + " max-h-32 min-h-24 max-w-72 font-mono text-[10px]"}
                  value={connectForm.target}
                  onChange={(e) => setConnectForm({ ...connectForm, target: e.target.value })}
                  aria-label="The connection target JSON (equipment port, run end or free endpoint)"
                  spellCheck={false}
                />
                <Button size="sm" onClick={() => void onConnect()} disabled={mepBusy} aria-label="Record the connection">connect</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.mepValidateRoute — the deterministic route validation</p>
              <div className="flex items-center gap-2">
                <input className={INP + " max-w-36"} placeholder="run id (tls-…)" value={routeForm.id} onChange={(e) => setRouteForm({ ...routeForm, id: e.target.value })} aria-label="Route validation run id" />
                <Button size="sm" onClick={() => void onValidateRoute()} disabled={mepBusy} aria-label="Validate the route">validate route</Button>
              </div>
              {routeReport !== null && (
                <ScrollArea className="max-h-32 rounded border dark:border-stone-800">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                      <tr>
                        <th className="px-2 py-1 text-left font-mono">run</th>
                        <th className="px-2 py-1 text-left">domain</th>
                        <th className="px-2 py-1 text-left">violations</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t dark:border-stone-800">
                        <td className="px-2 py-1 font-mono">{routeReport.id}</td>
                        <td className="px-2 py-1">{routeReport.domain}</td>
                        <td className="px-2 py-1">
                          {routeReport.violations.length === 0
                            ? "none (the route passes the grammar)"
                            : routeReport.violations.map((v, i) => (
                              <div key={i} className="font-mono text-[10px] text-rose-600">{v.code} — {v.message}</div>
                            ))}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </ScrollArea>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.mepClashReport — the clash/clearance diagnostics</p>
              <div className="flex items-center gap-2">
                <input className={INP + " max-w-28"} placeholder="clearance mm" value={clashForm.clearanceMm} onChange={(e) => setClashForm({ ...clashForm, clearanceMm: e.target.value })} aria-label="Required clearance mm" />
                <Button size="sm" onClick={() => void onClashReport()} disabled={mepBusy} aria-label="Derive the clash report">clash report</Button>
              </div>
              {clashReport !== null && (
                <ScrollArea className="max-h-40 rounded border dark:border-stone-800">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                      <tr>
                        <th className="px-2 py-1 text-left font-mono">run</th>
                        <th className="px-2 py-1 text-left">seg</th>
                        <th className="px-2 py-1 text-left font-mono">element</th>
                        <th className="px-2 py-1 text-left">kind</th>
                        <th className="px-2 py-1 text-left">distance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clashReport.diagnostics.map((d, i) => (
                        <tr key={i} className="border-t dark:border-stone-800">
                          <td className="px-2 py-1 font-mono">{d.runId}</td>
                          <td className="px-2 py-1 font-mono">{d.segmentIndex}</td>
                          <td className="px-2 py-1 font-mono">{d.elementId}</td>
                          <td className="px-2 py-1"><span className={STATUS_BADGE.missing}>{d.kindOfClash}</span></td>
                          <td className="px-2 py-1 font-mono">{d.distanceMm.toFixed(1)}mm / {d.clearanceMm}mm</td>
                        </tr>
                      ))}
                      {clashReport.diagnostics.length === 0 && (
                        <tr><td colSpan={5} className="px-2 py-2 text-stone-500">{clashReport.runCount} run(s) checked at {clashReport.clearanceMm}mm — no violations.</td></tr>
                      )}
                    </tbody>
                  </table>
                </ScrollArea>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {section === "mechanical" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Fan className="h-4 w-4" aria-hidden="true" /> Mechanical equipment (toolset.mech*)</CardTitle>
            <CardDescription className="text-xs">
              Bounded equipment records (machine/pump/fan/ahu/panel/tank) with ordinal ports carrying connector metadata, and the
              deterministic rectangular arrays (ports move with each instance). The ports are the connection targets of the MEP runs.
            </CardDescription>
            <ResultBlock label="mechanical" result={mechResult} error={mechError} />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.mechAddEquipment — the equipment record</p>
              <div className="flex flex-wrap items-start gap-2">
                <select className={INP + " max-w-24"} value={equipmentForm.kind} onChange={(e) => setEquipmentForm({ ...equipmentForm, kind: e.target.value })} aria-label="Equipment kind">
                  <option value="machine">machine</option>
                  <option value="pump">pump</option>
                  <option value="fan">fan</option>
                  <option value="ahu">ahu</option>
                  <option value="panel">panel</option>
                  <option value="tank">tank</option>
                </select>
                <input className={INP + " max-w-32"} placeholder="name" value={equipmentForm.name} onChange={(e) => setEquipmentForm({ ...equipmentForm, name: e.target.value })} aria-label="Equipment name" />
                <input className={INP + " max-w-28"} placeholder="origin x,y,z" value={equipmentForm.origin} onChange={(e) => setEquipmentForm({ ...equipmentForm, origin: e.target.value })} aria-label="Equipment origin" />
                <textarea
                  className={INP + " max-h-32 min-h-24 max-w-80 font-mono text-[10px]"}
                  value={equipmentForm.ports}
                  onChange={(e) => setEquipmentForm({ ...equipmentForm, ports: e.target.value })}
                  aria-label="The ports JSON (ordinal ids, connector kinds, positions, fluid metadata)"
                  spellCheck={false}
                />
                <Button size="sm" onClick={() => void onAddEquipment()} disabled={mechBusy} aria-label="Add the equipment record">add equipment</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.mechArray — the deterministic equipment array</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-36"} placeholder="equipment id (tls-…)" value={arrayForm.equipmentId} onChange={(e) => setArrayForm({ ...arrayForm, equipmentId: e.target.value })} aria-label="Array base equipment id" />
                <input className={INP + " max-w-20"} placeholder="cols" value={arrayForm.cols} onChange={(e) => setArrayForm({ ...arrayForm, cols: e.target.value })} aria-label="Array columns" />
                <input className={INP + " max-w-20"} placeholder="rows" value={arrayForm.rows} onChange={(e) => setArrayForm({ ...arrayForm, rows: e.target.value })} aria-label="Array rows" />
                <input className={INP + " max-w-24"} placeholder="dx mm" value={arrayForm.dxMm} onChange={(e) => setArrayForm({ ...arrayForm, dxMm: e.target.value })} aria-label="Array column spacing mm" />
                <input className={INP + " max-w-24"} placeholder="dy mm" value={arrayForm.dyMm} onChange={(e) => setArrayForm({ ...arrayForm, dyMm: e.target.value })} aria-label="Array row spacing mm" />
                <Button size="sm" onClick={() => void onEquipmentArray()} disabled={mechBusy} aria-label="Compose the equipment array">equipment array</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {section === "raster" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><ImageIcon className="h-4 w-4" aria-hidden="true" /> Raster / underlay (toolset.raster*)</CardTitle>
            <CardDescription className="text-xs">
              Canonical source + reference records (identity, transform, clipping, visibility), the fresh ok/stale/missing status
              derivation, and the typed NON-AUTHORITATIVE trace — committing through rasterCommitTrace is the only path to canonical
              geometry (lineage recorded in the element props).
            </CardDescription>
            <ResultBlock label="raster" result={rasterResult} error={rasterError} />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.rasterAddSource — the underlay source record</p>
              <div className="flex flex-wrap items-start gap-2">
                <input className={INP + " max-w-48"} placeholder="source ref (e.g. underlay/site-plan.png)" value={sourceForm.sourceRef} onChange={(e) => setSourceForm({ ...sourceForm, sourceRef: e.target.value })} aria-label="Source reference" />
                <input className={INP + " max-w-72"} placeholder="content digest (sha256)" value={sourceForm.contentDigest} onChange={(e) => setSourceForm({ ...sourceForm, contentDigest: e.target.value })} aria-label="Source content digest" />
                <input className={INP + " max-w-24"} placeholder="width px" value={sourceForm.widthPx} onChange={(e) => setSourceForm({ ...sourceForm, widthPx: e.target.value })} aria-label="Source width px" />
                <input className={INP + " max-w-24"} placeholder="height px" value={sourceForm.heightPx} onChange={(e) => setSourceForm({ ...sourceForm, heightPx: e.target.value })} aria-label="Source height px" />
                <textarea
                  className={INP + " max-h-24 min-h-20 max-w-64 font-mono text-[10px]"}
                  value={sourceForm.lineWork}
                  onChange={(e) => setSourceForm({ ...sourceForm, lineWork: e.target.value })}
                  aria-label="The optional lineWork vectors JSON (the trace source)"
                  spellCheck={false}
                />
                <Button size="sm" onClick={() => void onAddSource()} disabled={rasterBusy} aria-label="Register the raster source">add source</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.rasterAttach — the reference record</p>
              <div className="flex flex-wrap items-center gap-2">
                <input className={INP + " max-w-48"} placeholder="source ref" value={attachForm.sourceRef} onChange={(e) => setAttachForm({ ...attachForm, sourceRef: e.target.value })} aria-label="Attach source reference" />
                <input className={INP + " max-w-72"} placeholder="declared digest" value={attachForm.declaredDigest} onChange={(e) => setAttachForm({ ...attachForm, declaredDigest: e.target.value })} aria-label="Declared digest" />
                <input className={INP + " max-w-28"} placeholder="origin x,y" value={attachForm.origin} onChange={(e) => setAttachForm({ ...attachForm, origin: e.target.value })} aria-label="Reference origin" />
                <input className={INP + " max-w-24"} placeholder="scale" value={attachForm.scale} onChange={(e) => setAttachForm({ ...attachForm, scale: e.target.value })} aria-label="Reference scale" />
                <input className={INP + " max-w-28"} placeholder="rotation deg" value={attachForm.rotationDeg} onChange={(e) => setAttachForm({ ...attachForm, rotationDeg: e.target.value })} aria-label="Reference rotation degrees" />
                <Button size="sm" onClick={() => void onAttach()} disabled={rasterBusy} aria-label="Attach the raster reference">attach</Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.rasterStatus — the fresh status table</p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void onStatusRefresh()} disabled={rasterBusy} aria-label="Refresh the raster status table">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> refresh status
                </Button>
              </div>
              {statusView !== null && (
                <ScrollArea className="max-h-32 rounded border dark:border-stone-800">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                      <tr>
                        <th className="px-2 py-1 text-left font-mono">reference</th>
                        <th className="px-2 py-1 text-left font-mono">source</th>
                        <th className="px-2 py-1 text-left">status</th>
                        <th className="px-2 py-1 text-left">reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statusView.statuses.map((s) => (
                        <tr key={s.referenceId} className="border-t dark:border-stone-800">
                          <td className="px-2 py-1 font-mono">{s.referenceId}</td>
                          <td className="px-2 py-1 font-mono">{s.sourceRef}</td>
                          <td className="px-2 py-1"><span className={STATUS_BADGE[s.status] ?? KIND_BADGE.query}>{s.status}</span></td>
                          <td className="px-2 py-1 text-stone-600 dark:text-stone-400">{s.reason}</td>
                        </tr>
                      ))}
                      {statusView.statuses.length === 0 && (
                        <tr><td colSpan={4} className="px-2 py-2 text-stone-500">No raster references attached.</td></tr>
                      )}
                    </tbody>
                  </table>
                </ScrollArea>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-stone-600 dark:text-stone-400">toolset.rasterTrace — the NON-AUTHORITATIVE trace + the commit</p>
              <div className="flex items-center gap-2">
                <input className={INP + " max-w-36"} placeholder="reference id (tls-…)" value={traceForm.referenceId} onChange={(e) => setTraceForm({ ...traceForm, referenceId: e.target.value })} aria-label="Trace reference id" />
                <Button size="sm" onClick={() => void onTrace()} disabled={rasterBusy} aria-label="Derive the trace vectors">trace</Button>
                <Button size="sm" onClick={() => void onCommitTrace()} disabled={rasterBusy} aria-label="Commit the traced vectors as canonical line elements">commit trace</Button>
              </div>
              {traceView !== null && (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] text-stone-600 dark:text-stone-400">
                    {traceView.vectors.length} vector(s) · authoritative: {String(traceView.authoritative)} — {traceView.notice}
                  </p>
                  <ScrollArea className="max-h-28 rounded border dark:border-stone-800">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-stone-100 dark:bg-stone-900">
                        <tr>
                          <th className="px-2 py-1 text-left">from (mm)</th>
                          <th className="px-2 py-1 text-left">to (mm)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {traceView.vectors.map((v, i) => (
                          <tr key={i} className="border-t dark:border-stone-800">
                            <td className="px-2 py-1 font-mono">({v.from.x.toFixed(1)}, {v.from.y.toFixed(1)})</td>
                            <td className="px-2 py-1 font-mono">({v.to.x.toFixed(1)}, {v.to.y.toFixed(1)})</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollArea>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
