/**
 * IFC worker process driver (COMPAT-IFC-001 / Issue #47).
 *
 * The TypeScript side of the IfcOpenShell worker boundary — mirrors the
 * OCCT worker discipline (CAD-IMPLEMENT-002 / CAD-005 findings) exactly:
 *
 *   §6/§7 process isolation: the engine runs in a DISPOSABLE SUBPROCESS per
 *     call; the wall-clock timeout is enforced at the PROCESS boundary with
 *     SIGTERM -> SIGKILL escalation.
 *   §5 typed failures: every failure surfaces as an AdapterFailure with a
 *     stable code (engine_timeout / engine_unavailable / engine_error /
 *     ifc_invalid / ifc_unsupported pass-through) — never a bare throw.
 *   §5 structural validation: the worker's JSON response is structurally
 *     validated per op before it can reach the App API.
 *   §5 bounded output: stdout collection is byte-capped.
 *
 * Retry policy: every IFC worker op is a PURE FUNCTION of its request
 * (build/parse/ids/bcf are all idempotent — no engine-side state survives
 * the disposable process). A transient engine_error (observed as a rare
 * per-process startup race in the 0.8.5 toolchain) is therefore retried
 * ONCE; a repeated failure surfaces as the typed error.
 *
 * Engine discovery (mirrors the OCCT worker):
 *   python executable: $OFFISOS_PYTHON, else "python3".
 *   worker script:     $OFFISOS_IFC_WORKER, else candidates relative to cwd.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AdapterFailure } from "../../contracts/geometry.js";
import type { WorkerRequest, WorkerResponse } from "./ifc-worker-protocol.js";

export interface IfcProcessOptions {
  /** Wall-clock budget per worker call (default 120000 ms — IFC builds are heavier than OCCT tessellation). */
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

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const WORKER_RELATIVE_CANDIDATES = [
  "src/adapters/ifc/worker/ifc-worker.py", // cwd = app/
  "app/src/adapters/ifc/worker/ifc-worker.py", // cwd = repo root
  "../app/src/adapters/ifc/worker/ifc-worker.py", // cwd = tools/, sibling
  "../../app/src/adapters/ifc/worker/ifc-worker.py", // cwd = apps/web, apps/electron
] as const;

export const ENGINE_TIMEOUT = "engine_timeout";
export const ENGINE_UNAVAILABLE = "engine_unavailable";
export const ENGINE_ERROR = "engine_error";

export function resolveIfcWorkerScript(explicit?: string): string {
  const candidates: string[] = [];
  if (typeof explicit === "string" && explicit.length > 0) {
    candidates.push(explicit);
  } else {
    const fromEnv = process.env.OFFISOS_IFC_WORKER;
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
    `IFC worker script not found (cwd=${process.cwd()}; tried: ${candidates.join(", ")}); set OFFISOS_IFC_WORKER to the absolute path of app/src/adapters/ifc/worker/ifc-worker.py`,
    false,
  );
}

export function resolveIfcPythonExecutable(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env.OFFISOS_PYTHON;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return "python3";
}

interface RawRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function runProcess(command: string, args: string[], request: WorkerRequest, options: IfcProcessOptions): Promise<RawRun> {
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
          `IFC worker exceeded the ${timeoutMs} ms wall-clock budget and was terminated at the process boundary`,
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
            ? `engine executable not found: ${command} (set OFFISOS_PYTHON)`
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
            `IFC worker output exceeded the ${maxOutputBytes} byte bound (bounded output, CAD-005 §5)`,
            false,
          ),
        );
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 8192);
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
      `IFC worker produced no output (exit=${raw.exitCode} signal=${raw.signal ?? "none"}${raw.stderr ? `; stderr: ${raw.stderr.slice(-512)}` : ""})`,
      false,
    );
  }
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
      `IFC worker produced unparseable output (exit=${raw.exitCode}${raw.stderr ? `; stderr: ${raw.stderr.slice(-512)}` : ""})`,
      false,
    );
  }
}

const RETRYABLE_CODES = new Set([ENGINE_TIMEOUT, ENGINE_ERROR]);

/** Run one request in a fresh disposable worker process (with the single
 *  transient-error retry described in the module header). */
export async function runIfcWorker<T extends WorkerResponse>(
  request: WorkerRequest,
  validate: (response: WorkerResponse) => T,
  options: IfcProcessOptions = {},
): Promise<T> {
  const workerScript = resolveIfcWorkerScript(options.workerScript);
  const python = resolveIfcPythonExecutable(options.pythonExecutable);
  const attempt = async (): Promise<T> => {
    const raw = await runProcess(python, [workerScript], request, options);
    const response = parseResponse(raw);
    if (response.ok === false) {
      throw new AdapterFailure(response.code, response.message, RETRYABLE_CODES.has(response.code));
    }
    return validate(response);
  };
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof AdapterFailure && e.retryable) {
      // One retry for transient per-process failures — every op is a pure
      // function of the request, so the retry is always sound.
      return attempt();
    }
    throw e;
  }
}
