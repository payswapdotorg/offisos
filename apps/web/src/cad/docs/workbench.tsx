"use client";

/**
 * Offisos Documentation Workbench — Web host surface (COMPAT-CAD-003 /
 * Issue #41, Architecture v1.1 FROZEN).
 *
 * A REAL construction-documentation workflow, not a mockup: view definitions
 * (plan / elevation / section / detail) as versioned document content through
 * `docs.createViews`, a deterministic drawing viewport over the derived
 * `docs.getViewGeometry` projection, annotations (docs.dim / docs.tag /
 * docs.note) bound to canonical element identities, deterministic
 * regeneration (`docs.regenerate` — the content-hash determinism proof),
 * sheets with A1 title blocks and view placements (`docs.createSheets`) and
 * the canonical Sheet IR export contract (`docs.exportSheet` — pdf/dwg fail
 * typed docs_unsupported by design). One seed button runs the representative
 * end-to-end workflow.
 *
 * Every mutation goes through fetch("/api/cad") exactly like the Electron
 * host (Web/Electron parity, §5.5). Client-safety: only the pure BIM entity
 * parser (`bim/elements.js`) and the transport are imported — the projection
 * engine stays server-side behind the frozen docs.* App API (LOCK-003/018).
 */

import * as React from "react";
import {
  Download,
  FileWarning,
  Layers,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { CommandQueryResponse, ErrResult } from "@offisos/cad-app-shell/contracts/app-api";
import { elementToBimEntitySafe, type BimEntity } from "@offisos/cad-app-shell/bim/elements.js";

import {
  bimCreate,
  docsAddAnnotations,
  docsCreateSheets,
  docsCreateViews,
  docsExportSheet,
  docsGetViewGeometry,
  docsListSheets,
  docsListViews,
  docsRegenerate,
  docsRemoveAnnotations,
  docsRemoveSheet,
  docsRemoveView,
  getState,
  unwrapDocsCreated,
  unwrapDocsExport,
  unwrapDocsListSheets,
  unwrapDocsListViews,
  unwrapDocsRegenerate,
  unwrapDocsViewGeometry,
} from "@/cad/client/http-transport";
import type {
  DocsRegenerateResult,
  DocsSheetRecord,
  DocsViewGeometryResult,
  DocsViewListEntry,
} from "@/cad/client/http-transport";
import { DocsViewport } from "@/cad/docs/viewport";
import { DocsSheetPreview } from "@/cad/docs/sheet";

// --- constants + helpers ------------------------------------------------------

type ViewKind = "plan" | "elevation" | "section" | "detail";
type AnnotationKind = "docs.dim" | "docs.tag" | "docs.note";

const VIEW_KINDS: readonly { id: ViewKind; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "elevation", label: "Elevation" },
  { id: "section", label: "Section" },
  { id: "detail", label: "Detail" },
];

const KIND_DEFAULT_TITLE: Record<ViewKind, string> = {
  plan: "Ground Floor Plan",
  elevation: "Front Elevation",
  section: "Section A-A",
  detail: "Door Detail 1",
};

const ELEVATION_DIRECTIONS: readonly ("front" | "back" | "left" | "right")[] = ["front", "back", "left", "right"];

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

/** The representative building (docs-workflow test-suite precedent):
 *  story-gf + 4 walls + slab + op-door/door-main + op-win/win-1 + space-office
 *  — ONE atomic bim.createElements batch with explicit same-batch ids. */
const SEED_BUILDING: readonly Record<string, unknown>[] = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-west", storyId: "story-gf", start: [0, 5000], end: [0, 0], width: 300, height: 3000 },
  { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
  { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
  { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left", name: "Main entrance" },
  { type: "bim.opening", id: "op-win", hostId: "wall-south", distance: 3500, width: 1500, height: 1200, sill: 900 },
  { type: "bim.window", id: "win-1", openingId: "op-win", name: "Facade W1" },
  { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
];

/** Canonical sheet placement grid (the test-suite precedent). */
function canonicalPlacementSlot(i: number): { x: string; y: string; w: string; h: string } {
  return {
    x: String(10 + 310 * (i % 2)),
    y: String(10 + 290 * Math.floor(i / 2)),
    w: "300",
    h: "280",
  };
}

function toNum(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a finite number (got "${value}")`);
  }
  return n;
}

function entityLabel(e: BimEntity): string {
  const short = e.type.replace("bim.", "");
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? `${e.id} · ${short} “${name}”` : `${e.id} · ${short}`;
}

// --- component -----------------------------------------------------------------

export function DocsWorkbench(): React.JSX.Element {
  // --- document + documentation state ----------------------------------------
  const [snapshot, setSnapshot] = React.useState<CADDocumentSnapshot | null>(null);
  const [views, setViews] = React.useState<DocsViewListEntry[] | null>(null);
  const [sheets, setSheets] = React.useState<DocsSheetRecord[] | null>(null);
  const [geometry, setGeometry] = React.useState<DocsViewGeometryResult | null>(null);
  const [regenResult, setRegenResult] = React.useState<DocsRegenerateResult | null>(null);
  const [exportResult, setExportResult] = React.useState<{ sheetId: string; hash: string; bytes: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>("ready");

  // selection (refs keep refresh() identity stable; state drives rendering)
  const [selectedViewId, setSelectedViewId] = React.useState<string | null>(null);
  const [selectedSheetId, setSelectedSheetId] = React.useState<string | null>(null);
  const selectedViewRef = React.useRef<string | null>(null);
  const selectedSheetRef = React.useRef<string | null>(null);

  const applyViewSelection = React.useCallback((id: string | null): void => {
    selectedViewRef.current = id;
    setSelectedViewId(id);
  }, []);
  const applySheetSelection = React.useCallback((id: string | null): void => {
    selectedSheetRef.current = id;
    setSelectedSheetId(id);
  }, []);

  // --- view creation form ------------------------------------------------------
  const [viewKind, setViewKind] = React.useState<ViewKind>("plan");
  const [viewTitleForm, setViewTitleForm] = React.useState("Ground Floor Plan");
  const [viewStoryId, setViewStoryId] = React.useState("");
  const [viewDirection, setViewDirection] = React.useState<"front" | "back" | "left" | "right">("front");
  const [viewAxis, setViewAxis] = React.useState<"x" | "y">("y");
  const [viewSectionOffset, setViewSectionOffset] = React.useState("2500");
  const [viewSourceId, setViewSourceId] = React.useState("");
  const [viewRegion, setViewRegion] = React.useState({ x: "300", y: "-300", w: "1400", h: "600" });
  const [viewDetailScale, setViewDetailScale] = React.useState("2");
  const [viewScale, setViewScale] = React.useState("50");

  // --- annotation forms ----------------------------------------------------------
  const [annKind, setAnnKind] = React.useState<AnnotationKind>("docs.dim");
  const [dimRefA, setDimRefA] = React.useState("");
  const [dimRefB, setDimRefB] = React.useState("");
  const [dimAxis, setDimAxis] = React.useState<"x" | "y">("y");
  const [dimMode, setDimMode] = React.useState<"overall" | "clear">("overall");
  const [dimOffset, setDimOffset] = React.useState("-1000");
  const [tagTarget, setTagTarget] = React.useState("");
  const [noteForm, setNoteForm] = React.useState({ x: "3000", y: "5500", text: "Tighten construction tolerances" });

  // --- sheet form ---------------------------------------------------------------
  const [sheetForm, setSheetForm] = React.useState({
    title: "Ground Floor Documentation",
    projectName: "Offisos Demo",
    sheetTitle: "Ground Floor",
    sheetNumber: "A-101",
    author: "Z.ai",
    date: "2026-08-27",
  });
  const [placementRows, setPlacementRows] = React.useState<
    { viewId: string; x: string; y: string; w: string; h: string }[]
  >([{ viewId: "", x: "10", y: "10", w: "300", h: "280" }]);

  // --- derived from the snapshot (pure client-side parse, same core as server) --

  const elements = React.useMemo(() => snapshot?.elements ?? [], [snapshot]);

  const bimEntities = React.useMemo(() => {
    const out: BimEntity[] = [];
    for (const el of elements) {
      const entity = elementToBimEntitySafe(el);
      if (entity !== null) out.push(entity);
    }
    return out;
  }, [elements]);

  const stories = React.useMemo(
    () =>
      bimEntities
        .filter((e): e is Extract<BimEntity, { type: "bim.story" }> => e.type === "bim.story")
        .sort((a, b) => (a.level !== b.level ? a.level - b.level : a.id < b.id ? -1 : 1)),
    [bimEntities],
  );

  /** Model views (details crop these; detail-of-detail is rejected by contract). */
  const modelViews = React.useMemo(
    () => (views ?? []).filter((v) => v.view.kind !== "detail"),
    [views],
  );

  // Effective picker values: fall back to the first valid option at render.
  const effectiveStoryId = React.useMemo(
    () => (stories.some((s) => s.id === viewStoryId) ? viewStoryId : (stories[0]?.id ?? "")),
    [stories, viewStoryId],
  );
  const effectiveSourceViewId = React.useMemo(
    () => (modelViews.some((v) => v.view.id === viewSourceId) ? viewSourceId : (modelViews[0]?.view.id ?? "")),
    [modelViews, viewSourceId],
  );
  const effectiveDimRefA = React.useMemo(() => {
    if (bimEntities.some((e) => e.id === dimRefA)) return dimRefA;
    const south = bimEntities.find((e) => e.id === "wall-south");
    return south?.id ?? bimEntities[0]?.id ?? "";
  }, [bimEntities, dimRefA]);
  const effectiveDimRefB = React.useMemo(() => {
    if (bimEntities.some((e) => e.id === dimRefB)) return dimRefB;
    const north = bimEntities.find((e) => e.id === "wall-north");
    return north?.id ?? bimEntities.find((e) => e.id !== effectiveDimRefA)?.id ?? "";
  }, [bimEntities, dimRefB, effectiveDimRefA]);
  const effectiveTagTarget = React.useMemo(() => {
    if (bimEntities.some((e) => e.id === tagTarget)) return tagTarget;
    const office = bimEntities.find((e) => e.id === "space-office");
    return office?.id ?? bimEntities[0]?.id ?? "";
  }, [bimEntities, tagTarget]);

  const effectivePlacementView = React.useCallback(
    (rowViewId: string): string => {
      if ((views ?? []).some((v) => v.view.id === rowViewId)) return rowViewId;
      return views?.[0]?.view.id ?? "";
    },
    [views],
  );

  const seededBuilding = React.useMemo(() => bimEntities.some((e) => e.id === "story-gf"), [bimEntities]);

  // --- refresh + exec (the drafting/BIM workbench proven pattern) ----------------

  const refresh = React.useCallback(async (viewToSelect?: string, sheetToSelect?: string): Promise<void> => {
    const [stateRes, viewsRes, sheetsRes] = await Promise.all([
      getState(),
      docsListViews(),
      docsListSheets(),
    ]);
    if (stateRes.ok) {
      setSnapshot(stateRes.value as CADDocumentSnapshot);
    } else {
      setError(`[document.getState] ${stateRes.code}: ${stateRes.message}`);
    }
    let nextViews: DocsViewListEntry[] | null = null;
    if (viewsRes.ok) {
      nextViews = unwrapDocsListViews(viewsRes);
      setViews(nextViews);
    } else {
      setViews(null);
      setError(`[docs.listViews] ${viewsRes.code}: ${viewsRes.message}`);
    }
    let nextSheets: DocsSheetRecord[] | null = null;
    if (sheetsRes.ok) {
      nextSheets = unwrapDocsListSheets(sheetsRes);
      setSheets(nextSheets);
    } else {
      setSheets(null);
      setError(`[docs.listSheets] ${sheetsRes.code}: ${sheetsRes.message}`);
    }

    // View selection reconciliation: explicit target → current → first → none.
    const wantView = viewToSelect ?? selectedViewRef.current;
    const viewEntry = nextViews?.find((v) => v.view.id === wantView) ?? nextViews?.[0] ?? null;
    const viewId = viewEntry?.view.id ?? null;
    applyViewSelection(viewId);
    if (viewId === null) {
      setGeometry(null);
    } else {
      const geoRes = await docsGetViewGeometry(viewId);
      const geo = unwrapDocsViewGeometry(geoRes);
      if (geo === null) {
        setGeometry(null);
        setError(
          geoRes.ok
            ? "[docs.getViewGeometry] unexpected response shape"
            : `[docs.getViewGeometry] ${geoRes.code}: ${geoRes.message}`,
        );
      } else {
        setGeometry(geo);
      }
    }

    // Sheet selection reconciliation.
    const wantSheet = sheetToSelect ?? selectedSheetRef.current;
    const sheet = nextSheets?.find((s) => s.id === wantSheet) ?? nextSheets?.[0] ?? null;
    applySheetSelection(sheet?.id ?? null);
  }, [applyViewSelection, applySheetSelection]);

  // Initial load (async — setState fires after the await, lint-safe).
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      await refresh();
      if (!cancelled) {
        setStatus("loaded documentation state");
        setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /** Run one async operation with the busy guard, typed-error surfacing and
   *  the trailing refresh. `select` may pick a newly created view/sheet from
   *  the response (e.g. docs.createViews → created[0]). */
  const exec = React.useCallback(
    async (
      label: string,
      fn: () => Promise<CommandQueryResponse>,
      select?: (res: CommandQueryResponse) => { view?: string; sheet?: string },
    ): Promise<CommandQueryResponse> => {
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
      const sel = select !== undefined ? select(res) : {};
      await refresh(sel.view, sel.sheet);
      setBusy(false);
      return res;
    },
    [refresh],
  );

  // --- actions -------------------------------------------------------------------

  const selectView = React.useCallback(
    (id: string) => {
      void (async () => {
        setBusy(true);
        setError(null);
        applyViewSelection(id);
        const geoRes = await docsGetViewGeometry(id);
        const geo = unwrapDocsViewGeometry(geoRes);
        if (geo === null) {
          setGeometry(null);
          setError(
            geoRes.ok
              ? "[docs.getViewGeometry] unexpected response shape"
              : `[docs.getViewGeometry] ${geoRes.code}: ${geoRes.message}`,
          );
        } else {
          setGeometry(geo);
          setStatus(`projected “${geo.view.title}” — ${geo.primitiveCount} primitives, ${geo.skips.length} skips`);
        }
        setBusy(false);
      })();
    },
    [applyViewSelection],
  );

  const selectSheet = React.useCallback(
    (id: string) => {
      applySheetSelection(id);
      setExportResult(null);
    },
    [applySheetSelection],
  );

  const onKindChange = React.useCallback((k: ViewKind) => {
    setViewKind(k);
    setViewTitleForm(KIND_DEFAULT_TITLE[k]);
  }, []);

  const onCreateView = React.useCallback(() => {
    void (async () => {
      try {
        const title = viewTitleForm.trim() !== "" ? viewTitleForm.trim() : `${viewKind} view`;
        const scale = toNum(viewScale, "scale denominator");
        let payload: Record<string, unknown>;
        if (viewKind === "plan") {
          if (effectiveStoryId === "") throw new Error("plan views require storyId — author a story first (BIM workbench or the seed button)");
          payload = { kind: "plan", title, storyId: effectiveStoryId, scale };
        } else if (viewKind === "elevation") {
          payload = { kind: "elevation", title, direction: viewDirection, scale };
        } else if (viewKind === "section") {
          payload = {
            kind: "section", title, scale,
            sectionAxis: viewAxis,
            sectionOffset: toNum(viewSectionOffset, "section offset"),
          };
        } else {
          if (effectiveSourceViewId === "") throw new Error("detail views require a source model view — create a plan/elevation/section first");
          payload = {
            kind: "detail", title, scale,
            sourceViewId: effectiveSourceViewId,
            region: {
              x: toNum(viewRegion.x, "region x"),
              y: toNum(viewRegion.y, "region y"),
              w: toNum(viewRegion.w, "region w"),
              h: toNum(viewRegion.h, "region h"),
            },
            detailScale: toNum(viewDetailScale, "detail scale"),
          };
        }
        const res = await exec(
          "docs.createViews",
          () => docsCreateViews([payload]),
          (r) => ({ view: (unwrapDocsCreated(r) ?? [])[0] }),
        );
        if (res.ok) {
          const created = unwrapDocsCreated(res) ?? [];
          setStatus(`created ${viewKind} view → ${created.join(", ") || "document-minted id"} (1 atomic revision)`);
        }
      } catch (e) {
        setError(`[docs.createViews] ${(e as Error).message}`);
      }
    })();
  }, [viewKind, viewTitleForm, viewScale, effectiveStoryId, viewDirection, viewAxis, viewSectionOffset, effectiveSourceViewId, viewRegion, viewDetailScale, exec]);

  const onRemoveView = React.useCallback(
    (id: string) => {
      void (async () => {
        const res = await exec("docs.removeView", () => docsRemoveView(id));
        if (res.ok) setStatus(`removed view ${id} (1 atomic revision)`);
      })();
    },
    [exec],
  );

  const onAddAnnotation = React.useCallback(() => {
    void (async () => {
      try {
        if (selectedViewId === null) throw new Error("select a view first (annotations bind to a view)");
        let payload: Record<string, unknown>;
        if (annKind === "docs.dim") {
          if (effectiveDimRefA === "" || effectiveDimRefB === "") throw new Error("docs.dim requires two BIM element references — author the model first");
          if (effectiveDimRefA === effectiveDimRefB) throw new Error("docs.dim refIds must reference two DIFFERENT elements");
          payload = {
            type: "docs.dim", viewId: selectedViewId,
            refIds: [effectiveDimRefA, effectiveDimRefB],
            axis: dimAxis, mode: dimMode,
            offset: toNum(dimOffset, "dimension offset"),
          };
        } else if (annKind === "docs.tag") {
          if (effectiveTagTarget === "") throw new Error("docs.tag requires a target BIM element — author the model first");
          payload = { type: "docs.tag", viewId: selectedViewId, targetId: effectiveTagTarget };
        } else {
          if (noteForm.text.trim() === "") throw new Error("docs.note requires a text");
          payload = {
            type: "docs.note", viewId: selectedViewId,
            x: toNum(noteForm.x, "note x"), y: toNum(noteForm.y, "note y"),
            text: noteForm.text.trim(),
          };
        }
        const res = await exec("docs.addAnnotations", () => docsAddAnnotations([payload]));
        if (res.ok) {
          const created = unwrapDocsCreated(res) ?? [];
          setStatus(`added ${annKind} → ${created.join(", ") || "document-minted id"} (values derive on Regenerate)`);
        }
      } catch (e) {
        setError(`[docs.addAnnotations] ${(e as Error).message}`);
      }
    })();
  }, [selectedViewId, annKind, effectiveDimRefA, effectiveDimRefB, dimAxis, dimMode, dimOffset, effectiveTagTarget, noteForm, exec]);

  const onRemoveAnnotation = React.useCallback(
    (id: string) => {
      void (async () => {
        const res = await exec("docs.removeAnnotations", () => docsRemoveAnnotations([id]));
        if (res.ok) setStatus(`removed annotation ${id} (1 atomic revision)`);
      })();
    },
    [exec],
  );

  const onRegenerate = React.useCallback(() => {
    void (async () => {
      const res = await exec("docs.regenerate", () => docsRegenerate());
      if (res.ok) {
        const regen = unwrapDocsRegenerate(res);
        setRegenResult(regen);
        if (regen !== null) {
          setStatus(`regenerated ${regen.report.views.length} view(s) · ${regen.applied} annotation update(s) applied as one revision`);
        }
      } else {
        setRegenResult(null);
      }
    })();
  }, [exec]);

  const onAddPlacementRow = React.useCallback(() => {
    setPlacementRows((rows) => [...rows, { viewId: "", ...canonicalPlacementSlot(rows.length) }]);
  }, []);

  const onCreateSheet = React.useCallback(() => {
    void (async () => {
      try {
        const rows = placementRows.map((r) => ({
          viewId: effectivePlacementView(r.viewId),
          x: toNum(r.x, "placement x"),
          y: toNum(r.y, "placement y"),
          w: toNum(r.w, "placement w"),
          h: toNum(r.h, "placement h"),
        }));
        if (rows.length === 0) throw new Error("a sheet needs at least one view placement");
        for (const r of rows) {
          if (r.viewId === "") throw new Error("every placement needs a view — create views first");
        }
        const payload = {
          title: sheetForm.title.trim() !== "" ? sheetForm.title.trim() : "Sheet",
          titleBlock: {
            projectName: sheetForm.projectName.trim() !== "" ? sheetForm.projectName.trim() : "Untitled project",
            sheetTitle: sheetForm.sheetTitle.trim() !== "" ? sheetForm.sheetTitle.trim() : "Sheet",
            sheetNumber: sheetForm.sheetNumber.trim() !== "" ? sheetForm.sheetNumber.trim() : "A-001",
            ...(sheetForm.author.trim() !== "" ? { author: sheetForm.author.trim() } : {}),
            ...(sheetForm.date.trim() !== "" ? { date: sheetForm.date.trim() } : {}),
          },
          viewPlacements: rows,
        };
        const res = await exec(
          "docs.createSheets",
          () => docsCreateSheets([payload]),
          (r) => ({ sheet: (unwrapDocsCreated(r) ?? [])[0] }),
        );
        if (res.ok) {
          const created = unwrapDocsCreated(res) ?? [];
          setStatus(`created sheet → ${created.join(", ") || "document-minted id"} (${rows.length} placements, 1 atomic revision)`);
        }
      } catch (e) {
        setError(`[docs.createSheets] ${(e as Error).message}`);
      }
    })();
  }, [placementRows, sheetForm, effectivePlacementView, exec]);

  const onRemoveSheet = React.useCallback(
    (id: string) => {
      void (async () => {
        const res = await exec("docs.removeSheet", () => docsRemoveSheet(id));
        if (res.ok) {
          setStatus(`removed sheet ${id} (views and annotations are not cascaded)`);
          if (selectedSheetRef.current === id) setExportResult(null);
        }
      })();
    },
    [exec],
  );

  const onExport = React.useCallback(
    (format: "sheet-ir" | "pdf" | "dwg") => {
      const sheetId = selectedSheetRef.current;
      if (sheetId === null) return;
      void (async () => {
        setBusy(true);
        setError(null);
        const res = await docsExportSheet(sheetId, format);
        if (!res.ok) {
          // pdf/dwg are contract-only in this slice — the typed failure IS the
          // demonstrated behaviour (explicit, never a partial writer).
          setError(`[docs.exportSheet ${format}] ${res.code}: ${res.message}`);
          setExportResult(null);
        } else {
          const ex = unwrapDocsExport(res);
          if (ex === null) {
            setError(`[docs.exportSheet ${format}] unexpected response shape`);
          } else {
            setExportResult({ sheetId: ex.sheetId, hash: ex.hash, bytes: ex.canonical.length });
            setStatus(`exported ${ex.sheetId} → canonical Sheet IR (${ex.canonical.length} bytes, sha256 ${ex.hash.slice(0, 16)}…)`);
            // Download the canonical JSON artifact (Blob download).
            const blob = new Blob([ex.canonical], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${ex.sheetId}-sheet-ir.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        }
        setBusy(false);
      })();
    },
    [],
  );

  /** One-click representative workflow: building (if the document has no BIM
   *  elements) → 4 canonical views → 2 dims + 2 tags → one sheet with
   *  placements → docs.regenerate. Every step's typed failure is surfaced. */
  const onSeed = React.useCallback(() => {
    void (async () => {
      setBusy(true);
      setError(null);
      setStatus("seeding the representative documentation workflow…");
      const fail = async (label: string, res: ErrResult): Promise<void> => {
        setError(`[${label}] ${res.code}: ${res.message}`);
        await refresh();
        setBusy(false);
      };
      try {
        if (bimEntities.length === 0) {
          const r = await bimCreate([...SEED_BUILDING]);
          if (!r.ok) {
            await fail("seed bim.createElements", r);
            return;
          }
        }
        // 3 model views, then the detail (its source is the fresh plan's id).
        const r1 = await docsCreateViews([
          { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
          { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
          { kind: "section", title: "Section A-A", sectionAxis: "y", sectionOffset: 2500, scale: 50 },
        ]);
        if (!r1.ok) {
          await fail("seed docs.createViews", r1);
          return;
        }
        const [planId, elevId, sectId] = unwrapDocsCreated(r1) ?? [];
        if (planId === undefined || elevId === undefined || sectId === undefined) {
          setError("[seed docs.createViews] unexpected response shape");
          await refresh();
          setBusy(false);
          return;
        }
        const r2 = await docsCreateViews([
          { kind: "detail", title: "Door Detail 1", sourceViewId: planId, region: { x: 300, y: -300, w: 1400, h: 600 }, detailScale: 2, scale: 50 },
        ]);
        if (!r2.ok) {
          await fail("seed docs.createViews (detail)", r2);
          return;
        }
        const detailId = (unwrapDocsCreated(r2) ?? [])[0];
        if (detailId === undefined) {
          setError("[seed docs.createViews (detail)] unexpected response shape");
          await refresh();
          setBusy(false);
          return;
        }
        const r3 = await docsAddAnnotations([
          { type: "docs.dim", viewId: planId, refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall", offset: -1000 },
          { type: "docs.dim", viewId: planId, refIds: ["wall-south", "wall-north"], axis: "y", mode: "clear", offset: -1400 },
          { type: "docs.tag", viewId: planId, targetId: "space-office" },
          { type: "docs.tag", viewId: planId, targetId: "door-main" },
        ]);
        if (!r3.ok) {
          await fail("seed docs.addAnnotations", r3);
          return;
        }
        const r4 = await docsCreateSheets([{
          title: "Ground Floor Documentation",
          titleBlock: { projectName: "Offisos Demo", sheetTitle: "Ground Floor", sheetNumber: "A-101", author: "Z.ai", date: "2026-08-27" },
          viewPlacements: [
            { viewId: planId, x: 10, y: 10, w: 300, h: 280 },
            { viewId: elevId, x: 320, y: 10, w: 300, h: 280 },
            { viewId: sectId, x: 10, y: 300, w: 300, h: 280 },
            { viewId: detailId, x: 320, y: 300, w: 300, h: 280 },
          ],
        }]);
        if (!r4.ok) {
          await fail("seed docs.createSheets", r4);
          return;
        }
        const sheetId = (unwrapDocsCreated(r4) ?? [])[0];
        const r5 = await docsRegenerate();
        if (!r5.ok) {
          await fail("seed docs.regenerate", r5);
          return;
        }
        const regen = unwrapDocsRegenerate(r5);
        setRegenResult(regen);
        const dims = regen?.report.annotations.filter((a) => a.measured !== null) ?? [];
        setStatus(
          `seeded: 4 views (${planId}…${detailId}) + 2 dims + 2 tags + sheet ${sheetId ?? "?"} → regenerated` +
            (dims.length > 0 ? ` — measured ${dims.map((d) => `${d.measured} mm`).join(", ")}` : ""),
        );
        await refresh(planId, sheetId);
      } catch (e) {
        setError(`[seed] unexpected: ${(e as Error).message}`);
        await refresh();
      } finally {
        setBusy(false);
      }
    })();
  }, [bimEntities, refresh]);

  // --- render ---------------------------------------------------------------------

  const selectedEntry = views?.find((v) => v.view.id === selectedViewId) ?? null;
  const selectedSheet = sheets?.find((s) => s.id === selectedSheetId) ?? null;
  const annotations = geometry?.annotations ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documentation Workbench</CardTitle>
        <CardDescription>
          Construction documentation from the BIM model: plan/elevation/section/detail views (versioned
          content), deterministic projections, dimensions/tags/notes bound to canonical element ids,
          regeneration with content hashes, A1 sheets with title blocks and the canonical Sheet IR export
          contract — every mutation through the shared App API (COMPAT-CAD-003). Units: millimeters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error !== null && (
          <div role="alert" className="mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}
        <div
          data-testid="docs-status"
          data-state={busy ? "busy" : error !== null ? "error" : "done"}
          className="mb-3 rounded border bg-muted/40 px-2.5 py-1.5 text-xs"
          role="status"
          aria-label="documentation operation status"
        >
          {busy ? "working… " : ""}
          {status}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-4">
          {/* --- left: drawing viewport + sheet preview --------------------------- */}
          <div className="flex flex-col gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-sm font-semibold">Drawing viewport</span>
                {geometry !== null ? (
                  <>
                    <Badge variant="secondary" className="font-mono">{geometry.view.id}</Badge>
                    <Badge variant="outline" className="font-mono">{geometry.view.kind}</Badge>
                    <Badge variant="outline" className="font-mono" title={geometry.contentHash}>
                      sha256 {geometry.contentHash.slice(0, 8)}…
                    </Badge>
                    <Badge variant="outline" className="font-mono">{geometry.primitiveCount} prim</Badge>
                    <Badge variant="outline" className="font-mono">{geometry.skips.length} skips</Badge>
                    <span className="text-xs text-muted-foreground">“{geometry.view.title}”</span>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">no view projected</span>
                )}
              </div>
              <DocsViewport geometry={geometry} />
              <div data-testid="docs-skips" className="mt-2">
                {geometry !== null && geometry.skips.length > 0 ? (
                  <ScrollArea className="max-h-96 pr-2">
                    <ul className="space-y-1 text-xs font-mono">
                      {geometry.skips.map((s) => (
                        <li key={s.elementId} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                          skipped {s.elementId}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {geometry !== null ? "no skips — every in-scope element projected" : "skips appear here once a view is projected"}
                  </p>
                )}
              </div>
            </div>

            {selectedSheet !== null && (
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-sm font-semibold">Sheet</span>
                  <Badge variant="secondary" className="font-mono">{selectedSheet.id}</Badge>
                  <span className="text-xs text-muted-foreground">
                    “{selectedSheet.title}” · {selectedSheet.viewPlacements.length} placement(s) · A1 841×594 · drawable [0,641]×[0,594]
                  </span>
                </div>
                <DocsSheetPreview sheet={selectedSheet} views={views ?? []} />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    data-testid="docs-export-ir"
                    disabled={busy}
                    onClick={() => onExport("sheet-ir")}
                    title="docs.exportSheet format 'sheet-ir' — canonical deterministic JSON (the PDF/DWG adapter contract)"
                  >
                    <Download aria-hidden="true" />
                    Export Sheet IR
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="docs-export-pdf"
                    disabled={busy}
                    onClick={() => onExport("pdf")}
                    title="docs.exportSheet format 'pdf' — contract only; the writer is not implemented (typed docs_unsupported)"
                  >
                    <FileWarning aria-hidden="true" />
                    Export PDF
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="docs-export-dwg"
                    disabled={busy}
                    onClick={() => onExport("dwg")}
                    title="docs.exportSheet format 'dwg' — contract only; the writer is not implemented (typed docs_unsupported)"
                  >
                    <FileWarning aria-hidden="true" />
                    Export DWG
                  </Button>
                </div>
                {exportResult !== null && (
                  <div
                    data-testid="docs-export-hash"
                    className="mt-2 rounded border bg-muted/40 px-2.5 py-1.5 text-xs font-mono break-all"
                  >
                    {exportResult.sheetId} · sheet-ir · {exportResult.bytes} bytes · sha256 {exportResult.hash}
                  </div>
                )}
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  The Sheet IR is the export CONTRACT (canonical JSON, hashed). PDF/DWG writers are out of
                  scope for this slice — those requests fail typed docs_unsupported by design.
                </p>
              </div>
            )}
          </div>

          {/* --- right: seed + views + annotations + sheets ------------------------ */}
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-sm font-semibold mb-1">Representative workflow</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                One click seeds the demo building (when the document has no BIM elements), the 4 canonical
                views (plan + front elevation + section A-A + door detail ×2), 2 dimensions + 2 tags, one
                A-101 sheet with placements, then runs docs.regenerate.
              </p>
              <Button
                size="sm"
                variant="secondary"
                data-testid="docs-seed"
                disabled={busy}
                onClick={onSeed}
                title={seededBuilding ? "BIM elements exist — seeds views/annotations/sheet/regeneration on top" : "seeds the representative building + documentation set"}
              >
                <Layers aria-hidden="true" />
                {seededBuilding ? "Seed documentation set" : "Seed demo building + documentation"}
              </Button>
            </div>

            <Separator />

            {/* Views panel */}
            <div>
              <div className="text-sm font-semibold mb-1">Views</div>
              <div className="flex flex-wrap gap-1 mb-2" role="tablist" aria-label="view kind">
                {VIEW_KINDS.map((k) => (
                  <Button
                    key={k.id}
                    size="sm"
                    variant={viewKind === k.id ? "default" : "outline"}
                    onClick={() => onKindChange(k.id)}
                    role="tab"
                    aria-selected={viewKind === k.id}
                  >
                    {k.label}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 items-start text-sm">
                <div className="col-span-2">
                  <Field label="title">
                    <input className={INP} aria-label="view title" value={viewTitleForm} onChange={(e) => setViewTitleForm(e.target.value)} />
                  </Field>
                </div>
                {viewKind === "plan" && (
                  <Field label="story">
                    <select className={INP} aria-label="plan story" value={effectiveStoryId} onChange={(e) => setViewStoryId(e.target.value)}>
                      {stories.length === 0 && <option value="">— author a story first —</option>}
                      {stories.map((s) => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}
                    </select>
                  </Field>
                )}
                {viewKind === "elevation" && (
                  <Field label="direction">
                    <select className={INP} aria-label="elevation direction" value={viewDirection} onChange={(e) => setViewDirection(e.target.value as "front" | "back" | "left" | "right")}>
                      {ELEVATION_DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </Field>
                )}
                {viewKind === "section" && (
                  <>
                    <Field label="cut axis">
                      <select className={INP} aria-label="section axis" value={viewAxis} onChange={(e) => setViewAxis(e.target.value as "x" | "y")}>
                        <option value="x">x</option>
                        <option value="y">y</option>
                      </select>
                    </Field>
                    <Field label="cut offset (mm)">
                      <input className={INP} aria-label="section offset" value={viewSectionOffset} onChange={(e) => setViewSectionOffset(e.target.value)} />
                    </Field>
                  </>
                )}
                {viewKind === "detail" && (
                  <>
                    <div className="col-span-2">
                      <Field label="source view (plan/elevation/section)">
                        <select className={INP} aria-label="detail source view" value={effectiveSourceViewId} onChange={(e) => setViewSourceId(e.target.value)}>
                          {modelViews.length === 0 && <option value="">— create a model view first —</option>}
                          {modelViews.map((v) => <option key={v.view.id} value={v.view.id}>{v.view.id} · {v.view.title}</option>)}
                        </select>
                      </Field>
                    </div>
                    <Field label="region x"><input className={INP} aria-label="detail region x" value={viewRegion.x} onChange={(e) => setViewRegion((r) => ({ ...r, x: e.target.value }))} /></Field>
                    <Field label="region y"><input className={INP} aria-label="detail region y" value={viewRegion.y} onChange={(e) => setViewRegion((r) => ({ ...r, y: e.target.value }))} /></Field>
                    <Field label="region w"><input className={INP} aria-label="detail region w" value={viewRegion.w} onChange={(e) => setViewRegion((r) => ({ ...r, w: e.target.value }))} /></Field>
                    <Field label="region h"><input className={INP} aria-label="detail region h" value={viewRegion.h} onChange={(e) => setViewRegion((r) => ({ ...r, h: e.target.value }))} /></Field>
                    <Field label="detail scale (×)"><input className={INP} aria-label="detail scale" value={viewDetailScale} onChange={(e) => setViewDetailScale(e.target.value)} /></Field>
                  </>
                )}
                <Field label="drawing scale 1:N"><input className={INP} aria-label="view scale denominator" value={viewScale} onChange={(e) => setViewScale(e.target.value)} /></Field>
              </div>
              <Button size="sm" className="mt-2" data-testid="docs-create-view" disabled={busy} onClick={onCreateView}>
                Create {viewKind} view
              </Button>

              <p className="text-xs text-muted-foreground mt-3 mb-1.5">
                docs.listViews — click a row to project it in the viewport; ✕ removes (blocked while
                referenced — typed error).
              </p>
              <ScrollArea className="max-h-96 pr-2">
                {views === null || views.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No views yet — create one above or seed the workflow.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {views.map((entry) => {
                      const selected = entry.view.id === selectedViewId;
                      return (
                        <li
                          key={entry.view.id}
                          data-testid={`docs-view-row-${entry.view.id}`}
                          className={`rounded border px-2 py-1.5 text-xs transition-colors hover:bg-accent cursor-pointer ${selected ? "bg-accent ring-1 ring-primary/40" : ""}`}
                          onClick={() => selectView(entry.view.id)}
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-mono">{entry.view.id}</span>
                            <Badge variant={selected ? "default" : "outline"} className="font-mono">{entry.view.kind}</Badge>
                            <span className="truncate max-w-[9rem]">{entry.view.title}</span>
                            {entry.error === null ? (
                              <>
                                <span className="text-muted-foreground">{entry.primitiveCount} prim</span>
                                {entry.contentHash !== null && (
                                  <span className="font-mono text-muted-foreground" title={entry.contentHash}>{entry.contentHash.slice(0, 8)}…</span>
                                )}
                                {entry.skipCount > 0 && <span className="text-muted-foreground">{entry.skipCount} skips</span>}
                              </>
                            ) : (
                              <span className="text-red-700 dark:text-red-400 break-all">{entry.error}</span>
                            )}
                            <span className="ml-auto">
                              <button
                                type="button"
                                data-testid={`docs-remove-view-${entry.view.id}`}
                                className="text-red-700 hover:text-red-900 dark:text-red-400 disabled:opacity-50"
                                disabled={busy}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onRemoveView(entry.view.id);
                                }}
                                title="docs.removeView (blocked while placed/annotated/detail source)"
                                aria-label={`remove view ${entry.view.id}`}
                              >
                                ✕
                              </button>
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </ScrollArea>
            </div>

            <Separator />

            {/* Annotations panel */}
            <div>
              <div className="text-sm font-semibold mb-1">Annotations</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                Bound to the selected view{selectedEntry !== null ? ` (${selectedEntry.view.id} “${selectedEntry.view.title}”)` : ""} and canonical
                element ids. Derived values (measured/labels) refresh through docs.regenerate.
              </p>
              <div className="flex flex-wrap gap-1 mb-2" role="tablist" aria-label="annotation type">
                {(["docs.dim", "docs.tag", "docs.note"] as const).map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={annKind === t ? "default" : "outline"}
                    onClick={() => setAnnKind(t)}
                    role="tab"
                    aria-selected={annKind === t}
                  >
                    {t.replace("docs.", "")}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 items-start text-sm">
                {annKind === "docs.dim" && (
                  <>
                    <Field label="reference A">
                      <select className={INP} aria-label="dimension reference a" value={effectiveDimRefA} onChange={(e) => setDimRefA(e.target.value)}>
                        {bimEntities.length === 0 && <option value="">— author BIM elements first —</option>}
                        {bimEntities.map((en) => <option key={en.id} value={en.id}>{entityLabel(en)}</option>)}
                      </select>
                    </Field>
                    <Field label="reference B">
                      <select className={INP} aria-label="dimension reference b" value={effectiveDimRefB} onChange={(e) => setDimRefB(e.target.value)}>
                        {bimEntities.length === 0 && <option value="">— author BIM elements first —</option>}
                        {bimEntities.map((en) => <option key={en.id} value={en.id}>{entityLabel(en)}</option>)}
                      </select>
                    </Field>
                    <Field label="axis">
                      <select className={INP} aria-label="dimension axis" value={dimAxis} onChange={(e) => setDimAxis(e.target.value as "x" | "y")}>
                        <option value="x">x</option>
                        <option value="y">y</option>
                      </select>
                    </Field>
                    <Field label="mode">
                      <select className={INP} aria-label="dimension mode" value={dimMode} onChange={(e) => setDimMode(e.target.value as "overall" | "clear")}>
                        <option value="overall">overall</option>
                        <option value="clear">clear</option>
                      </select>
                    </Field>
                    <Field label="offset (mm)"><input className={INP} aria-label="dimension offset" value={dimOffset} onChange={(e) => setDimOffset(e.target.value)} /></Field>
                  </>
                )}
                {annKind === "docs.tag" && (
                  <div className="col-span-2">
                    <Field label="target element">
                      <select className={INP} aria-label="tag target" value={effectiveTagTarget} onChange={(e) => setTagTarget(e.target.value)}>
                        {bimEntities.length === 0 && <option value="">— author BIM elements first —</option>}
                        {bimEntities.map((en) => <option key={en.id} value={en.id}>{entityLabel(en)}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
                {annKind === "docs.note" && (
                  <>
                    <Field label="x (mm)"><input className={INP} aria-label="note x" value={noteForm.x} onChange={(e) => setNoteForm((f) => ({ ...f, x: e.target.value }))} /></Field>
                    <Field label="y (mm)"><input className={INP} aria-label="note y" value={noteForm.y} onChange={(e) => setNoteForm((f) => ({ ...f, y: e.target.value }))} /></Field>
                    <div className="col-span-2">
                      <Field label="text"><input className={INP} aria-label="note text" value={noteForm.text} onChange={(e) => setNoteForm((f) => ({ ...f, text: e.target.value }))} /></Field>
                    </div>
                  </>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button size="sm" data-testid="docs-add-annotation" disabled={busy} onClick={onAddAnnotation}>
                  Add {annKind.replace("docs.", "")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="docs-regenerate"
                  disabled={busy}
                  onClick={onRegenerate}
                  title="docs.regenerate — recompute every view projection (content hashes) + annotation values as one atomic revision"
                >
                  <RefreshCw aria-hidden="true" />
                  Regenerate
                </Button>
              </div>

              <p className="text-xs text-muted-foreground mt-3 mb-1.5">
                Annotations on the selected view{selectedEntry !== null ? ` (${selectedEntry.view.id})` : ""} — ✕ removes.
              </p>
              <div data-testid="docs-annotations">
                <ScrollArea className="max-h-96 pr-2">
                  {annotations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      None yet — add a dimension, tag or note (values derive on Regenerate).
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {annotations.map((ann) => (
                        <li key={ann.id} className="rounded border px-2 py-1.5 text-xs">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-mono">{ann.id}</span>
                            <Badge variant="outline" className="font-mono">{ann.type}</Badge>
                            {ann.type === "docs.dim" && (
                              <span className="font-mono text-muted-foreground">{(ann.refIds ?? []).join(" ↔ ")}</span>
                            )}
                            {ann.type === "docs.tag" && (
                              <span className="font-mono text-muted-foreground">→ {ann.targetId ?? ""}</span>
                            )}
                            {ann.type === "docs.note" && (
                              <span className="font-mono text-muted-foreground">({ann.x ?? 0}, {ann.y ?? 0})</span>
                            )}
                            {ann.dangling === true ? (
                              <span className="text-red-700 dark:text-red-400 break-all" title={ann.reason ?? ""}>
                                dangling: {ann.reason ?? "reference lost"}
                              </span>
                            ) : ann.type === "docs.dim" ? (
                              <span className="font-mono">
                                {typeof ann.measured === "number" ? `${ann.measured} mm` : "not regenerated"}
                                <span className="text-muted-foreground"> · {ann.axis ?? "?"}/{ann.mode ?? "?"}</span>
                              </span>
                            ) : ann.type === "docs.tag" ? (
                              <span className="font-mono">{ann.label ?? "not regenerated"}</span>
                            ) : (
                              <span className="truncate max-w-[10rem]">“{ann.text ?? ""}”</span>
                            )}
                            <span className="ml-auto">
                              <button
                                type="button"
                                data-testid={`docs-remove-annotation-${ann.id}`}
                                className="text-red-700 hover:text-red-900 dark:text-red-400 disabled:opacity-50"
                                disabled={busy}
                                onClick={() => onRemoveAnnotation(ann.id)}
                                title="docs.removeAnnotations"
                                aria-label={`remove annotation ${ann.id}`}
                              >
                                ✕
                              </button>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </div>

              {regenResult !== null && (
                <div data-testid="docs-regen-report" className="mt-3 rounded border bg-muted/30 p-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="font-mono">{regenResult.report.views.length} views</Badge>
                    <Badge variant="outline" className="font-mono">{regenResult.report.annotations.length} annotations</Badge>
                    <Badge variant="outline" className="font-mono">applied {regenResult.applied}</Badge>
                    <span className="text-muted-foreground">docs.regenerate report</span>
                  </div>
                  <ScrollArea className="max-h-96 mt-1.5 pr-2">
                    <ul className="space-y-0.5 font-mono">
                      {regenResult.report.views.map((v) => (
                        <li key={v.viewId} className="break-all">
                          {v.viewId} {v.kind} · {v.contentHash !== null ? `${v.contentHash.slice(0, 8)}… · ${v.primitiveCount} prim` : `ERROR: ${v.error ?? "not projected"}`}
                          {v.skipCount > 0 ? ` · ${v.skipCount} skips` : ""}
                        </li>
                      ))}
                      {regenResult.report.annotations.map((a) => (
                        <li key={a.id} className="break-all text-muted-foreground">
                          {a.id} {a.type} · {a.dangling ? `dangling: ${a.reason ?? ""}` : a.measured !== null ? `${a.measured} mm` : a.label !== null ? `“${a.label}”` : "note"}
                          {a.updated ? " · updated" : ""}
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              )}
            </div>

            <Separator />

            {/* Sheets panel */}
            <div>
              <div className="text-sm font-semibold mb-1">Sheets</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 items-start text-sm">
                <div className="col-span-2">
                  <Field label="sheet title"><input className={INP} aria-label="sheet title" value={sheetForm.title} onChange={(e) => setSheetForm((f) => ({ ...f, title: e.target.value }))} /></Field>
                </div>
                <Field label="project name"><input className={INP} aria-label="title block project name" value={sheetForm.projectName} onChange={(e) => setSheetForm((f) => ({ ...f, projectName: e.target.value }))} /></Field>
                <Field label="sheet title (block)"><input className={INP} aria-label="title block sheet title" value={sheetForm.sheetTitle} onChange={(e) => setSheetForm((f) => ({ ...f, sheetTitle: e.target.value }))} /></Field>
                <Field label="sheet number"><input className={INP} aria-label="title block sheet number" value={sheetForm.sheetNumber} onChange={(e) => setSheetForm((f) => ({ ...f, sheetNumber: e.target.value }))} /></Field>
                <Field label="author"><input className={INP} aria-label="title block author" value={sheetForm.author} onChange={(e) => setSheetForm((f) => ({ ...f, author: e.target.value }))} /></Field>
                <Field label="date"><input className={INP} aria-label="title block date" value={sheetForm.date} onChange={(e) => setSheetForm((f) => ({ ...f, date: e.target.value }))} /></Field>
              </div>

              <p className="text-xs text-muted-foreground mt-2 mb-1">View placements (sheet mm, drawable [0,641]×[0,594], non-overlapping):</p>
              <ul className="flex flex-col gap-1.5">
                {placementRows.map((row, i) => {
                  const effView = effectivePlacementView(row.viewId);
                  return (
                    <li key={i} className="rounded border p-1.5">
                      <div className="grid grid-cols-2 gap-1.5 text-xs">
                        <select
                          className={INP}
                          aria-label={`placement ${i + 1} view`}
                          value={effView}
                          onChange={(e) => setPlacementRows((rows) => rows.map((r, j) => (j === i ? { ...r, viewId: e.target.value } : r)))}
                        >
                          {(views ?? []).length === 0 && <option value="">— create views first —</option>}
                          {(views ?? []).map((v) => <option key={v.view.id} value={v.view.id}>{v.view.id} · {v.view.title}</option>)}
                        </select>
                        <div className="grid grid-cols-4 gap-1">
                          {(["x", "y", "w", "h"] as const).map((f) => (
                            <input
                              key={f}
                              className={INP}
                              aria-label={`placement ${i + 1} ${f}`}
                              value={row[f]}
                              onChange={(e) => setPlacementRows((rows) => rows.map((r, j) => (j === i ? { ...r, [f]: e.target.value } : r)))}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="flex justify-end mt-1">
                        <button
                          type="button"
                          className="text-red-700 hover:text-red-900 dark:text-red-400 disabled:opacity-50 text-xs"
                          disabled={busy || placementRows.length <= 1}
                          onClick={() => setPlacementRows((rows) => rows.filter((_, j) => j !== i))}
                          aria-label={`remove placement ${i + 1}`}
                        >
                          remove placement
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={onAddPlacementRow}>
                  <Plus aria-hidden="true" />
                  Add placement
                </Button>
                <Button size="sm" data-testid="docs-create-sheet" disabled={busy} onClick={onCreateSheet}>
                  Create sheet
                </Button>
              </div>

              <p className="text-xs text-muted-foreground mt-3 mb-1.5">
                docs.listSheets — click a row to preview the A1 sheet + exports.
              </p>
              <ScrollArea className="max-h-96 pr-2">
                {sheets === null || sheets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sheets yet — place views on one above.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {sheets.map((sh) => {
                      const selected = sh.id === selectedSheetId;
                      return (
                        <li
                          key={sh.id}
                          data-testid={`docs-sheet-row-${sh.id}`}
                          className={`rounded border px-2 py-1.5 text-xs transition-colors hover:bg-accent cursor-pointer ${selected ? "bg-accent ring-1 ring-primary/40" : ""}`}
                          onClick={() => selectSheet(sh.id)}
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-mono">{sh.id}</span>
                            <span className="truncate max-w-[9rem]">{sh.title}</span>
                            <Badge variant="outline" className="font-mono">{sh.viewPlacements.length} placements</Badge>
                            <Badge variant="outline" className="font-mono">{sh.titleBlock.sheetNumber}</Badge>
                            <span className="ml-auto">
                              <button
                                type="button"
                                data-testid={`docs-remove-sheet-${sh.id}`}
                                className="text-red-700 hover:text-red-900 dark:text-red-400 disabled:opacity-50"
                                disabled={busy}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onRemoveSheet(sh.id);
                                }}
                                title="docs.removeSheet (views and annotations are not cascaded)"
                                aria-label={`remove sheet ${sh.id}`}
                              >
                                ✕
                              </button>
                            </span>
                          </div>
                        </li>
                      );
                    })}
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
