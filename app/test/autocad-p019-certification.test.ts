/**
 * CAD-PARITY-019 (Issue #122) — the AutoCAD parity certification app-suite
 * test: the version-pinned corpus (autocad-p019-corpus/1) executed through
 * the REAL App API handler (the reference bundle + the pinned IfcOpenShell
 * interop adapter), assessed by the certification engine, pinned by the
 * fixture (app/test/fixtures/cad-parity-019-certification.json).
 *
 * The certification dimensions (the P019 record's evidence requirements):
 *  1. SEMANTIC FIDELITY — every declared reference expectation is evaluated
 *     against the live document/query results with its honest outcome
 *     classification (exact / lossy / unsupported);
 *  2. PERSISTENCE/ROUND-TRIP — save → open → save byte-identical canonical
 *     bytes (the deterministic canonical identity + lineage proof);
 *  3. REAL-UI TASK COMPLETION — every script phase runs through the SHARED
 *     prompt-engine command registry (the real command line surface; the
 *     Web host half is the certification-p019 smoke against the running
 *     dev server; the host-parity test proves the same stream through
 *     both host transports);
 *  4. INTEROP — the live carrier probes (the DRY DXF/IFC round-trip
 *     loops, the toolsets interop matrix, the sheet export surfaces) with
 *     explicit EXACT/LOSSY/UNSUPPORTED outcomes;
 *  5. PERFORMANCE/ROBUSTNESS — per-workflow wall-clock budgets asserted
 *     (never pinned), undo/redo atomicity, replay determinism.
 *
 * The pinned fixture is the NORMALIZED certification report (the run-unique
 * identity tokenized; every semantic field pinned verbatim; perf samples
 * excluded). Regenerate with --write-fixture.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import { ifcSkip } from "./ifc-availability.js";
import { runCertification, pinnedProjection, reportSha256, type CertDriver } from "../src/certification/engine.js";
import { P019_WORKFLOWS, corpusSha256, CORPUS_REFERENCE } from "../src/certification/corpus.js";
import type { CommandQueryResponse, Command, Query } from "../src/contracts/app-api.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "cad-parity-019-certification.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

const skipIfc = await ifcSkip();

function makeDriver(): { driver: CertDriver } {
  const handler = AppApiHandler.create({
    adapterBundle: createReferenceAdapterBundle(undefined, { ifc: createIfcInteropAdapter() }),
    entityId: "p019-certification-app",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "p019-certification",
  });
  const driver: CertDriver = {
    async command(name: string, payload: unknown) {
      const r = await handler.handle({ type: "command", name: name as never, payload } as Command);
      return toDriverResult(r);
    },
    async query(name: string, payload: unknown) {
      const r = await handler.handle({ type: "query", name: name as never, payload } as Query);
      return toDriverResult(r);
    },
  };
  return { driver };
}

function toDriverResult(r: CommandQueryResponse): { ok: true; value: unknown } | { ok: false; code: string; message?: string } {
  return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.code, message: r.message };
}

test("CAD-PARITY-019: the AutoCAD parity certification over the version-pinned corpus (semantics, persistence, interop, robustness) — the pinned certification report", { skip: skipIfc }, async () => {
  const { driver } = makeDriver();
  const { report } = await runCertification(driver, {
    driverKind: "in-process",
    basisNote: "The app-suite certification basis: the deterministic engine-free reference adapter + the pinned IfcOpenShell 0.8.5 interop adapter, driven in-process through the REAL App API handler and the shared prompt-engine command registry.",
  });

  // --- the certification verdict (the honest aggregate) -------------------
  assert.equal(report.summary.verdict, "CERTIFIED", `the certification verdict (summary: ${JSON.stringify(report.summary)})`);
  assert.equal(report.summary.workflows, P019_WORKFLOWS.length, "every corpus workflow is certified");
  assert.equal(report.summary.workflowsPassed, P019_WORKFLOWS.length, "every corpus workflow passes");
  assert.equal(report.summary.expectations.failed, 0, "zero failed expectations");
  assert.equal(report.summary.interop.failed, 0, "zero failed interop probes");
  for (const wf of report.workflows) {
    assert.equal(wf.status, "pass", `workflow ${wf.id} passes`);
    assert.equal(wf.robustness.roundTrip, "pass", `workflow ${wf.id}: the save/open round-trip preserves the canonical bytes`);
    assert.equal(wf.robustness.undoRedo, "pass", `workflow ${wf.id}: undo/redo atomicity`);
    assert.equal(wf.robustness.replayStable, "pass", `workflow ${wf.id}: replay determinism`);
  }

  // --- the version pin is bound into the report ---------------------------
  assert.equal(report.corpus.sha256, corpusSha256(), "the report pins THIS corpus revision");
  assert.equal(report.corpus.version, CORPUS_REFERENCE.corpusVersion, "the corpus version");
  assert.equal(report.contract, "offisos-p019-certification/1", "the certification report contract");

  // --- the honest outcome spread is non-trivial (not a feature checklist) -
  // The corpus declares exact AND lossy AND unsupported outcomes across both
  // the semantic expectations and the interop boundary — presence alone is
  // never the certification.
  assert.ok(report.summary.expectations.exact > 0, "exact expectations exist");
  assert.ok(report.summary.expectations.unsupported > 0, "explicit unsupported (typed-refusal) expectations exist");
  assert.ok(report.summary.interop.exact > 0, "exact interop outcomes exist");
  assert.ok(report.summary.interop.lossy > 0, "lossy interop outcomes exist");
  assert.ok(report.summary.interop.unsupported > 0, "unsupported interop outcomes exist");

  // --- the pinned fixture (the deterministic report basis) ----------------
  const normalized = pinnedProjection(report);
  const sha = reportSha256(normalized);
  console.log(`P019 CERTIFICATION TEST: pinned report sha256 ${sha}`);
  if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
    mkdirSync(join(HERE, "fixtures"), { recursive: true });
    writeFileSync(FIXTURE_PATH, `${JSON.stringify({ reportSha256: sha, normalized: JSON.parse(normalized) }, null, 2)}\n`);
    console.log(`P019 CERTIFICATION TEST: fixture ${WRITE_FIXTURE ? "written" : "created"} (regenerate deliberately with --write-fixture)`);
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { reportSha256: string; normalized: unknown };
  assert.equal(fixture.reportSha256, sha, "the certification report is byte-identical to the pinned fixture (deterministic across runs)");
  assert.deepEqual(fixture.normalized, JSON.parse(normalized), "the normalized report matches the pinned fixture");
});

test("CAD-PARITY-019: the corpus itself is pinned and well-formed (the first-deliverable invariants)", async () => {
  assert.equal(P019_WORKFLOWS.length, 8, "8 representative professional workflows");
  const ids = new Set(P019_WORKFLOWS.map((w) => w.id));
  assert.equal(ids.size, P019_WORKFLOWS.length, "unique workflow ids");
  const disciplines = new Set(P019_WORKFLOWS.map((w) => w.discipline));
  assert.ok(disciplines.size >= 8, "the corpus spans the professional disciplines");
  for (const wf of P019_WORKFLOWS) {
    assert.ok(wf.phases.length >= 3, `workflow ${wf.id} is an INTEGRATED multi-phase workflow`);
    assert.ok(wf.referenceBehavior.length > 100, `workflow ${wf.id} declares its AutoCAD reference behavior`);
    for (const phase of wf.phases) {
      assert.ok(phase.script !== undefined || phase.commands !== undefined, `phase ${wf.id}/${phase.id} has a driving surface`);
      for (const exp of phase.expectations) {
        assert.ok(exp.reference.length > 20, `expectation ${exp.id} cites its reference behavior`);
        assert.ok(exp.outcome === "exact" || exp.outcome === "lossy" || exp.outcome === "unsupported", `expectation ${exp.id} has an honest outcome classification`);
      }
    }
    for (const io of wf.interop) {
      assert.ok(io.reference.length > 20, `interop ${io.id} cites its exchange reference`);
    }
  }
  // The corpus sha is stable (the version pin is checkable): the digest is
  // a pure function of the corpus data.
  assert.match(corpusSha256(), /^[0-9a-f]{64}$/, "the corpus digest is a stable sha256");
  assert.equal(corpusSha256(), corpusSha256(), "the corpus digest is deterministic");
});
