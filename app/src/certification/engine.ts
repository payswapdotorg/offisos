/**
 * CAD-PARITY-019 (Issue #122) — the certification engine: the deterministic
 * assessor that executes the version-pinned corpus (corpus.ts) against a
 * driver and produces the revision-bound certification report.
 *
 * Architecture:
 *  - The DRIVER is the only seam: { command, query } over the governed App
 *    API. In-process (the app-suite test), the driver wraps the App API
 *    handler bound to the reference bundle (+ the IFC interop adapter); for
 *    the host-parity proof it wraps the Web/Electron host transports; the
 *    web smoke drives the REAL Next.js app over HTTP. Every host runs the
 *    SAME compiled stream — the certification measures the product, never
 *    a mock.
 *  - The SCRIPT phases are compiled through the SHARED prompt-engine
 *    command registry (runCommandScript) — the real professional command
 *    line — with entity picks resolved against the live document state.
 *  - The EXPECTATIONS are evaluated declaratively (the corpus check
 *    vocabulary); every expectation carries its declared AutoCAD reference
 *    and outcome classification; the verdict is per-expectation and
 *    aggregated honestly (exact / lossy / unsupported; a mismatch is a
 *    certification FAILURE, never a silent pass).
 *  - The cross-cutting arms: persistence round-trip (save → open → save:
 *    byte-identical canonical bytes), undo/redo atomicity (exact state
 *    restore), replay determinism (a second run in a fresh document
 *    reproduces the normalized digest), interop probes (the REAL carrier
 *    codecs/reports — the DRY round-trip loops, never narrative claims),
 *    and wall-clock performance budgets (asserted at run time, NEVER
 *    pinned).
 *
 * Determinism: the pinned report normalizes the run-unique identity (the
 * document key and content-addressed hashes); every SEMANTIC field is
 * pinned verbatim. Perf samples are reported to the run log and asserted
 * against the corpus budgets, but excluded from the pinned artifact.
 *
 * Engine boundary (LOCK-018): the engine calls only the governed App API
 * surface through the driver (and the pure prompt-engine compiler). No
 * engine, no host, no file I/O.
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "../caddocument/serialization.js";
import { applyPromptEvent, IDLE_PROMPT_STATE, type PromptEvent } from "../workspace/prompt-engine.js";
import { defaultCommandContext, type CommandContext, type EntityPick } from "../workspace/types.js";
import {
  CORPUS_REFERENCE,
  P019_WORKFLOWS,
  corpusSha256,
  type CorpusExpectation,
  type CorpusInteropExpectation,
  type CorpusScriptStep,
  type CorpusWorkflow,
} from "./corpus.js";

// ---------------------------------------------------------------------------
// The driver seam.
// ---------------------------------------------------------------------------

export type DriverResult = { ok: true; value: unknown } | { ok: false; code: string; message?: string };

export interface CertDriver {
  command(name: string, payload: unknown): Promise<DriverResult>;
  query(name: string, payload: unknown): Promise<DriverResult>;
}

/** The driver kind recorded in the report (honest basis disclosure). */
/** The driver kinds (the honest basis disclosure labels): the in-process
 *  App API handler, the Web host's WebSocket transport, the Electron
 *  host's IPC transport, and the real web app over HTTP. */
export type DriverKind = "in-process" | "websocket-transport" | "ipc-transport" | "web-http";

// ---------------------------------------------------------------------------
// Report types.
// ---------------------------------------------------------------------------

export interface ExpectationResult {
  readonly id: string;
  readonly outcome: "exact" | "lossy" | "unsupported";
  readonly status: "pass" | "fail";
  /** Present only on failure (the honest mismatch disclosure). */
  readonly detail?: string;
}

export interface InteropResult {
  readonly id: string;
  readonly surface: string;
  readonly expected: "exact" | "lossy" | "unsupported";
  readonly observed: string;
  readonly status: "pass" | "fail";
}

export interface PerfSample {
  readonly label: string;
  readonly ms: number;
  readonly budgetMs: number;
}

export interface PhaseResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly commandCount: number;
  readonly revisionDelta: number;
}

export interface WorkflowCertification {
  readonly id: string;
  readonly title: string;
  readonly discipline: string;
  readonly status: "pass" | "fail";
  readonly phases: readonly PhaseResult[];
  readonly expectations: readonly ExpectationResult[];
  readonly interop: readonly InteropResult[];
  readonly robustness: {
    readonly roundTrip: "pass" | "fail" | "not-declared";
    readonly undoRedo: "pass" | "fail" | "not-declared";
    readonly replayStable: "pass" | "fail" | "not-declared";
  };
  readonly finalDigest: string;
  readonly perf: readonly PerfSample[];
}

export interface CertificationReport {
  readonly contract: "offisos-p019-certification/1";
  readonly corpus: {
    readonly id: string;
    readonly version: string;
    readonly sha256: string;
    readonly workflowCount: number;
  };
  readonly basis: {
    readonly driverKind: DriverKind;
    readonly referenceProduct: string;
    readonly note: string;
  };
  readonly workflows: readonly WorkflowCertification[];
  readonly summary: {
    readonly workflows: number;
    readonly workflowsPassed: number;
    readonly expectations: { readonly total: number; readonly exact: number; readonly lossy: number; readonly unsupported: number; readonly failed: number };
    readonly interop: { readonly total: number; readonly exact: number; readonly lossy: number; readonly unsupported: number; readonly failed: number };
    readonly verdict: "CERTIFIED" | "FAILED";
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

interface PhaseRunState {
  readonly labeled: Map<string, DriverResult>;
  readonly echoLines: string[];
  revisionsBefore: number;
  revisionsAfter: number;
  commandCount: number;
}

const TOL_DEFAULT = 0;

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (seg === "length") {
        cur = cur.length;
        continue;
      }
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= Math.max(tol, TOL_DEFAULT);
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (canonicalStringify(a) === canonicalStringify(b)) return true;
  // numeric-array tolerance (vector comparisons)
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => typeof x === "number") && b.every((x) => typeof x === "number")) {
    return a.every((x, i) => Math.abs(x - (b[i] as number)) <= Math.max(tol, TOL_DEFAULT));
  }
  return false;
}

interface StateSnapshot {
  readonly elements: readonly { readonly id: string; readonly kind: string; readonly props: Readonly<Record<string, unknown>> }[];
  readonly layers: readonly unknown[];
  readonly blockDefs?: readonly unknown[];
  readonly layouts?: readonly unknown[];
  readonly draftingSettings?: Readonly<Record<string, unknown>>;
  readonly modelHistory?: { readonly revisions?: readonly unknown[] };
  readonly [key: string]: unknown;
}

async function getState(driver: CertDriver): Promise<StateSnapshot> {
  const r = await driver.query("document.getState", {});
  if (!r.ok) throw new Error(`document.getState failed: ${JSON.stringify(r).slice(0, 300)}`);
  return r.value as StateSnapshot;
}

function resolveRef(snap: StateSnapshot, ref: { by: "nth"; type: string; nth: number } | { by: "id"; id: string }): EntityPick {
  if (ref.by === "id") {
    const el = snap.elements.find((e) => e.id === ref.id);
    if (!el) throw new Error(`corpus entity ref id ${ref.id} not found`);
    return { id: el.id, kind: el.kind, props: el.props };
  }
  const matches = snap.elements.filter((e) => (e.props as Record<string, unknown> | undefined)?.type === ref.type);
  const el = matches[ref.nth];
  if (!el) throw new Error(`corpus entity ref nth(${ref.nth}) of type ${ref.type} not found (have ${matches.length})`);
  return { id: el.id, kind: el.kind, props: el.props };
}

function contextFor(snap: StateSnapshot): CommandContext {
  // The REAL host context contract (the same snapshot tables the Web/Electron
  // shell feeds the shared registry — the smokes' engineCtx shape).
  return defaultCommandContext({
    activeLayer: (snap.draftingSettings?.activeLayer as string | undefined) ?? "0",
    elementCount: snap.elements.length,
    storyCount: snap.elements.filter((e) => (e.props as Record<string, unknown> | undefined)?.type === "bim.story").length,
    currentSelection: [],
    layers: snap.layers as never,
    textStyles: (snap.textStyles ?? []) as never,
    dimStyles: (snap.dimStyles ?? []) as never,
    currentTextStyle: (snap.draftingSettings?.textStyle as string | undefined) ?? "Standard",
    currentDimStyle: (snap.draftingSettings?.dimStyle as string | undefined) ?? "Standard",
    blocks: (snap.blockDefs ?? []) as never,
    xrefs: (snap.xrefs ?? []) as never,
    constraints: (snap.constraints ?? []) as never,
    layouts: (snap.layouts ?? []) as never,
    viewports: (snap.viewports ?? []) as never,
    activeLayoutId: (snap.draftingSettings?.activeLayout as string | null | undefined) ?? ((snap.layouts ?? [])[0] as { id?: string } | undefined)?.id ?? null,
    space: (snap.draftingSettings?.space as "model" | "paper" | undefined) ?? "model",
    ucs: (snap.ucs ?? []) as never,
    activeUcsId: (snap.draftingSettings?.activeUcs as string | undefined) ?? "world",
    view3d: (snap.draftingSettings?.view3d ?? null) as never,
    model3dSolidCount: snap.elements.filter((e) => (e.props as Record<string, unknown> | undefined)?.type === "model3d.solid").length,
  });
}

function toPromptEvent(snap: StateSnapshot, step: CorpusScriptStep): PromptEvent {
  const ev = step.event;
  switch (ev.type) {
    case "typed":
    case "enter":
    case "cancel":
      return ev;
    case "pick":
      return { type: "pick", point: [ev.point[0], ev.point[1]] };
    case "entity":
      return { type: "entity", entity: resolveRef(snap, ev.entity) };
    case "entityPoint":
      return { type: "entityPoint", entity: resolveRef(snap, ev.entity), point: [ev.point[0], ev.point[1]] };
  }
}

function revisionCount(snap: StateSnapshot): number {
  return snap.modelHistory?.revisions?.length ?? 0;
}

/** The normalized digest basis: the SEMANTIC projection of the document. */
function semanticDigestData(snap: StateSnapshot): unknown {
  return {
    elements: snap.elements.map((e) => ({ id: e.id, kind: e.kind, props: e.props })),
    layers: snap.layers,
    blockDefs: snap.blockDefs ?? null,
    layouts: snap.layouts ?? null,
  };
}

function digestOf(snap: StateSnapshot): string {
  return createHash("sha256").update(canonicalStringify(semanticDigestData(snap))).digest("hex");
}

/** The canonical CONTENT of a saved document: the parsed save bytes with
 *  the live editorState (the session undo-stack markers) excluded — the
 *  documented volatile field of the round-trip comparison. */
function contentCanonical(bytes: number[]): string {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  const { editorState: _liveEditorState, ...content } = parsed;
  void _liveEditorState;
  return canonicalStringify(content);
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly driverKind: DriverKind;
  /** Extra basis note (the honest disclosure line). */
  readonly basisNote?: string;
  /** Restrict to specific workflow ids (used by the host-parity proof). */
  readonly only?: readonly string[];
}

export interface RunOutcome {
  readonly report: CertificationReport;
  readonly consoleLines: readonly string[];
}

const log = (lines: string[], msg: string) => {
  lines.push(msg);
  console.log(msg);
};

export async function runCertification(driver: CertDriver, options: RunOptions): Promise<RunOutcome> {
  const lines: string[] = [];
  const runId = `p019-${Math.random().toString(16).slice(2, 10)}`;

  // The perf collector: every driver call is timed; per-workflow budgets are
  // asserted; the samples are reported to the run log and NEVER pinned.
  const perfSamples: PerfSample[] = [];
  const call = async (kind: "command" | "query", name: string, payload: unknown): Promise<DriverResult> => {
    const t0 = Date.now();
    const out = kind === "command" ? await driver.command(name, payload) : await driver.query(name, payload);
    perfSamples.push({ label: `${kind}:${name}`, ms: Date.now() - t0, budgetMs: 0 });
    return out;
  };

  const selected = options.only !== undefined ? P019_WORKFLOWS.filter((w) => options.only!.includes(w.id)) : P019_WORKFLOWS;
  const workflowResults: WorkflowCertification[] = [];

  log(lines, `P019 CERTIFICATION: corpus ${CORPUS_REFERENCE.corpusId}/${CORPUS_REFERENCE.corpusVersion} sha256 ${corpusSha256().slice(0, 12)}… — ${selected.length} workflows on ${options.driverKind}`);

  for (const wf of selected) {
    const perfBefore = perfSamples.length;
    const result = await runWorkflow(driver, wf, runId, call, lines);
    workflowResults.push(result);
    const perf = perfSamples.slice(perfBefore);
    for (const target of wf.perf) {
      const total = perf.reduce((sum, s) => sum + s.ms, 0);
      if (total > target.budgetMs) {
        throw new Error(`PERF BUDGET EXCEEDED — ${target.label}: ${total}ms > ${target.budgetMs}ms`);
      }
      log(lines, `P019 CERTIFICATION: PERF ${target.label}: ${total}ms <= ${target.budgetMs}ms`);
    }
  }

  const expectTotal = workflowResults.flatMap((w) => w.expectations);
  const interopTotal = workflowResults.flatMap((w) => w.interop);
  const failed =
    expectTotal.filter((e) => e.status === "fail").length +
    interopTotal.filter((i) => i.status === "fail").length +
    workflowResults.filter((w) => w.robustness.roundTrip === "fail" || w.robustness.undoRedo === "fail" || w.robustness.replayStable === "fail").length;
  const workflowsPassed = workflowResults.filter((w) => w.status === "pass").length;

  const report: CertificationReport = {
    contract: "offisos-p019-certification/1",
    corpus: {
      id: CORPUS_REFERENCE.corpusId,
      version: CORPUS_REFERENCE.corpusVersion,
      sha256: corpusSha256(),
      workflowCount: selected.length,
    },
    basis: {
      driverKind: options.driverKind,
      referenceProduct: CORPUS_REFERENCE.referenceProduct,
      note:
        options.basisNote ??
        "The certification basis is the deterministic engine-free reference adapter with the pinned IfcOpenShell 0.8.5 interop adapter (the CAD-PARITY-009/014 parity basis); engine-backed exactness (OCCT) is evidenced by the VERIFIED CAD-PARITY-010 suite and cited in the corpus notes.",
    },
    workflows: workflowResults,
    summary: {
      workflows: selected.length,
      workflowsPassed,
      expectations: {
        total: expectTotal.length,
        exact: expectTotal.filter((e) => e.outcome === "exact").length,
        lossy: expectTotal.filter((e) => e.outcome === "lossy").length,
        unsupported: expectTotal.filter((e) => e.outcome === "unsupported").length,
        failed: expectTotal.filter((e) => e.status === "fail").length,
      },
      interop: {
        total: interopTotal.length,
        exact: interopTotal.filter((i) => i.expected === "exact" && i.status === "pass").length,
        lossy: interopTotal.filter((i) => i.expected === "lossy" && i.status === "pass").length,
        unsupported: interopTotal.filter((i) => i.expected === "unsupported" && i.status === "pass").length,
        failed: interopTotal.filter((i) => i.status === "fail").length,
      },
      verdict: failed === 0 && workflowsPassed === selected.length ? "CERTIFIED" : "FAILED",
    },
  };

  return { report, consoleLines: lines };
}

// ---------------------------------------------------------------------------
// One workflow.
// ---------------------------------------------------------------------------

async function runWorkflow(
  driver: CertDriver,
  wf: CorpusWorkflow,
  runId: string,
  call: (kind: "command" | "query", name: string, payload: unknown) => Promise<DriverResult>,
  lines: string[],
): Promise<WorkflowCertification> {
  const t0 = Date.now();
  log(lines, `P019 CERTIFICATION: workflow ${wf.id} — ${wf.title}`);

  const docKey = `${runId}-${wf.id}`;
  const created = await call("command", "document.create", {
    entityId: docKey,
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "p019-certification",
  });
  if (!created.ok) throw new Error(`document.create failed for ${wf.id}: ${JSON.stringify(created).slice(0, 200)}`);

  let snap = await getState(driver);
  const labeled = new Map<string, DriverResult>();
  const phaseResults: PhaseResult[] = [];
  const expectationResults: ExpectationResult[] = [];
  let workflowFailed = false;

  for (const phase of wf.phases) {
    const phaseState: PhaseRunState = {
      labeled: new Map(labeled),
      echoLines: [],
      revisionsBefore: revisionCount(snap),
      revisionsAfter: revisionCount(snap),
      commandCount: 0,
    };
    let phaseFailed = false;
    try {
      for (const c of phase.commands ?? []) {
        const res = await call("command", c.name, c.payload);
        phaseState.commandCount += 1;
        if (c.as) {
          labeled.set(c.as, res);
          phaseState.labeled.set(c.as, res);
        }
        // Commands that DECLINE are only legal when an expectation in this
        // phase declares that decline (the honest-refusal rule).
        const declaresDecline = phase.expectations.some((e) => e.check.kind === "decline" && e.check.command === c.name);
        if (!res.ok && !declaresDecline) {
          throw new Error(`phase ${phase.id}: command ${c.name} failed: ${JSON.stringify(res).slice(0, 300)}`);
        }
        snap = await getState(driver);
      }
      if (phase.script) {
        // The LIVE event loop: entity picks resolve against the CURRENT
        // document state (a later pick may reference an element an earlier
        // command in the same script created — the real host behavior), and
        // each emitted CommandPlan executes through the driver BEFORE the
        // next event is applied. The shared prompt-engine reducer stays the
        // ONLY command semantics source (runCommandScript's loop, unrolled
        // for live pick resolution).
        let promptState = IDLE_PROMPT_STATE;
        for (const step of phase.script) {
          const ev = toPromptEvent(snap, step);
          const result = applyPromptEvent(promptState, ev, contextFor(snap));
          promptState = result.state;
          phaseState.echoLines.push(...result.output.lines);
          if (result.output.plan !== null) {
            for (const entry of result.output.plan.appApi) {
              const res = await call("command", entry.name, entry.payload);
              phaseState.commandCount += 1;
              if (!res.ok) {
                throw new Error(`phase ${phase.id}: plan command ${entry.name} failed: ${JSON.stringify(res).slice(0, 300)}`);
              }
            }
            snap = await getState(driver);
          }
        }
      }
      for (const qq of phase.queries ?? []) {
        const res = await call("query", qq.name, qq.payload);
        labeled.set(qq.as, res);
        phaseState.labeled.set(qq.as, res);
      }
      snap = await getState(driver);
    } catch (err) {
      phaseFailed = true;
      log(lines, `P019 CERTIFICATION:   phase ${phase.id} EXECUTION ERROR: ${(err as Error).message}`);
    }
    snap = await getState(driver);
    phaseState.revisionsAfter = revisionCount(snap);

    for (const exp of phase.expectations) {
      const r = await evaluateExpectation(exp, phaseState, snap, call);
      expectationResults.push(r);
      if (r.status === "fail") {
        workflowFailed = true;
        phaseFailed = true;
        log(lines, `P019 CERTIFICATION:   FAIL ${exp.id} [${exp.outcome}]: ${r.detail ?? ""}`);
      }
    }
    phaseResults.push({
      id: phase.id,
      status: phaseFailed ? "fail" : "pass",
      commandCount: phaseState.commandCount,
      revisionDelta: phaseState.revisionsAfter - phaseState.revisionsBefore,
    });
    log(lines, `P019 CERTIFICATION:   phase ${phase.id} ${phaseFailed ? "FAIL" : "pass"} (${phaseState.commandCount} commands, Δrev ${phaseState.revisionsAfter - phaseState.revisionsBefore})`);
  }

  // --- the cross-cutting arms -------------------------------------------

  const finalDigest = digestOf(snap);

  // Undo/redo atomicity: undo N revisions, redo N — the exact state digest
  // must return byte-identically.
  let undoRedo: "pass" | "fail" | "not-declared" = "not-declared";
  if (wf.robustness.undoRedoSteps > 0) {
    const preDigest = digestOf(await getState(driver));
    for (let i = 0; i < wf.robustness.undoRedoSteps; i++) {
      await call("command", "document.undo", {});
    }
    for (let i = 0; i < wf.robustness.undoRedoSteps; i++) {
      await call("command", "document.redo", {});
    }
    const postDigest = digestOf(await getState(driver));
    undoRedo = preDigest === postDigest ? "pass" : "fail";
    if (undoRedo === "fail") workflowFailed = true;
    log(lines, `P019 CERTIFICATION:   undoRedo(${wf.robustness.undoRedoSteps}) ${undoRedo}`);
  }

  // Persistence round-trip: save → open → save again — the canonical
  // CONTENT (elements, history, layers, settings, tables — the deterministic
  // canonical identity + lineage) must round-trip byte-identically. The
  // live editorState field (canUndo/canRedo/commandDepth — the session's
  // undo-stack markers) is the one documented volatile field: a reopened
  // document starts with a fresh editor stack, so it is excluded from the
  // byte comparison and disclosed here (honest, never silent).
  let roundTrip: "pass" | "fail" | "not-declared" = "not-declared";
  if (wf.robustness.roundTrip) {
    const s1 = await call("command", "document.save", {});
    if (s1.ok) {
      const bytes1 = (s1.value as { bytes: number[] }).bytes;
      const opened = await call("command", "document.open", { source: bytes1 });
      if (opened.ok) {
        const s2 = await call("command", "document.save", {});
        if (s2.ok) {
          const bytes2 = (s2.value as { bytes: number[] }).bytes;
          roundTrip = contentCanonical(bytes1) === contentCanonical(bytes2) ? "pass" : "fail";
        } else {
          roundTrip = "fail";
        }
      } else {
        roundTrip = "fail";
      }
    } else {
      roundTrip = "fail";
    }
    if (roundTrip === "fail") workflowFailed = true;
    log(lines, `P019 CERTIFICATION:   roundTrip(save→open→save, content+history byte-identical; live editorState excluded) ${roundTrip}`);
  }

  // Replay determinism: the SAME workflow in a FRESH document reproduces
  // the normalized semantic digest byte-identically.
  let replayStable: "pass" | "fail" | "not-declared" = "not-declared";
  if (wf.robustness.replayStable) {
    const replay = await replayWorkflow(wf, `${runId}b`, call);
    const normalize = (d: string, key: string) => d.split(key).join("«project»").replace(/[0-9a-f]{64}/g, "«sha256»");
    replayStable =
      normalize(replay.finalDigest, `${runId}b-${wf.id}`) === normalize(finalDigest, `${runId}-${wf.id}`) ? "pass" : "fail";
    if (replayStable === "fail") workflowFailed = true;
    log(lines, `P019 CERTIFICATION:   replayStable ${replayStable}`);
  }

  // Interop probes: the REAL carrier codecs/reports (never narrative).
  const interopResults: InteropResult[] = [];
  for (const io of wf.interop) {
    const r = await runInteropProbe(driver, io, call);
    interopResults.push(r);
    if (r.status === "fail") {
      workflowFailed = true;
      log(lines, `P019 CERTIFICATION:   interop FAIL ${io.id}: expected ${io.expected}, observed ${r.observed}`);
    } else {
      log(lines, `P019 CERTIFICATION:   interop ${io.id} [${io.surface}/${io.concept}] expected ${io.expected} — observed ${r.observed} — pass`);
    }
  }

  const ms = Date.now() - t0;
  log(lines, `P019 CERTIFICATION: workflow ${wf.id} ${workflowFailed ? "FAIL" : "pass"} (${ms}ms)`);

  return {
    id: wf.id,
    title: wf.title,
    discipline: wf.discipline,
    status: workflowFailed ? "fail" : "pass",
    phases: phaseResults,
    expectations: expectationResults,
    interop: interopResults,
    robustness: { roundTrip, undoRedo, replayStable },
    finalDigest,
    perf: [],
  };
}

// ---------------------------------------------------------------------------
// Expectation evaluation.
// ---------------------------------------------------------------------------

async function evaluateExpectation(
  exp: CorpusExpectation,
  phase: PhaseRunState,
  snap: StateSnapshot,
  call: (kind: "command" | "query", name: string, payload: unknown) => Promise<DriverResult>,
): Promise<ExpectationResult> {
  const check = exp.check;
  try {
    switch (check.kind) {
      case "count": {
        if (snap.elements.length !== check.equals) {
          return fail(exp, `element count ${snap.elements.length} ≠ ${check.equals}`);
        }
        return pass(exp);
      }
      case "countBy": {
        const n = snap.elements.filter((e) => (e.props as Record<string, unknown> | undefined)?.type === check.type).length;
        if (n !== check.equals) {
          return fail(exp, `countBy ${check.type}: ${n} ≠ ${check.equals}`);
        }
        return pass(exp);
      }
      case "state": {
        const v = getPath(snap, check.path);
        if (!deepEqual(v, check.equals, check.tol ?? TOL_DEFAULT)) {
          return fail(exp, `state ${check.path}: ${JSON.stringify(v)} ≠ ${JSON.stringify(check.equals)}`);
        }
        return pass(exp);
      }
      case "result": {
        const r = phase.labeled.get(check.of);
        if (!r) return fail(exp, `labeled result '${check.of}' not found in this phase`);
        if (!r.ok) return fail(exp, `labeled result '${check.of}' is a decline: ${r.code}`);
        const v = getPath(r.value, check.path);
        if (!deepEqual(v, check.equals, check.tol ?? TOL_DEFAULT)) {
          return fail(exp, `result ${check.of}.${check.path}: ${JSON.stringify(v)} ≠ ${JSON.stringify(check.equals)}`);
        }
        return pass(exp);
      }
      case "resultSame": {
        const r1 = phase.labeled.get(check.of1);
        const r2 = phase.labeled.get(check.of2);
        if (!r1 || !r2) return fail(exp, `labeled results '${check.of1}/${check.of2}' not found in this phase`);
        if (!r1.ok || !r2.ok) return fail(exp, `labeled results '${check.of1}/${check.of2}' are declines`);
        const v1 = getPath(r1.value, check.path);
        const v2 = getPath(r2.value, check.path);
        if (!deepEqual(v1, v2, 0)) {
          return fail(exp, `resultSame ${check.path}: ${JSON.stringify(v1?.toString?.().slice(0, 60))} ≠ ${JSON.stringify(v2?.toString?.().slice(0, 60))}`);
        }
        return pass(exp);
      }
      case "echo": {
        if (!phase.echoLines.includes(check.equals)) {
          const tail = phase.echoLines.slice(-8).join(" / ");
          return fail(exp, `echo line not found: ${JSON.stringify(check.equals)} (last lines: ${tail.slice(0, 200)})`);
        }
        return pass(exp);
      }
      case "decline": {
        const res =
          check.via === "query"
            ? await call("query", check.command, check.payload ?? {})
            : await call("command", check.command, check.payload ?? {});
        if (res.ok) return fail(exp, `${check.via ?? "command"} ${check.command} unexpectedly succeeded`);
        if (res.code !== check.code) return fail(exp, `decline code ${res.code} ≠ ${check.code}`);
        return pass(exp);
      }
      case "revisionDelta": {
        const delta = phase.revisionsAfter - phase.revisionsBefore;
        if (delta !== check.equals) {
          return fail(exp, `revisionDelta ${delta} ≠ ${check.equals}`);
        }
        return pass(exp);
      }
      case "revisionCount": {
        if (revisionCount(snap) !== check.equals) {
          return fail(exp, `revisionCount ${revisionCount(snap)} ≠ ${check.equals}`);
        }
        return pass(exp);
      }
    }
  } catch (err) {
    return fail(exp, `evaluation error: ${(err as Error).message}`);
  }
  void snap;
}

function pass(exp: CorpusExpectation): ExpectationResult {
  return { id: exp.id, outcome: exp.outcome, status: "pass" };
}
function fail(exp: CorpusExpectation, detail: string): ExpectationResult {
  return { id: exp.id, outcome: exp.outcome, status: "fail", detail: detail.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Replay (the determinism arm).
// ---------------------------------------------------------------------------

async function replayWorkflow(
  wf: CorpusWorkflow,
  runId: string,
  call: (kind: "command" | "query", name: string, payload: unknown) => Promise<DriverResult>,
): Promise<{ finalDigest: string }> {
  const drv: CertDriver = { command: (n, p) => call("command", n, p), query: (n, p) => call("query", n, p) };
  const created = await call("command", "document.create", {
    entityId: `${runId}-${wf.id}`,
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "p019-certification-replay",
  });
  if (!created.ok) throw new Error(`replay document.create failed for ${wf.id}`);
  let snap = await getState(drv);
  for (const phase of wf.phases) {
    for (const c of phase.commands ?? []) {
      const res = await call("command", c.name, c.payload);
      const declaresDecline = phase.expectations.some((e) => e.check.kind === "decline" && e.check.command === c.name);
      if (!res.ok && !declaresDecline) throw new Error(`replay phase ${phase.id}: ${c.name} failed: ${JSON.stringify(res).slice(0, 200)}`);
      snap = await getState(drv);
    }
    if (phase.script) {
      let promptState = IDLE_PROMPT_STATE;
      for (const step of phase.script) {
        const ev = toPromptEvent(snap, step);
        const result = applyPromptEvent(promptState, ev, contextFor(snap));
        promptState = result.state;
        if (result.output.plan !== null) {
          for (const entry of result.output.plan.appApi) {
            const res = await call("command", entry.name, entry.payload);
            if (!res.ok) throw new Error(`replay phase ${phase.id}: ${entry.name} failed: ${JSON.stringify(res).slice(0, 200)}`);
          }
          snap = await getState(drv);
        }
      }
    }
    for (const qq of phase.queries ?? []) {
      await call("query", qq.name, qq.payload);
    }
    snap = await getState(drv);
  }
  return { finalDigest: digestOf(snap) };
}

// ---------------------------------------------------------------------------
// Interop probes.
// ---------------------------------------------------------------------------

type Classification = "exact" | "tolerance" | "lossy" | "unsupported";

interface FieldRow {
  field: string;
  classification: string;
}

/** Extract the per-element field rows from a round-trip outcome value. */
function fieldRowsOf(value: unknown): FieldRow[] {
  const v = value as Record<string, unknown>;
  // dxf: { format, sourceSha256, report: { elements: [...] }, reportHash }
  // ifc: { format, sourceSha256, elements: IfcImportReport { elements: [...] }, reportHash }
  let elements: { fields?: FieldRow[] }[] | undefined;
  if (v.report !== undefined && typeof v.report === "object") {
    elements = (v.report as Record<string, unknown>).elements as { fields?: FieldRow[] }[] | undefined;
  } else if (v.elements !== undefined && typeof v.elements === "object" && Array.isArray(v.elements)) {
    elements = v.elements as { fields?: FieldRow[] }[];
  } else if (v.elements !== undefined && typeof v.elements === "object") {
    const inner = (v.elements as Record<string, unknown>).elements;
    if (Array.isArray(inner)) elements = inner as { fields?: FieldRow[] }[];
  }
  const rows: FieldRow[] = [];
  for (const el of elements ?? []) {
    for (const f of el.fields ?? []) rows.push(f);
  }
  return rows;
}

function aggregateClassification(rows: { classification: string }[]): string {
  const worst = (c: Classification): number => (c === "exact" ? 0 : c === "tolerance" ? 1 : c === "lossy" ? 2 : 3);
  let worstSeen: Classification = "exact";
  for (const r of rows) {
    const c = r.classification as Classification;
    if (worst(c) > worst(worstSeen)) worstSeen = c;
  }
  return worstSeen;
}

async function runInteropProbe(
  driver: CertDriver,
  io: CorpusInteropExpectation,
  call: (kind: "command" | "query", name: string, payload: unknown) => Promise<DriverResult>,
): Promise<InteropResult> {
  try {
    switch (io.probe.kind) {
      case "dxfAggregate":
      case "dxfUnsupportedTypes":
      case "dxfLayers": {
        const e = await call("query", "dxf.export", {});
        if (!e.ok) return interopFail(io, `dxf.export declined: ${e.code}`);
        const imp = await call("command", "dxf.import", { dxf: (e.value as { bytesBase64: string }).bytesBase64 });
        if (!imp.ok) return interopFail(io, `dxf.import declined: ${imp.code}`);
        const rt = await call("query", "interop.roundtripReport", { format: "dxf" });
        if (!rt.ok) return interopFail(io, `roundtrip report declined: ${rt.code}`);
        if (io.probe.kind === "dxfAggregate") {
          const rows = fieldRowsOf(rt.value);
          if (rows.length === 0) return interopResult(io, "unsupported");
          return interopResult(io, aggregateClassification(rows));
        }
        if (io.probe.kind === "dxfLayers") {
          const report = (rt.value as { report: { layers: { matched: number; created: number; lossy: number } } }).report;
          return interopResult(io, report.layers.lossy > 0 ? "lossy" : "exact");
        }
        // The export-side skip surface: the writer counts every element it
        // does not carry (LOCK-007: counted, never silent) — the sorted
        // skippedKinds list on the dxf.export result.
        const skippedKinds = ((e.value as { skippedKinds?: string[] }).skippedKinds ?? []);
        const observed = skippedKinds.length === 0 ? "none" : skippedKinds.join(",");
        const includesOk = io.probe.includes.every((t) => skippedKinds.includes(t));
        if (!includesOk) return interopFail(io, `skippedKinds '${observed}' does not include every declared kind`);
        return interopResult(io, "unsupported");
      }
      case "ifcAggregate": {
        const e = await call("command", "ifc.export", { projectName: "P019 Certification" });
        if (!e.ok) return interopFail(io, `ifc.export declined: ${e.code}`);
        const imp = await call("command", "ifc.import", { ifc: (e.value as { ifc: string }).ifc });
        if (!imp.ok) return interopFail(io, `ifc.import declined: ${imp.code}`);
        const rt = await call("query", "interop.roundtripReport", { format: "ifc" });
        if (!rt.ok) return interopFail(io, `ifc roundtrip report declined: ${rt.code}`);
        const rows = fieldRowsOf(rt.value);
        if (rows.length === 0) return interopResult(io, "unsupported");
        return interopResult(io, aggregateClassification(rows));
      }
      case "toolsetsInterop": {
        const conceptId = io.probe.conceptId;
        const surface = io.probe.surface;
        const rt = await call("query", "interop.toolsetsReport", {});
        if (!rt.ok) return interopFail(io, `toolsets interop report declined: ${rt.code}`);
        const rows = (rt.value as { rows: { concept: string; surface: string; classification: string; note: string }[] }).rows;
        const row = rows.find((r) => r.concept === conceptId && (surface === undefined || r.surface === surface));
        if (!row) return interopFail(io, `no interop row for concept '${conceptId}'`);
        if (io.note && !row.note.includes(io.note)) {
          return interopFail(io, `note mismatch: expected substring '${io.note}' in '${row.note}'`);
        }
        return interopResult(io, row.classification);
      }
      case "sheetExportDecline": {
        const r = await call("query", "docs.exportSheet", { sheetId: "probe-sheet", format: io.probe.format });
        if (r.ok) return interopFail(io, `sheet export '${io.probe.format}' unexpectedly succeeded`);
        if (r.code !== "docs_unsupported") return interopFail(io, `decline code ${r.code} ≠ docs_unsupported`);
        return interopResult(io, "unsupported");
      }
      case "sheetExportDigestStable": {
        const setup = await ensureProbeSheet(driver, call);
        if (!setup) return interopFail(io, "probe sheet setup failed");
        const a = await call("query", "docs.exportSheet", { sheetId: "sh-000001", format: io.probe.format });
        if (!a.ok) return interopFail(io, `sheet export declined: ${a.code}`);
        const b = await call("query", "docs.exportSheet", { sheetId: "sh-000001", format: io.probe.format });
        if (!b.ok) return interopFail(io, `second sheet export declined: ${b.code}`);
        const va = a.value as { sha256?: string; hash?: string };
        const vb = b.value as { sha256?: string; hash?: string };
        const da = va.sha256 ?? va.hash ?? "";
        const db = vb.sha256 ?? vb.hash ?? "";
        return interopResult(io, da === db && da.length > 0 ? "exact" : "lossy");
      }
    }
  } catch (err) {
    return interopFail(io, `probe error: ${(err as Error).message}`);
  }
}

/** Creates the minimal deterministic probe sheet (idempotent). */
async function ensureProbeSheet(
  driver: CertDriver,
  call: (kind: "command" | "query", name: string, payload: unknown) => Promise<DriverResult>,
): Promise<boolean> {
  const st = await call("query", "document.getState", {});
  if (!st.ok) return false;
  const snap = st.value as StateSnapshot & { docsSheets?: unknown[] };
  if ((snap.docsSheets?.length ?? 0) > 0) return true;
  const created = await call("command", "docs.createSheets", {
    sheets: [{ title: "P019 Probe Sheet", viewPlacements: [], titleBlock: { projectName: "P019 Certification", sheetTitle: "P019 Probe Sheet", sheetNumber: "P-001" } }],
  });
  void driver;
  return created.ok;
}

function interopResult(io: CorpusInteropExpectation, observed: string): InteropResult {
  const status: "pass" | "fail" =
    observed === io.expected || (io.expected === "exact" && observed === "tolerance") ? "pass" : "fail";
  return { id: io.id, surface: io.surface, expected: io.expected, observed, status };
}

function interopFail(io: CorpusInteropExpectation, detail: string): InteropResult {
  return { id: io.id, surface: io.surface, expected: io.expected, observed: `probe-failure: ${detail.slice(0, 200)}`, status: "fail" };
}

// ---------------------------------------------------------------------------
// The pinned-fixture projection + normalization.
// ---------------------------------------------------------------------------

/**
 * The deterministic projection for the pinned fixture: the report WITHOUT
 * the basis line (the driver disclosure — the app-suite, host-parity and
 * web-smoke bases differ BY DESIGN) with the run-unique identity normalized
 * (the P016/P017/P018 discipline — content-addressed hex is tokenized;
 * every SEMANTIC field is pinned verbatim; perf samples are NEVER part of
 * the pinned artifact). The projection is the parity basis ACROSS hosts:
 * the same corpus through the in-process renderer, the Web/Electron host
 * transports and the real web app over HTTP must produce the byte-identical
 * projection.
 */
export function pinnedProjection(report: CertificationReport): string {
  const { basis: _basis, ...rest } = report;
  void _basis;
  return canonicalStringify(rest).replace(/[0-9a-f]{64}/g, "«sha256»");
}

export function reportSha256(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
