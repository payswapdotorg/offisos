/**
 * OCCT worker process driver (CAD-IMPLEMENT-002 / Issue #26).
 *
 * The Node side of the CAD-005 operational findings — every constraint here
 * is a measured finding, not a stylistic choice:
 *
 *   §6/§7 process isolation: the engine runs in a DISPOSABLE SUBPROCESS per
 *     call. Threads do not parallelize native engine work; in-process
 *     cancellation is impossible (a cancel flag set during a native OCCT call
 *     is observed only after the call returns). The wall-clock timeout is
 *     enforced at the PROCESS boundary with SIGTERM -> SIGKILL escalation.
 *   §5 typed failures: every failure surfaces as an AdapterFailure with a
 *     stable code (engine_timeout / engine_unavailable / engine_error /
 *     engine_malformed_input pass-through) — never a bare throw.
 *   §5 structural validation: the worker's JSON response is structurally
 *     validated (token shape, bbox finiteness, mesh index ranges) before it
 *     can reach the App API — engine output is never trusted blindly.
 *   §5 bounded output: stdout collection is byte-capped so a runaway worker
 *     cannot exhaust the parent's memory.
 *   §7 optional RLIMIT_AS: when OFFISOS_OCCT_RLIMIT_AS (bytes) is set and
 *     `prlimit` is available, the worker runs under an address-space ceiling
 *     (CAD-005: rlimits are enforceable ONLY because the worker is a
 *     disposable process).
 *
 * Engine discovery:
 *   python executable: $OFFISOS_PYTHON, else "python3".
 *   worker script:     $OFFISOS_OCCT_WORKER, else a candidate list relative
 *                      to cwd (app/, repo root, ../app/, ../../app/) — the
 *                      hosts (apps/web, apps/electron) and the app/ tests all
 *                      resolve without configuration.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AdapterFailure } from "../../contracts/geometry.js";
import type { WorkerOkResponse, WorkerPingRequest, WorkerPrepareRequest, WorkerRequest, WorkerResponse, WorkerSectionOk, WorkerSectionRequest, WorkerTopologyOk, WorkerTopologyRequest } from "./worker-protocol.js";

export interface OcctProcessOptions {
  /** Wall-clock budget per worker call (default 15000 ms). */
  readonly timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (default 1500 ms). */
  readonly killGraceMs?: number;
  /** Max bytes of worker stdout collected (default 64 MiB). */
  readonly maxOutputBytes?: number;
  /** Explicit python executable override (defaults to $OFFISOS_PYTHON/python3). */
  readonly pythonExecutable?: string;
  /** Explicit worker script path override. */
  readonly workerScript?: string;
  /** Extra environment for the worker process. */
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const WORKER_RELATIVE_CANDIDATES = [
  "src/adapters/occt/worker/occt-worker.py", // cwd = app/
  "app/src/adapters/occt/worker/occt-worker.py", // cwd = repo root
  "../app/src/adapters/occt/worker/occt-worker.py", // cwd = tools/, sibling
  "../../app/src/adapters/occt/worker/occt-worker.py", // cwd = apps/web, apps/electron
] as const;

export const ENGINE_TIMEOUT = "engine_timeout";
export const ENGINE_UNAVAILABLE = "engine_unavailable";
export const ENGINE_ERROR = "engine_error";

export function resolveWorkerScript(explicit?: string): string {
  const candidates: string[] = [];
  if (typeof explicit === "string" && explicit.length > 0) {
    candidates.push(explicit);
  } else {
    const fromEnv = process.env.OFFISOS_OCCT_WORKER;
    if (typeof fromEnv === "string" && fromEnv.length > 0) {
      candidates.push(fromEnv);
    } else {
      candidates.push(
        ...WORKER_RELATIVE_CANDIDATES.map((candidate) =>
          isAbsolute(candidate) ? candidate : join(process.cwd(), candidate),
        ),
      );
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new AdapterFailure(
    ENGINE_UNAVAILABLE,
    `OCCT worker script not found (cwd=${process.cwd()}; tried: ${candidates.join(", ")}); set OFFISOS_OCCT_WORKER to the absolute path of app/src/adapters/occt/worker/occt-worker.py`,
    false,
  );
}

export function resolvePythonExecutable(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env.OFFISOS_PYTHON;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return "python3";
}

function buildCommand(options: OcctProcessOptions, workerScript: string): { command: string; args: string[] } {
  const python = resolvePythonExecutable(options.pythonExecutable);
  const rlimit = process.env.OFFISOS_OCCT_RLIMIT_AS;
  if (typeof rlimit === "string" && /^\d+$/.test(rlimit) && Number(rlimit) > 0) {
    // CAD-005 §7: per-worker address-space ceiling via prlimit (only sound
    // because the worker is disposable — exhaustion kills the child, not us).
    return { command: "prlimit", args: ["--as", rlimit, "--", python, workerScript] };
  }
  return { command: python, args: [workerScript] };
}

interface RawRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function runProcess(command: string, args: string[], request: WorkerRequest, options: OcctProcessOptions): Promise<RawRun> {
  return new Promise<RawRun>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
    });

    let stdout = "";
    let stderr = "";
    let outputCapped = false;
    let settled = false;

    const fail = (error: AdapterFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Process-level escalation: SIGTERM, then SIGKILL (CAD-005 §6).
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, killGraceMs).unref();
      } catch {
        /* already gone */
      }
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(
        new AdapterFailure(
          ENGINE_TIMEOUT,
          `OCCT worker exceeded the ${timeoutMs} ms wall-clock budget and was terminated at the process boundary`,
          true,
        ),
      );
    }, timeoutMs);
    timer.unref();

    child.on("error", (e: NodeJS.ErrnoException) => {
      const code = e.code === "ENOENT" ? ENGINE_UNAVAILABLE : ENGINE_ERROR;
      fail(
        new AdapterFailure(
          code,
          e.code === "ENOENT"
            ? `engine executable not found: ${command} (set OFFISOS_PYTHON / ensure prlimit is installed if OFFISOS_OCCT_RLIMIT_AS is set)`
            : `failed to start engine process: ${e.message}`,
          false,
        ),
      );
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > maxOutputBytes) {
        outputCapped = true;
        fail(
          new AdapterFailure(
            ENGINE_ERROR,
            `OCCT worker output exceeded the ${maxOutputBytes} byte bound (bounded output, CAD-005 §5)`,
            false,
          ),
        );
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 4096);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputCapped) return; // already rejected
      resolve({ stdout, stderr, exitCode, signal });
    });

    try {
      child.stdin?.write(JSON.stringify(request) + "\n");
      child.stdin?.end();
    } catch (e) {
      fail(new AdapterFailure(ENGINE_ERROR, `failed to write request to worker: ${(e as Error).message}`, false));
    }
  });
}

function parseResponse(raw: RawRun): WorkerResponse {
  const text = raw.stdout.trim();
  if (text.length === 0) {
    throw new AdapterFailure(
      ENGINE_ERROR,
      `OCCT worker produced no output (exit=${raw.exitCode} signal=${raw.signal ?? "none"}${raw.stderr ? `; stderr: ${raw.stderr.slice(-512)}` : ""})`,
      false,
    );
  }
  // Whole-buffer parse first; fall back to the last non-empty line (guards
  // against stray engine noise on stdout).
  try {
    return JSON.parse(text) as WorkerResponse;
  } catch {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last !== undefined) {
      try {
        return JSON.parse(last) as WorkerResponse;
      } catch {
        /* fall through */
      }
    }
    throw new AdapterFailure(
      ENGINE_ERROR,
      `OCCT worker produced unparseable output (exit=${raw.exitCode}${raw.stderr ? `; stderr: ${raw.stderr.slice(-512)}` : ""})`,
      false,
    );
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Structural validation of a successful prepare response (CAD-005 §5). */
function assertPrepareResponse(response: WorkerOkResponse): void {
  if (typeof response.meshToken !== "string" || !response.meshToken.startsWith("occt:") || response.meshToken.length < 10) {
    throw new AdapterFailure(ENGINE_ERROR, "worker response meshToken is malformed", false);
  }
  const bbox = response.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 6 || !bbox.every(isFiniteNumber)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker response bbox must be 6 finite numbers", false);
  }
  if (!isFiniteNumber(response.volume)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker response volume must be a finite number", false);
  }
  const mesh = response.mesh;
  if (mesh === undefined || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.indices)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker response mesh is missing or malformed", false);
  }
  if (mesh.vertices.length % 3 !== 0 || !mesh.vertices.every(isFiniteNumber)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker response mesh.vertices must be finite x,y,z triples", false);
  }
  const vertexCount = mesh.vertices.length / 3;
  if (mesh.indices.length % 3 !== 0 || !mesh.indices.every((i) => Number.isInteger(i) && i >= 0 && i < vertexCount)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker response mesh.indices must be in-range a,b,c triples", false);
  }
  const stats = response.stats;
  if (
    typeof stats !== "object" || stats === null ||
    !Number.isInteger((stats as { vertices?: unknown }).vertices) ||
    !Number.isInteger((stats as { triangles?: unknown }).triangles)
  ) {
    throw new AdapterFailure(ENGINE_ERROR, "worker response stats is malformed", false);
  }
}

const RETRYABLE_CODES = new Set([ENGINE_TIMEOUT]);

/** Run one prepare request in a fresh disposable worker process. */
export async function runOcctWorker(
  request: WorkerPrepareRequest,
  options: OcctProcessOptions = {},
): Promise<WorkerOkResponse> {
  const workerScript = resolveWorkerScript(options.workerScript);
  const { command, args } = buildCommand(options, workerScript);
  const raw = await runProcess(command, args, request, options);
  const response = parseResponse(raw);
  if (response.ok === false) {
    throw new AdapterFailure(response.code, response.message, RETRYABLE_CODES.has(response.code));
  }
  assertPrepareResponse(response);
  return response;
}

/** Structural validation of a successful section response (CAD-PARITY-010). */
function assertSectionResponse(response: WorkerSectionOk): void {
  if (!Array.isArray(response.polylines)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker section response polylines is malformed", false);
  }
  let total = 0;
  for (const polyline of response.polylines) {
    const points = (polyline as { points?: unknown }).points;
    if (!Array.isArray(points) || points.length < 6 || points.length % 3 !== 0 || !points.every(isFiniteNumber)) {
      throw new AdapterFailure(ENGINE_ERROR, "worker section polyline must be ≥ 2 finite x,y,z triples", false);
    }
    total += points.length / 3;
    if (total > 8_192) {
      throw new AdapterFailure(ENGINE_ERROR, "worker section response exceeds the point bound", false);
    }
  }
}

/** Run one section request (plane ∩ shape intersection curves). */
export async function runOcctSectionWorker(
  request: WorkerSectionRequest,
  options: OcctProcessOptions = {},
): Promise<WorkerSectionOk> {
  const workerScript = resolveWorkerScript(options.workerScript);
  const { command, args } = buildCommand(options, workerScript);
  const raw = await runProcess(command, args, request, options);
  const response = parseResponse(raw) as WorkerResponse | WorkerSectionOk;
  if (response.ok === false) {
    throw new AdapterFailure(response.code, response.message, RETRYABLE_CODES.has(response.code));
  }
  if (!Array.isArray((response as WorkerSectionOk).polylines)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker section response is missing polylines", false);
  }
  assertSectionResponse(response as WorkerSectionOk);
  return response as WorkerSectionOk;
}

/** Structural validation of a successful topology response (CAD-PARITY-010). */
function assertTopologyResponse(response: WorkerTopologyOk): void {
  for (const key of ["faces", "edges", "vertices"] as const) {
    if (!Array.isArray(response[key])) {
      throw new AdapterFailure(ENGINE_ERROR, `worker topology response ${key} is malformed`, false);
    }
  }
  for (const face of response.faces) {
    if (typeof face.surfaceType !== "string" || typeof face.engineKey !== "string") {
      throw new AdapterFailure(ENGINE_ERROR, "worker topology face is malformed", false);
    }
    if (!Array.isArray(face.vertices) || face.vertices.length % 3 !== 0 || !face.vertices.every(isFiniteNumber)) {
      throw new AdapterFailure(ENGINE_ERROR, "worker topology face vertices must be finite x,y,z triples", false);
    }
    const vertexCount = face.vertices.length / 3;
    if (vertexCount === 0 || !Array.isArray(face.indices) || face.indices.length % 3 !== 0 ||
      !face.indices.every((i) => Number.isInteger(i) && i >= 0 && i < vertexCount)) {
      throw new AdapterFailure(ENGINE_ERROR, "worker topology face indices must be in-range a,b,c triples", false);
    }
    if (!isFiniteNumber(face.area) || !Array.isArray(face.centroid) || face.centroid.length !== 3 || !face.centroid.every(isFiniteNumber)) {
      throw new AdapterFailure(ENGINE_ERROR, "worker topology face area/centroid is malformed", false);
    }
  }
  for (const edge of response.edges) {
    if (typeof edge.curveType !== "string" || typeof edge.engineKey !== "string" || !isFiniteNumber(edge.length)) {
      throw new AdapterFailure(ENGINE_ERROR, "worker topology edge is malformed", false);
    }
    if (!Array.isArray(edge.points) || edge.points.length < 6 || edge.points.length % 3 !== 0 || !edge.points.every(isFiniteNumber)) {
      throw new AdapterFailure(ENGINE_ERROR, "worker topology edge points must be ≥ 2 finite x,y,z triples", false);
    }
  }
  for (const vertex of response.vertices) {
    if (typeof vertex.engineKey !== "string" || !Array.isArray(vertex.point) || vertex.point.length !== 3 || !vertex.point.every(isFiniteNumber)) {
      throw new AdapterFailure(ENGINE_ERROR, "worker topology vertex is malformed", false);
    }
  }
}

/** Run one topology request (the face/edge/vertex inventory). */
export async function runOcctTopologyWorker(
  request: WorkerTopologyRequest,
  options: OcctProcessOptions = {},
): Promise<WorkerTopologyOk> {
  const workerScript = resolveWorkerScript(options.workerScript);
  const { command, args } = buildCommand(options, workerScript);
  const raw = await runProcess(command, args, request, options);
  const response = parseResponse(raw) as WorkerResponse | WorkerTopologyOk;
  if (response.ok === false) {
    throw new AdapterFailure(response.code, response.message, RETRYABLE_CODES.has(response.code));
  }
  if (!Array.isArray((response as WorkerTopologyOk).faces)) {
    throw new AdapterFailure(ENGINE_ERROR, "worker topology response is missing faces", false);
  }
  assertTopologyResponse(response as WorkerTopologyOk);
  return response as WorkerTopologyOk;
}

export interface EngineProbe {
  readonly available: boolean;
  readonly engineVersion: string | null;
  readonly message: string | null;
}

/** Probe engine availability (a cheap ping — does NOT import OCP lazily...
 *  the ping op imports OCP and reports availability + version). */
export async function probeOcctEngine(options: OcctProcessOptions = {}): Promise<EngineProbe> {
  try {
    const workerScript = resolveWorkerScript(options.workerScript);
    const { command, args } = buildCommand(options, workerScript);
    const raw = await runProcess(command, args, { op: "ping" } satisfies WorkerPingRequest, {
      ...options,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    const response = parseResponse(raw);
    if (response.ok === false) {
      return { available: false, engineVersion: null, message: response.message };
    }
    return { available: true, engineVersion: response.engineVersion, message: null };
  } catch (e) {
    return { available: false, engineVersion: null, message: (e as Error).message };
  }
}
