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
 *
 * COMPAT-CAD-002 / Issue #39 (additive): a BIM authoring MODE sits alongside
 * the drafting surface (header toggle — drafting behavior is untouched). The
 * BIM panel authors the representative mini building through bim.* commands,
 * moves the hosted door opening along its wall, switches the standard camera
 * presets, realizes solids through bim.buildGeometry (the OCCT worker behind
 * the frozen adapter boundary — a multi-second engine call with a busy state),
 * undoes/redoes, proves save/open graph-events identity, and selects BIM
 * elements from the building tree. Everything crosses the App API ONLY via
 * window.cad.send — no bim/* module is imported into the renderer (queries
 * only, nothing computed client-side).
 *
 * COMPAT-CAD-003 / Issue #41 (additive): a Construction documentation MODE
 * completes the toggle (drafting + BIM behavior untouched). The docs panel
 * seeds the representative building + plan/elevation/section/detail views,
 * parametric dimensions + tags bound to canonical element ids, an A1 sheet
 * with title block, regenerates deterministically, exports the canonical
 * Sheet IR (PDF/DWG writers are typed docs_unsupported rejects), and proves
 * undo/redo + save/open identity. Everything crosses the App API ONLY via
 * window.cad.send — no docs/* module is imported into the renderer; the
 * projection is pure deterministic TS inside the core (engine-free).
 */

import type {
  CADDocumentSnapshot,
  Element as CDElement,
  VersionMeta,
} from "@offisos/cad-app-shell/contracts/caddocument";
import type {
  GraphBridgeResult,
  ModelHistory,
  ModelReplayResult,
} from "@offisos/cad-app-shell/contracts/model";
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

// COMPAT-CAD-002: structural shapes of the bim.* query responses (type-only —
// no app-core module is imported; the wire values come from window.cad.send).
interface BimRecord {
  elementId: string;
  type: string;
  semantics: Record<string, unknown>;
}
interface BimBuilding {
  stories: {
    story: BimRecord;
    walls: (BimRecord & { openings: (BimRecord & { fills: BimRecord[] })[] })[];
    slabs: BimRecord[];
    spaces: BimRecord[];
  }[];
  bimSettings?: { camera?: { preset?: string } };
}

// COMPAT-CAD-003: structural shapes of the docs.* query responses (type-only —
// no app-core module is imported; the wire values come from window.cad.send).
interface DocsViewListItem {
  view: { id: string; kind: string; title: string; direction?: string; storyId?: string };
  contentHash: string | null;
  primitiveCount: number;
  skipCount: number;
  error: string | null;
}
interface DocsViewGeometry {
  view: { id: string; kind: string; title: string };
  primitiveCount: number;
  contentHash: string;
  bbox: { uMin: number; uMax: number; vMin: number; vMax: number } | null;
  annotations: { id: string; type: string; [k: string]: unknown }[];
}
interface DocsSheetListItem {
  id: string;
  title: string;
  titleBlock: { projectName: string; sheetTitle: string; sheetNumber: string };
  viewPlacements: { viewId: string }[];
}

type WorkspaceMode = "drafting" | "bim" | "docs";

const state = {
  snapshot: null as CADDocumentSnapshot | null,
  selection: [] as string[],
  loading: true,
  busy: false,
  error: null as string | null,
  engine: null as { engineId: string; engineVersion: string } | null,
  meshes: new Map<string, CachedMesh>(),
  // CAD-IMPLEMENT-003: immutable model revisions + graph-facing events.
  history: null as ModelHistory | null,
  graphEvents: null as GraphBridgeResult | null,
  replay: null as ModelReplayResult | null,
  // COMPAT-CAD-002: BIM authoring mode (toggle alongside the drafting surface).
  mode: "drafting" as WorkspaceMode,
  bimBuilding: null as BimBuilding | null,
  // COMPAT-CAD-003: construction documentation mode (third toggle position).
  docsViews: [] as DocsViewListItem[],
  docsSheets: [] as DocsSheetListItem[],
  docsSelectedView: null as string | null,
  docsRunCount: 0,
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
  // COMPAT-CAD-002: mode toggle + BIM authoring panel.
  modeDraftBtn: HTMLButtonElement;
  modeBimBtn: HTMLButtonElement;
  bimCard: HTMLElement;
  bimStatus: HTMLElement;
  bimCreated: HTMLElement;
  bimMoveDx: HTMLInputElement;
  bimMoveDy: HTMLInputElement;
  bimMoveDz: HTMLInputElement;
  bimMoveBtn: HTMLButtonElement;
  bimCameraBtns: Map<string, HTMLButtonElement>;
  bimBuildBtn: HTMLButtonElement;
  bimBuildBusy: HTMLElement;
  bimUndoBtn: HTMLButtonElement;
  bimRedoBtn: HTMLButtonElement;
  bimSaveOpenBtn: HTMLButtonElement;
  bimCameraReadout: HTMLElement;
  bimBuildResult: HTMLElement;
  bimPersistResult: HTMLElement;
  bimSummary: HTMLElement;
  bimTree: HTMLElement;
  // COMPAT-CAD-003: mode toggle + construction documentation panel.
  modeDocsBtn: HTMLButtonElement;
  docsCard: HTMLElement;
  docsStatus: HTMLElement;
  docsSeedResult: HTMLElement;
  docsViewKind: HTMLSelectElement;
  docsViewStory: HTMLInputElement;
  docsViewDirection: HTMLSelectElement;
  docsViewAxis: HTMLSelectElement;
  docsViewOffset: HTMLInputElement;
  docsCreateViewBtn: HTMLButtonElement;
  docsListViewsBtn: HTMLButtonElement;
  docsViewList: HTMLElement;
  docsGetGeometryBtn: HTMLButtonElement;
  docsGeometryReadout: HTMLElement;
  docsRegenerateBtn: HTMLButtonElement;
  docsRegenReadout: HTMLElement;
  docsCreateSheetBtn: HTMLButtonElement;
  docsListSheetsBtn: HTMLButtonElement;
  docsSheetList: HTMLElement;
  docsExportBtn: HTMLButtonElement;
  docsExportReadout: HTMLElement;
  docsExportPdfBtn: HTMLButtonElement;
  docsUndoBtn: HTMLButtonElement;
  docsRedoBtn: HTMLButtonElement;
  docsSaveOpenBtn: HTMLButtonElement;
  docsPersistResult: HTMLElement;
  ddEid: HTMLElement;
  ddVid: HTMLElement;
  ddVn: HTMLElement;
  ddCun: HTMLElement;
  ddCred: HTMLElement;
  ddCd: HTMLElement;
  ddFmt: HTMLElement;
  ddFv: HTMLElement;
  revList: HTMLElement;
  replayEl: HTMLDivElement;
  eventsEl: HTMLDivElement;
  revSummary: HTMLElement;
}

/** The representative mini building (COMPAT-CAD-002, Issue #39). One ground
 *  story, the south wall carrying a door opening + door fill, the ground slab
 *  and the L-shaped office space. The slab mirrors the representative-building
 *  test precedent (app/test/bim-workflow.test.ts) so the model carries FIVE
 *  solid-bearing elements — bim.buildGeometry builds ≥ 5 and skips exactly the
 *  story (the level container) — while every entity from the work-item spec is
 *  present. Same-batch references use explicit ids. */
const MINI_BUILDING_ENTITIES: readonly Record<string, unknown>[] = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
  { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left", name: "Main entrance" },
  { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 6300], thickness: 200, baseOffset: -200 },
  { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
];

/** The documentation representative building (COMPAT-CAD-003, Issue #41).
 *  Same canonical ids as the BIM card's mini building where they overlap
 *  (story-gf, wall-south, op-door/door-main, slab-g, space-office) extended to
 *  the full four-wall envelope + facade window the documentation workflow
 *  projects (the app/test/docs-workflow.test.ts precedent): the plan view
 *  needs wall-north for the overall dimension and op-win/win-1 for the window
 *  symbol — 17 plan primitives, overall dim 5300, tag "Office 1 (27.00 m²)".
 *  One atomic bim.createElements batch (one revision, one undo). */
const DOCS_BUILDING_ENTITIES: readonly Record<string, unknown>[] = [
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

/** The seeded documentation set: plan + front elevation + section + door
 *  detail, the overall wall dimension + the office tag, and the A-101 sheet
 *  (placements inside the drawable region [0,641]×[0,594], non-overlapping).
 *  Minted ids on a fresh document: vw-000001..vw-000004, sh-000001. */
const DOCS_SEED_VIEWS: readonly Record<string, unknown>[] = [
  { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
  { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
  { kind: "section", title: "Section A-A", sectionAxis: "y", sectionOffset: 2500, scale: 50 },
  { kind: "detail", title: "Door Detail 1", sourceViewId: "vw-000001", region: { x: 300, y: -300, w: 1400, h: 600 }, detailScale: 2 },
];
const DOCS_SEED_ANNOTATIONS: readonly Record<string, unknown>[] = [
  { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall", offset: -1000 },
  { type: "docs.tag", viewId: "vw-000001", targetId: "space-office" },
];
const DOCS_SEED_SHEET: Record<string, unknown> = {
  title: "Ground Floor Documentation",
  titleBlock: { projectName: "Offisos Demo", sheetTitle: "Ground Floor", sheetNumber: "A-101", author: "Z.ai", date: "2026-08-27" },
  viewPlacements: [
    { viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 },
    { viewId: "vw-000002", x: 320, y: 10, w: 300, h: 280 },
  ],
};
/** The UI-created second sheet (A-102): section + detail — the two views the
 *  seed sheet does not place. Fixed date keeps the Sheet IR deterministic. */
const DOCS_UI_SHEET: Record<string, unknown> = {
  title: "Sections & Details",
  titleBlock: { projectName: "Offisos Demo", sheetTitle: "Sections & Details", sheetNumber: "A-102", author: "Z.ai", date: "2026-08-27" },
  viewPlacements: [
    { viewId: "vw-000003", x: 10, y: 10, w: 300, h: 280 },
    { viewId: "vw-000004", x: 320, y: 10, w: 300, h: 280 },
  ],
};

function buildShell(root: HTMLElement): Shell {
  root.replaceChildren();

  const header = el("header");
  const hWrap = el("div");
  const h1 = el("h1"); h1.textContent = "Offisos CAD Workspace";
  const hp = el("p"); hp.textContent = "Electron host — real OCCT geometry engine behind the frozen adapter boundary";
  hWrap.append(h1, hp);
  const badge = el("span", "badge"); badge.textContent = "CAD-IMPLEMENT-003 / v1.1";
  const engineBadge = el("span", "badge"); engineBadge.id = "engine-badge"; engineBadge.style.display = "none";
  // COMPAT-CAD-002: mode toggle — drafting surface (default, unchanged) | BIM.
  const modeWrap = el("div");
  modeWrap.style.cssText = "display:inline-flex;gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;";
  const modeDraftBtn = el("button");
  modeDraftBtn.type = "button"; modeDraftBtn.textContent = "Drafting";
  modeDraftBtn.setAttribute("data-testid", "mode-drafting");
  modeDraftBtn.setAttribute("aria-pressed", "true");
  modeDraftBtn.style.cssText = "min-height:32px;border:0;border-radius:0;font-size:12px;";
  const modeBimBtn = el("button");
  modeBimBtn.type = "button"; modeBimBtn.textContent = "BIM";
  modeBimBtn.setAttribute("data-testid", "mode-bim");
  modeBimBtn.setAttribute("aria-pressed", "false");
  modeBimBtn.style.cssText = "min-height:32px;border:0;border-radius:0;font-size:12px;";
  // COMPAT-CAD-003: the third mode — construction documentation.
  const modeDocsBtn = el("button");
  modeDocsBtn.type = "button"; modeDocsBtn.textContent = "Documentation";
  modeDocsBtn.setAttribute("data-testid", "mode-docs");
  modeDocsBtn.setAttribute("aria-pressed", "false");
  modeDocsBtn.style.cssText = "min-height:32px;border:0;border-radius:0;font-size:12px;";
  modeWrap.append(modeDraftBtn, modeBimBtn, modeDocsBtn);
  header.append(hWrap, modeWrap, badge, engineBadge);
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

  // COMPAT-CAD-002: BIM authoring panel (visible only in BIM mode).
  const bimCard = card("BIM authoring (3D)", "COMPAT-CAD-002 — semantic building authoring through the shared App API (bim.*). Author the representative mini building, edit in 3D, switch standard cameras, realize solids through the geometry engine behind the frozen adapter boundary, undo/redo, and prove save/open graph-events identity.");
  bimCard.setAttribute("data-testid", "bim-card");
  bimCard.style.display = "none"; // drafting is the default mode
  const bimBody = el("div", "card-c");

  const bimStatus = el("p");
  bimStatus.setAttribute("data-testid", "bim-status");
  bimStatus.setAttribute("data-state", "idle");
  bimStatus.setAttribute("data-op", "");
  bimStatus.style.cssText = "margin:0 0 8px;font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);";
  bimStatus.textContent = "BIM: idle";

  const bimCtrls = el("div", "controls");
  bimCtrls.style.marginBottom = "8px";
  const bBimCreate = btn("primary", "Create mini building", "▲");
  bBimCreate.type = "button"; bBimCreate.setAttribute("data-testid", "bim-create-building");
  bimCtrls.append(bBimCreate);

  const bimMoveGroup = el("div", "controls");
  bimMoveGroup.style.marginBottom = "8px";
  const mDx = numField("bim-move-dx", "dx", "600");
  const mDy = numField("bim-move-dy", "dy", "0");
  const mDz = numField("bim-move-dz", "dz", "0");
  const bBimMove = btn("", "Move door opening", "→");
  bBimMove.type = "button"; bBimMove.setAttribute("data-testid", "bim-move-opening");
  bBimMove.title = "bim.move {ids:[op-door]} — openings move ALONG the host wall axis (cross-axis is a typed reject)";
  bimMoveGroup.append(mDx.wrap, mDy.wrap, mDz.wrap, bBimMove);

  const bimCamGroup = el("div", "controls");
  bimCamGroup.style.marginBottom = "8px";
  const bimCameraBtns = new Map<string, HTMLButtonElement>();
  for (const preset of ["iso", "top", "front", "right"]) {
    const b = btn("", `Camera ${preset}`, "◉");
    b.type = "button"; b.setAttribute("data-testid", `bim-camera-${preset}`);
    b.setAttribute("aria-pressed", "false");
    bimCameraBtns.set(preset, b);
    bimCamGroup.append(b);
  }

  const bimOpsGroup = el("div", "controls");
  bimOpsGroup.style.marginBottom = "8px";
  const bBimBuild = btn("primary", "Build geometry", "◭");
  bBimBuild.type = "button"; bBimBuild.setAttribute("data-testid", "bim-build");
  bBimBuild.title = "bim.buildGeometry — realizes every solid-bearing element through the bound engine (OCCT worker; takes a few seconds)";
  const bBimUndo = btn("", "Undo", "<");
  bBimUndo.type = "button"; bBimUndo.setAttribute("data-testid", "bim-undo");
  const bBimRedo = btn("", "Redo", ">");
  bBimRedo.type = "button"; bBimRedo.setAttribute("data-testid", "bim-redo");
  const bBimSaveOpen = btn("", "Save → Open", "⟲");
  bBimSaveOpen.type = "button"; bBimSaveOpen.setAttribute("data-testid", "bim-save-open");
  bBimSaveOpen.title = "document.save then document.open(saved bytes) — graph events hash must be identical";
  bimOpsGroup.append(bBimBuild, bBimUndo, bBimRedo, bBimSaveOpen);

  const bimBuildBusy = el("p");
  bimBuildBusy.setAttribute("data-testid", "bim-build-busy");
  bimBuildBusy.hidden = true;
  bimBuildBusy.style.cssText = "margin:0 0 8px;font-size:12px;color:var(--accent);";
  bimBuildBusy.setAttribute("role", "status");
  bimBuildBusy.textContent = "Building solids through the geometry engine (OCCT worker)…";

  const monoP = (testid: string, initial: string): HTMLElement => {
    const p = el("p");
    p.setAttribute("data-testid", testid);
    p.style.cssText = "margin:0 0 8px;font-family:ui-monospace,monospace;font-size:11px;color:var(--fg);word-break:break-all;";
    p.textContent = initial;
    return p;
  };
  const bimCreated = monoP("bim-created", "created: —");
  bimCreated.setAttribute("data-count", "0");
  const bimCameraReadout = monoP("bim-camera-readout", "camera: —");
  const bimBuildResult = monoP("bim-build-result", "build: —");
  bimBuildResult.setAttribute("data-built", "");
  bimBuildResult.setAttribute("data-skipped", "");
  bimBuildResult.setAttribute("data-skip-id", "");
  bimBuildResult.setAttribute("data-skip-reason", "");
  const bimPersistResult = monoP("bim-persist-result", "persistence: —");
  bimPersistResult.setAttribute("data-identical", "");

  const bimSummary = el("p");
  bimSummary.setAttribute("data-testid", "bim-building-summary");
  bimSummary.style.cssText = "margin:0 0 8px;font-size:12px;color:var(--muted);";
  bimSummary.textContent = "No BIM elements yet — create the mini building.";

  const bimTree = el("div");
  bimTree.setAttribute("data-testid", "bim-tree");
  bimTree.setAttribute("role", "list");
  bimTree.style.cssText = "max-height:384px;overflow-y:auto;";

  bimBody.append(bimStatus, bimCtrls, bimMoveGroup, bimCamGroup, bimOpsGroup, bimBuildBusy, bimCreated, bimCameraReadout, bimBuildResult, bimPersistResult, bimSummary, bimTree);
  bimCard.append(bimBody);

  // COMPAT-CAD-003: construction documentation panel (visible only in docs mode).
  const docsCard = card(
    "Construction documentation",
    "COMPAT-CAD-003 — drawing production through the shared App API (docs.*). Views are projected deterministically from the BIM model (plan / elevation / section / detail), annotations bind to canonical element ids, sheets carry A1 title blocks; regeneration is the determinism proof and the canonical Sheet IR is the export contract (PDF/DWG writers fail typed docs_unsupported — explicit, no partial writer). Pure deterministic TS behind the frozen API: no engine involved.",
  );
  docsCard.setAttribute("data-testid", "docs-card");
  docsCard.style.display = "none"; // drafting is the default mode
  const docsBody = el("div", "card-c");

  const docsStatus = el("p");
  docsStatus.setAttribute("data-testid", "docs-status");
  docsStatus.setAttribute("data-state", "idle");
  docsStatus.setAttribute("data-op", "");
  docsStatus.setAttribute("data-run", "0");
  docsStatus.style.cssText = "margin:0 0 8px;font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);";
  docsStatus.textContent = "docs: idle";

  const docsSeedGroup = el("div", "controls");
  docsSeedGroup.style.marginBottom = "8px";
  const bDocsSeed = btn("primary", "Seed documentation", "▦");
  bDocsSeed.type = "button"; bDocsSeed.setAttribute("data-testid", "docs-seed");
  bDocsSeed.title = "document.create + bim.createElements (representative building) + docs.createViews (plan/elevation/section/detail) + docs.addAnnotations (overall dim + office tag) + docs.regenerate + docs.createSheets (A-101)";
  docsSeedGroup.append(bDocsSeed);

  const docsMonoP = (testid: string, initial: string): HTMLElement => {
    const p = el("p");
    p.setAttribute("data-testid", testid);
    p.style.cssText = "margin:0 0 8px;font-family:ui-monospace,monospace;font-size:11px;color:var(--fg);word-break:break-all;";
    p.textContent = initial;
    return p;
  };
  const docsSeedResult = docsMonoP("docs-seed-result", "seed: —");
  docsSeedResult.setAttribute("data-count", "0");
  docsSeedResult.setAttribute("data-annotations", "0");
  docsSeedResult.setAttribute("data-regen-applied", "-1");
  docsSeedResult.setAttribute("data-sheet", "");

  // Create-view quick form: kind + story/source + direction + axis + offset
  // (one compact row serving every kind; per-kind fields are composed on click).
  const docsForm = el("div", "controls");
  docsForm.style.marginBottom = "8px";
  const fKind = docsSelectField("docs-view-kind", "kind", ["plan", "elevation", "section", "detail"], "plan");
  const fStory = docsTextField("docs-view-story", "story / source view", "story-gf");
  const fDirection = docsSelectField("docs-view-direction", "direction", ["front", "back", "left", "right"], "front");
  const fAxis = docsSelectField("docs-view-axis", "axis", ["x", "y"], "y");
  const fOffset = docsNumberField("docs-view-offset", "offset / scale", "2500");
  const bDocsCreateView = btn("", "Create view", "+");
  bDocsCreateView.type = "button"; bDocsCreateView.setAttribute("data-testid", "docs-create-view");
  bDocsCreateView.title = "docs.createViews — plan uses the story; elevation the direction; section the axis + cut offset; detail the source view + magnification (offset field) with the representative region";
  docsForm.append(fKind.wrap, fStory.wrap, fDirection.wrap, fAxis.wrap, fOffset.wrap, bDocsCreateView);

  const docsViewsGroup = el("div", "controls");
  docsViewsGroup.style.marginBottom = "8px";
  const bDocsListViews = btn("", "List views", "≡");
  bDocsListViews.type = "button"; bDocsListViews.setAttribute("data-testid", "docs-list-views");
  const bDocsGetGeometry = btn("", "View geometry", "⌖");
  bDocsGetGeometry.type = "button"; bDocsGetGeometry.setAttribute("data-testid", "docs-get-geometry");
  bDocsGetGeometry.title = "docs.getViewGeometry of the selected view (click a row to select) — primitive count + content hash + bbox";
  docsViewsGroup.append(bDocsListViews, bDocsGetGeometry);

  const docsViewList = el("div");
  docsViewList.setAttribute("data-testid", "docs-view-list");
  docsViewList.setAttribute("role", "list");
  docsViewList.style.cssText = "max-height:200px;overflow-y:auto;margin:0 0 8px;";
  const docsGeometryReadout = docsMonoP("docs-geometry-readout", "geometry: —");
  docsGeometryReadout.setAttribute("data-primitives", "");
  docsGeometryReadout.setAttribute("data-hash", "");
  docsGeometryReadout.setAttribute("data-bbox", "");

  const docsOpsGroup = el("div", "controls");
  docsOpsGroup.style.marginBottom = "8px";
  const bDocsRegenerate = btn("primary", "Regenerate", "⟳");
  bDocsRegenerate.type = "button"; bDocsRegenerate.setAttribute("data-testid", "docs-regenerate");
  bDocsRegenerate.title = "docs.regenerate — recompute every view projection (canonical content hashes) + every annotation's derived values; a no-op records no revision";
  const bDocsCreateSheet = btn("", "Create sheet", "▭");
  bDocsCreateSheet.type = "button"; bDocsCreateSheet.setAttribute("data-testid", "docs-create-sheet");
  bDocsCreateSheet.title = "docs.createSheets — A-102 placing the section + detail views (non-overlapping inside the drawable region)";
  const bDocsListSheets = btn("", "List sheets", "▤");
  bDocsListSheets.type = "button"; bDocsListSheets.setAttribute("data-testid", "docs-list-sheets");
  docsOpsGroup.append(bDocsRegenerate, bDocsCreateSheet, bDocsListSheets);

  const docsRegenReadout = docsMonoP("docs-regen-readout", "regen: —");
  docsRegenReadout.setAttribute("data-applied", "");
  docsRegenReadout.setAttribute("data-first-hash", "");

  const docsSheetList = el("div");
  docsSheetList.setAttribute("data-testid", "docs-sheet-list");
  docsSheetList.setAttribute("role", "list");
  docsSheetList.style.cssText = "max-height:160px;overflow-y:auto;margin:0 0 8px;";

  const docsExportGroup = el("div", "controls");
  docsExportGroup.style.marginBottom = "8px";
  const bDocsExport = btn("primary", "Export sheet-ir", "⇩");
  bDocsExport.type = "button"; bDocsExport.setAttribute("data-testid", "docs-export");
  bDocsExport.title = "docs.exportSheet {format:'sheet-ir'} — the canonical deterministic Sheet IR + sha256 hash (the future PDF/DWG adapter contract)";
  const bDocsExportPdf = btn("danger", "Export pdf (typed reject)", "✕");
  bDocsExportPdf.type = "button"; bDocsExportPdf.setAttribute("data-testid", "docs-export-pdf");
  bDocsExportPdf.title = "docs.exportSheet {format:'pdf'} — the writer is outside this slice; the request fails typed docs_unsupported (explicit, no partial writer)";
  docsExportGroup.append(bDocsExport, bDocsExportPdf);
  const docsExportReadout = docsMonoP("docs-export-readout", "export: —");
  docsExportReadout.setAttribute("data-hash", "");
  docsExportReadout.setAttribute("data-sheet", "");

  const docsHistGroup = el("div", "controls");
  const bDocsUndo = btn("", "Undo", "<");
  bDocsUndo.type = "button"; bDocsUndo.setAttribute("data-testid", "docs-undo");
  const bDocsRedo = btn("", "Redo", ">");
  bDocsRedo.type = "button"; bDocsRedo.setAttribute("data-testid", "docs-redo");
  const bDocsSaveOpen = btn("", "Save → Open", "⟲");
  bDocsSaveOpen.type = "button"; bDocsSaveOpen.setAttribute("data-testid", "docs-save-open");
  bDocsSaveOpen.title = "document.save then document.open(saved bytes) — graph events hash must be identical";
  docsHistGroup.append(bDocsUndo, bDocsRedo, bDocsSaveOpen);
  const docsPersistResult = docsMonoP("docs-persist-result", "persistence: —");
  docsPersistResult.setAttribute("data-identical", "");

  docsBody.append(
    docsStatus,
    docsSeedGroup,
    docsSeedResult,
    docsForm,
    docsViewsGroup,
    docsViewList,
    docsGeometryReadout,
    docsOpsGroup,
    docsRegenReadout,
    docsSheetList,
    docsExportGroup,
    docsExportReadout,
    docsHistGroup,
    docsPersistResult,
  );
  docsCard.append(docsBody);

  const editCard = card("Edit", "Add or remove geometry elements (dummy shapes).");
  const editBody = el("div", "card-c"); const editCtrls = el("div", "controls");
  const bBox = btn("primary", "Add Box", "#"); const bCircle = btn("primary", "Add Circle", "o"); const bDel = btn("danger", "Delete", "x");
  editCtrls.append(bBox, bCircle, bDel); editBody.append(editCtrls); editCard.append(editBody);

  const histCard = card("History", "Undo / redo the last edit.");
  const histBody = el("div", "card-c"); const histCtrls = el("div", "controls");
  const bUndo = btn("", "Undo", "<"); const bRedo = btn("", "Redo", ">");
  histCtrls.append(bUndo, bRedo); histBody.append(histCtrls); histCard.append(histBody);

  // CAD-IMPLEMENT-003: persistent model revisions + Construction Graph bridge.
  const revCard = card("Model Revisions", "Immutable revision history persisted with the document (save/open). Click a revision to replay it deterministically.");
  const revBody = el("div", "card-c");
  const revSummary = el("p"); revSummary.style.fontSize = "12px"; revSummary.style.color = "var(--muted)";
  const revList = el("div"); revList.style.maxHeight = "384px"; revList.style.overflowY = "auto"; revList.style.marginTop = "8px";
  const replayEl = el("div"); replayEl.style.display = "none"; replayEl.style.marginTop = "8px";
  const eventsEl = el("div"); eventsEl.style.display = "none"; eventsEl.style.marginTop = "8px";
  revBody.append(revSummary, revList, replayEl, eventsEl);
  revCard.append(revBody);

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
  errorEl.setAttribute("data-testid", "cad-error");
  errorEl.setAttribute("role", "alert");
  nav.append(fileCard, occtCard, bimCard, docsCard, editCard, histCard, revCard, selCard, verCard, errorEl);

  main.append(canvasCard, nav);
  root.append(main);

  const footer = el("footer");
  footer.textContent = "Offisos CAD-IMPLEMENT-003 — Electron host (real BrowserWindow + native IPC + shared renderer + App API + real OCCT adapter behind the frozen boundary). Persistent model revisions + Construction Graph bridge; Web/Electron parity proven by app/test/model-host-parity.test.ts. Architecture v1.1 FROZEN.";
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
  // COMPAT-CAD-002: mode toggle + BIM panel handlers.
  modeDraftBtn.addEventListener("click", () => setMode("drafting"));
  modeBimBtn.addEventListener("click", () => setMode("bim"));
  bBimCreate.addEventListener("click", () => void onBimCreateBuilding());
  bBimMove.addEventListener("click", () => void onBimMoveOpening());
  for (const [preset, b] of bimCameraBtns) {
    b.addEventListener("click", () => void onBimCamera(preset));
  }
  bBimBuild.addEventListener("click", () => void onBimBuild());
  bBimUndo.addEventListener("click", () => void bimRun("undo", () => command("document.undo", {})));
  bBimRedo.addEventListener("click", () => void bimRun("redo", () => command("document.redo", {})));
  bBimSaveOpen.addEventListener("click", () => void onBimSaveOpen());
  // COMPAT-CAD-003: mode toggle + documentation panel handlers.
  modeDocsBtn.addEventListener("click", () => setMode("docs"));
  bDocsSeed.addEventListener("click", () => void onDocsSeed());
  bDocsCreateView.addEventListener("click", () => void onDocsCreateView());
  bDocsListViews.addEventListener("click", () => void onDocsListViews());
  bDocsGetGeometry.addEventListener("click", () => void onDocsGetGeometry());
  bDocsRegenerate.addEventListener("click", () => void onDocsRegenerate());
  bDocsCreateSheet.addEventListener("click", () => void onDocsCreateSheet());
  bDocsListSheets.addEventListener("click", () => void onDocsListSheets());
  bDocsExport.addEventListener("click", () => void onDocsExport());
  bDocsExportPdf.addEventListener("click", () => void onDocsExportPdf());
  bDocsUndo.addEventListener("click", () => void docsRun("undo", () => command("document.undo", {})));
  bDocsRedo.addEventListener("click", () => void docsRun("redo", () => command("document.redo", {})));
  bDocsSaveOpen.addEventListener("click", () => void onDocsSaveOpen());
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
    modeDraftBtn,
    modeBimBtn,
    bimCard,
    bimStatus,
    bimCreated,
    bimMoveDx: mDx.input,
    bimMoveDy: mDy.input,
    bimMoveDz: mDz.input,
    bimMoveBtn: bBimMove,
    bimCameraBtns,
    bimBuildBtn: bBimBuild,
    bimBuildBusy,
    bimUndoBtn: bBimUndo,
    bimRedoBtn: bBimRedo,
    bimSaveOpenBtn: bBimSaveOpen,
    bimCameraReadout,
    bimBuildResult,
    bimPersistResult,
    bimSummary,
    bimTree,
    modeDocsBtn,
    docsCard,
    docsStatus,
    docsSeedResult,
    docsViewKind: fKind.select,
    docsViewStory: fStory.input,
    docsViewDirection: fDirection.select,
    docsViewAxis: fAxis.select,
    docsViewOffset: fOffset.input,
    docsCreateViewBtn: bDocsCreateView,
    docsListViewsBtn: bDocsListViews,
    docsViewList,
    docsGetGeometryBtn: bDocsGetGeometry,
    docsGeometryReadout,
    docsRegenerateBtn: bDocsRegenerate,
    docsRegenReadout,
    docsCreateSheetBtn: bDocsCreateSheet,
    docsListSheetsBtn: bDocsListSheets,
    docsSheetList,
    docsExportBtn: bDocsExport,
    docsExportReadout,
    docsExportPdfBtn: bDocsExportPdf,
    docsUndoBtn: bDocsUndo,
    docsRedoBtn: bDocsRedo,
    docsSaveOpenBtn: bDocsSaveOpen,
    docsPersistResult,
    ddEid: rEid.dd,
    ddVid: rVid.dd,
    ddVn: rVn.dd,
    ddCun: rCun.dd,
    ddCred: rCred.dd,
    ddCd: rCd.dd,
    ddFmt: rFmt.dd,
    ddFv: rFv.dd,
    revList,
    replayEl,
    eventsEl,
    revSummary,
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

/** Labeled numeric input (COMPAT-CAD-002 BIM move deltas). */
function numField(testid: string, label: string, value: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label");
  wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);";
  const span = el("span"); span.textContent = label;
  const input = el("input");
  input.type = "number"; input.step = "any"; input.value = value;
  input.setAttribute("data-testid", testid);
  input.setAttribute("aria-label", `BIM move ${label} (mm)`);
  input.style.cssText = "width:64px;font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;";
  wrap.append(span, input);
  return { wrap, input };
}

/** COMPAT-CAD-003: labeled docs-panel form fields (select / text / number). */
function docsSelectField(testid: string, label: string, options: readonly string[], value: string): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = el("label");
  wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);";
  const span = el("span"); span.textContent = label;
  const select = el("select");
  for (const o of options) {
    const opt = el("option");
    opt.value = o; opt.textContent = o;
    select.append(opt);
  }
  select.value = value;
  select.setAttribute("data-testid", testid);
  select.setAttribute("aria-label", `Documentation view ${label}`);
  select.style.cssText = "font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;";
  wrap.append(span, select);
  return { wrap, select };
}

function docsTextField(testid: string, label: string, value: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label");
  wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);";
  const span = el("span"); span.textContent = label;
  const input = el("input");
  input.type = "text"; input.value = value;
  input.setAttribute("data-testid", testid);
  input.setAttribute("aria-label", `Documentation view ${label}`);
  input.style.cssText = "width:110px;font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;";
  wrap.append(span, input);
  return { wrap, input };
}

function docsNumberField(testid: string, label: string, value: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label");
  wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);";
  const span = el("span"); span.textContent = label;
  const input = el("input");
  input.type = "number"; input.step = "any"; input.value = value;
  input.setAttribute("data-testid", testid);
  input.setAttribute("aria-label", `Documentation view ${label}`);
  input.style.cssText = "width:70px;font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;";
  wrap.append(span, input);
  return { wrap, input };
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

// --- COMPAT-CAD-002: BIM authoring actions (window.cad.send only) ----------

/** BIM status protocol: [data-state] idle|busy|done|error + [data-op] label —
 *  the deterministic handle the BrowserWindow smoke waits on. */
function setBimStatus(st: "idle" | "busy" | "done" | "error", op: string, text: string): void {
  if (!ui) return;
  ui.bimStatus.setAttribute("data-state", st);
  ui.bimStatus.setAttribute("data-op", op);
  ui.bimStatus.textContent = text;
  ui.bimBuildBusy.hidden = !(st === "busy" && op === "build");
}

/** run() semantics for the BIM panel: busy state, typed-error surface, and
 *  the [data-state]/[data-op] status protocol the smoke polls. The error is
 *  set AFTER refresh() — refresh() itself resets the alert on successful
 *  queries, so setting it before would clear the typed message again. */
async function bimRun(op: string, fn: () => Promise<CommandQueryResponse>): Promise<CommandQueryResponse | null> {
  setBusy(true);
  setBimStatus("busy", op, `BIM ${op}: busy…`);
  try {
    const res = await fn();
    await refresh();
    if (!res.ok) {
      setError(`[${op}] ${res.code}: ${res.message}`);
      setBimStatus("error", op, `BIM ${op}: failed — ${res.code}: ${res.message}`);
    } else {
      setBimStatus("done", op, `BIM ${op}: done`);
    }
    return res;
  } catch (e) {
    await refresh();
    setError(`[${op}] unexpected: ${(e as Error).message}`);
    setBimStatus("error", op, `BIM ${op}: unexpected — ${(e as Error).message}`);
    return null;
  } finally {
    setBusy(false);
  }
}

function setMode(mode: WorkspaceMode): void {
  if (state.busy || state.mode === mode) return;
  state.mode = mode;
  void refresh();
}

/** Author the representative mini building: fresh document + ONE atomic
 *  bim.createElements batch (one versioned command, one revision, one undo). */
async function onBimCreateBuilding(): Promise<void> {
  if (!ui) return;
  ui.bimCreated.setAttribute("data-count", "0");
  ui.bimCreated.textContent = "created: —";
  const created = await bimRun("create-building", () => command("document.create", { entityId: "compat-cad-002-electron" }));
  if (created === null || !created.ok) return;
  const res = await bimRun("create-building", () => command("bim.createElements", { entities: MINI_BUILDING_ENTITIES }));
  if (res !== null && res.ok) {
    const ids = (res.value as { created?: string[] }).created ?? [];
    ui.bimCreated.setAttribute("data-count", String(ids.length));
    ui.bimCreated.textContent = `created ${ids.length}: ${ids.join(", ")}`;
  }
}

function readNum(input: HTMLInputElement, fallback: number): number {
  const v = Number(input.value);
  return Number.isFinite(v) ? v : fallback;
}

/** Move the mini building's door opening (op-door) by the dx/dy/dz deltas.
 *  Along-axis moves succeed; cross-axis/other typed rejects surface in the
 *  shared error alert (and the bim-status error state). */
async function onBimMoveOpening(): Promise<void> {
  if (!ui) return;
  const dx = readNum(ui.bimMoveDx, 0);
  const dy = readNum(ui.bimMoveDy, 0);
  const dz = readNum(ui.bimMoveDz, 0);
  await bimRun("move-opening", () => command("bim.move", { ids: ["op-door"], dx, dy, dz }));
}

/** Persist the camera preset (bim.setSettings, non-versioned) and display the
 *  deterministic standard camera (bim.camera — preset + eye). */
async function onBimCamera(preset: string): Promise<void> {
  if (!ui) return;
  const set = await bimRun(`camera-${preset}`, () => command("bim.setSettings", { settings: { camera: { preset } } }));
  if (set === null || !set.ok) return;
  const cam = await query("bim.camera", { preset });
  if (cam.ok) {
    const v = cam.value as { camera: { preset: string; eye: number[]; target: number[]; up: number[] } };
    ui.bimCameraReadout.textContent =
      `preset=${v.camera.preset} · eye=[${v.camera.eye.map((n) => Math.round(n)).join(", ")}] · ` +
      `target=[${v.camera.target.map((n) => Math.round(n)).join(", ")}] · up=[${v.camera.up.join(", ")}]`;
  } else {
    setError(`[camera-${preset}] ${cam.code}: ${cam.message}`);
  }
}

/** Realize every solid-bearing BIM element through the bound geometry engine
 *  (the OCCT worker — a multi-second call; the busy line stays visible). */
async function onBimBuild(): Promise<void> {
  if (!ui) return;
  const res = await bimRun("build", () => command("bim.buildGeometry", {}));
  if (res === null) return;
  if (res.ok) {
    const v = res.value as {
      built: number;
      results: { elementId: string; meshToken: string; engine: { engineId: string; engineVersion: string } }[];
      skipped: { elementId: string; reason: string }[];
    };
    const skip = v.skipped[0];
    const engine = v.results[0]?.engine ?? null;
    ui.bimBuildResult.setAttribute("data-built", String(v.built));
    ui.bimBuildResult.setAttribute("data-skipped", String(v.skipped.length));
    ui.bimBuildResult.setAttribute("data-skip-id", skip ? skip.elementId : "");
    ui.bimBuildResult.setAttribute("data-skip-reason", skip ? skip.reason : "");
    ui.bimBuildResult.textContent =
      `built=${v.built} skipped=${v.skipped.length}` +
      (skip ? ` (${skip.elementId}: ${skip.reason})` : "") +
      (engine ? ` · engine=${engine.engineId} ${engine.engineVersion}` : "");
    if (engine) state.engine = engine;
  } else {
    ui.bimBuildResult.setAttribute("data-built", "-1");
    ui.bimBuildResult.setAttribute("data-skipped", "");
    ui.bimBuildResult.setAttribute("data-skip-id", "");
    ui.bimBuildResult.setAttribute("data-skip-reason", "");
    ui.bimBuildResult.textContent = `build: failed — ${res.code}: ${res.message}`;
  }
}

/** Save → open round trip through the SAME handler document: the Construction
 *  Graph events hash before/after must be identical (identity proof). */
async function onBimSaveOpen(): Promise<void> {
  if (!ui) return;
  await bimRun("save-open", async () => {
    const before = await query("model.getGraphEvents", {});
    if (!before.ok) return before;
    const hashBefore = (before.value as { events_hash: string }).events_hash;
    const save = await command("document.save", {});
    if (!save.ok) return save;
    const bytes = (save.value as { bytes: number[] }).bytes;
    const open = await command("document.open", { source: bytes });
    if (!open.ok) return open;
    const after = await query("model.getGraphEvents", {});
    if (!after.ok) return after;
    const hashAfter = (after.value as { events_hash: string }).events_hash;
    const identical = hashAfter === hashBefore;
    ui!.bimPersistResult.setAttribute("data-identical", identical ? "true" : "false");
    ui!.bimPersistResult.textContent =
      `events_hash ${hashBefore.slice(0, 16)}… → ${hashAfter.slice(0, 16)}… · identical=${identical}`;
    // Surface a hash change as a typed failure of the round trip (the UI's own
    // honest verdict — not an App API error code).
    return identical
      ? open
      : ({ ok: false, code: "bim_invalid", message: "graph events hash changed across save/open" } as CommandQueryResponse);
  });
}

// --- COMPAT-CAD-003: construction documentation actions (window.cad.send only)

/** Docs status protocol: [data-state] idle|busy|done|error + [data-op] label +
 *  [data-run] monotonic per-op counter — the deterministic handle the
 *  BrowserWindow smoke waits on (the counter disambiguates repeated op labels
 *  such as a second undo: the busy state + counter are set synchronously at
 *  click time, so "run N settled" is unambiguous). */
function setDocsStatus(st: "idle" | "busy" | "done" | "error", op: string, text: string): void {
  if (!ui) return;
  ui.docsStatus.setAttribute("data-state", st);
  ui.docsStatus.setAttribute("data-op", op);
  ui.docsStatus.textContent = text;
}

/** run() semantics for the docs panel (mirrors bimRun): busy state, typed-error
 *  surface, refresh, and the [data-state]/[data-op]/[data-run] status protocol
 *  the smoke polls. The error is set AFTER refresh() — refresh() itself resets
 *  the alert on successful queries, so setting it before would clear the typed
 *  message again. */
async function docsRun(op: string, fn: () => Promise<CommandQueryResponse>): Promise<CommandQueryResponse | null> {
  if (!ui) return null;
  if (state.busy || state.loading) return null; // no interleaved docs ops (buttons disable, rows guard here)
  state.docsRunCount += 1;
  ui.docsStatus.setAttribute("data-run", String(state.docsRunCount));
  setBusy(true);
  setDocsStatus("busy", op, `docs ${op}: busy…`);
  try {
    const res = await fn();
    await refresh();
    if (!res.ok) {
      setError(`[${op}] ${res.code}: ${res.message}`);
      setDocsStatus("error", op, `docs ${op}: failed — ${res.code}: ${res.message}`);
    } else {
      setDocsStatus("done", op, `docs ${op}: done`);
    }
    return res;
  } catch (e) {
    await refresh();
    setError(`[${op}] unexpected: ${(e as Error).message}`);
    setDocsStatus("error", op, `docs ${op}: unexpected — ${(e as Error).message}`);
    return null;
  } finally {
    setBusy(false);
  }
}

/** Seed the full representative documentation set through the App API: fresh
 *  document + the representative building + plan/elevation/section/detail
 *  views + the overall dimension + office tag + regeneration (deriving the
 *  annotation values) + the A-101 sheet. One docsRun wrapper — every command
 *  crosses window.cad.send; a typed failure surfaces and stops the seed. */
async function onDocsSeed(): Promise<void> {
  if (!ui) return;
  ui.docsSeedResult.setAttribute("data-count", "0");
  ui.docsSeedResult.setAttribute("data-annotations", "0");
  ui.docsSeedResult.setAttribute("data-regen-applied", "-1");
  ui.docsSeedResult.setAttribute("data-sheet", "");
  ui.docsSeedResult.textContent = "seed: —";
  ui.docsGeometryReadout.setAttribute("data-primitives", "");
  ui.docsGeometryReadout.setAttribute("data-hash", "");
  ui.docsGeometryReadout.setAttribute("data-bbox", "");
  ui.docsGeometryReadout.textContent = "geometry: —";
  state.docsSelectedView = null;
  let viewIds: string[] = [];
  let annotationCount = 0;
  let regenApplied = -1;
  let sheetIds: string[] = [];
  const res = await docsRun("seed", async () => {
    const created = await command("document.create", { entityId: "compat-cad-003-electron" });
    if (!created.ok) return created;
    const building = await command("bim.createElements", { entities: DOCS_BUILDING_ENTITIES });
    if (!building.ok) return building;
    const views = await command("docs.createViews", { views: DOCS_SEED_VIEWS });
    if (!views.ok) return views;
    viewIds = (views.value as { created: string[] }).created;
    const annotations = await command("docs.addAnnotations", { annotations: DOCS_SEED_ANNOTATIONS });
    if (!annotations.ok) return annotations;
    annotationCount = ((annotations.value as { created: string[] }).created ?? []).length;
    const regen = await command("docs.regenerate", {});
    if (!regen.ok) return regen;
    regenApplied = (regen.value as { applied: number }).applied;
    const sheets = await command("docs.createSheets", { sheets: [DOCS_SEED_SHEET] });
    if (!sheets.ok) return sheets;
    sheetIds = (sheets.value as { created: string[] }).created;
    return sheets;
  });
  if (res !== null && res.ok) {
    ui.docsSeedResult.setAttribute("data-count", String(viewIds.length));
    ui.docsSeedResult.setAttribute("data-annotations", String(annotationCount));
    ui.docsSeedResult.setAttribute("data-regen-applied", String(regenApplied));
    ui.docsSeedResult.setAttribute("data-sheet", sheetIds[0] ?? "");
    ui.docsSeedResult.textContent =
      `seeded: ${viewIds.length} views (${viewIds.join(", ")}) · ${annotationCount} annotations · ` +
      `regen applied ${regenApplied} · sheet ${sheetIds[0] ?? "—"}`;
  }
}

/** Create one additional view from the quick form (docs.createViews). The
 *  five fields compose per kind: plan ← story; elevation ← direction (+story
 *  as optional scope); section ← axis + offset; detail ← source view + the
 *  offset field as magnification with the representative region. */
async function onDocsCreateView(): Promise<void> {
  if (!ui) return;
  const kind = ui.docsViewKind.value;
  const story = ui.docsViewStory.value.trim();
  const direction = ui.docsViewDirection.value;
  const axis = ui.docsViewAxis.value;
  const offset = readNum(ui.docsViewOffset, 0);
  let view: Record<string, unknown>;
  if (kind === "plan") {
    view = { kind, title: `Plan (${story})`, storyId: story };
  } else if (kind === "elevation") {
    view = story !== "" ? { kind, title: `Elevation ${direction}`, direction, storyId: story } : { kind, title: `Elevation ${direction}`, direction };
  } else if (kind === "section") {
    view = { kind, title: `Section ${axis}=${Math.round(offset)}`, sectionAxis: axis, sectionOffset: offset };
  } else {
    view = { kind, title: `Detail (${story})`, sourceViewId: story, region: { x: 300, y: -300, w: 1400, h: 600 }, detailScale: offset };
  }
  await docsRun("create-view", () => command("docs.createViews", { views: [view] }));
}

/** docs.listViews — the rows render from the live state refresh() maintains. */
async function onDocsListViews(): Promise<void> {
  await docsRun("list-views", () => query("docs.listViews", {}));
}

/** docs.getViewGeometry of the selected view (row click) — readout: primitive
 *  count + content hash prefix + bbox (+ the view's resolved annotations). */
async function fetchDocsGeometry(viewId: string): Promise<void> {
  if (!ui) return;
  const res = await docsRun("get-geometry", () => query("docs.getViewGeometry", { viewId }));
  if (res !== null && res.ok) {
    const v = res.value as DocsViewGeometry;
    const bbox = v.bbox;
    ui.docsGeometryReadout.setAttribute("data-primitives", String(v.primitiveCount));
    ui.docsGeometryReadout.setAttribute("data-hash", v.contentHash);
    ui.docsGeometryReadout.setAttribute("data-bbox", JSON.stringify(bbox));
    ui.docsGeometryReadout.textContent =
      `${v.view.id} ${v.view.kind} · ${v.primitiveCount} primitives · hash ${v.contentHash.slice(0, 8)}… · ` +
      (bbox !== null
        ? `bbox [${bbox.uMin}, ${bbox.uMax}] × [${bbox.vMin}, ${bbox.vMax}]`
        : "bbox —") +
      ` · ${v.annotations.length} annotations`;
  } else {
    ui.docsGeometryReadout.setAttribute("data-primitives", "");
    ui.docsGeometryReadout.setAttribute("data-hash", "");
    ui.docsGeometryReadout.setAttribute("data-bbox", "");
    ui.docsGeometryReadout.textContent = "geometry: failed — see the error alert";
  }
}

/** The View geometry button: the selected view, or the first listed view. */
async function onDocsGetGeometry(): Promise<void> {
  if (!ui) return;
  const viewId = state.docsSelectedView ?? state.docsViews[0]?.view.id ?? null;
  if (viewId === null) {
    await docsRun("get-geometry", () =>
      Promise.resolve({
        ok: false,
        code: "docs_invalid",
        message: "no view to inspect — seed the documentation set or create a view first",
      } as CommandQueryResponse),
    );
    return;
  }
  await fetchDocsGeometry(viewId);
}

/** docs.regenerate — readout: applied update count + the first view's content
 *  hash prefix (the determinism anchor). A no-op regeneration reports
 *  applied 0 and records no revision (identical inputs → identical outputs). */
async function onDocsRegenerate(): Promise<void> {
  if (!ui) return;
  const res = await docsRun("regenerate", () => command("docs.regenerate", {}));
  if (res !== null && res.ok) {
    const v = res.value as {
      applied: number;
      report: { views: { viewId: string; kind: string; contentHash: string | null; primitiveCount: number }[] };
    };
    const first = v.report.views[0];
    ui.docsRegenReadout.setAttribute("data-applied", String(v.applied));
    ui.docsRegenReadout.setAttribute("data-first-hash", first?.contentHash ?? "");
    ui.docsRegenReadout.textContent =
      `applied=${v.applied} · ${v.report.views.length} views · first ${first?.viewId ?? "—"} ` +
      `(${first?.kind ?? "—"}, ${first?.primitiveCount ?? 0} primitives) hash ${first?.contentHash?.slice(0, 8) ?? "—"}…`;
  } else {
    ui.docsRegenReadout.setAttribute("data-applied", "");
    ui.docsRegenReadout.setAttribute("data-first-hash", "");
    ui.docsRegenReadout.textContent = "regen: failed — see the error alert";
  }
}

/** docs.createSheets — the A-102 sheet placing section + detail. */
async function onDocsCreateSheet(): Promise<void> {
  await docsRun("create-sheet", () => command("docs.createSheets", { sheets: [DOCS_UI_SHEET] }));
}

/** docs.listSheets — the rows render from the live state refresh() maintains. */
async function onDocsListSheets(): Promise<void> {
  await docsRun("list-sheets", () => query("docs.listSheets", {}));
}

/** The first sheet's id (docs.listSheets — table order). */
async function firstSheetId(): Promise<string | null> {
  const res = await query("docs.listSheets", {});
  if (!res.ok) return null;
  const sheets = (res.value as { sheets: DocsSheetListItem[] }).sheets ?? [];
  return sheets[0]?.id ?? null;
}

/** docs.exportSheet {format:"sheet-ir"} of the first sheet — readout: the
 *  canonical 64-hex sha256 of the Sheet IR (the PDF/DWG adapter contract). */
async function onDocsExport(): Promise<void> {
  if (!ui) return;
  const res = await docsRun("export", async () => {
    const sheetId = await firstSheetId();
    if (sheetId === null) {
      return {
        ok: false,
        code: "docs_invalid",
        message: "no sheet to export — create one first",
      } as CommandQueryResponse;
    }
    return query("docs.exportSheet", { sheetId, format: "sheet-ir" });
  });
  if (res !== null && res.ok) {
    const v = res.value as { format: string; sheetId: string; hash: string };
    ui.docsExportReadout.setAttribute("data-hash", v.hash);
    ui.docsExportReadout.setAttribute("data-sheet", v.sheetId);
    ui.docsExportReadout.textContent = `${v.format} ${v.sheetId} · hash ${v.hash.slice(0, 16)}… (64-hex canonical)`;
  } else {
    ui.docsExportReadout.setAttribute("data-hash", "");
    ui.docsExportReadout.setAttribute("data-sheet", "");
    ui.docsExportReadout.textContent = "export: failed — see the error alert";
  }
}

/** docs.exportSheet {format:"pdf"} — the writer is outside this slice: the
 *  typed docs_unsupported failure surfaces in the shared cad-error alert. */
async function onDocsExportPdf(): Promise<void> {
  await docsRun("export-pdf", async () => {
    const sheetId = await firstSheetId();
    if (sheetId === null) {
      return {
        ok: false,
        code: "docs_invalid",
        message: "no sheet to export — create one first",
      } as CommandQueryResponse;
    }
    return query("docs.exportSheet", { sheetId, format: "pdf" });
  });
}

/** Save → open round trip through the SAME handler document: the Construction
 *  Graph events hash before/after must be identical (identity proof) — the
 *  BIM card's save/open pattern, docs readout. */
async function onDocsSaveOpen(): Promise<void> {
  if (!ui) return;
  await docsRun("save-open", async () => {
    const before = await query("model.getGraphEvents", {});
    if (!before.ok) return before;
    const hashBefore = (before.value as { events_hash: string }).events_hash;
    const save = await command("document.save", {});
    if (!save.ok) return save;
    const bytes = (save.value as { bytes: number[] }).bytes;
    const open = await command("document.open", { source: bytes });
    if (!open.ok) return open;
    const after = await query("model.getGraphEvents", {});
    if (!after.ok) return after;
    const hashAfter = (after.value as { events_hash: string }).events_hash;
    const identical = hashAfter === hashBefore;
    ui!.docsPersistResult.setAttribute("data-identical", identical ? "true" : "false");
    ui!.docsPersistResult.textContent =
      `events_hash ${hashBefore.slice(0, 16)}… → ${hashAfter.slice(0, 16)}… · identical=${identical}`;
    // Surface a hash change as a typed failure of the round trip (the UI's own
    // honest verdict — not an App API error code).
    return identical
      ? open
      : ({ ok: false, code: "docs_invalid", message: "graph events hash changed across save/open" } as CommandQueryResponse);
  });
}

// --- Refresh --------------------------------------------------------------

let ui: Shell | null = null;

async function refresh(): Promise<void> {
  const [stateRes, selRes, historyRes, eventsRes] = await Promise.all([
    query("document.getState", {}),
    query("document.getSelection", {}),
    query("model.getHistory", {}),
    query("model.getGraphEvents", {}),
  ]);
  const snap = unwrapSnapshot(stateRes);
  const sel = unwrapSelection(selRes);
  if (snap) state.snapshot = snap;
  state.selection = sel;
  state.history = unwrapHistory(historyRes);
  state.graphEvents = unwrapGraphEvents(eventsRes);
  if (!stateRes.ok) setError(stateRes.message);
  else if (!selRes.ok) setError(selRes.message);
  else setError(null);
  // COMPAT-CAD-002: BIM mode additionally pulls the story→elements structure.
  if (state.mode === "bim") {
    const bimRes = await query("bim.getBuilding", {});
    state.bimBuilding = bimRes.ok ? ((bimRes.value as BimBuilding) ?? null) : null;
  }
  // COMPAT-CAD-003: docs mode additionally pulls the live view/sheet tables
  // (fresh projections + content hashes — the rows stay current through every
  // op, exactly like the BIM building tree).
  if (state.mode === "docs") {
    const viewsRes = await query("docs.listViews", {});
    state.docsViews = viewsRes.ok ? ((viewsRes.value as { views: DocsViewListItem[] }).views ?? []) : [];
    const sheetsRes = await query("docs.listSheets", {});
    state.docsSheets = sheetsRes.ok ? ((sheetsRes.value as { sheets: DocsSheetListItem[] }).sheets ?? []) : [];
  }
  render();
}

// --- CAD-IMPLEMENT-003: model revisions + Construction Graph bridge --------

function unwrapHistory(res: CommandQueryResponse): ModelHistory | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ModelHistory> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.revisions) || typeof v.base !== "object") {
    return null;
  }
  return v as ModelHistory;
}

function unwrapGraphEvents(res: CommandQueryResponse): GraphBridgeResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<GraphBridgeResult> | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.events) || typeof v.events_hash !== "string") {
    return null;
  }
  return v as GraphBridgeResult;
}

function unwrapReplay(res: CommandQueryResponse): ModelReplayResult | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ModelReplayResult> | null;
  if (
    typeof v !== "object" || v === null ||
    typeof v.content_hash !== "string" ||
    !Array.isArray(v.elements) ||
    v.verified !== true
  ) {
    return null;
  }
  return v as ModelReplayResult;
}

/** Deterministic historical replay to a revision number (0 = base). */
async function onReplayTo(revisionNumber: number): Promise<void> {
  setBusy(true);
  try {
    const res = await query("model.replay", { revision_number: revisionNumber });
    const value = unwrapReplay(res);
    if (!res.ok || value === null) {
      setError(res.ok ? "[Replay] unexpected response shape" : `[Replay] ${res.code}: ${res.message}`);
      state.replay = null;
    } else {
      setError(null);
      state.replay = value;
    }
  } finally {
    setBusy(false);
    render();
  }
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

  // CAD-IMPLEMENT-003: model revisions + graph events panel
  const history = state.history;
  const graphEvents = state.graphEvents;
  ui.revSummary.textContent = history
    ? `${history.revisions.length} revisions — base: ${history.base.origin}` +
      (graphEvents ? ` — ${graphEvents.events.length} graph events` : "")
    : "No revisions yet — edit the document to record them.";
  ui.revList.replaceChildren();
  if (history) {
    for (const rev of history.revisions) {
      const row = el("button");
      row.type = "button";
      row.style.cssText =
        "display:block;width:100%;text-align:left;margin-bottom:6px;padding:6px 10px;font-size:11px;font-family:ui-monospace,monospace;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer;";
      row.textContent = `#${rev.revision_number} v${rev.version.version_number} [${rev.note}] +${rev.delta.added.length} ~${rev.delta.updated.length} -${rev.delta.removed.length}`;
      row.setAttribute("aria-label", `Replay to revision ${rev.revision_number}`);
      row.addEventListener("click", () => void onReplayTo(rev.revision_number));
      ui.revList.append(row);
    }
  }
  const replay = state.replay;
  if (replay !== null) {
    ui.replayEl.style.display = "block";
    ui.replayEl.style.cssText += ";border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;";
    const ids = replay.elements.map((e) => truncate(e.id, 12)).join(", ") || "—";
    ui.replayEl.textContent =
      `Replay @ ${replay.revision_number} — ${replay.verified ? "verified" : "unverified"} · ` +
      `${replay.elements.length} element(s): ${ids} · content ${truncate(replay.content_hash, 16)} · ${truncate(replay.revision_id, 40)}`;
  } else {
    ui.replayEl.style.display = "none";
  }
  if (graphEvents !== null) {
    const created = graphEvents.events.filter((e) => e.event_type === "model.created").length;
    const versioned = graphEvents.events.filter((e) => e.event_type === "model.version.created").length;
    ui.eventsEl.style.display = "block";
    ui.eventsEl.style.cssText += ";border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;";
    ui.eventsEl.textContent =
      `Construction Graph bridge — events_hash ${truncate(graphEvents.events_hash, 24)} · ` +
      `${created}× model.created, ${versioned}× model.version.created · deterministic, engine-id provenance only.`;
  } else {
    ui.eventsEl.style.display = "none";
  }

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

  // COMPAT-CAD-002: mode toggle + BIM panel state.
  ui.modeDraftBtn.setAttribute("aria-pressed", state.mode === "drafting" ? "true" : "false");
  ui.modeBimBtn.setAttribute("aria-pressed", state.mode === "bim" ? "true" : "false");
  ui.modeDraftBtn.disabled = state.busy;
  ui.modeBimBtn.disabled = state.busy;
  ui.bimCard.style.display = state.mode === "bim" ? "" : "none";
  const bimDisabled = state.busy || state.loading;
  ui.bimMoveBtn.disabled = bimDisabled;
  ui.bimBuildBtn.disabled = bimDisabled;
  ui.bimSaveOpenBtn.disabled = bimDisabled;
  ui.bimUndoBtn.disabled = bimDisabled || !canUndo;
  ui.bimRedoBtn.disabled = bimDisabled || !canRedo;
  const activePreset = snap?.bimSettings?.camera?.preset ?? null;
  for (const [preset, b] of ui.bimCameraBtns) {
    b.disabled = bimDisabled;
    b.setAttribute("aria-pressed", preset === activePreset ? "true" : "false");
  }
  renderBimTree();

  // COMPAT-CAD-003: mode toggle + documentation panel state.
  ui.modeDocsBtn.setAttribute("aria-pressed", state.mode === "docs" ? "true" : "false");
  ui.modeDocsBtn.disabled = state.busy;
  ui.docsCard.style.display = state.mode === "docs" ? "" : "none";
  const docsDisabled = state.busy || state.loading;
  ui.docsCreateViewBtn.disabled = docsDisabled;
  ui.docsListViewsBtn.disabled = docsDisabled;
  ui.docsGetGeometryBtn.disabled = docsDisabled;
  ui.docsRegenerateBtn.disabled = docsDisabled;
  ui.docsCreateSheetBtn.disabled = docsDisabled;
  ui.docsListSheetsBtn.disabled = docsDisabled;
  ui.docsExportBtn.disabled = docsDisabled;
  ui.docsExportPdfBtn.disabled = docsDisabled;
  ui.docsSaveOpenBtn.disabled = docsDisabled;
  ui.docsUndoBtn.disabled = docsDisabled || !canUndo;
  ui.docsRedoBtn.disabled = docsDisabled || !canRedo;
  renderDocsViews();
  renderDocsSheets();
}

/** View rows from the live docs.listViews state (docs mode): id · kind ·
 *  primitive count · content-hash prefix (8 chars). Clicking a row selects the
 *  view and fetches its geometry (docs.getViewGeometry). */
function renderDocsViews(): void {
  if (!ui) return;
  ui.docsViewList.replaceChildren();
  if (state.docsViews.length === 0) {
    const p = el("p");
    p.style.cssText = "margin:0 0 8px;font-size:12px;color:var(--muted);";
    p.textContent = "No views yet — seed the documentation set or create a view.";
    ui.docsViewList.append(p);
    return;
  }
  for (const v of state.docsViews) {
    const selected = state.docsSelectedView === v.view.id;
    const b = el("button");
    b.type = "button";
    b.setAttribute("data-testid", `docs-view-row-${v.view.id}`);
    b.setAttribute("role", "listitem");
    b.setAttribute("aria-pressed", selected ? "true" : "false");
    b.setAttribute("aria-label", `Inspect view ${v.view.id} (${v.view.kind})`);
    b.style.cssText =
      "display:block;width:100%;text-align:left;margin-bottom:4px;padding:5px 10px;font-size:11px;font-family:ui-monospace,monospace;" +
      "border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer;" +
      (selected ? "border-color:var(--accent);background:#fff7ed;" : "");
    b.textContent =
      `${v.view.id} · ${v.view.kind} · ${v.primitiveCount} primitives · ` +
      (v.contentHash !== null ? `${v.contentHash.slice(0, 8)}…` : (v.error ?? "not projected"));
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.docsSelectedView = v.view.id;
      void fetchDocsGeometry(v.view.id);
    });
    ui.docsViewList.append(b);
  }
}

/** Sheet rows from the live docs.listSheets state (docs mode). */
function renderDocsSheets(): void {
  if (!ui) return;
  ui.docsSheetList.replaceChildren();
  if (state.docsSheets.length === 0) {
    const p = el("p");
    p.style.cssText = "margin:0 0 8px;font-size:12px;color:var(--muted);";
    p.textContent = "No sheets yet — seed or create one.";
    ui.docsSheetList.append(p);
    return;
  }
  for (const s of state.docsSheets) {
    const row = el("div");
    row.setAttribute("data-testid", `docs-sheet-row-${s.id}`);
    row.setAttribute("role", "listitem");
    row.style.cssText =
      "margin-bottom:4px;padding:5px 10px;font-size:11px;font-family:ui-monospace,monospace;" +
      "border:1px solid var(--border);border-radius:6px;color:var(--fg);";
    row.textContent =
      `${s.id} · ${s.titleBlock.sheetNumber} ${s.titleBlock.sheetTitle} · ${s.viewPlacements.length} view(s) · ${s.titleBlock.projectName}`;
    ui.docsSheetList.append(row);
  }
}

/** Building tree + summary from the last bim.getBuilding query (BIM mode). */
function renderBimTree(): void {
  if (!ui) return;
  const building = state.bimBuilding;
  ui.bimTree.replaceChildren();
  if (building === null || building.stories.length === 0) {
    ui.bimSummary.textContent = "No BIM elements yet — create the mini building.";
    return;
  }
  let total = 0;
  const counts = new Map<string, number>();
  const row = (rec: BimRecord, depth: number): void => {
    total += 1;
    counts.set(rec.type, (counts.get(rec.type) ?? 0) + 1);
    const selected = state.selection.includes(rec.elementId);
    const b = el("button");
    b.type = "button";
    b.setAttribute("data-testid", `bim-element-row-${rec.elementId}`);
    b.setAttribute("role", "listitem");
    b.setAttribute("aria-pressed", selected ? "true" : "false");
    b.setAttribute("aria-label", `Select BIM element ${rec.elementId} (${rec.type})`);
    b.style.cssText =
      "display:block;width:100%;text-align:left;margin-bottom:4px;padding:5px 10px;font-size:11px;font-family:ui-monospace,monospace;" +
      "border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer;" +
      (selected ? "border-color:var(--accent);background:#fff7ed;" : "");
    b.style.marginLeft = `${depth * 18}px`;
    b.textContent = `${rec.elementId} — ${rec.type.replace("bim.", "")}`;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void run("Select BIM", () => command("document.setSelection", { ids: [rec.elementId] }));
    });
    ui!.bimTree.append(b);
  };
  for (const story of building.stories) {
    row(story.story, 0);
    for (const wall of story.walls) {
      row(wall, 1);
      for (const opening of wall.openings) {
        row(opening, 2);
        for (const fill of opening.fills) row(fill, 3);
      }
    }
    for (const slab of story.slabs) row(slab, 1);
    for (const space of story.spaces) row(space, 1);
  }
  const parts = [...counts.entries()].sort().map(([type, n]) => `${n} ${type.replace("bim.", "")}`);
  ui.bimSummary.textContent = `${total} BIM element(s) — ${parts.join(" · ")} (click a row to select)`;
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
