/**
 * Shared renderer UI — Electron host surface (CAD-IMPLEMENT-001 / Issue #24
 * remediation, Architecture v1.1 FROZEN).
 *
 * Browser-pure. Imports ONLY type-only contracts from
 * `@offisos/cad-app-shell/contracts/*` (erased at build — no runtime node:crypto
 * dependency in the renderer bundle). Talks to the App API ONLY through
 * the native IPC bridge `window.cad.send` (exposed by the preload contextBridge),
 * exactly as the Web host (`apps/web/src/app/page.tsx`) talks ONLY through
 * `fetch("/api/cad")`. Same v1 wire contract; transport independence (§5.5).
 *
 * The workspace semantics mirror the Web host: SVG canvas + New / Add box /
 * Add circle / Delete / Undo / Redo / Save, with the versioned CADDocument
 * panel. CADDocument is the editor representation, NOT the Construction Graph
 * (LOCK-019). The dummy adapter is the only engine (LOCK-003/018).
 */

import type {
  CADDocumentSnapshot,
  Element as CDElement,
  VersionMeta,
} from "@offisos/cad-app-shell/contracts/caddocument";
import type { Command, CommandQueryResponse, Query } from "@offisos/cad-app-shell/contracts/app-api";

interface ShapeProps {
  shape: "box" | "circle";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
}

function isGeometryElement(el: CDElement): boolean {
  // CAD-IMPLEMENT-002: real-engine geometry elements carry a meshToken;
  // legacy dummy shapes carry the flat shape/x/y/w/h props. Both render.
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

function truncate(s: string, n = 18): string {
  return s.length > n ? `${s.slice(0, n)}\u2026` : s;
}

function rnd(max: number): number {
  return Math.floor(Math.random() * max);
}

// --- Transport: native IPC bridge (window.cad) ----------------------------

async function send(req: Command | Query): Promise<CommandQueryResponse> {
  const res = await window.cad.send(req);
  return res as CommandQueryResponse;
}

function command(name: Command["name"], payload: unknown): Promise<CommandQueryResponse> {
  return send({ type: "command", name, payload });
}
function query(name: Query["name"], payload: unknown = {}): Promise<CommandQueryResponse> {
  return send({ type: "query", name, payload });
}

function unwrapSnapshot(res: CommandQueryResponse): CADDocumentSnapshot | null {
  if (!res.ok) return null;
  const value = res.value;
  if (value && typeof value === "object" && "snapshot" in value) {
    return ((value as { snapshot: unknown }).snapshot ?? null) as CADDocumentSnapshot | null;
  }
  return (value ?? null) as CADDocumentSnapshot | null;
}

function unwrapSelection(res: CommandQueryResponse): string[] {
  if (!res.ok) return [];
  const value = res.value;
  if (Array.isArray(value)) return value as string[];
  if (value && typeof value === "object" && "selection" in value) {
    const s = (value as { selection: unknown }).selection;
    if (Array.isArray(s)) return s as string[];
  }
  return [];
}

function unwrapSaveBytes(res: CommandQueryResponse): { bytes: number[]; format: string } | null {
  if (!res.ok) return null;
  const value = res.value;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { bytes?: unknown }).bytes) &&
    typeof (value as { format?: unknown }).format === "string"
  ) {
    return value as unknown as { bytes: number[]; format: string };
  }
  return null;
}

// --- App state -------------------------------------------------------------

interface CachedMesh {
  vertices: number[];
  indices: number[];
  bbox: number[];
}

const state = {
  snapshot: null as CADDocumentSnapshot | null,
  selection: [] as string[],
  loading: true,
  busy: false,
  error: null as string | null,
  engine: null as { engineId: string; engineVersion: string } | null,
  meshes: new Map<string, CachedMesh>(),
};

// --- DOM helpers ----------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function svgNs(tag: string): SVGElement {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

interface Shell {
  canvasSvg: SVGSVGElement;
  selList: HTMLElement;
  lineageEl: HTMLUListElement;
  errorEl: HTMLDivElement;
  undoBtn: HTMLButtonElement;
  redoBtn: HTMLButtonElement;
  delBtn: HTMLButtonElement;
  ddEid: HTMLElement;
  ddVid: HTMLElement;
  ddVn: HTMLElement;
  ddCun: HTMLElement;
  ddCred: HTMLElement;
  ddCd: HTMLElement;
  ddFmt: HTMLElement;
  ddFv: HTMLElement;
}

function buildShell(root: HTMLElement): Shell {
  root.replaceChildren();

  const header = el("header");
  const hWrap = el("div");
  const h1 = el("h1"); h1.textContent = "Offisos CAD Workspace";
  const hp = el("p"); hp.textContent = "Electron host — real OCCT geometry engine behind the frozen adapter boundary";
  hWrap.append(h1, hp);
  const badge = el("span", "badge"); badge.textContent = "CAD-IMPLEMENT-002 / v1.1";
  const engineBadge = el("span", "badge"); engineBadge.id = "engine-badge"; engineBadge.style.display = "none";
  header.append(hWrap, badge, engineBadge);
  root.append(header);

  const main = el("main");

  // Canvas card
  const canvasCard = el("div", "card");
  const ccH = el("header", "card-h"); const ccH2 = el("h2"); ccH2.textContent = "Canvas"; const ccP = el("p"); ccP.textContent = "Click an element to select; click empty canvas to clear. SVG viewBox 800 × 600.";
  ccH.append(ccH2, ccP); canvasCard.append(ccH);
  const ccBody = el("div", "card-c");
  const svg = svgNs("svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 800 600");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "CAD canvas");
  ccBody.append(svg);
  canvasCard.append(ccBody);

  // Controls nav
  const nav = el("nav"); nav.style.display = "flex"; nav.style.flexDirection = "column"; nav.style.gap = "16px";

  const fileCard = card("File", "Create, open, or save the document.");
  const fileBody = el("div", "card-c"); const fileCtrls = el("div", "controls");
  const bNew = btn("primary", "New", "+"); const bSave = btn("", "Save", "v");
  fileCtrls.append(bNew, bSave); fileBody.append(fileCtrls); fileCard.append(fileBody);

  const occtCard = card("Real geometry (OCCT)", "Prepare real engine geometry (deterministic boxes, cylinders, booleans) through the shared App API — geometry.prepare -> applyEdit. Requires the pinned toolchain (python3 + cadquery-ocp); failures are typed.");
  const occtBody = el("div", "card-c"); const occtCtrls = el("div", "controls");
  const bOcctBox = btn("primary", "Box (OCCT)", "B"); const bOcctCyl = btn("primary", "Cylinder (OCCT)", "C"); const bOcctFuse = btn("primary", "Fuse (OCCT)", "F");
  occtCtrls.append(bOcctBox, bOcctCyl, bOcctFuse); occtBody.append(occtCtrls); occtCard.append(occtBody);

  const editCard = card("Edit", "Add or remove geometry elements (dummy shapes).");
  const editBody = el("div", "card-c"); const editCtrls = el("div", "controls");
  const bBox = btn("primary", "Add Box", "#"); const bCircle = btn("primary", "Add Circle", "o"); const bDel = btn("danger", "Delete", "x");
  editCtrls.append(bBox, bCircle, bDel); editBody.append(editCtrls); editCard.append(editBody);

  const histCard = card("History", "Undo / redo the last edit.");
  const histBody = el("div", "card-c"); const histCtrls = el("div", "controls");
  const bUndo = btn("", "Undo", "<"); const bRedo = btn("", "Redo", ">");
  histCtrls.append(bUndo, bRedo); histBody.append(histCtrls); histCard.append(histBody);

  const selCard = card("Selection", "Nothing selected.");
  const selBody = el("div", "card-c"); const selList = el("div", "selection"); selBody.append(selList); selCard.append(selBody);

  const verCard = card("Version", "Versioned CADDocument — deterministic content-hash derivative.");
  const verBody = el("div", "card-c");
  const dl = el("dl");
  function dlRow(k: string): { dt: HTMLElement; dd: HTMLElement } {
    const dt = el("dt"); dt.textContent = k; const dd = el("dd"); dl.append(dt, dd); return { dt, dd };
  }
  const rEid = dlRow("entity_id"); const rVid = dlRow("version_id"); const rVn = dlRow("version_number");
  const rCun = dlRow("canUndo"); const rCred = dlRow("canRedo"); const rCd = dlRow("commandDepth");
  const rFmt = dlRow("format"); const rFv = dlRow("formatVersion");
  verBody.append(dl);
  const verSep = el("hr"); verSep.style.border = "0"; verSep.style.borderTop = "1px solid var(--border)"; verSep.style.margin = "10px 0";
  const linHead = el("p"); linHead.style.fontWeight = "600"; linHead.style.color = "var(--fg)"; linHead.textContent = "Source artifact lineage";
  const lineageEl = el("ul", "lineage");
  verBody.append(verSep, linHead, lineageEl);
  const verSep2 = el("hr"); verSep2.style.border = "0"; verSep2.style.borderTop = "1px solid var(--border)"; verSep2.style.margin = "10px 0";
  const note = el("p"); note.style.fontSize = "11px"; note.style.color = "var(--muted)"; note.style.lineHeight = "1.5";
  note.textContent = "CADDocument is the editor representation. Construction Graph identity remains canonical (LOCK-019). The real OCCT engine lives strictly behind the EngineAdapterBundle boundary; the renderer/CADDocument/App API import no engine (LOCK-003/018).";
  verBody.append(verSep2, note);
  verCard.append(verBody);

  const errorEl = el("div", "alert"); errorEl.style.display = "none";
  nav.append(fileCard, occtCard, editCard, histCard, selCard, verCard, errorEl);

  main.append(canvasCard, nav);
  root.append(main);

  const footer = el("footer");
  footer.textContent = "Offisos CAD-IMPLEMENT-002 — Electron host (real BrowserWindow + native IPC + shared renderer + App API + real OCCT adapter behind the frozen boundary). Web/Electron parity proven by app/test/geometry-prepare.test.ts. Architecture v1.1 FROZEN.";
  root.append(footer);

  // wire handlers
  bNew.addEventListener("click", () => void run("New", () => command("document.create", {})));
  bSave.addEventListener("click", () => void onSave());
  bOcctBox.addEventListener("click", () => void onAddRealGeometry("Box (OCCT)", { shape: "box", width: 120, depth: 90, height: 70 }));
  bOcctCyl.addEventListener("click", () => void onAddRealGeometry("Cylinder (OCCT)", { shape: "cylinder", radius: 45, height: 110 }));
  bOcctFuse.addEventListener("click", () => void onAddRealGeometry("Fuse (OCCT)", { shape: "fuse", a: { shape: "box", width: 140, depth: 100, height: 60 }, b: { shape: "cylinder", radius: 40, height: 90, origin: [70, 50, 0], direction: [0, 0, 1] } }));
  bBox.addEventListener("click", () => void onAdd("box", "#f97316", "#9a3412"));
  bCircle.addEventListener("click", () => void onAdd("circle", "#10b981", "#065f46"));
  bDel.addEventListener("click", () => void onDelete());
  bUndo.addEventListener("click", () => void run("Undo", () => command("document.undo", {})));
  bRedo.addEventListener("click", () => void run("Redo", () => command("document.redo", {})));
  svg.addEventListener("click", () => {
    if (state.selection.length === 0) return;
    void run("Clear selection", () => command("document.setSelection", { ids: [] }));
  });

  return {
    canvasSvg: svg,
    selList,
    lineageEl,
    errorEl,
    undoBtn: bUndo,
    redoBtn: bRedo,
    delBtn: bDel,
    ddEid: rEid.dd,
    ddVid: rVid.dd,
    ddVn: rVn.dd,
    ddCun: rCun.dd,
    ddCred: rCred.dd,
    ddCd: rCd.dd,
    ddFmt: rFmt.dd,
    ddFv: rFv.dd,
  };
}

function card(title: string, desc: string): HTMLElement {
  const c = el("div", "card");
  const h = el("header", "card-h"); const h2 = el("h2"); h2.textContent = title; const p = el("p"); p.textContent = desc;
  h.append(h2, p); c.append(h); return c;
}

function btn(variant: string, label: string, glyph: string): HTMLButtonElement {
  const b = el("button");
  if (variant === "primary") b.className = "primary";
  else if (variant === "danger") b.className = "danger";
  const g = el("span"); g.textContent = glyph; g.setAttribute("aria-hidden", "true"); g.style.fontWeight = "700";
  const s = el("span"); s.textContent = label;
  b.append(g, s);
  return b;
}

// --- Actions --------------------------------------------------------------

async function run(label: string, fn: () => Promise<CommandQueryResponse>): Promise<void> {
  setBusy(true);
  try {
    const res = await fn();
    if (!res.ok) setError(`[${label}] ${res.code}: ${res.message}`);
    else setError(null);
    await refresh();
  } catch (e) {
    setError(`[${label}] unexpected: ${(e as Error).message}`);
    await refresh();
  } finally {
    setBusy(false);
  }
}

async function onAdd(shape: "box" | "circle", fill: string, stroke: string): Promise<void> {
  const id = crypto.randomUUID();
  void run(`Add ${shape}`, () =>
    command("document.applyEdit", {
      edit: {
        type: "addElement",
        element: {
          id,
          kind: "geometry",
          engineId: null,
          props: { shape, x: 60 + rnd(600), y: 60 + rnd(400), w: 80, h: 60, fill, stroke },
        },
      },
    }),
  );
}

// --- CAD-IMPLEMENT-002: real geometry through the shared App API ----------

interface PreparedGeometry {
  meshToken: string;
  bbox: number[];
  mesh: { vertices: number[]; indices: number[] } | null;
  metadata: { volume: number; vertices: number; triangles: number } | null;
  engine: { engineId: string; engineVersion: string };
}

function unwrapPrepared(res: CommandQueryResponse): PreparedGeometry | null {
  if (!res.ok) return null;
  const v = res.value as Partial<PreparedGeometry> | null;
  if (typeof v !== "object" || v === null || typeof v.meshToken !== "string" || !Array.isArray(v.bbox)) {
    return null;
  }
  return v as PreparedGeometry;
}

/** Prepare a real geometry descriptor through the OCCT adapter (geometry.prepare
 *  -> deterministic meshToken), cache the viewport mesh, and persist the element
 *  via the EXISTING applyEdit(addElement) workflow. */
async function onAddRealGeometry(label: string, geometry: Record<string, unknown>): Promise<void> {
  setBusy(true);
  try {
    const res = await command("geometry.prepare", { geometry });
    const prepared = unwrapPrepared(res);
    if (!prepared) {
      setError(res.ok ? `[${label}] unexpected response shape` : `[${label}] ${res.code}: ${res.message}`);
      await refresh();
      return;
    }
    state.engine = prepared.engine;
    if (prepared.mesh !== null) {
      state.meshes.set(prepared.meshToken, { vertices: [...prepared.mesh.vertices], indices: [...prepared.mesh.indices], bbox: [...prepared.bbox] });
    }
    const addRes = await command("document.applyEdit", {
      edit: {
        type: "addElement",
        element: {
          id: crypto.randomUUID(),
          kind: "geometry",
          engineId: prepared.engine.engineId,
          props: { geometry, meshToken: prepared.meshToken, bbox: [...prepared.bbox] },
        },
      },
    });
    if (!addRes.ok) setError(`[${label}] ${addRes.code}: ${addRes.message}`);
    else setError(null);
    await refresh();
  } catch (e) {
    setError(`[${label}] unexpected: ${(e as Error).message}`);
    await refresh();
  } finally {
    setBusy(false);
  }
}

/** Re-hydrate viewport meshes for persisted real-geometry elements
 *  (deterministic: re-preparing returns the identical meshToken). */
async function hydrateMeshes(): Promise<void> {
  const snap = state.snapshot;
  if (!snap) return;
  for (const e of snap.elements) {
    if (e.kind !== "geometry") continue;
    const props = e.props as Record<string, unknown>;
    const token = typeof props.meshToken === "string" ? props.meshToken : null;
    if (token === null || state.meshes.has(token) || typeof props.geometry !== "object") continue;
    const res = await command("geometry.prepare", { geometry: props.geometry });
    const prepared = unwrapPrepared(res);
    if (prepared && prepared.meshToken === token && prepared.mesh !== null) {
      state.engine = prepared.engine;
      state.meshes.set(token, { vertices: [...prepared.mesh.vertices], indices: [...prepared.mesh.indices], bbox: [...prepared.bbox] });
    }
  }
}

async function onDelete(): Promise<void> {
  if (state.selection.length === 0) return;
  setBusy(true);
  try {
    for (const id of state.selection) {
      await command("document.applyEdit", { edit: { type: "removeElement", elementId: id } });
    }
    await command("document.setSelection", { ids: [] });
    await refresh();
  } catch (e) {
    setError(`[Delete] unexpected: ${(e as Error).message}`);
    await refresh();
  } finally {
    setBusy(false);
  }
}

async function onSave(): Promise<void> {
  setBusy(true);
  try {
    const res = await command("document.save", {});
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
    // In the sandboxed Electron renderer (no direct FS), route the save
    // through a Blob download — the same UX as the Web host's Save.
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
}

// --- Refresh --------------------------------------------------------------

let ui: Shell | null = null;

async function refresh(): Promise<void> {
  const [stateRes, selRes] = await Promise.all([query("document.getState", {}), query("document.getSelection", {})]);
  const snap = unwrapSnapshot(stateRes);
  const sel = unwrapSelection(selRes);
  if (snap) state.snapshot = snap;
  state.selection = sel;
  if (!stateRes.ok) setError(stateRes.message);
  else if (!selRes.ok) setError(selRes.message);
  render();
}

/** Isometric model viewport (host-surface presentation only): projects the
 *  real engine's tessellated mesh onto the SVG canvas with painter-sorted,
 *  flat-shaded triangles. The shared renderer core (LOCK-017) still consumes
 *  just meshToken + transform for the deterministic scene hash. */
function buildMeshViewport(mesh: CachedMesh, selected: boolean, onSelect: () => void): SVGElement {
  const [xmin = 0, ymin = 0, zmin = 0, xmax = 1, ymax = 1, zmax = 1] = mesh.bbox;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const cz = (zmin + zmax) / 2;
  const extent = Math.max(xmax - xmin, ymax - ymin, zmax - zmin, 1);
  const scale = (0.7 * 520) / extent;
  const originX = 400 + ((cx * 31 - cy * 17) % 40);
  const originY = 300;
  const project = (x: number, y: number, z: number): [number, number] => [
    originX + (x - cx - (y - cy)) * 0.866 * scale,
    originY + (x - cx + (y - cy)) * 0.5 * scale - (z - cz) * scale,
  ];
  const verts = mesh.vertices;
  const tris: { pts: string; depth: number; light: number }[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]! * 3;
    const ib = mesh.indices[t + 1]! * 3;
    const ic = mesh.indices[t + 2]! * 3;
    const ax = verts[ia]!, ay = verts[ia + 1]!, az = verts[ia + 2]!;
    const bx = verts[ib]!, by = verts[ib + 1]!, bz = verts[ib + 2]!;
    const cxv = verts[ic]!, cyv = verts[ic + 1]!, czv = verts[ic + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const norm = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const light = Math.max(0.18, (nx / norm) * 0.42 + (ny / norm) * -0.28 + (nz / norm) * 0.86);
    const pa = project(ax, ay, az);
    const pb = project(bx, by, bz);
    const pc = project(cxv, cyv, czv);
    tris.push({
      pts: `${pa[0].toFixed(1)},${pa[1].toFixed(1)} ${pb[0].toFixed(1)},${pb[1].toFixed(1)} ${pc[0].toFixed(1)},${pc[1].toFixed(1)}`,
      depth: (ax + bx + cxv) / 3 + (ay + by + cyv) / 3 + (az + bz + czv) / 3,
      light,
    });
  }
  tris.sort((a, b) => b.depth - a.depth);
  const g = svgNs("g");
  g.setAttribute("role", "button");
  g.setAttribute("aria-label", "Select real geometry element");
  g.style.cursor = "pointer";
  for (const t of tris) {
    const p = svgNs("polygon");
    p.setAttribute("points", t.pts);
    p.setAttribute("fill", `rgb(${Math.round(20 + (200 - 20) * t.light)},${Math.round(120 + (230 - 120) * t.light)},${Math.round(110 + (220 - 110) * t.light)})`);
    p.setAttribute("stroke", `rgba(6,78,59,${selected ? "0.9" : "0.35"})`);
    p.setAttribute("stroke-width", selected ? "1.2" : "0.5");
    g.append(p);
  }
  g.addEventListener("click", (ev: MouseEvent) => {
    ev.stopPropagation();
    onSelect();
  });
  return g;
}

function render(): void {
  if (!ui) return;
  const snap = state.snapshot;
  const version: VersionMeta | null = snap?.version ?? null;
  const editorState = snap?.editorState;
  const canUndo = editorState?.canUndo ?? false;
  const canRedo = editorState?.canRedo ?? false;
  const commandDepth = editorState?.commandDepth ?? 0;
  const elements: CDElement[] = snap?.elements ? [...snap.elements] : [];
  const format = snap?.format ?? "—";
  const formatVersion = snap?.formatVersion ?? "—";
  const lineage = snap?.sourceArtifactLineage ?? [];

  // canvas
  const svg = ui.canvasSvg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  // grid lines
  for (let x = 50; x < 800; x += 50) {
    const l = svgNs("line");
    l.setAttribute("x1", String(x)); l.setAttribute("y1", "0"); l.setAttribute("x2", String(x)); l.setAttribute("y2", "600");
    l.setAttribute("stroke", "#e2e8f0"); l.setAttribute("stroke-width", "1");
    svg.append(l);
  }
  for (let y = 50; y < 600; y += 50) {
    const l = svgNs("line");
    l.setAttribute("x1", "0"); l.setAttribute("y1", String(y)); l.setAttribute("x2", "800"); l.setAttribute("y2", String(y));
    l.setAttribute("stroke", "#e2e8f0"); l.setAttribute("stroke-width", "1");
    svg.append(l);
  }
  for (const e of elements) {
    if (!isGeometryElement(e)) continue;
    const selected = state.selection.includes(e.id);
    // Real engine geometry: isometric model viewport of the cached mesh.
    const token = typeof e.props.meshToken === "string" ? e.props.meshToken : null;
    const cached = token !== null ? state.meshes.get(token) : undefined;
    if (cached !== undefined) {
      svg.append(buildMeshViewport(cached, selected, () => {
        void run("Select", () => command("document.setSelection", { ids: [e.id] }));
      }));
      continue;
    }
    const { shape, x, y, w, h, fill, stroke } = e.props as unknown as {
      shape: "box" | "circle"; x: number; y: number; w: number; h: number; fill: string; stroke: string;
    };
    const g = svgNs("g");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", `Select element ${e.id}`);
    g.style.cursor = "pointer";
    const node = shape === "box" ? svgNs("rect") : svgNs("circle");
    if (shape === "box") {
      node.setAttribute("x", String(x)); node.setAttribute("y", String(y));
      node.setAttribute("width", String(w)); node.setAttribute("height", String(h));
    } else {
      node.setAttribute("cx", String(x + w / 2)); node.setAttribute("cy", String(y + h / 2));
      node.setAttribute("r", String(Math.min(w, h) / 2));
    }
    node.setAttribute("fill", fill); node.setAttribute("stroke", stroke);
    node.setAttribute("stroke-width", selected ? "4" : "2");
    g.append(node);
    if (selected) {
      const sel = svgNs("rect");
      sel.setAttribute("x", String(x - 6)); sel.setAttribute("y", String(y - 6));
      sel.setAttribute("width", String(w + 12)); sel.setAttribute("height", String(h + 12));
      sel.setAttribute("fill", "none"); sel.setAttribute("stroke", "currentColor");
      sel.setAttribute("stroke-width", "1.5"); sel.setAttribute("stroke-dasharray", "6,4");
      sel.style.pointerEvents = "none";
      g.append(sel);
    }
    const title = svgNs("title");
    title.textContent = `${shape} ${e.id}`;
    g.append(title);
    g.addEventListener("click", (ev: MouseEvent) => {
      ev.stopPropagation();
      void run("Select", () => command("document.setSelection", { ids: [e.id] }));
    });
    svg.append(g);
  }
  if (elements.length === 0) {
    const t = svgNs("text");
    t.setAttribute("x", "400"); t.setAttribute("y", "300"); t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", "#94a3b8"); t.style.fontSize = "18px";
    t.textContent = "empty document — add a shape to begin";
    svg.append(t);
  }

  // selection badges
  ui.selList.replaceChildren();
  if (state.selection.length === 0) {
    const p = el("p"); p.style.fontSize = "13px"; p.style.color = "var(--muted)"; p.textContent = "—";
    ui.selList.append(p);
  } else {
    for (const id of state.selection) {
      const b = el("span", "sel-badge"); b.textContent = truncate(id, 14);
      ui.selList.append(b);
    }
  }

  // version fields
  ui.ddEid.textContent = version ? truncate(version.entity_id, 24) : "—";
  ui.ddVid.textContent = version ? truncate(version.version_id, 32) : "—";
  ui.ddVn.textContent = version ? String(version.version_number) : "—";
  ui.ddCun.textContent = String(canUndo);
  ui.ddCred.textContent = String(canRedo);
  ui.ddCd.textContent = String(commandDepth);
  ui.ddFmt.textContent = format;
  ui.ddFv.textContent = formatVersion;

  // lineage
  ui.lineageEl.replaceChildren();
  if (lineage.length === 0) {
    const li = el("li"); li.textContent = "—"; ui.lineageEl.append(li);
  } else {
    for (const l of lineage) {
      const li = el("li"); li.textContent = truncate(l, 48); ui.lineageEl.append(li);
    }
  }

  // engine badge
  const engineBadge = document.getElementById("engine-badge");
  if (engineBadge) {
    if (state.engine) {
      engineBadge.style.display = "inline-block";
      engineBadge.textContent = `${state.engine.engineId} ${state.engine.engineVersion}`;
    } else {
      engineBadge.style.display = "none";
    }
  }

  // buttons
  ui.undoBtn.disabled = state.busy || state.loading || !canUndo;
  ui.redoBtn.disabled = state.busy || state.loading || !canRedo;
  ui.delBtn.disabled = state.busy || state.loading || state.selection.length === 0;
}

function setBusy(b: boolean): void {
  state.busy = b;
  render();
}

function setError(msg: string | null): void {
  state.error = msg;
  if (!ui) return;
  if (msg) {
    ui.errorEl.style.display = "block";
    ui.errorEl.textContent = msg;
  } else {
    ui.errorEl.style.display = "none";
    ui.errorEl.textContent = "";
  }
}

// --- Boot ------------------------------------------------------------------

function main(): void {
  const root = document.getElementById("app");
  if (!root) return;
  ui = buildShell(root);
  void (async () => {
    state.loading = true;
    render();
    await refresh();
    await hydrateMeshes();
    state.loading = false;
    render();
  })();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => main());
} else {
  main();
}
