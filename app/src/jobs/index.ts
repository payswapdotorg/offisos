/**
 * CAD-PARITY-016 (Issue #112) — the durable background-regeneration job
 * engine (PLAT-004; additive, engine-free, Architecture v1.1 FROZEN).
 *
 * Bounded, serverless-honest design: there is NO hidden background thread.
 * A job is a DETERMINISTIC stepwise state machine (queued → running →
 * succeeded/failed) whose durable state advances one explicit step per
 * `jobs.tick` command — reproducible, observable, and honest about the
 * host boundary (a long-running model/document operation is decomposed into
 * steps; each tick performs one step's work through the EXISTING module
 * boundaries — the docs projection core, the quantities takeoff core, the
 * bounded stream cache).
 *
 * Authority boundary (LOCK-019, the P016 governing boundary): a job NEVER
 * mutates the CADDocument. Its output is a REPORT (deterministic summary
 * bound to the canonical revision it was computed against). Promoting any
 * of it to canonical state happens ONLY through the caller's explicit
 * canonical persistence (the document command model) — the persistHint on
 * every job records this contract.
 */

import type {
  JobKind,
  JobResultSummary,
  JobView,
  SessionClock,
  StreamPageView,
} from "../contracts/collab.js";
import type { CADDocument } from "../caddocument/document.js";
import type { DocsViewRecord } from "../contracts/caddocument.js";
import { headRevisionIdOf } from "../recovery/index.js";
import { projectAllViews, viewContentHash } from "../docs/index.js";
import {
  parseQuantityTakeoffInput,
  runQuantityTakeoff,
  type QuantityReport,
  type QuantityTakeoffContext,
  type QuantityTakeoffInput,
} from "../quantities/index.js";

/** The closed job-kind vocabulary. */
export const JOB_KINDS: readonly JobKind[] = [
  "docs.regenerate",
  "quantity.recalculate",
  "model.stream.warm",
];

/** Typed job failure (surfaces as an app-api typed err). */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The persist contract printed on every job (the authority note). */
export const JOB_PERSIST_HINT =
  "job output is a report only — canonical persistence requires an explicit document command (docs.regenerate / document.applyEdit); worker output is never authority";

interface JobRecord {
  readonly id: string;
  readonly kind: JobKind;
  status: JobView["status"];
  step: number;
  readonly totalSteps: number;
  readonly createdAt: SessionClock;
  finishedAt: SessionClock | null;
  result: JobResultSummary | null;
  failure: { code: string; message: string } | null;
  /** Job params (validated per kind at create). */
  readonly params: Readonly<Record<string, unknown>>;
  /** Deterministic per-kind working state (accumulated across ticks). */
  readonly work: Readonly<Record<string, unknown>>;
  workMut: Record<string, unknown>;
}

/** The document-facing dependencies a tick may use (read-only). */
export interface JobDocumentContext {
  readonly doc: CADDocument;
  readonly streamPage: (doc: CADDocument, pageIndex: number, pageSize: number) => StreamPageView;
}

const STREAM_WARM_PAGE_SIZE = 100;

/**
 * The durable job store: create → tick (one deterministic step each) →
 * terminal. `jobs.get`/`jobs.list` read the durable state; nothing about a
 * job depends on wall-clock, random or environment state.
 */
export class JobStore {
  private readonly jobs: JobRecord[] = [];
  private seq = 0;
  private tickCount = 0;

  get jobTickCount(): number {
    return this.tickCount;
  }

  list(): readonly JobView[] {
    return this.jobs.map((j) => this.jobView(j));
  }

  byId(id: string): JobView | null {
    const record = this.jobs.find((j) => j.id === id);
    return record !== undefined ? this.jobView(record) : null;
  }

  /** Create a durable job (queued). Step counts are fixed per kind so the
   *  whole lifecycle is a pure function of the tick sequence. */
  create(kind: JobKind, params: unknown, clock: SessionClock, doc: CADDocument): JobView {
    if (!JOB_KINDS.includes(kind)) {
      throw new JobError("jobs_invalid", `job kind must be one of ${JOB_KINDS.join(" | ")}`);
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new JobError("jobs_invalid", "job params must be an object");
    }
    const p = params as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      if (key !== "source" && key !== "groupBy" && key !== "pageSize") {
        throw new JobError(
          "jobs_invalid",
          `job params allow { source?, groupBy?, pageSize? } — unknown field '${key}'`,
        );
      }
    }
    let totalSteps = 3;
    if (kind === "model.stream.warm") {
      const pageSize = streamWarmPageSizeOf(p);
      const totalElements = doc.allElements().length;
      totalSteps = Math.max(1, Math.ceil(totalElements / pageSize));
    }
    this.seq += 1;
    const workMut: Record<string, unknown> = {};
    const record: JobRecord = {
      id: `job-${String(this.seq).padStart(6, "0")}`,
      kind,
      status: "queued",
      step: 0,
      totalSteps,
      createdAt: clock,
      finishedAt: null,
      result: null,
      failure: null,
      params: p,
      work: workMut,
      workMut,
    };
    this.jobs.push(record);
    return this.jobView(record);
  }

  /** Advance ONE job by ONE deterministic step. Terminal jobs decline the
   *  tick typed (job_terminal). */
  tick(jobId: string, clock: SessionClock, ctx: JobDocumentContext): JobView {
    const record = this.jobs.find((j) => j.id === jobId);
    if (record === undefined) {
      throw new JobError("job_not_found", `job '${jobId}' does not exist`);
    }
    if (record.status === "succeeded" || record.status === "failed") {
      throw new JobError(
        "job_terminal",
        `job '${jobId}' is already ${record.status} (terminal jobs do not tick)`,
      );
    }
    this.tickCount += 1;
    record.status = "running";
    record.step += 1;
    try {
      this.runStep(record, ctx);
    } catch (e) {
      record.status = "failed";
      record.finishedAt = clock;
      record.failure = {
        code: e instanceof JobError ? e.code : "job_failed",
        message: (e as Error).message.slice(0, 200),
      };
      return this.jobView(record);
    }
    if (record.step >= record.totalSteps) {
      record.status = "succeeded";
      record.finishedAt = clock;
      record.result = this.buildResult(record, ctx);
    }
    return this.jobView(record);
  }

  // --- per-kind deterministic steps -----------------------------------------

  private runStep(record: JobRecord, ctx: JobDocumentContext): void {
    switch (record.kind) {
      case "docs.regenerate":
        this.stepDocsRegenerate(record, ctx);
        return;
      case "quantity.recalculate":
        this.stepQuantityRecalculate(record, ctx);
        return;
      case "model.stream.warm":
        this.stepStreamWarm(record, ctx);
        return;
    }
  }

  /** docs.regenerate — the documentation regeneration report computed in
   *  three durable steps (resolve views → project + hash → assemble),
   *  through the SAME shared docs core the docs.regenerate command uses
   *  (projectAllViews — model views directly, detail views against their
   *  source's fresh projection). */
  private stepDocsRegenerate(record: JobRecord, ctx: JobDocumentContext): void {
    const doc = ctx.doc;
    if (record.step === 1) {
      const views: readonly DocsViewRecord[] = doc.viewTable;
      if (views.length === 0) {
        throw new JobError("job_failed", "docs.regenerate: the document has no documentation views to regenerate");
      }
      record.workMut.views = views;
      return;
    }
    if (record.step === 2) {
      const views = record.work.views as readonly DocsViewRecord[];
      const elements = doc.allElements();
      const projections = projectAllViews(views, elements);
      const hashes: {
        viewId: string;
        kind: string;
        contentHash: string;
        primitiveCount: number;
        skips: number;
      }[] = [];
      for (const view of views) {
        const result = projections.get(view.id);
        if (result !== undefined && result.projection !== null) {
          hashes.push({
            viewId: view.id,
            kind: view.kind,
            contentHash: viewContentHash(result.projection),
            primitiveCount: result.projection.primitives.length,
            skips: result.projection.skips.length,
          });
        } else {
          hashes.push({
            viewId: view.id,
            kind: view.kind,
            contentHash: "error",
            primitiveCount: 0,
            skips: 0,
          });
        }
      }
      record.workMut.hashes = hashes;
      return;
    }
    // step 3: nothing further — the result assembles at terminal.
  }

  /** quantity.recalculate — the deterministic revision-bound takeoff
   *  computed in three durable steps (validate/parse → compute → assemble)
   *  through the SAME quantities core the quantities.run query uses. */
  private stepQuantityRecalculate(record: JobRecord, ctx: JobDocumentContext): void {
    if (record.step === 1) {
      const payload: Record<string, unknown> = {};
      // The closed takeoff-source vocabulary with the documented default
      // ("elements" — the same basis quantities.run validates against).
      payload.source = typeof record.params.source === "string" ? record.params.source : "elements";
      if (typeof record.params.groupBy === "string") payload.groupBy = record.params.groupBy;
      // parseQuantityTakeoffInput throws typed on invalid params — the job
      // records the failure deterministically.
      record.workMut.input = parseQuantityTakeoffInput(payload);
      return;
    }
    if (record.step === 2) {
      const input = record.work.input as QuantityTakeoffInput;
      const report = runQuantityTakeoff(input, quantityContextOf(ctx.doc));
      record.workMut.report = report;
      return;
    }
    // step 3: nothing further — the result assembles at terminal.
  }

  /** model.stream.warm — one bounded cache page per tick (the explicit
   *  cache warm-up for large models; the cache is NEVER authoritative). */
  private stepStreamWarm(record: JobRecord, ctx: JobDocumentContext): void {
    const pageSize = streamWarmPageSizeOf(record.params);
    const pageIndex = record.step - 1;
    ctx.streamPage(ctx.doc, pageIndex, pageSize);
  }

  private buildResult(record: JobRecord, ctx: JobDocumentContext): JobResultSummary {
    const doc = ctx.doc;
    const snapshot = doc.snapshot();
    const headRevision = headRevisionIdOf(doc.history);
    const revisionBinding = {
      documentVersionId: snapshot.version.version_id,
      documentVersionNumber: snapshot.version.version_number,
      contentHash: doc.currentContentHash(),
      modelRevisionNumber: headRevision.number,
    };
    if (record.kind === "docs.regenerate") {
      const hashes = record.work.hashes as readonly {
        viewId: string;
        kind: string;
        contentHash: string;
        primitiveCount: number;
        skips: number;
      }[];
      return {
        kind: record.kind,
        summary: {
          views: hashes.length,
          sheets: doc.sheetTable.length,
          viewHashes: hashes,
          revision: revisionBinding,
        },
      };
    }
    if (record.kind === "quantity.recalculate") {
      const report = record.work.report as QuantityReport | undefined;
      return {
        kind: record.kind,
        summary: {
          rows: report?.rows.length ?? 0,
          skipped: report?.skipped.length ?? 0,
          reportSha256: report?.reportSha256 ?? null,
          revision: revisionBinding,
        },
      };
    }
    // model.stream.warm
    const pageSize = streamWarmPageSizeOf(record.params);
    return {
      kind: record.kind,
      summary: {
        pagesWarmed: record.totalSteps,
        pageSize,
        totalElements: doc.allElements().length,
        cacheNonAuthority: true,
        revision: revisionBinding,
      },
    };
  }

  private jobView(record: JobRecord): JobView {
    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      step: record.step,
      totalSteps: record.totalSteps,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
      result: record.result,
      failure: record.failure,
      persistHint: JOB_PERSIST_HINT,
    };
  }
}

function streamWarmPageSizeOf(params: Readonly<Record<string, unknown>>): number {
  return typeof params.pageSize === "number" &&
    Number.isInteger(params.pageSize) &&
    params.pageSize >= 10 &&
    params.pageSize <= 500
    ? params.pageSize
    : STREAM_WARM_PAGE_SIZE;
}

/** The read-only takeoff context (the same context the quantities.run query
 *  builds — canonical elements + the persisted model history). */
export function quantityContextOf(doc: CADDocument): QuantityTakeoffContext {
  return { elements: doc.allElements(), history: doc.history };
}
