// CAD-PARITY-013 / Issue #104: Web host documentation-production workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt-engine command registry (NAVFOLDER/SUBSET/
// NAVASSIGN/LAYOUTMASTER/TITLEBLOCK/TITLEPLACE/REVISION/REVLIST/SCHEDULE/
// SCHLIST/PUBSET/PUBLISHBOOK in commands-documentation.ts) plus the App API
// surface the Documentation palette produces (navigator.createFolder/
// createSubset, docs.updateView folderId, layout.update patches,
// titleblock.create, schedule.create, revision.add/update, publisher.create,
// publisher.run — the SAME HTTP endpoints the palette's transport wrappers
// call; the palette itself is DOM, this smoke proves the wire surface under
// it) — against the running dev server, asserting the document state after
// every step. This is the Web half of the Web/Electron semantic-parity
// evidence (LOCK-004); the pinned fixture
// (app/test/fixtures/cad-parity-013-documentation.json) is the parity basis.
//
// Covers the CAD-PARITY-013 acceptance surface: the document-owned navigator
// (View Map folders + Layout Book subsets, one kind-tagged table with
// parent/kind/order gates), the saved views filed into folders, the layouts
// filed into subsets with the DERIVED deterministic sheet numbering (custom
// B-… subsets vs the L… default), single-level master layouts, the reusable
// title blocks with the deterministic row grammar (180 mm × rows × 12 mm),
// revisions with the fixed deterministic timestamps and the issued lifecycle,
// the schedules/indexes with the closed per-source column vocabulary and the
// FRESH row derivation (schedules.run — never stored), the publisher sets
// with the subset→book-order expansion (publisher.run NON-VERSIONED output
// automation), the report surfaces (REVLIST/SCHLIST with the report.* +
// palette.show ui actions), the typed exchange classification report
// (docs.exchangeReport), and the save/open round-trip preserving the whole
// authored state with stable minted ids.
//
// ENGINE BASIS: the pinned fixture is REFERENCE-adapter basis (the parity
// pattern). Start the dev server with OFFISOS_GEOMETRY_ENGINE=reference.
//
// Reproduce: cd <repo>/apps/web && OFFISOS_GEOMETRY_ENGINE=reference npm run dev -- --webpack -p 3100 &
//            then: node --import tsx apps/web/test/docs-p013-smoke.mjs
//            First run: --write-fixture to pin the fixture.
//            Remote deployment: OFFISOS_WEB_URL=https://<host> node --import tsx apps/web/test/docs-p013-smoke.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-013-documentation.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

const { runCommandScript } = await import(join(REPO_ROOT, "app", "src", "workspace", "prompt-engine.ts"));
const { defaultCommandContext } = await import(join(REPO_ROOT, "app", "src", "workspace", "types.ts"));
const { DEFAULT_SCHEDULE_COLUMNS } = await import(join(REPO_ROOT, "app", "src", "workspace", "commands-documentation.ts"));

async function send(body) {
  const res = await fetch(`${BASE}/api/cad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api: "1", body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const executed = [];
const cmd = (name, payload) => {
  executed.push(name);
  return send({ type: "command", name, payload });
};
const q = (name, payload) => send({ type: "query", name, payload });
const ok = (r) => r.ok === true;
const val = (r) => {
  if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};

const step = (name) => console.log(`DOCS P013 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- document -----------------------------------------------------------------

val(
  await cmd("document.create", {
    entityId: "cad-parity-013-smoke",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-013-smoke",
  }),
);
let snap = val(await q("document.getState", {}));
let activeStoryId = null;
let storyCount = 0;

function context(overrides = {}) {
  // The Documentation command builders resolve names through the CommandContext
  // (CAD-PARITY-013): the docs view table (view titles), the navigator node
  // table (folder/subset names), the title-block and publisher-set tables, and
  // the layout table. The web shell feeds exactly these snapshot tables
  // (engineCtx in shell.tsx) — this smoke mirrors that host contract.
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: snap.elements.length,
    storyCount,
    currentSelection: [],
    layers: snap.layers ?? [],
    textStyles: snap.textStyles ?? [],
    dimStyles: snap.dimStyles ?? [],
    activeStoryId,
    blocks: snap.blockDefs ?? [],
    layouts: snap.layouts ?? [],
    activeLayoutId: snap.draftingSettings?.activeLayout ?? snap.layouts?.[0]?.id ?? null,
    docsViews: snap.docsViews ?? [],
    navigatorNodes: snap.navigatorNodes ?? [],
    titleBlocks: snap.titleBlocks ?? [],
    publisherSets: snap.publisherSets ?? [],
    ...overrides,
  });
}

const echoLines = [];
async function runScript(steps, overrides = {}) {
  const plans = [];
  const responses = [];
  const result = runCommandScript(steps, context(overrides), (plan) => plans.push(plan));
  for (const line of result.lines) echoLines.push(line);
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
      responses.push({ name: entry.name, value: val(res) });
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans, responses };
}

const byName = (table, name) => (snap[table] ?? []).find((r) => r.name === name);
const revisionsOf = () => snap.revisions ?? [];

// --- 1. the document + model + saved views + layouts (direct palette paths) ----

step("document.create + bim.createElements seed + docs.createViews ×2 + layout.create ×2");
{
  // The model seed: one story + one wall (ONE atomic payload = one revision).
  // The story.activate equivalent is the smoke-side activeStoryId tracking
  // (the host's UI-action channel).
  const seed = val(
    await cmd("bim.createElements", {
      entities: [
        { type: "bim.story", id: "story-gf", name: "Ground", level: 0, height: 3000 },
        { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      ],
    }),
  );
  assert(
    JSON.stringify(seed.created) === JSON.stringify(["story-gf", "wall-south"]),
    `the seed created both entities (got ${JSON.stringify(seed.created)})`,
  );
  activeStoryId = "story-gf";
  storyCount = 1;
  snap = val(await q("document.getState", {}));
  assert(snap.elements.length === 2, `two elements (story + wall): got ${snap.elements.length}`);
  assert(snap.elements.find((e) => e.id === "story-gf")?.props?.type === "bim.story", "the story element");
  assert(snap.elements.find((e) => e.id === "wall-south")?.props?.type === "bim.wall", "the wall element");

  // The saved views: a plan of the story + a front elevation (ONE payload).
  const views = val(
    await cmd("docs.createViews", {
      views: [
        { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
        { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
      ],
    }),
  );
  assert(
    JSON.stringify(views.created) === JSON.stringify(["vw-000001", "vw-000002"]),
    `two views minted (got ${JSON.stringify(views.created)})`,
  );
  snap = val(await q("document.getState", {}));
  assert((snap.docsViews ?? []).length === 2, "the view table carries both views");
  assert(snap.docsViews[0].kind === "plan" && snap.docsViews[0].title === "Ground Floor Plan", "the plan view record");
  assert(snap.docsViews[1].kind === "elevation" && snap.docsViews[1].direction === "front", "the elevation view record");

  // The two layouts (the direct palette path).
  const gfLayout = val(await cmd("layout.create", { name: "Ground Floor" }));
  assert(gfLayout.layoutId === "lo-000001", `Ground Floor layout id (got ${gfLayout.layoutId})`);
  const coverLayout = val(await cmd("layout.create", { name: "Cover Sheet" }));
  assert(coverLayout.layoutId === "lo-000002", `Cover Sheet layout id (got ${coverLayout.layoutId})`);
  snap = val(await q("document.getState", {}));
  assert((snap.layouts ?? []).length === 2, "two layouts");
  assert(byName("layouts", "Ground Floor") !== undefined && byName("layouts", "Cover Sheet") !== undefined, "layout names");
}

// --- 2. the shared prompt-engine registry stream -------------------------------

step("NAVFOLDER 'Plans' (root) + SUBSET 'Structural' [A] none + SUBSET 'Custom Set' [B] custom 01");
{
  const { result: nvf } = await runScript([
    { event: { type: "typed", text: "NAVFOLDER" } },
    { event: { type: "typed", text: "Plans" } },
    { event: { type: "enter" } }, // parent folder <root>
  ]);
  assert(nvf.lines.includes("NAVFOLDER: 'Plans'."), `the NAVFOLDER echo (got ${nvf.lines.join(" / ")})`);
  const plans = byName("navigatorNodes", "Plans");
  assert(
    plans !== undefined && plans.id === "nav-000001" && plans.kind === "folder" &&
      plans.parentId === null && plans.order === 1,
    `the Plans folder node (got ${JSON.stringify(plans)})`,
  );

  const { result: sub1 } = await runScript([
    { event: { type: "typed", text: "SUBSET" } },
    { event: { type: "typed", text: "Structural" } },
    { event: { type: "enter" } }, // parent subset <root>
    { event: { type: "enter" } }, // prefix <A>
    { event: { type: "enter" } }, // numbering <none>
    { event: { type: "enter" } }, // custom start <01> (unused under numbering none)
  ]);
  assert(
    sub1.lines.includes("SUBSET: 'Structural' [A] numbering none."),
    `the SUBSET none echo (got ${sub1.lines.join(" / ")})`,
  );
  const structural = byName("navigatorNodes", "Structural");
  assert(
    structural !== undefined && structural.id === "nav-000002" && structural.kind === "subset" &&
      structural.parentId === null && structural.prefix === "A" && structural.numbering === undefined &&
      structural.order === 1,
    `the Structural subset node (got ${JSON.stringify(structural)})`,
  );

  const { result: sub2 } = await runScript([
    { event: { type: "typed", text: "SUBSET" } },
    { event: { type: "typed", text: "Custom Set" } },
    { event: { type: "enter" } }, // parent subset <root>
    { event: { type: "typed", text: "B" } }, // prefix
    { event: { type: "typed", text: "CUSTOM" } }, // the numbering flag
    { event: { type: "enter" } }, // numbering <none> (the flag wins)
    { event: { type: "enter" } }, // custom start <01> — completes
  ]);
  assert(
    sub2.lines.includes("SUBSET: 'Custom Set' [B] numbering custom from 01."),
    `the SUBSET custom echo (got ${sub2.lines.join(" / ")})`,
  );
  const custom = byName("navigatorNodes", "Custom Set");
  assert(
    custom !== undefined && custom.id === "nav-000003" && custom.kind === "subset" &&
      custom.prefix === "B" && custom.numbering === "custom" && custom.customNumber === "01" &&
      custom.order === 2,
    `the Custom Set subset node (got ${JSON.stringify(custom)})`,
  );
}

step("NAVASSIGN view 'Ground Floor Plan' → 'Plans' + NAVASSIGN layout 'Ground Floor' → 'Structural'");
{
  const { result: na1 } = await runScript([
    { event: { type: "typed", text: "NAVASSIGN" } },
    { event: { type: "typed", text: "VIEW" } }, // the kind flag
    { event: { type: "enter" } }, // kind <view> (the flag wins — the MATERIAL category pattern)
    { event: { type: "typed", text: "Ground Floor Plan" } },
    { event: { type: "typed", text: "Plans" } },
  ]);
  assert(
    na1.lines.includes("NAVASSIGN: view 'Ground Floor Plan' → 'Plans'."),
    `the NAVASSIGN view echo (got ${na1.lines.join(" / ")})`,
  );
  snap = val(await q("document.getState", {}));
  assert(
    snap.docsViews.find((v) => v.title === "Ground Floor Plan").folderId === "nav-000001",
    "the plan view is filed under Plans (docs.updateView folderId)",
  );

  const { result: na2 } = await runScript([
    { event: { type: "typed", text: "NAVASSIGN" } },
    { event: { type: "typed", text: "LAYOUT" } }, // the kind flag
    { event: { type: "enter" } }, // kind <view> default — the LAYOUT flag wins
    { event: { type: "typed", text: "Ground Floor" } },
    { event: { type: "typed", text: "Structural" } },
  ]);
  assert(
    na2.lines.includes("NAVASSIGN: layout 'Ground Floor' → 'Structural'."),
    `the NAVASSIGN layout echo (got ${na2.lines.join(" / ")})`,
  );
  snap = val(await q("document.getState", {}));
  assert(
    byName("layouts", "Ground Floor").subsetId === "nav-000002",
    "the Ground Floor layout is filed under Structural (layout.update subsetId)",
  );
}

step("TITLEBLOCK 'Standard' (Project/Layout/Sheet/Revisions/Author) + TITLEPLACE at (10, 10)");
{
  const { result: tb } = await runScript([
    { event: { type: "typed", text: "TITLEBLOCK" } },
    { event: { type: "typed", text: "Standard" } },
    { event: { type: "typed", text: "Offisos Tower" } },
    { event: { type: "typed", text: "Z" } }, // the author row
    { event: { type: "enter" } }, // date <omit>
  ]);
  assert(
    tb.lines.includes("TITLEBLOCK: 'Standard' — 5 rows, 180×60 mm."),
    `the TITLEBLOCK echo (got ${tb.lines.join(" / ")})`,
  );
  const standard = byName("titleBlocks", "Standard");
  assert(
    standard !== undefined && standard.id === "tb-000001" && standard.widthMm === 180 &&
      standard.heightMm === 60 && standard.rowHeightMm === 12,
    `the Standard title block geometry (got ${JSON.stringify(standard)})`,
  );
  assert(
    JSON.stringify(standard.rows) === JSON.stringify([
      { label: "Project", field: "text", value: "Offisos Tower" },
      { label: "Layout", field: "layoutName" },
      { label: "Sheet", field: "sheetNumber" },
      { label: "Revisions", field: "revisions" },
      { label: "Author", field: "text", value: "Z" },
    ]),
    `the deterministic row set (got ${JSON.stringify(standard.rows)})`,
  );

  const { result: tp } = await runScript([
    { event: { type: "typed", text: "TITLEPLACE" } },
    { event: { type: "typed", text: "Ground Floor" } },
    { event: { type: "typed", text: "Standard" } },
    { event: { type: "enter" } }, // x <10>
    { event: { type: "enter" } }, // y <10>
  ]);
  assert(
    tp.lines.includes("TITLEPLACE: 'Ground Floor' ← 'Standard' at (10, 10) mm."),
    `the TITLEPLACE echo (got ${tp.lines.join(" / ")})`,
  );
  snap = val(await q("document.getState", {}));
  const gf = byName("layouts", "Ground Floor");
  assert(
    JSON.stringify(gf.titleBlockPlacement) === JSON.stringify({ titleBlockId: "tb-000001", xMm: 10, yMm: 10 }),
    `the placement patch (got ${JSON.stringify(gf.titleBlockPlacement)})`,
  );
}

step("REVISION 'P01' + REVISION 'P02' (layout 'Ground Floor') + the layout revision link");
{
  const { result: r1 } = await runScript([
    { event: { type: "typed", text: "REVISION" } },
    { event: { type: "typed", text: "P01" } },
    { event: { type: "typed", text: "First issue" } },
    { event: { type: "typed", text: "Ground Floor" } },
  ]);
  assert(
    r1.lines.includes("REVISION: 'P01' — 1 layout(s)."),
    `the REVISION P01 echo (got ${r1.lines.join(" / ")})`,
  );
  const p01 = revisionsOf()[0];
  assert(
    JSON.stringify(p01) === JSON.stringify({
      id: "rev-000001",
      code: "P01",
      description: "First issue",
      issued: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      layoutIds: ["lo-000001"],
    }),
    `the P01 record with the fixed deterministic timestamp (got ${JSON.stringify(p01)})`,
  );

  const { result: r2 } = await runScript([
    { event: { type: "typed", text: "REVISION" } },
    { event: { type: "typed", text: "P02" } },
    { event: { type: "typed", text: "Coordination update" } },
    { event: { type: "typed", text: "Ground Floor" } },
  ]);
  assert(
    r2.lines.includes("REVISION: 'P02' — 1 layout(s)."),
    `the REVISION P02 echo (got ${r2.lines.join(" / ")})`,
  );

  // The layout-side revision link (layout.update revisionIds — the book
  // surfaces + title-block "Revisions" rows join through it).
  val(await cmd("layout.update", { id: "lo-000001", patch: { revisionIds: ["rev-000001", "rev-000002"] } }));
  snap = val(await q("document.getState", {}));
  assert(
    JSON.stringify(byName("layouts", "Ground Floor").revisionIds) === JSON.stringify(["rev-000001", "rev-000002"]),
    "the layout carries both revisions",
  );
}

step("REVLIST (instant) — the report ui actions + the palette focus");
{
  const { plans, result } = await runScript([{ event: { type: "typed", text: "REVLIST" } }]);
  assert(plans.length === 1, "REVLIST is instant (one plan)");
  assert(plans[0].appApi.length === 0, "REVLIST emits no app-api commands");
  assert(
    JSON.stringify(plans[0].ui) === JSON.stringify([
      { action: "report.revisions" },
      { action: "palette.show", payload: { palette: "layouts" } },
    ]),
    `REVLIST ui actions (got ${JSON.stringify(plans[0].ui)})`,
  );
  assert(result.lines.includes("REVLIST."), "the REVLIST echo line");
}

step("SCHEDULE 'Wall Schedule' (elements, type bim.wall) + SCHEDULE 'View Index' (views)");
{
  const { result: s1 } = await runScript([
    { event: { type: "typed", text: "SCHEDULE" } },
    { event: { type: "typed", text: "Wall Schedule" } },
    { event: { type: "typed", text: "EL" } }, // the source flag
    { event: { type: "enter" } }, // source <elements> (the flag wins)
    { event: { type: "typed", text: "bim.wall" } }, // the type filter — completes
  ]);
  assert(
    s1.lines.includes("SCHEDULE: 'Wall Schedule' (elements, type bim.wall) — 9 columns."),
    `the Wall Schedule echo (got ${s1.lines.join(" / ")})`,
  );
  const wall = byName("schedules", "Wall Schedule");
  assert(
    wall !== undefined && wall.id === "sch-000001" && wall.source === "elements" &&
      JSON.stringify(wall.filter) === JSON.stringify({ type: "bim.wall" }),
    `the Wall Schedule record (got ${JSON.stringify(wall)})`,
  );
  assert(
    JSON.stringify(wall.columns) === JSON.stringify(DEFAULT_SCHEDULE_COLUMNS.elements),
    "the DEFAULT full elements column set (the registry's closed vocabulary)",
  );

  const { result: s2 } = await runScript([
    { event: { type: "typed", text: "SCHEDULE" } },
    { event: { type: "typed", text: "View Index" } },
    { event: { type: "typed", text: "VIE" } }, // the source flag
    { event: { type: "enter" } }, // source <elements> default — the VIE flag wins
    { event: { type: "enter" } }, // type filter <none> (last optional step — completes)
  ]);
  assert(
    s2.lines.includes("SCHEDULE: 'View Index' (views) — 7 columns."),
    `the View Index echo (got ${s2.lines.join(" / ")})`,
  );
  const viewIndex = byName("schedules", "View Index");
  assert(
    viewIndex !== undefined && viewIndex.id === "sch-000002" && viewIndex.source === "views" &&
      viewIndex.filter === undefined && JSON.stringify(viewIndex.columns) === JSON.stringify(DEFAULT_SCHEDULE_COLUMNS.views),
    "the View Index record with the views column set",
  );
}

step("SCHLIST (instant) — the report ui actions + the palette focus");
{
  const { plans, result } = await runScript([{ event: { type: "typed", text: "SCHLIST" } }]);
  assert(plans.length === 1, "SCHLIST is instant (one plan)");
  assert(plans[0].appApi.length === 0, "SCHLIST emits no app-api commands");
  assert(
    JSON.stringify(plans[0].ui) === JSON.stringify([
      { action: "report.schedule" },
      { action: "palette.show", payload: { palette: "schedules" } },
    ]),
    `SCHLIST ui actions (got ${JSON.stringify(plans[0].ui)})`,
  );
  assert(result.lines.includes("SCHLIST."), "the SCHLIST echo line");
}

step("LAYOUTMASTER 'Cover Sheet' master ← 'Ground Floor'");
{
  const { result } = await runScript([
    { event: { type: "typed", text: "LAYOUTMASTER" } },
    { event: { type: "typed", text: "Cover Sheet" } },
    { event: { type: "typed", text: "Ground Floor" } },
  ]);
  assert(
    result.lines.includes("LAYOUTMASTER: 'Cover Sheet' master ← 'Ground Floor'."),
    `the LAYOUTMASTER echo (got ${result.lines.join(" / ")})`,
  );
  snap = val(await q("document.getState", {}));
  assert(byName("layouts", "Cover Sheet").masterId === "lo-000001", "the master assignment");
  assert(byName("layouts", "Ground Floor").masterId === undefined, "Ground Floor stays masterless (single-level)");
}

step("PUBSET 'Issue Set' (subset:Structural | layout:Cover Sheet) + PUBLISHBOOK (NON-VERSIONED)");
let publishRun;
{
  const { result: ps } = await runScript([
    { event: { type: "typed", text: "PUBSET" } },
    { event: { type: "typed", text: "Issue Set" } },
    { event: { type: "typed", text: "subset:Structural|layout:Cover Sheet" } },
  ]);
  assert(
    ps.lines.includes("PUBSET: 'Issue Set' — 2 item(s)."),
    `the PUBSET echo (got ${ps.lines.join(" / ")})`,
  );
  const issueSet = byName("publisherSets", "Issue Set");
  assert(
    issueSet !== undefined && issueSet.id === "pub-000001" &&
      JSON.stringify(issueSet.items) === JSON.stringify([
        { kind: "subset", id: "nav-000002", format: "pdf" },
        { kind: "layout", id: "lo-000002", format: "pdf" },
      ]),
    `the Issue Set items (got ${JSON.stringify(issueSet)})`,
  );

  const versionsBefore = snap.modelHistory?.revisions?.length ?? 0;
  const { result: pb, responses } = await runScript([
    { event: { type: "typed", text: "PUBLISHBOOK" } },
    { event: { type: "typed", text: "Issue Set" } },
  ]);
  assert(pb.lines.includes("PUBLISHBOOK: 'Issue Set'."), `the PUBLISHBOOK echo (got ${pb.lines.join(" / ")})`);
  snap = val(await q("document.getState", {}));
  assert(
    (snap.modelHistory?.revisions?.length ?? 0) === versionsBefore,
    `PUBLISHBOOK adds NO revision (non-versioned output automation): ${versionsBefore} → ${snap.modelHistory?.revisions?.length}`,
  );
  publishRun = responses.find((r) => r.name === "publisher.run")?.value;
  assert(publishRun !== undefined, "the PUBLISHBOOK plan executed publisher.run");
  assert(
    JSON.stringify(publishRun.pages.map((p) => [p.layoutId, p.layoutName, p.format, p.revisions])) ===
      JSON.stringify([
        ["lo-000001", "Ground Floor", "pdf", ["P01", "P02"]],
        ["lo-000002", "Cover Sheet", "pdf", []],
      ]),
    `the run pages in book order with the revision join (got ${JSON.stringify(publishRun.pages.map((p) => [p.layoutId, p.layoutName, p.format, p.revisions]))})`,
  );
  assert(
    publishRun.pages.every((p) => typeof p.sha256 === "string" && /^[0-9a-f]{64}$/.test(p.sha256)),
    "every page carries its deterministic sha256",
  );
  assert(
    typeof publishRun.pdfSha256 === "string" && /^[0-9a-f]{64}$/.test(publishRun.pdfSha256) &&
      Number.isInteger(publishRun.pdfSize) && publishRun.pdfSize > 0,
    "the multi-page PDF hash + size",
  );
}

// --- 3. the palette-path direct commands (bypassing the engine) ----------------

step("palette path: navigator.createFolder 'Elevations' + docs.updateView + titleblock 'Minimal' + schedule + revision");
{
  const versionsBefore = snap.modelHistory?.revisions?.length ?? 0;

  // The View-Map folder create form (navigatorCreateFolder transport).
  const elevations = val(await cmd("navigator.createFolder", { name: "Elevations" }));
  assert(
    elevations.node.id === "nav-000004" && elevations.node.kind === "folder" &&
      elevations.node.name === "Elevations" && elevations.node.parentId === null && elevations.node.order === 2,
    `the Elevations folder (got ${JSON.stringify(elevations.node)})`,
  );
  assert(elevations.snapshot !== undefined, "the folder create ok value carries the snapshot");

  // The view-assign form (docsUpdateViewFolder transport → raw docs.updateView).
  val(await cmd("docs.updateView", { viewId: "vw-000002", patch: { folderId: "nav-000004" } }));
  snap = val(await q("document.getState", {}));
  assert(
    snap.docsViews.find((v) => v.title === "Front Elevation").folderId === "nav-000004",
    "the elevation view filed under Elevations (the palette assign path)",
  );

  // The title-block create form with a LITERAL rows array (titleblockCreate).
  val(
    await cmd("titleblock.create", {
      name: "Minimal",
      widthMm: 120,
      heightMm: 24,
      rowHeightMm: 12,
      rows: [
        { label: "Project", field: "text", value: "Offisos Tower" },
        { label: "Sheet", field: "sheetNumber" },
      ],
    }),
  );
  snap = val(await q("document.getState", {}));
  const minimal = byName("titleBlocks", "Minimal");
  assert(
    minimal !== undefined && minimal.id === "tb-000002" && minimal.widthMm === 120 && minimal.heightMm === 24,
    `the Minimal title block (got ${JSON.stringify(minimal)})`,
  );
  assert(minimal.rows.length === 2 && minimal.rows[1].field === "sheetNumber", "the literal rows array");

  // The schedule create form over the materials source (scheduleCreate; the
  // panel mirrors DEFAULT_SCHEDULE_COLUMNS.materials client-side — the same
  // closed vocabulary the registry command pins).
  val(
    await cmd("schedule.create", {
      name: "Material Schedule",
      source: "materials",
      columns: DEFAULT_SCHEDULE_COLUMNS.materials,
    }),
  );
  snap = val(await q("document.getState", {}));
  const materialSchedule = byName("schedules", "Material Schedule");
  assert(
    materialSchedule !== undefined && materialSchedule.id === "sch-000003" && materialSchedule.source === "materials",
    `the Material Schedule (got ${JSON.stringify(materialSchedule)})`,
  );

  // The revision form (revisionAdd with layoutIds [], issued starts false).
  const p03 = val(await cmd("revision.add", { code: "P03", description: "Palette issue", layoutIds: [] }));
  assert(
    p03.revision.id === "rev-000003" && p03.revision.code === "P03" && p03.revision.issued === false &&
      JSON.stringify(p03.revision.layoutIds) === JSON.stringify([]) &&
      p03.revision.createdAt === "2026-01-01T00:00:00.000Z",
    `the palette revision record (got ${JSON.stringify(p03.revision)})`,
  );

  // The publisher create form (publisherCreate with ONE subset item).
  val(
    await cmd("publisher.create", {
      name: "Custom Book",
      items: [{ kind: "subset", id: "nav-000003", format: "pdf" }],
    }),
  );
  snap = val(await q("document.getState", {}));
  const customBook = byName("publisherSets", "Custom Book");
  assert(
    customBook !== undefined && customBook.id === "pub-000002" && customBook.items.length === 1,
    `the Custom Book set (got ${JSON.stringify(customBook)})`,
  );

  // Version math: one revision per palette-path mutating command above
  // (folder, view assign, title block, schedule, revision, publisher set).
  snap = val(await q("document.getState", {}));
  assert(
    (snap.modelHistory?.revisions?.length ?? 0) === versionsBefore + 6,
    `+6 revisions for the six palette mutations (got +${(snap.modelHistory?.revisions?.length ?? 0) - versionsBefore})`,
  );

  // The issued flip through revisionUpdate (the LAST mutating command — the
  // undo/redo proof target below).
  const flip = val(await cmd("revision.update", { id: "rev-000003", patch: { issued: true } }));
  assert(flip.revision.issued === true, "the issued flip took");
  snap = val(await q("document.getState", {}));
  assert((snap.modelHistory?.revisions?.length ?? 0) === versionsBefore + 7, "+1 for the issued flip");
}

// --- 4. the queries + reports ----------------------------------------------------

step("navigator.tree — the project map, the View Map, the Layout Book, the publisher sets");
let treeJson;
{
  const tree = val(await q("navigator.tree", {}));
  const tree2 = val(await q("navigator.tree", {}));
  treeJson = JSON.stringify(tree);
  assert(treeJson === JSON.stringify(tree2), "navigator.tree is deterministic across a double run");

  // projectMap: one story with the wall as its only counted element.
  assert(
    JSON.stringify(tree.projectMap.stories) === JSON.stringify([
      { id: "story-gf", name: "Ground", level: 0, height: 3000, elementCount: 1 },
    ]),
    `the project map (got ${JSON.stringify(tree.projectMap.stories)})`,
  );

  // viewMap: the plan view under Plans, the elevation under Elevations.
  assert(tree.viewMap.views.length === 0, "no root views (both filed into folders)");
  const plansBranch = tree.viewMap.children.find((c) => c.node.name === "Plans");
  const elevationsBranch = tree.viewMap.children.find((c) => c.node.name === "Elevations");
  assert(plansBranch !== undefined && elevationsBranch !== undefined, "both folder branches");
  assert(
    plansBranch.node.id === "nav-000001" && plansBranch.children.length === 0 &&
      plansBranch.views.length === 1 && plansBranch.views[0].viewId === "vw-000001" &&
      plansBranch.views[0].kind === "plan" && plansBranch.views[0].title === "Ground Floor Plan" &&
      plansBranch.views[0].scale === 50,
    `the Plans branch (got ${JSON.stringify(plansBranch)})`,
  );
  assert(
    typeof plansBranch.views[0].contentHash === "string" && /^[0-9a-f]{64}$/.test(plansBranch.views[0].contentHash),
    "the fresh view content hash",
  );
  assert(
    elevationsBranch.node.id === "nav-000004" && elevationsBranch.views.length === 1 &&
      elevationsBranch.views[0].viewId === "vw-000002" && elevationsBranch.views[0].kind === "elevation",
    `the Elevations branch (got ${JSON.stringify(elevationsBranch)})`,
  );

  // layoutBook: Ground Floor under Structural (L-numbered — numbering none),
  // Cover Sheet at root with the master; the empty Custom Set branch.
  assert(tree.layoutBook.layouts.length === 1, "one root layout (Cover Sheet)");
  const cover = tree.layoutBook.layouts[0];
  assert(
    JSON.stringify([cover.layoutId, cover.name, cover.sheetNumber, cover.masterId, cover.titleBlockId, cover.revisionCodes]) ===
      JSON.stringify(["lo-000002", "Cover Sheet", "L02", "lo-000001", undefined, []]),
    `the root Cover Sheet row (got ${JSON.stringify(cover)})`,
  );
  const structuralBranch = tree.layoutBook.children.find((c) => c.node.name === "Structural");
  assert(structuralBranch !== undefined, "the Structural branch");
  const gfRow = structuralBranch.layouts[0];
  assert(
    JSON.stringify([gfRow.layoutId, gfRow.name, gfRow.sheetNumber, gfRow.masterId, gfRow.titleBlockId, gfRow.revisionCodes]) ===
      JSON.stringify(["lo-000001", "Ground Floor", "L01", undefined, "tb-000001", ["P01", "P02"]]),
    `the Ground Floor book row (got ${JSON.stringify(gfRow)})`,
  );
  const customBranch = tree.layoutBook.children.find((c) => c.node.name === "Custom Set");
  assert(
    customBranch !== undefined && customBranch.layouts.length === 0 && customBranch.children.length === 0,
    "the empty Custom Set branch (custom numbering grammar, no layouts filed)",
  );

  // publisherSets registry.
  assert(
    JSON.stringify(tree.publisherSets) === JSON.stringify([
      { id: "pub-000001", name: "Issue Set", itemCount: 2 },
      { id: "pub-000002", name: "Custom Book", itemCount: 1 },
    ]),
    `the publisher set registry (got ${JSON.stringify(tree.publisherSets)})`,
  );

  // A third identical run (the pinned stability proof).
  assert(JSON.stringify(val(await q("navigator.tree", {}))) === treeJson, "navigator.tree identical on a third run");
}

step("schedules.run — the fresh deterministic rows (wall + views + materials)");
let wallRun;
{
  const run1 = val(await q("schedules.run", { id: "sch-000001" }));
  const run2 = val(await q("schedules.run", { id: "sch-000001" }));
  wallRun = run1;
  assert(JSON.stringify(run1) === JSON.stringify(run2), "the wall schedule run is deterministic across a double run");
  assert(run1.rowCount === 1, `one wall row (got ${run1.rowCount})`);
  assert(
    JSON.stringify(run1.rows) === JSON.stringify([
      ["wall-south", "bim.wall", "-", "Ground", "-", "-", "-", "existing", "-"],
    ]),
    `the wall row cells (got ${JSON.stringify(run1.rows)})`,
  );
  assert(
    run1.sha256 === sha(JSON.stringify(run1.rows)),
    `the run sha256 is the canonical serialization of the rows (got ${run1.sha256})`,
  );
  assert(run1.schedule.name === "Wall Schedule", "the run echoes its schedule record");

  const viewRun = val(await q("schedules.run", { id: "sch-000002" }));
  assert(viewRun.rowCount === 2, `two view rows (got ${viewRun.rowCount})`);
  assert(
    viewRun.rows.map((r) => [r[0], r[1], r[2], r[3], r[4]]).join(";") ===
      "vw-000001,plan,Ground Floor Plan,50,Plans;vw-000002,elevation,Front Elevation,50,Elevations",
    `the view rows filed into their folders (got ${JSON.stringify(viewRun.rows)})`,
  );

  const materialRun = val(await q("schedules.run", { id: "sch-000003" }));
  assert(materialRun.rowCount === 0, "the materials schedule runs empty (no bim.material elements in this document)");
  const materialRun2 = val(await q("schedules.run", { id: "sch-000003" }));
  assert(JSON.stringify(materialRun) === JSON.stringify(materialRun2), "the empty materials run is deterministic");
}

step("revisions.list + publisher.list + docs.exchangeReport");
let revisionsJson;
{
  const revisions = val(await q("revisions.list", {}));
  revisionsJson = JSON.stringify(revisions);
  assert(
    JSON.stringify(revisions.revisions.map((r) => [r.id, r.code, r.description, r.issued])) === JSON.stringify([
      ["rev-000001", "P01", "First issue", false],
      ["rev-000002", "P02", "Coordination update", false],
      ["rev-000003", "P03", "Palette issue", true],
    ]),
    `the three revisions with the issued flags (got ${JSON.stringify(revisions)})`,
  );
  assert(
    revisions.revisions.every((r) => r.createdAt === "2026-01-01T00:00:00.000Z") &&
      JSON.stringify(revisions.revisions[2].layoutIds) === JSON.stringify([]),
    "the deterministic timestamps + the palette revision's empty layoutIds",
  );

  const publisher = val(await q("publisher.list", {}));
  assert(
    publisher.publisherSets.length === 2 &&
      publisher.publisherSets[0].name === "Issue Set" && publisher.publisherSets[1].name === "Custom Book" &&
      publisher.publisherSets[1].items.length === 1,
    `the publisher table (got ${JSON.stringify(publisher)})`,
  );

  const report = val(await q("docs.exchangeReport", {}));
  assert(report.contract === "offisos-docs-exchange/1", "the exchange contract string");
  assert(report.classifications.length === 9, `nine classifications (got ${report.classifications.length})`);
  assert(
    report.classifications.map((c) => [c.concept, c.classification]).join(";") ===
      "model-elements,exact;navigator-structure,unsupported;saved-views,unsupported;sheets,unsupported;" +
      "layouts,unsupported;title-blocks,unsupported;schedules,lossy;revisions,unsupported;publisher-sets,unsupported",
    "the typed classification vocabulary",
  );
  assert(
    JSON.stringify(report.counts) === JSON.stringify({
      views: 2,
      sheets: 0,
      layouts: 2,
      titleBlocks: 2,
      schedules: 3,
      revisions: 3,
      publisherSets: 2,
      navigatorNodes: 4,
    }),
    `the live table counts (got ${JSON.stringify(report.counts)})`,
  );
}

// --- 5. undo/redo + save/open/determinism ----------------------------------------

step("undo/redo the issued flip (the exact inverse restores the record)");
{
  const before = JSON.stringify(revisionsOf().find((r) => r.id === "rev-000003"));
  const undoRes = val(await cmd("document.undo", {}));
  snap = val(await q("document.getState", {}));
  const after = JSON.stringify(revisionsOf().find((r) => r.id === "rev-000003"));
  assert(after !== before, "the undo changed the P03 record");
  assert(revisionsOf().find((r) => r.id === "rev-000003").issued === false, "the undo restored issued=false");
  assert(undoRes.undone.type === "updateRevision", `the undone edit kind (got ${JSON.stringify(undoRes.undone).slice(0, 120)})`);

  val(await cmd("document.redo", {}));
  snap = val(await q("document.getState", {}));
  assert(revisionsOf().find((r) => r.id === "rev-000003").issued === true, "the redo restored issued=true");
  assert(JSON.stringify(revisionsOf().find((r) => r.id === "rev-000003")) === before, "the redo restored the record bit-for-bit");

  // The whole-stream version math: one revision per mutating command, then
  // the undo/redo journal entries (undo is itself versioned — the journal
  // records both directions while the STATE is the final one).
  const versioned = 25;
  assert(
    (snap.modelHistory?.revisions?.length ?? 0) === versioned + 2,
    `the version math: 25 mutating commands + 2 journal entries = ${snap.modelHistory?.revisions?.length}`,
  );
}

step("save/open round-trip — the documentation state survives with stable ids");
{
  const saved1 = val(await cmd("document.save", {}));
  const saved2 = val(await cmd("document.save", {}));
  assert(
    sha(JSON.stringify(saved1.bytes)) === sha(JSON.stringify(saved2.bytes)),
    "double-save is byte-identical",
  );

  val(await cmd("document.open", { source: saved1.bytes, entityId: "cad-parity-013-smoke-reopened" }));
  snap = val(await q("document.getState", {}));
  assert(snap.elements.length === 2, "the model seed survives");
  assert(
    JSON.stringify(val(await q("navigator.tree", {}))) === treeJson,
    "the navigator tree is identical after the round-trip (stable ids)",
  );
  const wallRunAfter = val(await q("schedules.run", { id: "sch-000001" }));
  assert(JSON.stringify(wallRunAfter) === JSON.stringify(wallRun), "the wall schedule run is identical after the round-trip");
  assert(JSON.stringify(val(await q("revisions.list", {}))) === revisionsJson, "the revision table is identical after the round-trip");
  const runAfter = val(await cmd("publisher.run", { id: "pub-000001" }));
  assert(
    JSON.stringify(runAfter.pages.map((p) => [p.layoutId, p.revisions, p.sha256])) ===
      JSON.stringify(publishRun.pages.map((p) => [p.layoutId, p.revisions, p.sha256])) &&
      runAfter.pdfSha256 === publishRun.pdfSha256 && runAfter.pdfSize === publishRun.pdfSize,
    "the publisher run artifacts are identical after the round-trip",
  );
  assert(
    (snap.modelHistory?.revisions?.length ?? 0) === 27,
    `the version count survives the round-trip (publisher.run added none): got ${snap.modelHistory?.revisions?.length}`,
  );
}

// --- 6. the pinned fixture ---------------------------------------------------------

step("fixture");

const sA = val(await cmd("document.save", {}));
const sB = val(await cmd("document.save", {}));
assert(sha(JSON.stringify(sA.bytes)) === sha(JSON.stringify(sB.bytes)), "save must be deterministic");
snap = val(await q("document.getState", {}));

const tree = val(await q("navigator.tree", {}));
const finalWallRun = val(await q("schedules.run", { id: "sch-000001" }));
const finalRun = val(await cmd("publisher.run", { id: "pub-000001" }));
const exchangeReport = val(await q("docs.exchangeReport", {}));

const fixture = {
  saveSha256: sha(JSON.stringify(sA.bytes)),
  saveSize: sA.bytes.length,
  elements: snap.elements.length,
  viewCount: snap.docsViews.length,
  folderCount: (snap.navigatorNodes ?? []).filter((n) => n.kind === "folder").length,
  subsetCount: (snap.navigatorNodes ?? []).filter((n) => n.kind === "subset").length,
  layoutCount: snap.layouts.length,
  titleBlockCount: (snap.titleBlocks ?? []).length,
  scheduleCount: (snap.schedules ?? []).length,
  revisionCount: (snap.revisions ?? []).length,
  publisherSetCount: (snap.publisherSets ?? []).length,
  treeSha256: sha(JSON.stringify(tree)),
  scheduleRunSha256: sha(JSON.stringify(finalWallRun)),
  publisherRunSha256: sha(JSON.stringify(finalRun)),
  exchangeReportSha256: sha(JSON.stringify(exchangeReport)),
  echoDigest: sha(echoLines.join("\n")),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`DOCS P013 SMOKE: fixture written → ${FIXTURE_PATH}`);
} else {
  const pinned = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  let mismatch = null;
  for (const key of Object.keys(pinned)) {
    const a = JSON.stringify(pinned[key]);
    const b = JSON.stringify(fixture[key]);
    if (a !== b) {
      mismatch = `${key}: pinned ${a.slice(0, 80)} ≠ actual ${b.slice(0, 80)}`;
      break;
    }
  }
  if (mismatch !== null) {
    throw new Error(`FIXTURE MISMATCH — ${mismatch}`);
  }
  console.log(`DOCS P013 SMOKE: fixture match (${pinned.saveSha256.slice(0, 8)}…, ${executed.length} commands)`);
}

console.log(`DOCS P013 SMOKE: PASS (${executed.length} commands, ${echoLines.length} echo lines)`);
