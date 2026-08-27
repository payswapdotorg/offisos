'use client';

/**
 * Offisos CAD Workspace — Web host surface (CAD-IMPLEMENT-001 / Issue #24,
 * Architecture v1.1 FROZEN).
 *
 * Client component. Talks to the backend ONLY via fetch('/api/cad', ...).
 * Imports NO module that transitively imports `node:crypto` — only the pure
 * contract type modules (`@offisos/cad-app-shell/contracts/app-api`,
 * `@offisos/cad-app-shell/contracts/caddocument`) and the client-side http
 * transport. Web/Electron parity is proven by the Offisos repo's host-parity
 * tests; the same AppApiHandler + CADDocument + dummy adapter run server-side
 * here.
 *
 * Construction Graph boundary (LOCK-019): CADDocument is the editor
 * representation only. The dummy adapter is the only engine — no FreeCAD/
 * OCCT/IfcOpenShell coupling (LOCK-003/018).
 */

import * as React from "react";
import {
  Box,
  Circle as CircleIcon,
  Combine,
  Cylinder,
  Download,
  FilePlus,
  FolderOpen,
  Redo2,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";

import type {
  CADDocumentSnapshot,
  Element,
  VersionMeta,
} from "@offisos/cad-app-shell/contracts/caddocument";
import type {
  GraphBridgeResult,
  ModelHistory,
  ModelReplayResult,
} from "@offisos/cad-app-shell/contracts/model";
import type { CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import {
  applyEdit,
  canRedo,
  canUndo,
  createDoc,
  getGraphEvents,
  getHistory,
  getImpactCascade,
  getState,
  getSelection,
  openFromText,
  prepareGeometry,
  redo,
  replayModel,
  save,
  setSelection,
  undo,
  unwrapGraphEvents,
  unwrapHistory,
  unwrapImpactCascade,
  unwrapPrepared,
  unwrapReplay,
  unwrapSaveBytes,
  unwrapSelection,
  unwrapSnapshot,
} from "@/cad/client/http-transport";
import type { ImpactCascadeResult } from "@/cad/client/http-transport";
import { DraftingWorkbench } from "@/cad/drafting/workbench";
import { BimWorkbench } from "@/cad/bim/workbench";
import { DocsWorkbench } from "@/cad/docs/workbench";

// --- Helpers --------------------------------------------------------------

function truncate(s: string, n = 18): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isLegacyShapeElement(el: Element): el is Element & {
  props: { shape: "box" | "circle"; x: number; y: number; w: number; h: number; fill: string; stroke: string };
} {
  const p = el.props as Record<string, unknown>;
  return (
    el.kind === "geometry" &&
    (p.shape === "box" || p.shape === "circle") &&
    typeof p.x === "number" &&
    typeof p.y === "number" &&
    typeof p.w === "number" &&
    typeof p.h === "number" &&
    typeof p.fill === "string" &&
    typeof p.stroke === "string"
  );
}

function isGeometryElement(el: Element): boolean {
  // CAD-IMPLEMENT-002: real-engine geometry elements carry a meshToken
  // (props.geometry + props.meshToken); legacy dummy shapes carry the flat
  // shape/x/y/w/h props. Both render on the canvas.
  if (el.kind !== "geometry") return false;
  const p = el.props as Record<string, unknown>;
  if (typeof p.meshToken === "string") return true;
  return (
    (p.shape === "box" || p.shape === "circle") &&
    typeof p.x === "number" &&
    typeof p.y === "number" &&
    typeof p.w === "number" &&
    typeof p.h === "number" &&
    typeof p.fill === "string" &&
    typeof p.stroke === "string"
  );
}

function randomOffset(max: number): number {
  return Math.floor(Math.random() * max);
}

// --- Component -------------------------------------------------------------

export default function Home() {
  const [workbenchMode, setWorkbenchMode] = React.useState<"drafting" | "bim" | "docs">("drafting");
  const [snapshot, setSnapshot] = React.useState<CADDocumentSnapshot | null>(null);
  const [selection, setSel] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [engine, setEngine] = React.useState<{ engineId: string; engineVersion: string } | null>(null);
  const [meshes, setMeshes] = React.useState<Record<string, { vertices: number[]; indices: number[]; bbox: number[] }>>({});
  // CAD-IMPLEMENT-003: immutable model revisions + the graph-facing event stream.
  const [history, setHistory] = React.useState<ModelHistory | null>(null);
  const [graphEvents, setGraphEvents] = React.useState<GraphBridgeResult | null>(null);
  const [replay, setReplay] = React.useState<ModelReplayResult | null>(null);
  // RESEARCH-CAD-007: the downstream impact cascade.
  const [impact, setImpact] = React.useState<ImpactCascadeResult | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  /** Cache a prepared mesh for viewport rendering (keyed by meshToken —
   *  deterministic, so re-preparing the same geometry re-hydrates it). */
  const rememberMesh = React.useCallback((prepared: { meshToken: string; bbox: readonly number[]; mesh: { vertices: readonly number[]; indices: readonly number[] } | null }) => {
    if (prepared.mesh === null) return;
    setMeshes((prev) => ({
      ...prev,
      [prepared.meshToken]: {
        vertices: [...prepared.mesh!.vertices],
        indices: [...prepared.mesh!.indices],
        bbox: [...prepared.bbox],
      },
    }));
  }, []);

  const refresh = React.useCallback(async () => {
    const [stateRes, selRes, historyRes, eventsRes] = await Promise.all([
      getState(),
      getSelection(),
      getHistory(),
      getGraphEvents(),
    ]);
    const snap = unwrapSnapshot(stateRes);
    const sel = unwrapSelection(selRes);
    if (snap) setSnapshot(snap);
    setSel(sel);
    setHistory(unwrapHistory(historyRes));
    setGraphEvents(unwrapGraphEvents(eventsRes));
    if (!stateRes.ok) setError(stateRes.message);
    else if (!selRes.ok) setError(selRes.message);
    else setError(null);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [stateRes, selRes, historyRes, eventsRes] = await Promise.all([
        getState(),
        getSelection(),
        getHistory(),
        getGraphEvents(),
      ]);
      if (cancelled) return;
      const snap = unwrapSnapshot(stateRes);
      const sel = unwrapSelection(selRes);
      if (snap) setSnapshot(snap);
      setSel(sel);
      setHistory(unwrapHistory(historyRes));
      setGraphEvents(unwrapGraphEvents(eventsRes));
      if (!stateRes.ok) setError(stateRes.message);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Run an async operation with the busy guard, then refresh state. Catches
   * any thrown error and surfaces it through the error banner (defensive —
   * the http transport itself never throws; it returns ErrResult on failure).
   */
  const run = React.useCallback(
    async (label: string, fn: () => Promise<CommandQueryResponse>) => {
      setBusy(true);
      try {
        const res = await fn();
        if (!res.ok) {
          setError(`[${label}] ${res.code}: ${res.message}`);
        } else {
          setError(null);
        }
        await refresh();
      } catch (e) {
        setError(`[${label}] unexpected: ${(e as Error).message}`);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // --- Action handlers -----------------------------------------------------

  /** CAD-IMPLEMENT-003: deterministic historical replay to a revision. */
  const onReplayTo = React.useCallback(
    (revisionNumber: number) => {
      setBusy(true);
      (async () => {
        const res = await replayModel(revisionNumber);
        const value = unwrapReplay(res);
        if (!res.ok || value === null) {
          setError(res.ok ? `[Replay] unexpected response shape` : `[Replay] ${res.code}: ${res.message}`);
          setReplay(null);
        } else {
          setError(null);
          setReplay(value);
        }
        setBusy(false);
      })();
    },
    [],
  );

  /** RESEARCH-CAD-007: run the downstream impact cascade for the latest
   *  model transition (model change → quantity delta → estimate impact →
   *  affected RFQ → commercial impact) through the shared App API. */
  const onRunImpact = React.useCallback(
    (revisionNumber?: number) => {
      setBusy(true);
      (async () => {
        const res = await getImpactCascade(revisionNumber);
        const value = unwrapImpactCascade(res);
        if (!res.ok || value === null) {
          setError(res.ok ? `[Impact] unexpected response shape` : `[Impact] ${res.code}: ${res.message}`);
          setImpact(null);
        } else {
          setError(null);
          setImpact(value);
        }
        setBusy(false);
      })();
    },
    [],
  );

  const onNew = React.useCallback(() => {
    void run("New", () => createDoc({}));
  }, [run]);

  const onOpen = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChosen = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setBusy(true);
      try {
        const text = await file.text();
        await run("Open", () => openFromText(text));
      } catch (err) {
        setError(`[Open] failed to read file: ${(err as Error).message}`);
      } finally {
        // Reset so the same file can be re-selected later.
        if (fileInputRef.current) fileInputRef.current.value = "";
        setBusy(false);
      }
    },
    [run],
  );

  const onSave = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await save();
      if (!res.ok) {
        setError(`[Save] ${res.code}: ${res.message}`);
        await refresh();
        return;
      }
      const data = unwrapSaveBytes(res);
      if (!data) {
        setError("[Save] unexpected response shape");
        await refresh();
        return;
      }
      const bytes = new Uint8Array(data.bytes);
      const blob = new Blob([bytes], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "workspace.offisos-dummy.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setError(null);
      await refresh();
    } catch (e) {
      setError(`[Save] unexpected: ${(e as Error).message}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const onAddBox = React.useCallback(() => {
    const id = crypto.randomUUID();
    void run("Add Box", () =>
      applyEdit({
        type: "addElement",
        element: {
          id,
          kind: "geometry",
          engineId: null,
          props: {
            shape: "box",
            x: 60 + randomOffset(600),
            y: 60 + randomOffset(400),
            w: 80,
            h: 60,
            fill: "#f97316",
            stroke: "#9a3412",
          },
        },
      }),
    );
  }, [run]);

  const onAddCircle = React.useCallback(() => {
    const id = crypto.randomUUID();
    void run("Add Circle", () =>
      applyEdit({
        type: "addElement",
        element: {
          id,
          kind: "geometry",
          engineId: null,
          props: {
            shape: "circle",
            x: 60 + randomOffset(600),
            y: 60 + randomOffset(400),
            w: 70,
            h: 70,
            fill: "#10b981",
            stroke: "#065f46",
          },
        },
      }),
    );
  }, [run]);

  // --- CAD-IMPLEMENT-002: real geometry through the shared App API -------

  /** Prepare a real geometry descriptor, cache the mesh, and add the element
   *  with the deterministic occt: meshToken (the EXISTING document workflow). */
  const onAddRealGeometry = React.useCallback(
    (label: string, geometry: Record<string, unknown>) => {
      setBusy(true);
      (async () => {
        try {
          const res = await prepareGeometry(geometry);
          const prepared = unwrapPrepared(res);
          if (!prepared) {
            setError(res.ok ? `[${label}] unexpected response shape` : `[${label}] ${res.code}: ${res.message}`);
            await refresh();
            return;
          }
          setEngine(prepared.engine);
          rememberMesh(prepared);
          const addRes = await applyEdit({
            type: "addElement",
            element: {
              id: crypto.randomUUID(),
              kind: "geometry",
              engineId: prepared.engine.engineId,
              props: { geometry, meshToken: prepared.meshToken, bbox: [...prepared.bbox] },
            },
          });
          if (!addRes.ok) {
            setError(`[${label}] ${addRes.code}: ${addRes.message}`);
          } else {
            setError(null);
          }
          await refresh();
        } catch (e) {
          setError(`[${label}] unexpected: ${(e as Error).message}`);
          await refresh();
        } finally {
          setBusy(false);
        }
      })();
    },
    [refresh, rememberMesh],
  );

  const onAddOcctBox = React.useCallback(() => {
    onAddRealGeometry("Box (OCCT)", { shape: "box", width: 120, depth: 90, height: 70 });
  }, [onAddRealGeometry]);

  const onAddOcctCylinder = React.useCallback(() => {
    onAddRealGeometry("Cylinder (OCCT)", { shape: "cylinder", radius: 45, height: 110 });
  }, [onAddRealGeometry]);

  const onAddOcctFuse = React.useCallback(() => {
    onAddRealGeometry("Fuse (OCCT)", {
      shape: "fuse",
      a: { shape: "box", width: 140, depth: 100, height: 60 },
      b: { shape: "cylinder", radius: 40, height: 90, origin: [70, 50, 0], direction: [0, 0, 1] },
    });
  }, [onAddRealGeometry]);

  /** Re-hydrate viewport meshes for persisted real-geometry elements (the
   *  descriptors live in props.geometry; re-preparing is deterministic and
   *  returns the identical meshToken). */
  React.useEffect(() => {
    if (!snapshot) return;
    const pending = snapshot.elements.filter(
      (el) =>
        el.kind === "geometry" &&
        typeof (el.props as Record<string, unknown>).meshToken === "string" &&
        typeof (el.props as Record<string, unknown>).geometry === "object" &&
        !meshes[(el.props as Record<string, unknown>).meshToken as string],
    );
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const el of pending) {
        if (cancelled) return;
        const res = await prepareGeometry((el.props as Record<string, unknown>).geometry);
        const prepared = unwrapPrepared(res);
        if (prepared && prepared.meshToken === (el.props as Record<string, unknown>).meshToken) {
          if (cancelled) return;
          setEngine(prepared.engine);
          rememberMesh(prepared);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, meshes, rememberMesh]);

  const onDeleteSelected = React.useCallback(async () => {
    if (selection.length === 0) return;
    setBusy(true);
    try {
      for (const id of selection) {
        await applyEdit({ type: "removeElement", elementId: id });
      }
      await setSelection([]);
      await refresh();
    } catch (e) {
      setError(`[Delete] unexpected: ${(e as Error).message}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [selection, refresh]);

  const onUndo = React.useCallback(() => {
    void run("Undo", () => undo());
  }, [run]);

  const onRedo = React.useCallback(() => {
    void run("Redo", () => redo());
  }, [run]);

  // --- Canvas interaction -------------------------------------------------

  const onCanvasClick = React.useCallback(() => {
    if (selection.length === 0) return;
    void run("Clear Selection", () => setSelection([]));
  }, [selection.length, run]);

  const onElementClick = React.useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      void run("Select", () => setSelection([id]));
    },
    [run],
  );

  // --- Derived state ------------------------------------------------------

  const version: VersionMeta | null = snapshot?.version ?? null;
  const editorState = snapshot?.editorState;
  const canUndoFlag = editorState?.canUndo ?? false;
  const canRedoFlag = editorState?.canRedo ?? false;
  const commandDepth = editorState?.commandDepth ?? 0;
  const elements: Element[] = snapshot?.elements ? [...snapshot.elements] : [];
  const format = snapshot?.format ?? "—";
  const formatVersion = snapshot?.formatVersion ?? "—";
  const lineage = snapshot?.sourceArtifactLineage ?? [];

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="px-4 sm:px-6 lg:px-8 py-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
              Offisos CAD Workspace
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Web host — real OCCT geometry engine behind the frozen adapter boundary
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              CAD-IMPLEMENT-003 · COMPAT-CAD-001/002/003 / v1.1
            </Badge>
            {engine && (
              <Badge variant="outline" className="font-mono">
                {engine.engineId} {engine.engineVersion}
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Canvas (left, spans 2 on desktop) */}
          <section
            aria-label="CAD canvas"
            className="lg:col-span-2"
          >
            <Card className="h-full">
              <CardHeader>
                <CardTitle>Canvas</CardTitle>
                <CardDescription>
                  Click an element to select it; click empty canvas to clear. Real
                  engine geometry renders as an isometric model viewport; legacy
                  dummy shapes render as flat SVG.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <Skeleton className="w-full aspect-[4/3] rounded-md" />
                ) : (
                  <svg
                    viewBox="0 0 800 600"
                    className="w-full h-auto rounded-md border bg-neutral-50 dark:bg-neutral-900"
                    role="img"
                    aria-label="CAD canvas with geometry elements"
                    onClick={onCanvasClick}
                  >
                    <GridLines />
                    {elements.map((el) => {
                      if (!isGeometryElement(el)) return null;
                      const selected = selection.includes(el.id);
                      const props = el.props as Record<string, unknown>;
                      const token = typeof props.meshToken === "string" ? props.meshToken : null;
                      const cachedMesh = token !== null ? meshes[token] : undefined;
                      if (cachedMesh !== undefined) {
                        return (
                          <MeshViewport
                            key={el.id}
                            mesh={cachedMesh}
                            selected={selected}
                            onClick={(e) => onElementClick(e, el.id)}
                          />
                        );
                      }
                      if (isLegacyShapeElement(el)) {
                        return (
                          <GeometryShape
                            key={el.id}
                            element={el}
                            selected={selected}
                            onClick={(e) => onElementClick(e, el.id)}
                          />
                        );
                      }
                      return null;
                    })}
                    {elements.length === 0 && !loading && (
                      <text
                        x="400"
                        y="300"
                        textAnchor="middle"
                        className="fill-muted-foreground"
                        style={{ fontSize: 18 }}
                      >
                        empty document — add a shape to begin
                      </text>
                    )}
                  </svg>
                )}
              </CardContent>
            </Card>
          </section>

          {/* Controls (right, 1 column on desktop) */}
          <nav aria-label="CAD workspace controls" className="lg:col-span-1 flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>File</CardTitle>
                <CardDescription>Create, open, or save the document.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={onNew}
                    disabled={busy || loading}
                    aria-label="New document"
                  >
                    <FilePlus aria-hidden="true" />
                    <span>New</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={onOpen}
                    disabled={busy || loading}
                    aria-label="Open document"
                  >
                    <FolderOpen aria-hidden="true" />
                    <span>Open</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={onSave}
                    disabled={busy || loading}
                    aria-label="Save document"
                  >
                    <Download aria-hidden="true" />
                    <span>Save</span>
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,.offisos-dummy"
                    className="sr-only"
                    aria-hidden="true"
                    tabIndex={-1}
                    onChange={onFileChosen}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Real geometry (OCCT)</CardTitle>
                <CardDescription>
                  Prepare real engine geometry (deterministic boxes, cylinders,
                  booleans) through the shared App API — geometry.prepare →
                  applyEdit. Requires the pinned toolchain (python3 +
                  cadquery-ocp); failures are typed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="default"
                    className="h-11"
                    onClick={onAddOcctBox}
                    disabled={busy || loading}
                    aria-label="Add real OCCT box"
                  >
                    <Box aria-hidden="true" />
                    <span>Box (OCCT)</span>
                  </Button>
                  <Button
                    variant="default"
                    className="h-11"
                    onClick={onAddOcctCylinder}
                    disabled={busy || loading}
                    aria-label="Add real OCCT cylinder"
                  >
                    <Cylinder aria-hidden="true" />
                    <span>Cylinder (OCCT)</span>
                  </Button>
                  <Button
                    variant="default"
                    className="h-11"
                    onClick={onAddOcctFuse}
                    disabled={busy || loading}
                    aria-label="Fuse real OCCT box and cylinder"
                  >
                    <Combine aria-hidden="true" />
                    <span>Fuse (OCCT)</span>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit</CardTitle>
                <CardDescription>Add or remove geometry elements (dummy shapes).</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="default"
                    className="h-11"
                    onClick={onAddBox}
                    disabled={busy || loading}
                    aria-label="Add box"
                  >
                    <Square aria-hidden="true" />
                    <span>Add Box</span>
                  </Button>
                  <Button
                    variant="default"
                    className="h-11"
                    onClick={onAddCircle}
                    disabled={busy || loading}
                    aria-label="Add circle"
                  >
                    <CircleIcon aria-hidden="true" />
                    <span>Add Circle</span>
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-11"
                    onClick={onDeleteSelected}
                    disabled={busy || loading || selection.length === 0}
                    aria-label="Delete selected elements"
                  >
                    <Trash2 aria-hidden="true" />
                    <span>Delete</span>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>History</CardTitle>
                <CardDescription>Undo / redo the last edit.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={onUndo}
                    disabled={busy || loading || !canUndoFlag}
                    aria-label="Undo"
                  >
                    <Undo2 aria-hidden="true" />
                    <span>Undo</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={onRedo}
                    disabled={busy || loading || !canRedoFlag}
                    aria-label="Redo"
                  >
                    <Redo2 aria-hidden="true" />
                    <span>Redo</span>
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* CAD-IMPLEMENT-003: persistent model revisions + Graph bridge */}
            <Card>
              <CardHeader>
                <CardTitle>Model Revisions</CardTitle>
                <CardDescription>
                  Immutable revision history persisted with the document
                  (save/open). Click a revision to replay it deterministically.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="font-mono">
                    {history ? `${history.revisions.length} revisions` : "—"}
                  </Badge>
                  <Badge variant="outline" className="font-mono">
                    base: {history?.base.origin ?? "—"}
                  </Badge>
                  {graphEvents && (
                    <Badge variant="outline" className="font-mono">
                      {graphEvents.events.length} graph events
                    </Badge>
                  )}
                </div>
                <ScrollArea className="max-h-96 mt-3 pr-3">
                  {!history || history.revisions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No revisions yet — edit the document to record them.
                    </p>
                  ) : (
                    <ol className="space-y-1.5">
                      {history.revisions.map((rev) => (
                        <li key={rev.revision_id}>
                          <button
                            type="button"
                            className="w-full text-left rounded-md border px-2.5 py-2 text-xs hover:bg-accent transition-colors disabled:opacity-50"
                            onClick={() => onReplayTo(rev.revision_number)}
                            disabled={busy}
                            aria-label={`Replay to revision ${rev.revision_number}`}
                          >
                            <span className="font-mono">#{rev.revision_number}</span>{" "}
                            <span className="font-mono text-muted-foreground">v{rev.version.version_number}</span>{" "}
                            <Badge variant="outline" className="ml-1 font-mono">
                              {rev.note}
                            </Badge>
                            <span className="ml-1 text-muted-foreground">
                              +{rev.delta.added.length} ~{rev.delta.updated.length} −{rev.delta.removed.length}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </ScrollArea>
                {replay && (
                  <div className="mt-3 rounded-md border bg-muted/40 p-2.5 text-xs">
                    <p className="font-medium">
                      Replay @ {replay.revision_number}{" "}
                      <Badge variant="secondary" className="font-mono ml-1">
                        {replay.verified ? "verified" : "unverified"}
                      </Badge>
                    </p>
                    <p className="font-mono break-all text-muted-foreground mt-1">
                      {truncate(replay.revision_id, 44)}
                    </p>
                    <p className="font-mono break-all text-muted-foreground">
                      content {truncate(replay.content_hash, 16)}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {replay.elements.length} element{replay.elements.length === 1 ? "" : "s"}:{" "}
                      <span className="font-mono">
                        {replay.elements.map((e) => truncate(e.id, 12)).join(", ") || "—"}
                      </span>
                    </p>
                  </div>
                )}
                {graphEvents && (
                  <div className="mt-3 rounded-md border p-2.5 text-xs">
                    <p className="font-medium">Construction Graph bridge</p>
                    <p className="font-mono break-all text-muted-foreground mt-1">
                      events_hash {truncate(graphEvents.events_hash, 24)}
                    </p>
                    <p className="text-muted-foreground mt-1">
                      Event stream: {graphEvents.events.filter((e) => e.event_type === "model.created").length}×{" "}
                      model.created,{" "}
                      {graphEvents.events.filter((e) => e.event_type === "model.version.created").length}×{" "}
                      model.version.created — deterministic, engine-id provenance only.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* RESEARCH-CAD-007: downstream impact cascade */}
            <Card>
              <CardHeader>
                <CardTitle>Impact</CardTitle>
                <CardDescription>
                  Model change → quantity delta → estimate impact → affected
                  RFQ → commercial impact. Deterministic cascade caused by the
                  model.version.created graph event.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => onRunImpact()}
                  disabled={busy || !history || history.revisions.length === 0}
                  aria-label="Run the downstream impact cascade for the latest revision"
                >
                  Run impact cascade
                </Button>
                {!impact ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    No cascade yet — edit the model, then run the cascade.
                  </p>
                ) : (
                  <div className="mt-3 space-y-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                      <Badge variant="secondary" className="font-mono">
                        r{impact.from_revision.revision_number} → r{impact.to_revision.revision_number}
                      </Badge>
                      <Badge variant="outline" className="font-mono">
                        {impact.events.length} events
                      </Badge>
                      <Badge variant="outline" className="font-mono">
                        {impact.engine.engineId}@{impact.engine.engineVersion}
                      </Badge>
                    </div>

                    <div>
                      <p className="font-medium">Quantity deltas</p>
                      <ScrollArea className="max-h-40 mt-1 pr-2">
                        <ul className="space-y-1 font-mono">
                          {impact.quantities.deltas
                            .filter((d) => d.delta !== null && Math.abs(d.delta) > 0)
                            .map((d) => (
                              <li key={d.element_id} className="flex justify-between gap-2">
                                <span className="truncate">{truncate(d.element_id, 20)}</span>
                                <span>
                                  {d.previous?.toFixed(4)} → {d.current?.toFixed(4)} ({d.delta! >= 0 ? "+" : ""}
                                  {d.delta!.toFixed(4)})
                                </span>
                              </li>
                            ))}
                          {impact.quantities.deltas.every((d) => d.delta === null || Math.abs(d.delta) === 0) && (
                            <li className="text-muted-foreground">no quantity change</li>
                          )}
                        </ul>
                      </ScrollArea>
                      {impact.quantities.skipped.length > 0 && (
                        <p className="mt-1 text-muted-foreground">
                          {impact.quantities.skipped.length} unmeasured (UNKNOWN:{" "}
                          {impact.quantities.skipped.map((s) => truncate(s.element_id, 12)).join(", ")})
                        </p>
                      )}
                    </div>

                    <div>
                      <p className="font-medium">Estimate</p>
                      <p className="font-mono">
                        {impact.estimate.previous
                          ? `${impact.estimate.previous.total.toFixed(2)} → ${impact.estimate.current.total.toFixed(2)} ${impact.estimate.current.currency}`
                          : `${impact.estimate.current.total.toFixed(2)} ${impact.estimate.current.currency}`}
                      </p>
                    </div>

                    <div>
                      <p className="font-medium">Affected RFQ packages</p>
                      <ul className="mt-1 space-y-1 font-mono">
                        {impact.rfq.impacts
                          .filter((i) => i.affected)
                          .map((i) => (
                            <li key={i.category} className="flex justify-between gap-2">
                              <span>{i.category}</span>
                              <span>
                                {i.delta_amount >= 0 ? "+" : ""}
                                {i.delta_amount.toFixed(2)}
                              </span>
                            </li>
                          ))}
                        {impact.rfq.impacts.every((i) => !i.affected) && (
                          <li className="text-muted-foreground">no package affected</li>
                        )}
                      </ul>
                    </div>

                    <div className="rounded-md border bg-muted/40 p-2.5">
                      <p className="font-medium">Commercial impact</p>
                      <p className="mt-1 font-mono text-sm">
                        {impact.commercial_impact.total_delta >= 0 ? "+" : ""}
                        {impact.commercial_impact.total_delta.toFixed(2)}{" "}
                        {impact.commercial_impact.currency}
                      </p>
                      <p className="text-muted-foreground">
                        {impact.commercial_impact.affected_category_count} affected package
                        {impact.commercial_impact.affected_category_count === 1 ? "" : "s"} · demo rate table ·
                        quantities {impact.quantities.current[0]?.uncertainty ?? "CALCULATED"} via{" "}
                        {impact.quantities.current[0]?.method ?? "engine"}
                      </p>
                      <p className="mt-1 break-all font-mono text-muted-foreground">
                        events_hash {truncate(impact.events_hash, 24)}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Selection</CardTitle>
                <CardDescription>
                  {selection.length === 0
                    ? "Nothing selected."
                    : `${selection.length} element${selection.length === 1 ? "" : "s"} selected.`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="max-h-32">
                  {selection.length === 0 ? (
                    <p className="text-sm text-muted-foreground">—</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {selection.map((id) => (
                        <Badge key={id} variant="outline" className="font-mono break-all">
                          {truncate(id, 14)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Version</CardTitle>
                <CardDescription>
                  Versioned CADDocument — deterministic content-hash derivative.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">entity_id</dt>
                  <dd className="font-mono break-all">{version ? truncate(version.entity_id, 24) : "—"}</dd>
                  <dt className="text-muted-foreground">version_id</dt>
                  <dd className="font-mono break-all">{version ? truncate(version.version_id, 32) : "—"}</dd>
                  <dt className="text-muted-foreground">version_number</dt>
                  <dd className="font-mono">{version ? version.version_number : "—"}</dd>
                  <dt className="text-muted-foreground">canUndo</dt>
                  <dd className="font-mono">{String(canUndoFlag)}</dd>
                  <dt className="text-muted-foreground">canRedo</dt>
                  <dd className="font-mono">{String(canRedoFlag)}</dd>
                  <dt className="text-muted-foreground">commandDepth</dt>
                  <dd className="font-mono">{commandDepth}</dd>
                  <dt className="text-muted-foreground">format</dt>
                  <dd className="font-mono">{format}</dd>
                  <dt className="text-muted-foreground">formatVersion</dt>
                  <dd className="font-mono">{formatVersion}</dd>
                </dl>
                <Separator className="my-3" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-foreground/80">Source artifact lineage</p>
                  {lineage.length === 0 ? (
                    <p className="mt-1">—</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 font-mono break-all">
                      {lineage.map((l, i) => (
                        <li key={i}>{truncate(l, 48)}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <Separator className="my-3" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  CADDocument is the editor representation. Construction Graph
                  identity remains canonical (LOCK-019) — the Graph bridge maps
                  revisions to deterministic domain events; engine ids are
                  provenance only. No engine coupling in renderer/CADDocument/
                  App API (LOCK-003/018).
                </p>
              </CardContent>
            </Card>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {error}
              </div>
            )}
          </nav>
        </div>

        {/* COMPAT-CAD-001/002/003: the mode-switchable CAD workbench (full width,
            below the 3D/impact workspace). Every mutation goes through the
            shared App API — the same contract the Electron host drives. */}
        <section aria-label="CAD workbench" className="mt-6">
          <div
            className="flex flex-wrap items-center gap-2 mb-3"
            role="tablist"
            aria-label="Workbench mode"
          >
            <span className="text-sm font-medium text-muted-foreground">Workbench:</span>
            <Button
              role="tab"
              size="sm"
              variant={workbenchMode === "drafting" ? "default" : "outline"}
              aria-selected={workbenchMode === "drafting"}
              onClick={() => setWorkbenchMode("drafting")}
            >
              2D Drafting
            </Button>
            <Button
              role="tab"
              size="sm"
              variant={workbenchMode === "bim" ? "default" : "outline"}
              aria-selected={workbenchMode === "bim"}
              onClick={() => setWorkbenchMode("bim")}
            >
              3D BIM Authoring
            </Button>
            <Button
              role="tab"
              size="sm"
              variant={workbenchMode === "docs" ? "default" : "outline"}
              aria-selected={workbenchMode === "docs"}
              onClick={() => setWorkbenchMode("docs")}
            >
              Documentation
            </Button>
          </div>
          {workbenchMode === "drafting" ? <DraftingWorkbench /> : workbenchMode === "bim" ? <BimWorkbench /> : <DocsWorkbench />}
        </section>
      </main>

      <footer className="mt-auto border-t">
        <div className="px-4 sm:px-6 lg:px-8 py-4 text-xs text-muted-foreground">
          Offisos CAD-IMPLEMENT-003 + COMPAT-CAD-001/002/003 — milestone: persistent
          model revisions + Construction Graph bridge (immutable revision
          history, save/open persistence, stable canonical element identity,
          deterministic graph events, Web/Electron parity); the 2D drafting +
          3D/BIM authoring workbenches (stories/walls/slabs/openings/doors/
          windows/spaces, deterministic cameras, real OCCT geometry builds); and
          the construction-documentation workbench (plan/elevation/section/detail
          views, annotations on canonical ids, deterministic regeneration, A1
          sheets + the canonical Sheet IR export contract).
          Architecture v1.1 FROZEN.
        </div>
      </footer>
    </div>
  );
}

// --- Subcomponents ---------------------------------------------------------

function GridLines() {
  const lines: React.ReactElement[] = [];
  for (let x = 50; x < 800; x += 50) {
    lines.push(
      <line
        key={`v-${x}`}
        x1={x}
        y1={0}
        x2={x}
        y2={600}
        className="stroke-neutral-200 dark:stroke-neutral-700"
        strokeWidth={1}
      />,
    );
  }
  for (let y = 50; y < 600; y += 50) {
    lines.push(
      <line
        key={`h-${y}`}
        x1={0}
        y1={y}
        x2={800}
        y2={y}
        className="stroke-neutral-200 dark:stroke-neutral-700"
        strokeWidth={1}
      />,
    );
  }
  return <>{lines}</>;
}

interface GeometryShapeProps {
  element: Element & {
    props: { shape: "box" | "circle"; x: number; y: number; w: number; h: number; fill: string; stroke: string };
  };
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
}

// --- CAD-IMPLEMENT-002: isometric model viewport ---------------------------
// Projects the real engine's tessellated mesh (flat x,y,z + a,b,c indices)
// onto the SVG canvas with a fixed isometric camera, painter-sorted flat-
// shaded triangles. Host-surface rendering only — the shared renderer core
// (LOCK-017) still consumes just meshToken + transform for the deterministic
// scene hash; this is the viewport presentation of the same data.

interface MeshViewportProps {
  mesh: { vertices: number[]; indices: number[]; bbox: number[] };
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
}

function MeshViewport({ mesh, selected, onClick }: MeshViewportProps) {
  const [xmin, ymin, zmin, xmax, ymax, zmax] = mesh.bbox;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const cz = (zmin + zmax) / 2;
  const extent = Math.max(xmax - xmin, ymax - ymin, zmax - zmin, 1);
  // Fit into ~70% of the 800x600 canvas around a deterministic offset.
  const scale = (0.7 * 520) / extent;
  const originX = 400 + ((cx * 31 - cy * 17) % 40);
  const originY = 300;

  const project = (x: number, y: number, z: number): [number, number] => [
    originX + ((x - cx) - (y - cy)) * 0.866 * scale,
    originY + ((x - cx) + (y - cy)) * 0.5 * scale - (z - cz) * scale,
  ];

  const verts = mesh.vertices;
  const tris: { pts: string; depth: number; shade: number }[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]! * 3;
    const ib = mesh.indices[t + 1]! * 3;
    const ic = mesh.indices[t + 2]! * 3;
    const ax = verts[ia]!, ay = verts[ia + 1]!, az = verts[ia + 2]!;
    const bx = verts[ib]!, by = verts[ib + 1]!, bz = verts[ib + 2]!;
    const cxv = verts[ic]!, cyv = verts[ic + 1]!, czv = verts[ic + 2]!;
    // Face normal for flat shading (fixed light direction).
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const norm = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    // Light from (1, -1, 2) normalized; stone/teal palette.
    const light = Math.max(0.18, (nx / norm) * 0.42 + (ny / norm) * -0.28 + (nz / norm) * 0.86);
    const base = { r: 20, g: 120, b: 110 };
    const r = Math.round(base.r + (255 - base.r) * (light * 0.78));
    const g = Math.round(base.g + (255 - base.g) * (light * 0.78));
    const b = Math.round(base.b + (255 - base.b) * (light * 0.78));
    const pa = project(ax, ay, az);
    const pb = project(bx, by, bz);
    const pc = project(cxv, cyv, czv);
    tris.push({
      pts: `${pa[0].toFixed(1)},${pa[1].toFixed(1)} ${pb[0].toFixed(1)},${pb[1].toFixed(1)} ${pc[0].toFixed(1)},${pc[1].toFixed(1)}`,
      depth: (ax + bx + cxv) / 3 + (ay + by + cyv) / 3 + (az + bz + czv) / 3,
      shade: light,
    });
  }
  // Painter's algorithm: far triangles first (larger x+y+z sum = closer to
  // the camera in this projection, so sort descending depth).
  tris.sort((a, b) => b.depth - a.depth);

  return (
    <g onClick={onClick} role="button" aria-label="Select real geometry element" style={{ cursor: "pointer" }}>
      {tris.map((t, i) => (
        <polygon
          key={i}
          points={t.pts}
          fill={`rgb(${Math.round(20 + (200 - 20) * t.shade)},${Math.round(120 + (230 - 120) * t.shade)},${Math.round(110 + (220 - 110) * t.shade)})`}
          stroke={`rgba(6,78,59,${selected ? 0.9 : 0.35})`}
          strokeWidth={selected ? 1.2 : 0.5}
        />
      ))}
      {selected && (
        <rect
          x={originX - 0.42 * 520}
          y={originY - 0.34 * 520}
          width={0.84 * 520}
          height={0.68 * 520}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="6,4"
          className="text-foreground"
          pointerEvents="none"
        />
      )}
    </g>
  );
}

function GeometryShape({ element, selected, onClick }: GeometryShapeProps) {
  const { shape, x, y, w, h, fill, stroke } = element.props;
  const strokeWidth = selected ? 4 : 2;
  const shapeNode =
    shape === "box" ? (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        style={{ cursor: "pointer" }}
      />
    ) : (
      <circle
        cx={x + w / 2}
        cy={y + h / 2}
        r={Math.min(w, h) / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        style={{ cursor: "pointer" }}
      />
    );
  return (
    <g onClick={onClick} role="button" aria-label={`Select element ${element.id}`}>
      {shapeNode}
      {selected && (
        <rect
          x={x - 6}
          y={y - 6}
          width={w + 12}
          height={h + 12}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="6,4"
          className="text-foreground"
          pointerEvents="none"
        />
      )}
      <title>{`${shape} ${element.id}`}</title>
    </g>
  );
}
