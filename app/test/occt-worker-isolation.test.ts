/**
 * Engine worker isolation tests (CAD-IMPLEMENT-002 / Issue #26).
 *
 * Proves the CAD-005 operational findings are honored at the process
 * boundary:
 *   - wall-clock timeout fires AT THE PROCESS BOUNDARY (in-process
 *     cancellation of native OCCT calls is impossible — CAD-005 §6);
 *   - the timeout kill escalates SIGTERM -> SIGKILL and is TYPED
 *     (engine_timeout, retryable);
 *   - the disposable-worker model RECOVERS: the next call after a kill
 *     starts a fresh process and succeeds (CAD-005 §6/§7);
 *   - a missing engine runtime is typed engine_unavailable;
 *   - unparseable worker output is typed engine_error (bounded output is
 *     enforced by the same driver — CAD-005 §5).
 *
 * These tests need a python3 executable (NOT OCP — the failure paths are
 * exercised before/without engine imports). They skip (with the recorded
 * reason) when python3 is absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { compileDescriptor, createOcctGeometryAdapter, resolvePythonExecutable, resolveWorkerScript } from "../src/adapters/occt/index.js";
import { isAdapterFailure } from "../src/contracts/geometry.js";
import { engineSkip, pythonAvailable } from "./engine-availability.js";

const havePython = await pythonAvailable();
const skipPython = havePython ? false : "python3 executable not available (process-boundary tests skipped)";
// The recovery test performs a REAL successful prepare after the kill — it
// needs the full engine (OCP), not just a python3 executable. Environments
// with python3 but without OCP (e.g. the engine-free CAD-IMPLEMENT-001 CI
// shell job) skip it with the recorded reason.
const skipEngine = await engineSkip();

test("worker script resolves from the app/ test cwd", () => {
  const script = resolveWorkerScript();
  assert.ok(script.endsWith("occt-worker.py"), `resolved ${script}`);
});

test("descriptor compile rejects malformed input synchronously with engine_malformed_input", () => {
  const cases: unknown[] = [
    { shape: "box", width: -1, depth: 1, height: 1 },
    { shape: "box", width: 1 },
    { shape: "box", width: Number.NaN, depth: 1, height: 1 },
    { shape: "cylinder", radius: 0, height: 1 },
    { shape: "cylinder", radius: 1, height: 1, origin: [1, 2] },
    { shape: "cylinder", radius: 1, height: 1, direction: [0, 0, 0] },
    { shape: "nope" },
    { shape: "transform", matrix: [1, 0, 0, 0], target: { shape: "box", width: 1, depth: 1, height: 1 } },
    { shape: "transform", matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1], target: { shape: "box", width: 1, depth: 1, height: 1 } },
    { shape: "fuse", a: { shape: "box", width: 1, depth: 1, height: 1 }, b: { shape: "box" } },
    "not an object",
  ];
  for (const descriptor of cases) {
    assert.throws(
      () => compileDescriptor(descriptor),
      (e: unknown) => isAdapterFailure(e) && e.code === "engine_malformed_input",
      `descriptor ${JSON.stringify(descriptor)} must fail compilation with engine_malformed_input`,
    );
  }
});

test("wall-clock timeout fires at the process boundary with a typed, retryable engine_timeout", { skip: skipPython }, async () => {
  // 10 ms is below even bare python startup — the budget MUST expire.
  const adapter = createOcctGeometryAdapter({ timeoutMs: 10 });
  await assert.rejects(
    adapter.prepareGeometry({ id: "x", kind: "geometry", engineId: null, props: { shape: "box", width: 1, depth: 1, height: 1 } }),
    (e: unknown) => {
      assert.ok(isAdapterFailure(e), "failure is an AdapterFailure");
      const failure = e as { code: string; retryable: boolean };
      assert.equal(failure.code, "engine_timeout");
      assert.equal(failure.retryable, true);
      return true;
    },
  );
});

test("the disposable worker recovers after a timeout kill (fresh process next call)", { skip: skipEngine }, async () => {
  const tight = createOcctGeometryAdapter({ timeoutMs: 10 });
  await assert.rejects(
    tight.prepareGeometry({ id: "x", kind: "geometry", engineId: null, props: { shape: "box", width: 1, depth: 1, height: 1 } }),
    (e: unknown) => isAdapterFailure(e),
  );
  // The NEXT call on a sane adapter must succeed (worker-restart recovery —
  // CAD-005: after cancellation/timeout kills, the next engine subprocess
  // starts and completes normally).
  const sane = createOcctGeometryAdapter({ timeoutMs: 60_000 });
  const result = await sane.prepareGeometry({ id: "x", kind: "geometry", engineId: null, props: { shape: "box", width: 2, depth: 3, height: 4 } });
  assert.ok(result.meshToken.startsWith("occt:"));
  const metadata = await sane.describeGeometryMetadata(result.meshToken);
  assert.equal(metadata!.volume, 24);
});

test("a missing engine runtime is typed engine_unavailable", async () => {
  const adapter = createOcctGeometryAdapter({ pythonExecutable: "/nonexistent/offisos-python" });
  await assert.rejects(
    adapter.prepareGeometry({ id: "x", kind: "geometry", engineId: null, props: { shape: "box", width: 1, depth: 1, height: 1 } }),
    (e: unknown) => {
      assert.ok(isAdapterFailure(e), "failure is an AdapterFailure");
      const failure = e as { code: string; retryable: boolean };
      assert.equal(failure.code, "engine_unavailable");
      assert.equal(failure.retryable, false);
      return true;
    },
  );
});

test("a missing worker script is typed engine_unavailable", () => {
  assert.throws(
    () => resolveWorkerScript("/nonexistent/worker.py"),
    (e: unknown) => isAdapterFailure(e) && (e as { code: string }).code === "engine_unavailable",
  );
});

test("unparseable worker output is typed engine_error (never trusted blindly)", { skip: skipPython }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "offisos-occt-test-"));
  try {
    const garbageWorker = join(dir, "garbage-worker.py");
    writeFileSync(garbageWorker, "print('this is not json')\n");
    const adapter = createOcctGeometryAdapter({ workerScript: garbageWorker, timeoutMs: 30_000 });
    await assert.rejects(
      adapter.prepareGeometry({ id: "x", kind: "geometry", engineId: null, props: { shape: "box", width: 1, depth: 1, height: 1 } }),
      (e: unknown) => {
        assert.ok(isAdapterFailure(e), "failure is an AdapterFailure");
        assert.equal((e as { code: string }).code, "engine_error");
        return true;
      },
    );
    // A worker that crashes (non-zero exit, no stdout) is also engine_error.
    const crashingWorker = join(dir, "crashing-worker.py");
    writeFileSync(crashingWorker, "raise SystemExit(3)\n");
    const adapter2 = createOcctGeometryAdapter({ workerScript: crashingWorker, timeoutMs: 30_000 });
    await assert.rejects(
      adapter2.prepareGeometry({ id: "x", kind: "geometry", engineId: null, props: { shape: "box", width: 1, depth: 1, height: 1 } }),
      (e: unknown) => isAdapterFailure(e) && (e as { code: string }).code === "engine_error",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker stderr noise before the JSON line is tolerated (last-line fallback)", { skip: skipPython }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "offisos-occt-test-"));
  try {
    const noisyWorker = join(dir, "noisy-worker.py");
    writeFileSync(
      noisyWorker,
      [
        "import sys",
        "sys.stderr.write('libpng warning: noise\\n')",
        "print('OCCT WARNING: stray stdout noise')",
        "import json",
        "print(json.dumps({'ok': True, 'engine': 'occt', 'engineVersion': 'test', 'meshToken': 'occt:' + 'a'*64,",
        "  'bbox': [0,0,0,1,1,1], 'volume': 1.0, 'stats': {'vertices': 8, 'triangles': 12},",
        "  'mesh': {'vertices': [0,0,0, 1,0,0, 0,1,0, 0,0,1], 'indices': [0,1,2, 0,1,3]}}))",
      ].join("\n") + "\n",
    );
    const adapter = createOcctGeometryAdapter({ workerScript: noisyWorker, timeoutMs: 30_000 });
    const result = await adapter.prepareGeometry({ id: "x", kind: "geometry", engineId: null, props: { shape: "box", width: 1, depth: 1, height: 1 } });
    assert.equal(result.meshToken, "occt:" + "a".repeat(64));
    assert.deepEqual([...result.bbox], [0, 0, 0, 1, 1, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("python availability probe agrees with a direct spawn of the resolved executable", async () => {
  // Both sides use the SAME resolution ($OFFISOS_PYTHON, else python3) so the
  // probe reflects what the adapter will actually spawn.
  const resolved = resolvePythonExecutable();
  const direct = await new Promise<boolean>((resolve) => {
    const child = spawn(resolved, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  assert.equal(await pythonAvailable(), direct);
});
