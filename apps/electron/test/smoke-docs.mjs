// COMPAT-CAD-003 / Issue #41: reproducible CONSTRUCTION DOCUMENTATION Electron
// smoke — drives the REAL renderer UI (Documentation mode panel) through a
// BrowserWindow.
//
// Launches a headless Xvfb display, then runs the Electron host in
// --smoke-docs mode against it. The 12 steps live in main.ts (runDocsSmoke):
// mode toggle → seed (building + plan/elevation/section/detail views +
// annotations + regeneration + A-101 sheet) → listViews (4 rows, plan 17
// primitives) → view geometry (hash + exact bbox) → create elevation back
// view → regenerate (no-op determinism proof + dim 5300/tag label) →
// parametric dimension (move wall-north → 5800) → undo twice (back to 5300) →
// second sheet → Sheet IR export (64-hex hash) → pdf typed docs_unsupported
// reject → save/open identical graph events hash.
//
// Engine-free by construction (the documentation projection is pure
// deterministic TypeScript inside the core; the default bundle binding stays
// lazily unused exactly like --smoke-drafting) — it runs on any toolchain.
//
// Reproduce: cd apps/electron && npm run smoke:docs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 npm run smoke:docs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dirname, ".."); // apps/electron
const REPO_ROOT = join(APP, "..", "..");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-docs-smoke-"));
const outFile = join(tmp, "smoke-result.json");

// Random display number to avoid collisions with the other smokes' X servers.
const displayNum = 400 + Math.floor(Math.random() * 100);
const display = `:${displayNum}`;
const xvfbArgs = [display, "-screen", "0", "1280x800x24", "-ac", "-nolisten", "tcp"];

const env = {
  ...process.env,
  DISPLAY: display,
  OFFISOS_SMOKE_OUT: outFile,
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  ELECTRON_RUN_AS_NODE: "", // ensure NOT set (we need the real Electron runtime)
};

const verbose = !!process.env.OFFISOS_SMOKE_VERBOSE;

// 1. Start Xvfb.
const xvfb = spawn("Xvfb", xvfbArgs, { stdio: "ignore" });
xvfb.on("error", (e) => {
  console.error("docs smoke: failed to spawn Xvfb:", e.message);
  printResult(null, "", `Xvfb spawn error: ${e.message}`, "xvfb-spawn-error");
  process.exit(1);
});

await new Promise((r) => setTimeout(r, 1000));

let stdout = "";
let stderr = "";
function attachIO(child) {
  child.stdout.on("data", (d) => {
    const s = d.toString();
    stdout += s;
    if (verbose) process.stdout.write(s);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (verbose) process.stderr.write(s);
  });
}

// 2. Start Electron in --smoke-docs mode against the Xvfb display.
const electronArgs = [APP, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--smoke-docs"];
const child = spawn(electronExe, electronArgs, { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
attachIO(child);

// The smoke drives the real UI through 12 documented steps — all engine-free
// (pure deterministic TS projection), so the budget is tight.
const timeoutMs = Number(process.env.OFFISOS_SMOKE_TIMEOUT_MS || 240000);
const timer = setTimeout(() => {
  console.error(`docs smoke: TIMEOUT after ${timeoutMs}ms`);
  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
  try {
    xvfb.kill("SIGTERM");
  } catch {
    // ignore
  }
  printResult(null, stdout, stderr, "timeout");
  process.exit(124);
}, timeoutMs);

child.on("error", (e) => {
  clearTimeout(timer);
  printResult(null, stdout, stderr, `electron spawn error: ${e.message}`);
  try {
    xvfb.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  let result = null;
  if (existsSync(outFile)) {
    try {
      result = JSON.parse(readFileSync(outFile, "utf8"));
    } catch (e) {
      printResult(null, stdout, stderr, `bad result json: ${(e).message}`);
      cleanup();
      process.exit(1);
    }
  }
  const status = `exit ${code}` + (signal ? ` signal ${signal}` : "");
  printResult(result, stdout, stderr, status);
  // Persist the result JSON next to the build output so CI can upload it as
  // inspectable documentation smoke evidence.
  if (result) {
    try {
      mkdirSync(join(APP, "dist"), { recursive: true });
      writeFileSync(join(APP, "dist", "smoke-docs-result.json"), JSON.stringify(result, null, 2) + "\n");
    } catch {
      // ignore — not fatal
    }
  }
  cleanup();
  process.exit(result && result.ok === true ? 0 : 1);
});

function cleanup() {
  try {
    xvfb.kill("SIGTERM");
  } catch {
    // ignore
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function printResult(result, out, err, status) {
  console.log("=== Electron CONSTRUCTION DOCUMENTATION smoke result (real UI, engine-free) ===");
  console.log("status:", status);
  console.log("command:", electronExe, electronArgs.join(" "), "  (DISPLAY=" + display + ")");
  if (result) {
    console.log("ok:", result.ok);
    console.log("electronVersion:", result.electronVersion);
    console.log("nodeVersion:", result.nodeVersion);
    console.log("chromeVersion:", result.chromeVersion);
    console.log("steps:");
    for (const s of result.steps || []) {
      const pass = s.pass === undefined ? s.ok : s.pass;
      const label = s.name !== undefined ? `${s.step}. ${s.name}` : s.step;
      console.log(
        `  [${pass ? "PASS" : "FAIL"}] ${label} — ${typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)}`,
      );
    }
  } else {
    console.log("ok: false (no result file written)");
  }
  console.log("--- stdout (last 3KB) ---");
  console.log(out.slice(-3072));
  console.log("--- stderr (last 3KB) ---");
  console.log(err.slice(-3072));
  console.log(`(verbose: OFFISOS_SMOKE_VERBOSE=1; repo root: ${REPO_ROOT})`);
}
