// CAD-IMPLEMENT-002 / Issue #26: reproducible REAL-ENGINE Electron geometry smoke.
//
// Launches a headless Xvfb display, then runs the Electron host in
// --smoke-geometry mode against it. Requires the pinned candidate toolchain
// (python3 + cadquery-ocp / OCCT 7.8.1.1) — this smoke proves the FULL chain
// with the real engine:
//   BrowserWindow -> window.cad.send (preload) -> ipcRenderer.invoke
//     -> ipcMain.handle -> ElectronHost + IpcTransport -> AppApiHandler
//     geometry.prepare -> EngineAdapterBundle -> OCCT worker (disposable
//     Python subprocess) -> deterministic GeometryResult -> applyEdit
//     -> CADDocument -> undo/redo + selection metadata.
//
// The CAD-IMPLEMENT-001 smoke (test/smoke.mjs) stays engine-free and
// byte-identical; this is the additive real-engine counterpart.
//
// Reproduce: cd apps/electron && npm run smoke:geometry
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 npm run smoke:geometry

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

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-geometry-smoke-"));
const outFile = join(tmp, "smoke-result.json");

// Random display number to avoid collisions with leftover X servers.
const displayNum = 200 + Math.floor(Math.random() * 100);
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
  console.error("geometry smoke: failed to spawn Xvfb:", e.message);
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

// 2. Start Electron in --smoke-geometry mode against the Xvfb display.
const electronArgs = [APP, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--smoke-geometry"];
const child = spawn(electronExe, electronArgs, { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
attachIO(child);

const timeoutMs = Number(process.env.OFFISOS_SMOKE_TIMEOUT_MS || 180000);
const timer = setTimeout(() => {
  console.error(`geometry smoke: TIMEOUT after ${timeoutMs}ms`);
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
  // inspectable real-engine smoke evidence.
  if (result) {
    try {
      mkdirSync(join(APP, "dist"), { recursive: true });
      writeFileSync(join(APP, "dist", "smoke-geometry-result.json"), JSON.stringify(result, null, 2) + "\n");
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
  console.log("=== Electron REAL-ENGINE geometry smoke result ===");
  console.log("status:", status);
  console.log("command:", electronExe, electronArgs.join(" "), "  (DISPLAY=" + display + ")");
  if (result) {
    console.log("ok:", result.ok);
    console.log("electronVersion:", result.electronVersion);
    console.log("nodeVersion:", result.nodeVersion);
    console.log("chromeVersion:", result.chromeVersion);
    console.log("steps:");
    for (const s of result.steps || []) {
      console.log(
        `  [${s.ok ? "PASS" : "FAIL"}] ${s.step} — ${typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)}`,
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
