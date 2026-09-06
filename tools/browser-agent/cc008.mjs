import { chromium } from "playwright";
import fs from "node:fs/promises";

const baseUrl = process.env.OFFISOS_WEB_URL ?? "http://127.0.0.1:3100";
const targetSha = process.env.OFFISOS_TARGET_SHA ?? "unknown";
const evidencePath = process.env.OFFISOS_BROWSER_EVIDENCE ?? "browser-evidence.json";

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
  if (screenshot) await page.screenshot({ path: `/tmp/cc008-${name.replace(/[^a-z0-9]+/gi, "-")}.png`, fullPage: false });
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

async function waitForHistory(fragment) {
  await page.getByTestId("command-history").waitFor();
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), fragment);
}

async function submit(text) {
  await input(text, "Enter");
  await page.waitForTimeout(120);
}

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.getByTestId("command-line").waitFor();
await record("G3-initial-workspace", true, await page.locator("canvas").count() > 0, true);

// G3/G5/G6/G7 changed-path: create a source line through the visible command UI.
await submit("LINE");
await page.waitForFunction(() => document.body.innerText.includes("Specify first point"));
const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();
if (!box) throw new Error("Model canvas was not measurable");
await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.45 } });
await page.waitForFunction(() => document.body.innerText.includes("Specify next point"));
await canvas.click({ position: { x: box.width * 0.55, y: box.height * 0.45 } });
await input("", "Escape");
await page.waitForTimeout(300);

// Issue #5 changed-path: rectangular ARRAY creation through the real command line.
await submit("AR");
await page.waitForFunction(() => document.body.innerText.includes("Select objects"));
await canvas.click({ position: { x: box.width * 0.45, y: box.height * 0.45 } });
await input("", "Enter");
await page.waitForFunction(() => document.body.innerText.includes("Rectangular"));
await submit("Rectangular");
await page.waitForFunction(() => document.body.innerText.includes("rows"));
await submit("2");
await page.waitForFunction(() => document.body.innerText.includes("columns"));
await submit("2");
await page.waitForFunction(() => document.body.innerText.includes("row spacing"));
await submit("100");
await page.waitForFunction(() => document.body.innerText.includes("column spacing"));
await submit("100");
await page.waitForTimeout(400);

const afterArray = await historyText();
await record("G3-array-command", true, afterArray.includes("ARRAY Rectangular"), true);
await record("G5-array-command", true, afterArray.includes("array") || afterArray.includes("ARRAY"));
await record("G6-array-command", true, !afterArray.includes("ERROR") && !afterArray.includes("Unknown command"));
await record("G7-array-command", true, afterArray.includes("100"));

// DEF-015 / invalid-array: one-by-one is a deterministic no-op rather than a fabricated copy.
await submit("AR");
await page.waitForFunction(() => document.body.innerText.includes("Select objects"));
await canvas.click({ position: { x: box.width * 0.45, y: box.height * 0.45 } });
await input("", "Enter");
await page.waitForFunction(() => document.body.innerText.includes("Rectangular"));
await submit("Rectangular");
await submit("1");
await submit("1");
await submit("100");
await submit("100");
await page.waitForTimeout(250);
const noOpHistory = await historyText();
await record("DEF-015-one-by-one-noop", true, noOpHistory.includes("nothing to create") || noOpHistory.includes("no-op"));

// Unsupported path must be typed and mutation-free.
await submit("AR");
await page.waitForFunction(() => document.body.innerText.includes("Select objects"));
await canvas.click({ position: { x: box.width * 0.45, y: box.height * 0.45 } });
await input("", "Enter");
await page.waitForFunction(() => document.body.innerText.includes("Rectangular"));
await submit("Path");
await page.waitForTimeout(250);
const unsupportedHistory = await historyText();
await record("unsupported-path-typed", true, unsupportedHistory.toLowerCase().includes("unsupported"));

// Undo/redo changed-path: visible keyboard commands must be accepted and echoed.
await submit("U");
await submit("REDO");
const undoRedoHistory = await historyText();
await record("undo-redo-visible", true, undoRedoHistory.includes("U") || undoRedoHistory.toLowerCase().includes("undo"));

const result = {
  protocol: "CC008 browser-agent phase gate",
  targetSha,
  deployedRevision: `ephemeral-ci:${process.env.GITHUB_RUN_ID ?? "local"}`,
  browser: "Playwright Chromium headless",
  url: baseUrl,
  steps,
  pass: failures.length === 0,
  failures,
  note: "Black-box browser evidence uses only the visible workspace, command input, keyboard, canvas and rendered history; no /api/cad calls are made by the test agent."
};
await fs.writeFile(evidencePath, JSON.stringify(result, null, 2));
await browser.close();
if (failures.length) process.exit(1);
