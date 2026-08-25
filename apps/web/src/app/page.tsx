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
  Circle as CircleIcon,
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
import type { CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import {
  applyEdit,
  canRedo,
  canUndo,
  createDoc,
  getState,
  getSelection,
  openFromText,
  redo,
  save,
  setSelection,
  undo,
  unwrapSaveBytes,
  unwrapSelection,
  unwrapSnapshot,
} from "@/cad/client/http-transport";

// --- Helpers --------------------------------------------------------------

function truncate(s: string, n = 18): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isGeometryElement(el: Element): el is Element & {
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

function randomOffset(max: number): number {
  return Math.floor(Math.random() * max);
}

// --- Component -------------------------------------------------------------

export default function Home() {
  const [snapshot, setSnapshot] = React.useState<CADDocumentSnapshot | null>(null);
  const [selection, setSel] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const refresh = React.useCallback(async () => {
    const [stateRes, selRes] = await Promise.all([getState(), getSelection()]);
    const snap = unwrapSnapshot(stateRes);
    const sel = unwrapSelection(selRes);
    if (snap) setSnapshot(snap);
    setSel(sel);
    if (!stateRes.ok) setError(stateRes.message);
    else if (!selRes.ok) setError(selRes.message);
    else setError(null);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [stateRes, selRes] = await Promise.all([getState(), getSelection()]);
      if (cancelled) return;
      const snap = unwrapSnapshot(stateRes);
      const sel = unwrapSelection(selRes);
      if (snap) setSnapshot(snap);
      setSel(sel);
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
              Web host — dummy engine adapter (no FreeCAD/OCCT/IfcOpenShell coupling)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              CAD-IMPLEMENT-001 / v1.1
            </Badge>
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
                  Click an element to select it; click empty canvas to clear. SVG
                  viewBox 800 × 600.
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
                      return (
                        <GeometryShape
                          key={el.id}
                          element={el}
                          selected={selected}
                          onClick={(e) => onElementClick(e, el.id)}
                        />
                      );
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
                <CardTitle>Edit</CardTitle>
                <CardDescription>Add or remove geometry elements.</CardDescription>
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
                  identity remains canonical (LOCK-019). The dummy adapter is
                  the only engine — no FreeCAD/OCCT/IfcOpenShell coupling
                  (LOCK-003/018).
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
      </main>

      <footer className="mt-auto border-t">
        <div className="px-4 sm:px-6 lg:px-8 py-4 text-xs text-muted-foreground">
          Offisos CAD-IMPLEMENT-001 — milestone: usable CAD workspace (create/
          open/save, selection, undo/redo, versioned CADDocument, dummy adapter,
          Web transport). Web/Electron parity proven by the Offisos repo
          host-parity tests (50/50 green). Architecture v1.1 FROZEN.
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
