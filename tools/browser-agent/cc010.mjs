/**
 * COMPAT-CAD-010 (Issue #18) — independent black-box browser agent for the
 * G1/G4/G6/G8 Golden workflows through the visible product UI.
 *
 * G1 — Single-family floor plan: geometry + DIMENSIONS + TEXT + the bounded
 *      LIST inspection (the annotation/dimension slice of the workflow).
 * G4 — Precision quadrilateral: relative/polar coordinate entry + closure +
 *      LIST (vertices/area inspection).
 * G6 — Wall section detail: HATCH creation over a closed boundary,
 *      HATCHEDIT, LIST hatch inspection, boundary ERASE cascade + UNDO.
 * G8 — Title-block sheet: TEXT + DIMLINEAR + LIST inspection in the sheet
 *      context.
 *
 * Negative/error paths (typed declines, never fabricated success):
 *  - HATCH over an OPEN boundary (a line) → the bounded-boundary typed
 *    decline at the pick step;
 *  - HATCH with an unsupported pattern (STARS) → the typed decline at the
 *    pattern step;
 *  - LIST is non-mutating (the query reports the unchanged version).
 *
 * The agent uses ONLY the visible workspace, command input, keyboard, canvas
 * and rendered history — no /api/cad calls are made by the test agent. It
 * records machine-readable evidence with the exact target SHA.
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.OFFISOS_WEB_URL ?? "http://127.0.0.1:3100";
const targetSha = process.env.OFFISOS_TARGET_SHA ?? "unknown";
const evidencePath = process.env.OFFISOS_BROWSER_EVIDENCE ?? "cc010-browser-evidence.json";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const failures = [];
const steps = [];

async function record(name, expected, actual, screenshot = false) {
  const ok = expected === actual;
  const entry = { name, expected, actual, pass: ok };
  steps.push(entry);
  if (!ok) failures.push(entry);
  if (screenshot) await page.screenshot({ path: `/tmp/cc010-${name.replace(/[^a-z0-9]+/gi, "-")}.png`, fullPage: false });
  return ok;
}

async function historyText() {
  return await page.getByTestId("command-history").innerText();
}

async function input(text = "", press = null) {
  const el = page.getByTestId("command-input");
  await el.fill(text);
  if (press) await el.press(press);
}

async function submit(text) {
  await input(text, "Enter");
  await page.waitForTimeout(200);
}

async function acceptDefault() {
  await input("", "Enter");
  await page.waitForTimeout(200);
}

async function escapeCommand() {
  await input("", "Escape");
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Workspace bootstrap.
// ---------------------------------------------------------------------------

await page.goto(baseUrl, { waitUntil: "load" });
await page.getByTestId("command-line").waitFor({ timeout: 30000 });
const canvas = page.locator("canvas").first();
await record("G1-initial-workspace", true, (await canvas.count()) > 0, true);
const box = await canvas.boundingBox();
if (!box) throw new Error("Model canvas was not measurable");

// ---------------------------------------------------------------------------
// G1 — floor plan slice: geometry + dimension + text + inspection.
// ---------------------------------------------------------------------------

// A wall-run line pair through the visible command UI.
await submit("LINE");
await page.waitForFunction(() => document.body.innerText.includes("Specify first point"));
await canvas.click({ position: { x: box.width * 0.10, y: box.height * 0.30 } });
await page.waitForFunction(() => document.body.innerText.includes("Specify next point"));
await canvas.click({ position: { x: box.width * 0.55, y: box.height * 0.30 } });
await submit("");
await page.waitForTimeout(300);

// DIMLINEAR over the drawn line: two extension origins + placement.
await submit("DIMLINEAR");
await page.waitForFunction(() => document.body.innerText.includes("first extension line origin"));
await canvas.click({ position: { x: box.width * 0.10, y: box.height * 0.30 } });
await page.waitForFunction(() => document.body.innerText.includes("second extension line origin"));
await canvas.click({ position: { x: box.width * 0.55, y: box.height * 0.30 } });
await page.waitForFunction(() => document.body.innerText.includes("dimension line location"));
await canvas.click({ position: { x: box.width * 0.32, y: box.height * 0.22 } });
await page.waitForTimeout(500);
let h = await historyText();
await record("G1-dimlinear-created", true, h.includes("DIMLINEAR"), true);

// TEXT (the room label).
await submit("TEXT");
await page.waitForFunction(() => document.body.innerText.includes("start point of text"));
await canvas.click({ position: { x: box.width * 0.12, y: box.height * 0.40 } });
await page.waitForFunction(() => document.body.innerText.includes("Specify height"));
await submit("2.5");
await page.waitForFunction(() => document.body.innerText.includes("rotation angle"));
await acceptDefault();
await page.waitForFunction(() => document.body.innerText.includes("Enter text"));
await submit("LIVING ROOM");
await page.waitForTimeout(500);
h = await historyText();
await record("G1-text-created", true, h.includes("LIVING ROOM"));

// LIST inspection of the text + the dimension (the bounded inspection).
await submit("LIST");
await page.waitForFunction(() => document.body.innerText.includes("Select objects to inspect"));
// Pick the text by its baseline point.
await canvas.click({ position: { x: box.width * 0.12, y: box.height * 0.40 } });
await page.waitForTimeout(400);
await submit("");
await page.waitForTimeout(700);
h = await historyText();
await record("G1-list-text", true, h.includes("| text |") && h.includes("LIVING ROOM"));
await record("G1-list-nonmutating", true, h.includes("canonical inspection, non-mutating"));

// Negative path: HATCH over the OPEN line → the bounded-boundary decline.
await submit("HATCH");
await page.waitForFunction(() => document.body.innerText.includes("Select boundary objects"));
await canvas.click({ position: { x: box.width * 0.32, y: box.height * 0.30 } });
await page.waitForTimeout(500);
h = await historyText();
await record(
  "G1-negative-open-boundary",
  true,
  h.includes("closed polyline, rectangle or circle") || h.includes("CLOSED polyline"),
  true,
);
await escapeCommand();

// ---------------------------------------------------------------------------
// G4 — precision quadrilateral: relative/polar typed entry + closure + LIST.
// ---------------------------------------------------------------------------

await submit("POLYLINE");
await page.waitForFunction(() => document.body.innerText.includes("Specify start point"));
await submit("800,800");
await page.waitForFunction(() => document.body.innerText.includes("Specify next vertex"));
// Relative cartesian + polar entries (the G4 precision vocabulary).
await submit("@400,0");
await submit("@400<90");
await submit("@-400,0");
await submit("C");
await page.waitForTimeout(500);
h = await historyText();
await record("G4-polyline-closed", true, h.includes("closed"), true);

// LIST the closed quadrilateral: vertices + area (derived from the stored
// geometry — the deterministic inspection).
await submit("LIST");
await page.waitForFunction(() => document.body.innerText.includes("Select objects to inspect"));
// Pick the quadrilateral through the LAST selection keyword (deterministic,
// coordinate-free — the CC007 selection vocabulary).
await submit("L");
await submit("");
await page.waitForTimeout(700);
h = await historyText();
await record("G4-list-polyline", true, h.includes("| polyline |") && h.includes("4 vertices closed"));
await record("G4-list-area", true, h.includes("area=160000"));

// ---------------------------------------------------------------------------
// G6 — wall section detail: hatch + hatchedit + boundary cascade + undo.
// ---------------------------------------------------------------------------

// A closed wall-section boundary (the section band).
await submit("POLYLINE");
await page.waitForFunction(() => document.body.innerText.includes("Specify start point"));
await canvas.click({ position: { x: box.width * 0.12, y: box.height * 0.65 } });
await page.waitForFunction(() => document.body.innerText.includes("Specify next vertex"));
await canvas.click({ position: { x: box.width * 0.48, y: box.height * 0.65 } });
await canvas.click({ position: { x: box.width * 0.48, y: box.height * 0.85 } });
await canvas.click({ position: { x: box.width * 0.12, y: box.height * 0.85 } });
await submit("C");
await page.waitForTimeout(500);
h = await historyText();
await record("G6-boundary-closed", true, h.includes("closed"));

// Negative path: unsupported pattern STARS → typed decline at the pattern step.
await submit("HATCH");
await page.waitForFunction(() => document.body.innerText.includes("Select boundary objects"));
// Pick the boundary: a point on its top edge.
await canvas.click({ position: { x: box.width * 0.30, y: box.height * 0.65 } });
await page.waitForFunction(() => document.body.innerText.includes("hatch pattern"));
await submit("STARS");
await page.waitForFunction(() => document.body.innerText.includes("pattern scale"));
await submit("1");
await page.waitForFunction(() => document.body.innerText.includes("pattern angle"));
await submit("0");
await page.waitForTimeout(600);
h = await historyText();
await record(
  "G6-negative-unsupported-pattern",
  true,
  h.includes("typed decline") || h.includes("bounded CC010 registry"),
  true,
);

// The supported pattern run: ANSI31 over the same boundary.
await submit("HATCH");
await page.waitForFunction(() => document.body.innerText.includes("Select boundary objects"));
await canvas.click({ position: { x: box.width * 0.30, y: box.height * 0.65 } });
await page.waitForFunction(() => document.body.innerText.includes("hatch pattern"));
await submit("ANSI31");
await page.waitForFunction(() => document.body.innerText.includes("pattern scale"));
await submit("1");
await page.waitForFunction(() => document.body.innerText.includes("pattern angle"));
await acceptDefault();
await page.waitForTimeout(600);
h = await historyText();
await record("G6-hatch-created", true, h.includes("HATCH: pattern ANSI31"), true);

// LIST the hatch: pattern/scale/loops (the canonical stored state).
await submit("LIST");
await page.waitForFunction(() => document.body.innerText.includes("Select objects to inspect"));
// Click INSIDE the hatched band (the even-odd region pick surface).
await canvas.click({ position: { x: box.width * 0.30, y: box.height * 0.75 } });
await page.waitForTimeout(400);
await submit("");
await page.waitForTimeout(700);
h = await historyText();
await record("G6-list-hatch", true, h.includes("| hatch |"));
await record("G6-list-hatch-fields", true, h.includes("pattern=ANSI31") && h.includes("loops=1"));

// HATCHEDIT: scale 2 (Enter keeps pattern + angle).
await submit("HATCHEDIT");
await page.waitForFunction(() => document.body.innerText.includes("Select a hatch to edit"));
await canvas.click({ position: { x: box.width * 0.30, y: box.height * 0.75 } });
await page.waitForFunction(() => document.body.innerText.includes("Enter new pattern"));
await submit("");
await page.waitForFunction(() => document.body.innerText.includes("new pattern scale"));
await submit("2");
await page.waitForFunction(() => document.body.innerText.includes("new pattern angle"));
await submit("");
await page.waitForTimeout(600);
h = await historyText();
await record("G6-hatchedit-scale", true, h.includes("HATCHEDIT") && h.includes("scale 2"));

// Boundary ERASE → the hatch cascade-erases; UNDO restores both. The
// browser-level cascade evidence: the hatch's pick surface VANISHES with
// the boundary (LIST inside the band finds nothing) and UNDO restores it.
await submit("ERASE");
await page.waitForFunction(() => document.body.innerText.includes("Select objects"));
// 6 device px ABOVE the top edge: inside the 10px pickbox of the boundary
// polyline but OUTSIDE the hatch region (the hatch's nearest stroke is on
// the edge itself — the tie breaks to the lower canonical id, the boundary).
await canvas.click({ position: { x: box.width * 0.30, y: box.height * 0.65 - 6 } });
await submit("");
await page.waitForTimeout(600);
h = await historyText();
await record("G6-erase-picked-boundary", true, h.includes("1 found"), true);
// The hatch is pickable nowhere now: a pick inside the band finds nothing.
await submit("LIST");
await page.waitForFunction(() => document.body.innerText.includes("Select objects to inspect"));
await canvas.click({ position: { x: box.width * 0.30, y: box.height * 0.75 } });
await page.waitForTimeout(500);
h = await historyText();
await record("G6-hatch-gone-after-cascade", true, h.includes("0 found"));
await escapeCommand();
// UNDO restores the boundary AND the hatch atomically (one revision).
await submit("UNDO");
await page.waitForTimeout(700);
await submit("LIST");
await page.waitForFunction(() => document.body.innerText.includes("Select objects to inspect"));
await canvas.click({ position: { x: box.width * 0.30, y: box.height * 0.75 } });
await page.waitForTimeout(500);
await submit("");
await page.waitForTimeout(700);
h = await historyText();
await record("G6-undo-restores-hatch", true, h.includes("| hatch |"));

// ---------------------------------------------------------------------------
// G8 — title-block sheet context: text + dimension + inspection.
// ---------------------------------------------------------------------------

await submit("TEXT");
await page.waitForFunction(() => document.body.innerText.includes("start point of text"));
await canvas.click({ position: { x: box.width * 0.75, y: box.height * 0.80 } });
await page.waitForFunction(() => document.body.innerText.includes("Specify height"));
await submit("3.5");
await page.waitForFunction(() => document.body.innerText.includes("rotation angle"));
await acceptDefault();
await page.waitForFunction(() => document.body.innerText.includes("Enter text"));
await submit("A-101 TITLE BLOCK");
await page.waitForTimeout(500);

await submit("DIMLINEAR");
await page.waitForFunction(() => document.body.innerText.includes("first extension line origin"));
await canvas.click({ position: { x: box.width * 0.70, y: box.height * 0.85 } });
await page.waitForFunction(() => document.body.innerText.includes("second extension line origin"));
await canvas.click({ position: { x: box.width * 0.90, y: box.height * 0.85 } });
await page.waitForFunction(() => document.body.innerText.includes("dimension line location"));
await canvas.click({ position: { x: box.width * 0.80, y: box.height * 0.78 } });
await page.waitForTimeout(500);

await submit("LIST");
await page.waitForFunction(() => document.body.innerText.includes("Select objects to inspect"));
await canvas.click({ position: { x: box.width * 0.75, y: box.height * 0.80 } });
await page.waitForTimeout(400);
await submit("");
await page.waitForTimeout(700);
h = await historyText();
await record("G8-list-titleblock-text", true, h.includes("| text |") && h.includes("A-101 TITLE BLOCK"), true);
await record("G8-list-nonmutating", true, h.includes("canonical inspection, non-mutating"));

// ---------------------------------------------------------------------------
// Evidence.
// ---------------------------------------------------------------------------

const evidence = {
  targetSha,
  gate: "COMPAT-CAD-010",
  workflows: ["G1", "G4", "G6", "G8"],
  pass: failures.length === 0,
  steps: steps.map((s) => ({ name: s.name, pass: s.pass, expected: s.expected, actual: s.actual })),
  summary: `${steps.length - failures.length}/${steps.length} steps passed`,
};
await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));
await page.screenshot({ path: "/tmp/cc010-final-state.png", fullPage: false });
await browser.close();
console.log(`CC010 browser gate: ${evidence.summary}`);
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
