"use client";

/**
 * Offisos BIM Authoring Workbench — Web host surface (COMPAT-CAD-002 /
 * Issue #39, Architecture v1.1 FROZEN).
 *
 * A REAL 3D/BIM authoring workflow, not a mockup: story/wall/slab/opening/
 * door/window/space authoring forms (bim.createElements — one atomic batch
 * per create), a deterministic orthographic 3D viewport driven by the shared
 * `bim.camera` query, an element explorer over `bim.getBuilding` with
 * selection/move/copy/delete/property-edit through the shared App API,
 * global undo/redo (document.canUndo/canRedo), Build geometry realizing the
 * pure-core descriptors through the REAL OCCT engine behind the adapter
 * boundary, and save/open persistence with revision-lineage identity.
 *
 * Client-safety: imports ONLY the pure BIM core modules
 * (`@offisos/cad-app-shell/bim/elements.js` + `bim/geometry.js` — engine-free
 * type+math modules with no node:crypto chain) and the transport. Every
 * MUTATION goes through fetch("/api/cad") exactly like the Electron host
 * (Web/Electron parity, §5.5). No engine ever loads in the browser
 * (LOCK-003/018).
 */

import * as React from "react";
import {
  Copy,
  Download,
  FilePlus,
  FolderOpen,
  Hammer,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { CommandQueryResponse, ErrResult } from "@offisos/cad-app-shell/contracts/app-api";
import { elementToBimEntitySafe, type BimEntity } from "@offisos/cad-app-shell/bim/elements.js";
import { bimGeometryContext, bimWorldBBox } from "@offisos/cad-app-shell/bim/geometry.js";

import {
  bimBuildGeometry,
  bimCamera,
  bimCreate,
  bimGetBuilding,
  bimOp,
  bimSetProperties,
  bimSetSettings,
  canRedo,
  canUndo,
  createDoc,
  getState,
  getSelection,
  openFromBytes,
  redo,
  save,
  setSelection,
  undo,
  unwrapBimBuild,
  unwrapBimBuilding,
  unwrapBimCamera,
  unwrapBimCreated,
  unwrapBimOp,
  unwrapSaveBytes,
} from "@/cad/client/http-transport";
import type {
  BimBuildResult,
  BimBuildingResult,
  BimSemanticRecord,
} from "@/cad/client/http-transport";
import { BimViewport } from "@/cad/bim/viewport";
import type { BimBox, BimCameraState } from "@/cad/bim/viewport";
import type { WorldBox } from "@/cad/bim/projection";

// --- constants + helpers ------------------------------------------------------

type AuthorType = "story" | "wall" | "slab" | "opening" | "door" | "window" | "space";

const AUTHOR_TYPES: readonly { id: AuthorType; label: string }[] = [
  { id: "story", label: "Story" },
  { id: "wall", label: "Wall" },
  { id: "slab", label: "Slab" },
  { id: "opening", label: "Opening" },
  { id: "door", label: "Door" },
  { id: "window", label: "Window" },
  { id: "space", label: "Space" },
];

const CAMERA_PRESETS: readonly ("iso" | "top" | "front" | "right")[] = ["iso", "top", "front", "right"];

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

/** One atomic demo batch with EXPLICIT ids — same-batch references (wall →
 *  story, opening → wall, fill → opening) must be explicit ids by contract;
 *  door/window storyId is DERIVED server-side (never sent). */
const DEMO_ENTITIES: readonly Record<string, unknown>[] = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", name: "South wall", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-north", storyId: "story-gf", name: "North wall", start: [0, 5600], end: [6000, 5600], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-west", storyId: "story-gf", name: "West wall", start: [0, 0], end: [0, 5600], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", name: "East wall", start: [6000, 0], end: [6000, 5600], width: 300, height: 3000 },
  { type: "bim.slab", id: "slab-gf", storyId: "story-gf", name: "Ground slab", corner1: [-300, -300], corner2: [6300, 5900], thickness: 200, baseOffset: -200 },
  { type: "bim.opening", id: "opening-front-door", hostId: "wall-south", name: "Front door void", distance: 500, width: 900, height: 2100, sill: 0 },
  { type: "bim.door", id: "door-front", openingId: "opening-front-door", swing: "left", name: "Front door" },
  { type: "bim.opening", id: "opening-window-s1", hostId: "wall-south", name: "South window void", distance: 2500, width: 1500, height: 1200, sill: 900 },
  { type: "bim.window", id: "window-south-1", openingId: "opening-window-s1", name: "South window" },
  { type: "bim.opening", id: "opening-window-n1", hostId: "wall-north", name: "North window void", distance: 2500, width: 1500, height: 1200, sill: 900 },
  { type: "bim.window", id: "window-north-1", openingId: "opening-window-n1", name: "North window" },
  { type: "bim.space", id: "space-living", storyId: "story-gf", name: "Living", footprint: [[0, 0], [6000, 0], [6000, 5600], [0, 5600]], height: 3000, baseOffset: 0 },
];

/** Whitelisted property-edit dimension key per type (name is always offered;
 *  mirrors the server's setProperties whitelist). */
const EDIT_DIM_KEY: Record<string, { key: string; label: string } | null> = {
  "bim.story": { key: "height", label: "height (mm)" },
  "bim.wall": { key: "height", label: "height (mm)" },
  "bim.slab": { key: "thickness", label: "thickness (mm)" },
  "bim.opening": { key: "width", label: "width (mm)" },
  "bim.door": { key: "leafThickness", label: "leaf thickness (mm)" },
  "bim.window": null,
  "bim.space": { key: "height", label: "height (mm)" },
};

function toNum(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a finite number (got "${value}")`);
  }
  return n;
}

/** Parse a comma/space separated "x,y" point list into Vec2 pairs. */
function parseFootprint(text: string): [number, number][] {
  const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length < 6 || tokens.length % 2 !== 0) {
    throw new Error(`footprint must be a list of "x,y" pairs (≥ 3 points)`);
  }
  const pts: [number, number][] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const x = Number(tokens[i]);
    const y = Number(tokens[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`footprint pair ${i / 2} is not numeric ("${tokens[i]},${tokens[i + 1]}")`);
    }
    pts.push([x, y]);
  }
  return pts;
}

function isFiniteBox(v: unknown): v is [number, number, number, number, number, number] {
  return (
    Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function fmtNum(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "—";
}

/** One-line key semantics for the explorer rows. */
function describeProps(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case "bim.story":
      return `level ${fmtNum(p.level)} mm · ${fmtNum(p.height)} mm tall`;
    case "bim.wall": {
      const s = p.start;
      const e = p.end;
      const length =
        Array.isArray(s) && Array.isArray(e) && s.length === 2 && e.length === 2
          ? Math.hypot((e[0] as number) - (s[0] as number), (e[1] as number) - (s[1] as number))
          : NaN;
      return `${Number.isFinite(length) ? length.toFixed(0) : "—"} L × ${fmtNum(p.width)} W × ${fmtNum(p.height)} H mm`;
    }
    case "bim.slab":
      return `thickness ${fmtNum(p.thickness)} mm · baseOffset ${fmtNum(p.baseOffset)} mm`;
    case "bim.opening":
      return `${fmtNum(p.width)}×${fmtNum(p.height)} mm · d ${fmtNum(p.distance)} · sill ${fmtNum(p.sill)}`;
    case "bim.door":
      return `swing ${String(p.swing)} · leaf ${fmtNum(p.leafThickness)} mm`;
    case "bim.window":
      return `fills ${String(p.openingId)}`;
    case "bim.space": {
      const area = typeof p.area === "number" ? p.area / 1e6 : NaN;
      return `${Number.isFinite(area) ? area.toFixed(2) : "—"} m² · ${fmtNum(p.height)} mm tall`;
    }
    default:
      return "";
  }
}

// --- component -----------------------------------------------------------------

export function BimWorkbench(): React.JSX.Element {
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const [snapshot, setSnapshot] = React.useState<CADDocumentSnapshot | null>(null);
  const [selection, setSel] = React.useState<string[]>([]);
  const [building, setBuilding] = React.useState<BimBuildingResult | null>(null);
  const [camera, setCamera] = React.useState<BimCameraState | null>(null);
  const [cameraBox, setCameraBox] = React.useState<WorldBox | null>(null);
  const [canUndoFlag, setCanUndoFlag] = React.useState(false);
  const [canRedoFlag, setCanRedoFlag] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>("ready");
  const [lastBuild, setLastBuild] = React.useState<BimBuildResult | null>(null);

  // authoring form state (string inputs; parsed on submit)
  const [authorType, setAuthorType] = React.useState<AuthorType>("story");
  const [storyForm, setStoryForm] = React.useState({ id: "", name: "Ground Floor", level: "0", height: "3000" });
  const [wallForm, setWallForm] = React.useState({ id: "", storyId: "", name: "Wall", sx: "0", sy: "0", ex: "6000", ey: "0", width: "300", height: "3000" });
  const [slabForm, setSlabForm] = React.useState({ id: "", storyId: "", name: "Ground slab", c1x: "0", c1y: "0", c2x: "6600", c2y: "5600", thickness: "200", baseOffset: "-200" });
  const [openingForm, setOpeningForm] = React.useState({ id: "", hostId: "", name: "Door void", distance: "500", width: "900", height: "2100", sill: "0" });
  const [doorForm, setDoorForm] = React.useState({ id: "", openingId: "", swing: "left" as "left" | "right", leafThickness: "40", name: "Door" });
  const [windowForm, setWindowForm] = React.useState({ id: "", openingId: "", name: "Window" });
  const [spaceForm, setSpaceForm] = React.useState({ id: "", storyId: "", name: "Living", footprint: "0,0 6000,0 6000,5600 0,5600", height: "3000", baseOffset: "0" });
  const [move, setMove] = React.useState({ dx: "0", dy: "0", dz: "1000" });

  // property editor (one element at a time)
  const [editId, setEditId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editDim, setEditDim] = React.useState("");

  const selectedSet = React.useMemo(() => new Set(selection), [selection]);

  // --- derived from the snapshot (pure client-side parse, same core as server)

  const elements = React.useMemo(() => snapshot?.elements ?? [], [snapshot]);

  const bimData = React.useMemo(() => {
    const entities: BimEntity[] = [];
    const propsById = new Map<string, Record<string, unknown>>();
    for (const el of elements) {
      const entity = elementToBimEntitySafe(el);
      if (entity !== null) {
        entities.push(entity);
        propsById.set(el.id, el.props as Record<string, unknown>);
      }
    }
    const ctx = bimGeometryContext(entities);
    return { entities, propsById, ctx };
  }, [elements]);

  const { propsById, ctx } = bimData;

  const stories = React.useMemo(
    () =>
      bimData.entities
        .filter((e): e is Extract<BimEntity, { type: "bim.story" }> => e.type === "bim.story")
        .sort((a, b) => (a.level !== b.level ? a.level - b.level : a.id < b.id ? -1 : 1)),
    [bimData],
  );
  const walls = React.useMemo(
    () =>
      bimData.entities
        .filter((e): e is Extract<BimEntity, { type: "bim.wall" }> => e.type === "bim.wall")
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    [bimData],
  );
  const openings = React.useMemo(
    () =>
      bimData.entities
        .filter((e): e is Extract<BimEntity, { type: "bim.opening" }> => e.type === "bim.opening")
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    [bimData],
  );

  /** Viewport boxes: engine meshBBox when present, else the derived extents. */
  const boxes = React.useMemo<BimBox[]>(() => {
    const out: BimBox[] = [];
    for (const entity of bimData.entities) {
      if (entity.type === "bim.story") continue; // level container — no solid
      const props = propsById.get(entity.id);
      if (props === undefined) continue;
      const mesh = isFiniteBox(props.meshBBox) ? props.meshBBox : null;
      const box = mesh !== null ? mesh : bimWorldBBox(entity, ctx);
      if (box === null) continue;
      out.push({ id: entity.id, type: entity.type, bbox: box, built: mesh !== null });
    }
    return out;
  }, [bimData, propsById, ctx]);

  const seeded = React.useMemo(() => bimData.entities.some((e) => e.id === "story-gf"), [bimData]);

  // Effective dropdown references: fall back to the first valid host when the
  // stored reference is stale (computed at render — no state syncing).
  const effectiveStoryId = React.useMemo(
    () => (stories.some((s) => s.id === wallForm.storyId) ? wallForm.storyId : (stories[0]?.id ?? "")),
    [stories, wallForm.storyId],
  );
  const effectiveSlabStoryId = React.useMemo(
    () => (stories.some((s) => s.id === slabForm.storyId) ? slabForm.storyId : (stories[0]?.id ?? "")),
    [stories, slabForm.storyId],
  );
  const effectiveSpaceStoryId = React.useMemo(
    () => (stories.some((s) => s.id === spaceForm.storyId) ? spaceForm.storyId : (stories[0]?.id ?? "")),
    [stories, spaceForm.storyId],
  );
  const effectiveHostId = React.useMemo(
    () => (walls.some((w) => w.id === openingForm.hostId) ? openingForm.hostId : (walls[0]?.id ?? "")),
    [walls, openingForm.hostId],
  );
  const effectiveDoorOpeningId = React.useMemo(
    () => (openings.some((o) => o.id === doorForm.openingId) ? doorForm.openingId : (openings[0]?.id ?? "")),
    [openings, doorForm.openingId],
  );
  const effectiveWindowOpeningId = React.useMemo(
    () => (openings.some((o) => o.id === windowForm.openingId) ? windowForm.openingId : (openings[0]?.id ?? "")),
    [openings, windowForm.openingId],
  );

  // --- refresh + run (the drafting workbench's proven pattern) -----------------

  const applyCameraResponse = React.useCallback((res: CommandQueryResponse): boolean => {
    const cam = unwrapBimCamera(res);
    if (cam === null) {
      setCamera(null);
      setCameraBox(null);
      return false;
    }
    setCamera({
      preset: cam.camera.preset,
      eye: [cam.camera.eye[0] ?? 0, cam.camera.eye[1] ?? 0, cam.camera.eye[2] ?? 0],
      target: [cam.camera.target[0] ?? 0, cam.camera.target[1] ?? 0, cam.camera.target[2] ?? 0],
      up: [cam.camera.up[0] ?? 0, cam.camera.up[1] ?? 0, cam.camera.up[2] ?? 0],
    });
    setCameraBox(isFiniteBox(cam.bbox) ? cam.bbox : null);
    return true;
  }, []);

  /** Surface a failed bim.camera honestly. The "no solid-bearing elements"
   *  case is the expected empty-model state → soft status line, not an error
   *  banner; everything else is a real typed failure. */
  const surfaceCameraFailure = React.useCallback((failure: ErrResult): void => {
    if (
      failure.code === "bim_invalid" &&
      failure.message.includes("bounding box")
    ) {
      setStatus(`bim.camera: ${failure.code} — author a solid-bearing element (story + wall/slab/space) to derive the camera`);
    } else {
      setError(`[bim.camera] ${failure.code}: ${failure.message}`);
    }
  }, []);

  const refresh = React.useCallback(async () => {
    const [stateRes, selRes, buildingRes, undoRes, redoRes] = await Promise.all([
      getState(),
      getSelection(),
      bimGetBuilding(),
      canUndo(),
      canRedo(),
    ]);
    const snap = stateRes.ok ? (stateRes.value as CADDocumentSnapshot) : null;
    if (snap !== null) {
      setSnapshot(snap);
      setSel([...(snap.selection ?? [])]);
    } else if (!stateRes.ok) {
      setError(`[getState] ${stateRes.code}: ${stateRes.message}`);
    }
    const bld = unwrapBimBuilding(buildingRes);
    setBuilding(bld);
    if (!buildingRes.ok) {
      setError(`[bim.getBuilding] ${buildingRes.code}: ${buildingRes.message}`);
    }
    if (selRes.ok && Array.isArray(selRes.value)) {
      setSel([...(selRes.value as string[])]);
    }
    setCanUndoFlag(undoRes.ok && undoRes.value === true);
    setCanRedoFlag(redoRes.ok && redoRes.value === true);
    const preset = snap?.bimSettings?.camera.preset ?? bld?.bimSettings.camera.preset ?? "iso";
    // A camera needs a non-degenerate model bbox; absent solids this query
    // answers bim_invalid — surfaced honestly, viewport shows a hint instead.
    const camRes = await bimCamera(preset);
    if (!applyCameraResponse(camRes) && !camRes.ok) {
      surfaceCameraFailure(camRes as ErrResult);
    }
  }, [applyCameraResponse, surfaceCameraFailure]);

  // Initial load (async — setState fires after the await, lint-safe).
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      await refresh();
      if (!cancelled) {
        setStatus("loaded document state");
        setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const run = React.useCallback(
    async (label: string, fn: () => Promise<CommandQueryResponse>): Promise<CommandQueryResponse> => {
      setBusy(true);
      setError(null);
      let res: CommandQueryResponse;
      try {
        res = await fn();
      } catch (e) {
        res = { ok: false, code: "unexpected", message: (e as Error).message, retryable: false };
      }
      if (!res.ok) {
        setError(`[${label}] ${res.code}: ${res.message}`);
      }
      await refresh();
      setBusy(false);
      return res;
    },
    [refresh],
  );

  // --- actions ------------------------------------------------------------------

  const selectElement = React.useCallback(
    (id: string, additive: boolean) => {
      const next = additive
        ? selection.includes(id)
          ? selection.filter((s) => s !== id)
          : [...selection, id]
        : [id];
      void run("selection", () => setSelection(next));
    },
    [selection, run],
  );

  const clearSelection = React.useCallback(() => {
    if (selection.length === 0) return;
    void run("clear selection", () => setSelection([]));
  }, [selection.length, run]);

  const onPreset = React.useCallback(
    async (preset: "iso" | "top" | "front" | "right") => {
      setBusy(true);
      setError(null);
      const settingsRes = await bimSetSettings({ camera: { preset } });
      if (!settingsRes.ok) {
        setError(`[camera preset] ${settingsRes.code}: ${settingsRes.message}`);
        await refresh();
        setBusy(false);
        return;
      }
      const camRes = await bimCamera(preset);
      if (applyCameraResponse(camRes)) {
        setStatus(`camera preset → ${preset} (bim.setSettings + bim.camera)`);
      } else if (!camRes.ok) {
        surfaceCameraFailure(camRes as ErrResult);
      }
      await refresh();
      setBusy(false);
    },
    [applyCameraResponse, refresh, surfaceCameraFailure],
  );

  const submitCreate = React.useCallback(
    async (entity: Record<string, unknown>, label: string) => {
      const res = await run(`create ${label}`, () => bimCreate([entity]));
      if (res.ok) {
        const created = unwrapBimCreated(res) ?? [];
        setStatus(`created ${label} → ${created.length > 0 ? created.join(", ") : String(entity.id ?? "document-minted id")} (1 atomic revision)`);
      }
    },
    [run],
  );

  const onCreate = React.useCallback(() => {
    try {
      switch (authorType) {
        case "story": {
          void submitCreate(
            {
              type: "bim.story",
              ...(storyForm.id.trim() !== "" ? { id: storyForm.id.trim() } : {}),
              name: storyForm.name,
              level: toNum(storyForm.level, "story level"),
              height: toNum(storyForm.height, "story height"),
            },
            "story",
          );
          break;
        }
        case "wall": {
          if (effectiveStoryId === "") throw new Error("author a story first (no story to host the wall)");
          void submitCreate(
            {
              type: "bim.wall",
              ...(wallForm.id.trim() !== "" ? { id: wallForm.id.trim() } : {}),
              storyId: effectiveStoryId,
              ...(wallForm.name.trim() !== "" ? { name: wallForm.name } : {}),
              start: [toNum(wallForm.sx, "wall start x"), toNum(wallForm.sy, "wall start y")],
              end: [toNum(wallForm.ex, "wall end x"), toNum(wallForm.ey, "wall end y")],
              width: toNum(wallForm.width, "wall width"),
              height: toNum(wallForm.height, "wall height"),
            },
            "wall",
          );
          break;
        }
        case "slab": {
          if (effectiveSlabStoryId === "") throw new Error("author a story first (no story to host the slab)");
          void submitCreate(
            {
              type: "bim.slab",
              ...(slabForm.id.trim() !== "" ? { id: slabForm.id.trim() } : {}),
              storyId: effectiveSlabStoryId,
              ...(slabForm.name.trim() !== "" ? { name: slabForm.name } : {}),
              corner1: [toNum(slabForm.c1x, "slab corner1 x"), toNum(slabForm.c1y, "slab corner1 y")],
              corner2: [toNum(slabForm.c2x, "slab corner2 x"), toNum(slabForm.c2y, "slab corner2 y")],
              thickness: toNum(slabForm.thickness, "slab thickness"),
              baseOffset: toNum(slabForm.baseOffset, "slab baseOffset"),
            },
            "slab",
          );
          break;
        }
        case "opening": {
          if (effectiveHostId === "") throw new Error("author a wall first (openings are hosted in walls)");
          void submitCreate(
            {
              type: "bim.opening",
              ...(openingForm.id.trim() !== "" ? { id: openingForm.id.trim() } : {}),
              hostId: effectiveHostId,
              ...(openingForm.name.trim() !== "" ? { name: openingForm.name } : {}),
              distance: toNum(openingForm.distance, "opening distance"),
              width: toNum(openingForm.width, "opening width"),
              height: toNum(openingForm.height, "opening height"),
              sill: toNum(openingForm.sill, "opening sill"),
            },
            "opening",
          );
          break;
        }
        case "door": {
          if (effectiveDoorOpeningId === "") throw new Error("author an opening first (doors fill openings)");
          // storyId is DERIVED server-side from the opening's host wall — omitted.
          void submitCreate(
            {
              type: "bim.door",
              ...(doorForm.id.trim() !== "" ? { id: doorForm.id.trim() } : {}),
              openingId: effectiveDoorOpeningId,
              swing: doorForm.swing,
              leafThickness: toNum(doorForm.leafThickness, "door leafThickness"),
              ...(doorForm.name.trim() !== "" ? { name: doorForm.name } : {}),
            },
            "door",
          );
          break;
        }
        case "window": {
          if (effectiveWindowOpeningId === "") throw new Error("author an opening first (windows fill openings)");
          void submitCreate(
            {
              type: "bim.window",
              ...(windowForm.id.trim() !== "" ? { id: windowForm.id.trim() } : {}),
              openingId: effectiveWindowOpeningId,
              ...(windowForm.name.trim() !== "" ? { name: windowForm.name } : {}),
            },
            "window",
          );
          break;
        }
        case "space": {
          if (effectiveSpaceStoryId === "") throw new Error("author a story first (no story to host the space)");
          void submitCreate(
            {
              type: "bim.space",
              ...(spaceForm.id.trim() !== "" ? { id: spaceForm.id.trim() } : {}),
              storyId: effectiveSpaceStoryId,
              name: spaceForm.name.trim() !== "" ? spaceForm.name : "Space",
              footprint: parseFootprint(spaceForm.footprint),
              height: toNum(spaceForm.height, "space height"),
              baseOffset: toNum(spaceForm.baseOffset, "space baseOffset"),
            },
            "space",
          );
          break;
        }
      }
    } catch (e) {
      setError(`[create ${authorType}] ${(e as Error).message}`);
    }
  }, [authorType, storyForm, wallForm, slabForm, openingForm, doorForm, windowForm, spaceForm, submitCreate, effectiveStoryId, effectiveSlabStoryId, effectiveSpaceStoryId, effectiveHostId, effectiveDoorOpeningId, effectiveWindowOpeningId]);

  const onSeed = React.useCallback(() => {
    void (async () => {
      const res = await run("seed demo building", () => bimCreate([...DEMO_ENTITIES]));
      if (res.ok) {
        setStatus("seeded the demo building — 13 elements in ONE atomic batch (explicit same-batch ids)");
      }
    })();
  }, [run]);

  const onMove = React.useCallback(
    (op: "bim.move" | "bim.copy") => {
      void (async () => {
        try {
          const res = await run(op, () =>
            bimOp(op, {
              ids: selection,
              dx: toNum(move.dx, "dx"),
              dy: toNum(move.dy, "dy"),
              dz: toNum(move.dz, "dz"),
            }),
          );
          if (res.ok) {
            const outcome = unwrapBimOp(res);
            setStatus(outcome !== null && outcome.applied ? (outcome.summary ?? op) : (outcome?.reason ?? "no-op"));
          }
        } catch (e) {
          setError(`[${op}] ${(e as Error).message}`);
        }
      })();
    },
    [selection, move, run],
  );

  const onDeleteIds = React.useCallback(
    (ids: string[]) => {
      void (async () => {
        const res = await run("delete", () => bimOp("bim.delete", { ids }));
        if (res.ok) {
          const outcome = unwrapBimOp(res);
          setStatus(outcome !== null && outcome.applied ? (outcome.summary ?? "deleted") : (outcome?.reason ?? "no-op"));
          if (editId !== null && ids.includes(editId)) setEditId(null);
        }
      })();
    },
    [run, editId],
  );

  const onBuild = React.useCallback(
    (ids?: string[]) => {
      void (async () => {
        setStatus("building geometry through the real OCCT engine — seconds per element (a Python worker per solid)…");
        setBusy(true);
        setError(null);
        const res = await bimBuildGeometry(ids);
        const result = unwrapBimBuild(res);
        if (result === null) {
          setError(res.ok ? "[build geometry] unexpected response shape" : `[build geometry] ${res.code}: ${res.message}`);
        } else {
          setLastBuild(result);
          const engine = result.results[0]?.engine;
          setStatus(
            `built ${result.built} solid(s)${result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ""}` +
              (engine !== undefined ? ` via ${engine.engineId}@${engine.engineVersion}` : ""),
          );
        }
        await refresh();
        setBusy(false);
      })();
    },
    [refresh],
  );

  const onUndo = React.useCallback(() => {
    void run("undo", () => undo());
  }, [run]);

  const onRedo = React.useCallback(() => {
    void run("redo", () => redo());
  }, [run]);

  const onSave = React.useCallback(() => {
    void (async () => {
      const res = await run("save", () => save());
      const saved = unwrapSaveBytes(res);
      if (saved === null) return;
      const blob = new Blob([new Uint8Array(saved.bytes)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "offisos-bim.json";
      a.click();
      URL.revokeObjectURL(url);
      const revisions = snapshot?.modelHistory?.revisions.length ?? 0;
      setStatus(`saved ${saved.bytes.length} bytes (${saved.format}) · content identity: ${revisions} revision(s) in modelHistory`);
    })();
  }, [run, snapshot]);

  const onOpenFile = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    void (async () => {
      const buf = new Uint8Array(await file.arrayBuffer());
      await run("open", () => openFromBytes(buf));
      setStatus("opened document from file — revision lineage restored (content identity)");
    })();
    e.target.value = "";
  }, [run]);

  const onNew = React.useCallback(() => {
    void run("new document", () => createDoc({ entityId: `bim-${Date.now()}` }));
  }, [run]);

  const openEditor = React.useCallback(
    (id: string) => {
      const props = propsById.get(id);
      if (props === undefined) return;
      setEditId((cur) => (cur === id ? null : id));
      setEditName(typeof props.name === "string" ? props.name : "");
      const dim = EDIT_DIM_KEY[String(props.type)];
      setEditDim(dim !== null && typeof props[dim.key] === "number" ? String(props[dim.key]) : "");
    },
    [propsById],
  );

  const applyEdit = React.useCallback(() => {
    if (editId === null) return;
    const props = propsById.get(editId);
    if (props === undefined) return;
    const type = String(props.type);
    const dim = EDIT_DIM_KEY[type];
    void (async () => {
      try {
        const patch: Record<string, unknown> = { name: editName };
        if (dim !== null) patch[dim.key] = toNum(editDim, dim.label);
        const res = await run("set properties", () => bimSetProperties(editId, patch));
        if (res.ok) setStatus(`updated ${type} '${editId}': ${Object.keys(patch).join(", ")}`);
      } catch (e) {
        setError(`[set properties] ${(e as Error).message}`);
      }
    })();
  }, [editId, propsById, editName, editDim, run]);

  // Explorer row + inline property editor for one semantic record.
  const renderRecord = React.useCallback(
    (rec: BimSemanticRecord): React.JSX.Element => (
      <>
        <ExplorerRow
          id={rec.elementId}
          type={rec.type}
          props={propsById.get(rec.elementId) ?? {}}
          selected={selectedSet.has(rec.elementId)}
          busy={busy}
          onSelect={selectElement}
          onDelete={onDeleteIds}
          onEdit={openEditor}
          isEditOpen={editId === rec.elementId}
        />
        {editId === rec.elementId && (
          <EditForm
            name={editName}
            dim={editDim}
            dimDef={EDIT_DIM_KEY[rec.type] ?? null}
            onName={setEditName}
            onDim={setEditDim}
            onApply={applyEdit}
            busy={busy}
          />
        )}
      </>
    ),
    [propsById, selectedSet, busy, selectElement, onDeleteIds, openEditor, editId, editName, editDim, applyEdit],
  );

  // --- render -------------------------------------------------------------------

  const revisions = snapshot?.modelHistory?.revisions.length ?? 0;
  const activePreset = camera?.preset ?? snapshot?.bimSettings?.camera.preset ?? "iso";

  return (
    <Card>
      <CardHeader>
        <CardTitle>BIM Authoring Workbench</CardTitle>
        <CardDescription>
          Stories → walls/slabs/spaces → hosted openings → door/window fills, camera presets, Build
          geometry through the real OCCT engine, undo/redo, save/open — every mutation through the
          shared App API (COMPAT-CAD-002). Units: millimeters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error !== null && (
          <div role="alert" className="mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-4">
          {/* --- left: viewport + global actions --------------------------------- */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="camera presets">
              <span className="text-xs text-muted-foreground mr-1">View:</span>
              {CAMERA_PRESETS.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={activePreset === p ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void onPreset(p)}
                  aria-pressed={activePreset === p}
                  title={`bim.setSettings + bim.camera (${p})`}
                >
                  {p}
                </Button>
              ))}
              <Badge variant="outline" className="font-mono ml-1">
                {camera !== null ? `eye ${camera.eye.map((n) => n.toFixed(0)).join(", ")}` : "camera: —"}
              </Badge>
            </div>

            <BimViewport
              boxes={boxes}
              camera={camera}
              modelBBox={cameraBox}
              selectedIds={selectedSet}
              onSelect={selectElement}
              onClearSelection={clearSelection}
            />

            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>revisions: {revisions}</span>
              <span>elements: {elements.length}</span>
              <span>BIM: {bimData.entities.length}</span>
              <span>selection: {selection.length}</span>
              <span className="font-mono">{snapshot?.version.version_id.slice(0, 30) ?? ""}</span>
            </div>
            <div className="rounded border bg-muted/40 px-2.5 py-1.5 text-xs" role="status" aria-label="operation status">
              {status}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => onBuild()}
                disabled={busy || boxes.length === 0}
                title="bim.buildGeometry — realize every solid-bearing element through the real OCCT engine (seconds per element)"
              >
                <Hammer aria-hidden="true" />
                Build geometry (OCCT)
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onBuild(selection)}
                disabled={busy || selection.length === 0}
                title="bim.buildGeometry with the selected ids only"
              >
                Build selected
              </Button>
              <Separator orientation="vertical" className="h-6" />
              <Button size="sm" variant="outline" disabled={!canUndoFlag || busy} onClick={onUndo} title={canUndoFlag ? "document.undo" : "nothing to undo (document.canUndo = false)"}>
                <Undo2 aria-hidden="true" />
                Undo{canUndoFlag ? "" : " (empty)"}
              </Button>
              <Button size="sm" variant="outline" disabled={!canRedoFlag || busy} onClick={onRedo} title={canRedoFlag ? "document.redo" : "nothing to redo (document.canRedo = false)"}>
                <Redo2 aria-hidden="true" />
                Redo{canRedoFlag ? "" : " (empty)"}
              </Button>
              <Separator orientation="vertical" className="h-6" />
              <Button size="sm" variant="outline" disabled={busy} onClick={onNew} title="document.create — fresh BIM document">
                <FilePlus aria-hidden="true" />
                New
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={onSave} title="document.save — download the persisted artifact">
                <Download aria-hidden="true" />
                Save ↓
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} title="document.open — open saved bytes">
                <FolderOpen aria-hidden="true" />
                Open ↑
              </Button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onOpenFile} />
            </div>

            {/* selection transform */}
            <div className="flex flex-wrap items-center gap-2 rounded border p-2">
              <span className="text-xs font-semibold">Selection ({selection.length}):</span>
              <span className="text-xs text-muted-foreground">ΔX</span>
              <input aria-label="delta x mm" className="w-16 border rounded px-2 py-1 text-sm" value={move.dx} onChange={(e) => setMove((m) => ({ ...m, dx: e.target.value }))} />
              <span className="text-xs text-muted-foreground">ΔY</span>
              <input aria-label="delta y mm" className="w-16 border rounded px-2 py-1 text-sm" value={move.dy} onChange={(e) => setMove((m) => ({ ...m, dy: e.target.value }))} />
              <span className="text-xs text-muted-foreground">ΔZ</span>
              <input aria-label="delta z mm" className="w-16 border rounded px-2 py-1 text-sm" value={move.dz} onChange={(e) => setMove((m) => ({ ...m, dz: e.target.value }))} />
              <Button size="sm" variant="outline" disabled={busy || selection.length === 0} onClick={() => onMove("bim.move")} title="bim.move (stories move in Z only; openings along the host wall axis)">
                Move
              </Button>
              <Button size="sm" variant="outline" disabled={busy || selection.length === 0} onClick={() => onMove("bim.copy")} title="bim.copy (wall copies cascade their openings + fills)">
                <Copy aria-hidden="true" />
                Copy
              </Button>
              <Button size="sm" variant="destructive" disabled={busy || selection.length === 0} onClick={() => onDeleteIds(selection)} title="bim.delete (wall deletion cascades hosted openings + fills)">
                <Trash2 aria-hidden="true" />
                Delete
              </Button>
            </div>

            {lastBuild !== null && (
              <div className="rounded border bg-muted/30 p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="font-mono">built {lastBuild.built}</Badge>
                  <Badge variant="outline" className="font-mono">skipped {lastBuild.skipped.length}</Badge>
                  {lastBuild.results[0] !== undefined && (
                    <Badge variant="outline" className="font-mono">
                      {lastBuild.results[0].engine.engineId}@{lastBuild.results[0].engine.engineVersion}
                    </Badge>
                  )}
                </div>
                {lastBuild.skipped.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 font-mono text-muted-foreground">
                    {lastBuild.skipped.map((s) => (
                      <li key={s.elementId} className="break-all">
                        skipped {s.elementId}: {s.reason}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-muted-foreground">
                  Engine provenance attached as an immutable revision (props: meshToken, meshBBox,
                  geometryEngine) — the viewport now draws the ACTUAL engine bboxes.
                </p>
              </div>
            )}
          </div>

          {/* --- right: authoring + explorer -------------------------------------- */}
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-sm font-semibold mb-1">Author element</div>
              <div className="flex flex-wrap gap-1 mb-2" role="tablist" aria-label="element type">
                {AUTHOR_TYPES.map((t) => (
                  <Button
                    key={t.id}
                    size="sm"
                    variant={authorType === t.id ? "default" : "outline"}
                    onClick={() => setAuthorType(t.id)}
                    role="tab"
                    aria-selected={authorType === t.id}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 items-start text-sm">
                {authorType === "story" && (
                  <>
                    <Field label="id (optional)"><input className={INP} aria-label="story id" value={storyForm.id} onChange={(e) => setStoryForm((f) => ({ ...f, id: e.target.value }))} /></Field>
                    <Field label="name"><input className={INP} aria-label="story name" value={storyForm.name} onChange={(e) => setStoryForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                    <Field label="level (mm)"><input className={INP} aria-label="story level" value={storyForm.level} onChange={(e) => setStoryForm((f) => ({ ...f, level: e.target.value }))} /></Field>
                    <Field label="height (mm)"><input className={INP} aria-label="story height" value={storyForm.height} onChange={(e) => setStoryForm((f) => ({ ...f, height: e.target.value }))} /></Field>
                  </>
                )}
                {authorType === "wall" && (
                  <>
                    <Field label="id (optional)"><input className={INP} aria-label="wall id" value={wallForm.id} onChange={(e) => setWallForm((f) => ({ ...f, id: e.target.value }))} /></Field>
                    <Field label="story">
                      <select className={INP} aria-label="wall story" value={effectiveStoryId} onChange={(e) => setWallForm((f) => ({ ...f, storyId: e.target.value }))}>
                        {stories.length === 0 && <option value="">— author a story first —</option>}
                        {stories.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
                      </select>
                    </Field>
                    <Field label="start x"><input className={INP} aria-label="wall start x" value={wallForm.sx} onChange={(e) => setWallForm((f) => ({ ...f, sx: e.target.value }))} /></Field>
                    <Field label="start y"><input className={INP} aria-label="wall start y" value={wallForm.sy} onChange={(e) => setWallForm((f) => ({ ...f, sy: e.target.value }))} /></Field>
                    <Field label="end x"><input className={INP} aria-label="wall end x" value={wallForm.ex} onChange={(e) => setWallForm((f) => ({ ...f, ex: e.target.value }))} /></Field>
                    <Field label="end y"><input className={INP} aria-label="wall end y" value={wallForm.ey} onChange={(e) => setWallForm((f) => ({ ...f, ey: e.target.value }))} /></Field>
                    <Field label="width (mm)"><input className={INP} aria-label="wall width" value={wallForm.width} onChange={(e) => setWallForm((f) => ({ ...f, width: e.target.value }))} /></Field>
                    <Field label="height (mm)"><input className={INP} aria-label="wall height" value={wallForm.height} onChange={(e) => setWallForm((f) => ({ ...f, height: e.target.value }))} /></Field>
                    <Field label="name (optional)"><input className={INP} aria-label="wall name" value={wallForm.name} onChange={(e) => setWallForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                  </>
                )}
                {authorType === "slab" && (
                  <>
                    <Field label="id (optional)"><input className={INP} aria-label="slab id" value={slabForm.id} onChange={(e) => setSlabForm((f) => ({ ...f, id: e.target.value }))} /></Field>
                    <Field label="story">
                      <select className={INP} aria-label="slab story" value={effectiveSlabStoryId} onChange={(e) => setSlabForm((f) => ({ ...f, storyId: e.target.value }))}>
                        {stories.length === 0 && <option value="">— author a story first —</option>}
                        {stories.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
                      </select>
                    </Field>
                    <Field label="corner1 x"><input className={INP} aria-label="slab corner1 x" value={slabForm.c1x} onChange={(e) => setSlabForm((f) => ({ ...f, c1x: e.target.value }))} /></Field>
                    <Field label="corner1 y"><input className={INP} aria-label="slab corner1 y" value={slabForm.c1y} onChange={(e) => setSlabForm((f) => ({ ...f, c1y: e.target.value }))} /></Field>
                    <Field label="corner2 x"><input className={INP} aria-label="slab corner2 x" value={slabForm.c2x} onChange={(e) => setSlabForm((f) => ({ ...f, c2x: e.target.value }))} /></Field>
                    <Field label="corner2 y"><input className={INP} aria-label="slab corner2 y" value={slabForm.c2y} onChange={(e) => setSlabForm((f) => ({ ...f, c2y: e.target.value }))} /></Field>
                    <Field label="thickness (mm)"><input className={INP} aria-label="slab thickness" value={slabForm.thickness} onChange={(e) => setSlabForm((f) => ({ ...f, thickness: e.target.value }))} /></Field>
                    <Field label="baseOffset (mm)"><input className={INP} aria-label="slab baseOffset" value={slabForm.baseOffset} onChange={(e) => setSlabForm((f) => ({ ...f, baseOffset: e.target.value }))} /></Field>
                    <Field label="name (optional)"><input className={INP} aria-label="slab name" value={slabForm.name} onChange={(e) => setSlabForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                  </>
                )}
                {authorType === "opening" && (
                  <>
                    <Field label="id (optional)"><input className={INP} aria-label="opening id" value={openingForm.id} onChange={(e) => setOpeningForm((f) => ({ ...f, id: e.target.value }))} /></Field>
                    <Field label="host wall">
                      <select className={INP} aria-label="opening host wall" value={effectiveHostId} onChange={(e) => setOpeningForm((f) => ({ ...f, hostId: e.target.value }))}>
                        {walls.length === 0 && <option value="">— author a wall first —</option>}
                        {walls.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
                      </select>
                    </Field>
                    <Field label="distance (mm)"><input className={INP} aria-label="opening distance" value={openingForm.distance} onChange={(e) => setOpeningForm((f) => ({ ...f, distance: e.target.value }))} /></Field>
                    <Field label="width (mm)"><input className={INP} aria-label="opening width" value={openingForm.width} onChange={(e) => setOpeningForm((f) => ({ ...f, width: e.target.value }))} /></Field>
                    <Field label="height (mm)"><input className={INP} aria-label="opening height" value={openingForm.height} onChange={(e) => setOpeningForm((f) => ({ ...f, height: e.target.value }))} /></Field>
                    <Field label="sill (mm)"><input className={INP} aria-label="opening sill" value={openingForm.sill} onChange={(e) => setOpeningForm((f) => ({ ...f, sill: e.target.value }))} /></Field>
                    <Field label="name (optional)"><input className={INP} aria-label="opening name" value={openingForm.name} onChange={(e) => setOpeningForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                  </>
                )}
                {authorType === "door" && (
                  <>
                    <Field label="id (optional)"><input className={INP} aria-label="door id" value={doorForm.id} onChange={(e) => setDoorForm((f) => ({ ...f, id: e.target.value }))} /></Field>
                    <Field label="opening">
                      <select className={INP} aria-label="door opening" value={effectiveDoorOpeningId} onChange={(e) => setDoorForm((f) => ({ ...f, openingId: e.target.value }))}>
                        {openings.length === 0 && <option value="">— author an opening first —</option>}
                        {openings.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
                      </select>
                    </Field>
                    <Field label="swing">
                      <select className={INP} aria-label="door swing" value={doorForm.swing} onChange={(e) => setDoorForm((f) => ({ ...f, swing: e.target.value as "left" | "right" }))}>
                        <option value="left">left</option>
                        <option value="right">right</option>
                      </select>
                    </Field>
                    <Field label="leaf thickness (mm)"><input className={INP} aria-label="door leaf thickness" value={doorForm.leafThickness} onChange={(e) => setDoorForm((f) => ({ ...f, leafThickness: e.target.value }))} /></Field>
                    <Field label="name (optional)"><input className={INP} aria-label="door name" value={doorForm.name} onChange={(e) => setDoorForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                  </>
                )}
                {authorType === "window" && (
                  <>
                    <Field label="id (optional)"><input className={INP} aria-label="window id" value={windowForm.id} onChange={(e) => setWindowForm((f) => ({ ...f, id: e.target.value }))} /></Field>
                    <Field label="opening">
                      <select className={INP} aria-label="window opening" value={effectiveWindowOpeningId} onChange={(e) => setWindowForm((f) => ({ ...f, openingId: e.target.value }))}>
                        {openings.length === 0 && <option value="">— author an opening first —</option>}
                        {openings.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
                      </select>
                    </Field>
                    <Field label="name (optional)"><input className={INP} aria-label="window name" value={windowForm.name} onChange={(e) => setWindowForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                  </>
                )}
                {authorType === "space" && (
                  <>
                    <Field label="id (optional)"><input className={INP} aria-label="space id" value={spaceForm.id} onChange={(e) => setSpaceForm((f) => ({ ...f, id: e.target.value }))} /></Field>
                    <Field label="story">
                      <select className={INP} aria-label="space story" value={effectiveSpaceStoryId} onChange={(e) => setSpaceForm((f) => ({ ...f, storyId: e.target.value }))}>
                        {stories.length === 0 && <option value="">— author a story first —</option>}
                        {stories.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
                      </select>
                    </Field>
                    <Field label="name"><input className={INP} aria-label="space name" value={spaceForm.name} onChange={(e) => setSpaceForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                    <Field label="height (mm)"><input className={INP} aria-label="space height" value={spaceForm.height} onChange={(e) => setSpaceForm((f) => ({ ...f, height: e.target.value }))} /></Field>
                    <Field label="baseOffset (mm)"><input className={INP} aria-label="space baseOffset" value={spaceForm.baseOffset} onChange={(e) => setSpaceForm((f) => ({ ...f, baseOffset: e.target.value }))} /></Field>
                    <div className="col-span-2">
                      <span className="text-xs text-muted-foreground block mb-0.5">footprint — comma/space separated “x,y” points (≥ 3)</span>
                      <input className="w-full border rounded px-2 py-1 text-xs font-mono bg-transparent" aria-label="space footprint" value={spaceForm.footprint} onChange={(e) => setSpaceForm((f) => ({ ...f, footprint: e.target.value }))} />
                    </div>
                  </>
                )}
              </div>

              <div className="flex flex-wrap gap-2 mt-2">
                <Button size="sm" disabled={busy} onClick={onCreate}>Create {authorType}</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || seeded}
                  onClick={onSeed}
                  title={seeded ? "demo building already seeded (story-gf exists)" : "one atomic bim.createElements batch with explicit same-batch ids"}
                >
                  Seed demo building
                </Button>
              </div>
            </div>

            <Separator />

            <div>
              <div className="text-sm font-semibold mb-1">Element explorer</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                bim.getBuilding — click a row to select (document.setSelection); ✕ deletes (declared
                hosted cascades); “edit” opens the property patcher (bim.setProperties).
              </p>
              <ScrollArea className="max-h-96 pr-2">
                {building === null || building.stories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No BIM elements yet — author a story, then host walls/slabs/spaces on it.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {building.stories.map((storyBlock) => (
                      <li key={storyBlock.story.elementId} className="rounded border p-1.5">
                        {renderRecord(storyBlock.story)}
                        <ul className="mt-1 ml-3 border-l pl-2">
                          {storyBlock.walls.map((wallRec) => (
                            <li key={wallRec.elementId}>
                              {renderRecord(wallRec)}
                              {wallRec.openings.map((openingRec) => (
                                <ul key={openingRec.elementId} className="mt-1 ml-3 border-l pl-2">
                                  <li>
                                    {renderRecord(openingRec)}
                                    {openingRec.fills.map((fillRec) => (
                                      <ul key={fillRec.elementId} className="mt-1 ml-3 border-l pl-2">
                                        <li>{renderRecord(fillRec)}</li>
                                      </ul>
                                    ))}
                                  </li>
                                </ul>
                              ))}
                            </li>
                          ))}
                          {storyBlock.slabs.map((slabRec) => (
                            <li key={slabRec.elementId} className="mt-1">
                              {renderRecord(slabRec)}
                            </li>
                          ))}
                          {storyBlock.spaces.map((spaceRec) => (
                            <li key={spaceRec.elementId} className="mt-1">
                              {renderRecord(spaceRec)}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- small form helpers ---------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

interface ExplorerRowProps {
  readonly id: string;
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (id: string, additive: boolean) => void;
  readonly onDelete: (ids: string[]) => void;
  readonly onEdit: (id: string) => void;
  readonly isEditOpen: boolean;
}

function ExplorerRow({ id, type, props, selected, busy, onSelect, onDelete, onEdit, isEditOpen }: ExplorerRowProps): React.JSX.Element {
  const engine = props.geometryEngine as { engineId?: unknown; engineVersion?: unknown } | undefined;
  const built = typeof props.meshToken === "string";
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-xs transition-colors hover:bg-accent ${selected ? "bg-accent ring-1 ring-primary/40" : ""}`}
    >
      <button
        type="button"
        className="font-mono underline-offset-2 hover:underline text-left"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(id, e.shiftKey);
        }}
        title="click to select (shift adds/removes)"
      >
        {id}
      </button>
      <span className="text-muted-foreground">{describeProps(type, props)}</span>
      {typeof props.name === "string" && props.name !== "" && (
        <span className="text-muted-foreground">“{props.name}”</span>
      )}
      {built && engine !== undefined && typeof engine.engineId === "string" && typeof engine.engineVersion === "string" ? (
        <Badge variant="secondary" className="font-mono" title="engine realized (meshToken + meshBBox revision)">
          {engine.engineId}@{engine.engineVersion}
        </Badge>
      ) : type === "bim.story" ? (
        <Badge variant="outline" className="font-mono">level container</Badge>
      ) : (
        <Badge variant="outline" className="font-mono" title="no engine realization yet — derived extents only">
          not built
        </Badge>
      )}
      <span className="ml-auto flex items-center gap-1">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(id);
          }}
          title="edit properties (bim.setProperties)"
        >
          {isEditOpen ? "close" : "edit"}
        </button>
        <button
          type="button"
          className="text-red-700 hover:text-red-900 dark:text-red-400 disabled:opacity-50"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onDelete([id]);
          }}
          title="delete (bim.delete — declared hosted cascades)"
          aria-label={`delete ${id}`}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

interface EditFormProps {
  readonly name: string;
  readonly dim: string;
  readonly dimDef: { key: string; label: string } | null;
  readonly onName: (v: string) => void;
  readonly onDim: (v: string) => void;
  readonly onApply: () => void;
  readonly busy: boolean;
}

function EditForm({ name, dim, dimDef, onName, onDim, onApply, busy }: EditFormProps): React.JSX.Element {
  return (
    <div className="mt-1 ml-3 rounded border bg-muted/30 p-2 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">name</span>
      <input aria-label="edit name" className="w-28 border rounded px-2 py-1 text-sm bg-transparent" value={name} onChange={(e) => onName(e.target.value)} />
      {dimDef !== null && (
        <>
          <span className="text-xs text-muted-foreground">{dimDef.label}</span>
          <input aria-label={`edit ${dimDef.label}`} className="w-20 border rounded px-2 py-1 text-sm bg-transparent" value={dim} onChange={(e) => onDim(e.target.value)} />
        </>
      )}
      <Button size="sm" variant="outline" disabled={busy} onClick={onApply}>
        Apply
      </Button>
    </div>
  );
}
