/**
 * CAD-PARITY-020 (Issue #123) — the Archicad-class parity certification
 * app-suite test: the version-pinned Archicad corpus (archicad-p020-corpus/1
 * — the version-pinned Graphisoft Archicad 27 reference manifest with every
 * manifest locator verified live, the explicit command-analog map with the
 * closed partition — Archicad documents NO command-line interface, so every
 * Offisos surface the corpus drives is a declared semantic analog, never an
 * "Archicad command") executed through the REAL App API handler (the
 * reference bundle + the pinned IfcOpenShell interop adapter), assessed by
 * the certification engine (the SAME P019-certified engine — the corpus
 * bundle seam), pinned by the fixture
 * (app/test/fixtures/cad-parity-020-certification.json).
 *
 * The certification dimensions (the P020 record's evidence requirements):
 *  1. SEMANTIC FIDELITY — every declared reference expectation is evaluated
 *     against the live document/query results with its honest outcome
 *     classification (exact / lossy / unsupported);
 *  2. PERSISTENCE/ROUND-TRIP — save → open → save byte-identical canonical
 *     bytes (the deterministic canonical identity + lineage proof);
 *  3. REAL-UI TASK COMPLETION — every script phase runs through the SHARED
 *     prompt-engine command registry (the real command line surface with
 *     the shell-mirroring story activation; the Web host half is the
 *     certification-p020 smoke against the running dev server; the
 *     host-parity test proves the same stream through both host
 *     transports);
 *  4. INTEROP — the live carrier probes (the DRY IFC round-trip loops, the
 *     toolsets interop matrix incl. the honest LOSSY structured-arrays
 *     boundary, the DXF 2D-carrier skip boundary, the sheet export
 *     surfaces) with explicit EXACT/LOSSY/UNSUPPORTED outcomes;
 *  5. PERFORMANCE/ROBUSTNESS — per-workflow wall-clock budgets asserted
 *     (never pinned), undo/redo atomicity, replay determinism.
 *
 * The pinned fixture is the NORMALIZED certification report (the run-unique
 * identity tokenized; every semantic field pinned verbatim; perf samples
 * excluded — the phase command streams are pinned too: the invoked command
 * names are part of the auditable certification basis). Regenerate with
 * --write-fixture.
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
import { runCertification, pinnedProjection, reportSha256, P020_ARCHICAD_CORPUS_BUNDLE, type CertDriver } from "../src/certification/engine.js";
import {
  ARCHICAD_WORKFLOWS,
  archicadCorpusSha256,
  archicadCorpusCatalog,
  archicadCorpusOutcomeCounts,
  ARCHICAD_CORPUS_REFERENCE,
  ARCHICAD_REFERENCE_MANIFEST,
  ARCHICAD_COMMAND_ANALOGS,
} from "../src/certification/corpus-archicad.js";
import type { CommandQueryResponse, Command, Query } from "../src/contracts/app-api.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "cad-parity-020-certification.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

const skipIfc = await ifcSkip();

function makeDriver(): { driver: CertDriver } {
  const handler = AppApiHandler.create({
    adapterBundle: createReferenceAdapterBundle(undefined, { ifc: createIfcInteropAdapter() }),
    entityId: "p020-certification-app",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "p020-certification",
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

test("CAD-PARITY-020: the Archicad-class parity certification over the version-pinned corpus (semantics, persistence, interop, robustness) — the pinned certification report", { skip: skipIfc }, async () => {
  const { driver } = makeDriver();
  const { report } = await runCertification(driver, {
    driverKind: "in-process",
    corpus: P020_ARCHICAD_CORPUS_BUNDLE,
    basisNote: "The app-suite certification basis: the deterministic engine-free reference adapter + the pinned IfcOpenShell 0.8.5 interop adapter (the same basis family the VERIFIED P019 certification used), driven in-process through the REAL App API handler and the shared prompt-engine command registry; the Offisos surfaces are the declared Graphisoft Archicad 27 semantic analogs.",
  });

  // --- the certification verdict (the honest aggregate) -------------------
  assert.equal(report.summary.verdict, "CERTIFIED", `the certification verdict (summary: ${JSON.stringify(report.summary)})`);
  assert.equal(report.summary.workflows, ARCHICAD_WORKFLOWS.length, "every corpus workflow is certified");
  assert.equal(report.summary.workflowsPassed, ARCHICAD_WORKFLOWS.length, "every corpus workflow passes");
  assert.equal(report.summary.expectations.failed, 0, "zero failed expectations");
  assert.equal(report.summary.interop.failed, 0, "zero failed interop probes");
  for (const wf of report.workflows) {
    assert.equal(wf.status, "pass", `workflow ${wf.id} passes`);
    assert.equal(wf.robustness.roundTrip, "pass", `workflow ${wf.id}: the save/open round-trip preserves the canonical bytes`);
    assert.equal(wf.robustness.undoRedo, "pass", `workflow ${wf.id}: undo/redo atomicity`);
    assert.equal(wf.robustness.replayStable, "pass", `workflow ${wf.id}: replay determinism`);
  }

  // --- the version pin is bound into the report ---------------------------
  assert.equal(report.corpus.sha256, archicadCorpusSha256(), "the report pins THIS corpus revision");
  assert.equal(report.corpus.version, ARCHICAD_CORPUS_REFERENCE.corpusVersion, "the corpus version");
  assert.equal(report.contract, "offisos-p020-certification/1", "the certification report contract");

  // --- the honest outcome spread is non-trivial (not a feature checklist) -
  // The corpus declares exact AND unsupported outcomes across the semantic
  // expectations, and exact AND lossy AND unsupported across the interop
  // boundary — presence alone is never the certification.
  const spread = archicadCorpusOutcomeCounts();
  assert.equal(report.summary.expectations.exact, spread.exact, "the exact expectation count matches the corpus declaration");
  assert.equal(report.summary.expectations.unsupported, spread.unsupported, "the unsupported (typed-refusal) expectation count matches the corpus declaration");
  assert.ok(report.summary.expectations.exact > 0, "exact expectations exist");
  assert.ok(report.summary.expectations.unsupported > 0, "explicit unsupported (typed-refusal) expectations exist");
  assert.ok(report.summary.interop.exact > 0, "exact interop outcomes exist");
  assert.ok(report.summary.interop.lossy > 0, "lossy interop outcomes exist (the honest structured-arrays boundary)");
  assert.ok(report.summary.interop.unsupported > 0, "unsupported interop outcomes exist");

  // --- the pinned fixture (the deterministic report basis) ----------------
  const normalized = pinnedProjection(report);
  const sha = reportSha256(normalized);
  console.log(`P020 CERTIFICATION TEST: pinned report sha256 ${sha}`);

  // --- the closed command-analog partition (the P019-rev2 discipline) -----
  // Archicad documents NO command-line interface: every command-line name
  // the certification ACTUALLY invoked must be an explicit semantic-analog
  // entry — no unbound Offisos command can be presented as Archicad
  // behavior, and NOTHING is ever claimed as an "Archicad command".
  const analogs = new Set(ARCHICAD_COMMAND_ANALOGS.filter((a) => a.surface === "command-line").map((a) => a.offisosSurface));
  const invoked = new Set<string>();
  for (const wf of report.workflows) {
    for (const phase of wf.phases) {
      for (const name of phase.commandNames) invoked.add(name);
    }
  }
  const unbound = [...invoked].filter((n) => !analogs.has(n));
  assert.deepEqual(unbound, [], "every invoked command-line name is an explicit semantic-analog entry (the closed partition — Archicad documents no command line)");
  assert.ok(invoked.size >= 20, `the certification exercised a representative command-line surface (${invoked.size} distinct commands)`);

  // --- the catalog drift guard (the P019-rev3 lesson generalized) ---------
  // The derived catalog (the certification.archicadCatalog App API surface)
  // must agree with THIS run's report counts — the single source of truth
  // is the canonical corpus, so the UI can never drift.
  const cat = archicadCorpusCatalog();
  assert.equal(cat.corpus.version, ARCHICAD_CORPUS_REFERENCE.corpusVersion, "the catalog pins the current corpus version");
  assert.equal(cat.corpus.sha256, archicadCorpusSha256(), "the catalog pins the current corpus sha256");
  assert.equal(cat.totals.workflows, report.summary.workflows, "the catalog workflow count equals the report");
  assert.equal(cat.totals.expectations, report.summary.expectations.total, "the catalog expectation count equals the report");
  assert.equal(cat.totals.interop, report.summary.interop.total, "the catalog interop count equals the report");
  for (const row of cat.workflows) {
    const wf = report.workflows.find((w) => w.id === row.id);
    assert.ok(wf !== undefined, `the catalog row ${row.id} exists in the report`);
    assert.equal(row.phases, wf.phases.length, `the catalog row ${row.id} phase count equals the report`);
    assert.equal(row.expectations, wf.expectations.length, `the catalog row ${row.id} expectation count equals the report`);
  }
  // And the App API query itself returns the canonical catalog (the REAL
  // handler — the same surface the Certification workbench renders).
  const catQuery = await driver.query("certification.archicadCatalog", {});
  assert.ok(catQuery.ok, `the certification.archicadCatalog query succeeds: ${JSON.stringify(catQuery).slice(0, 200)}`);
  assert.deepEqual((catQuery as { ok: true; value: unknown }).value, cat, "the App API returns the canonical derived catalog byte-identically");

  if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
    mkdirSync(join(HERE, "fixtures"), { recursive: true });
    writeFileSync(FIXTURE_PATH, `${JSON.stringify({ reportSha256: sha, normalized: JSON.parse(normalized) }, null, 2)}\n`);
    console.log(`P020 CERTIFICATION TEST: fixture ${WRITE_FIXTURE ? "written" : "created"} (regenerate deliberately with --write-fixture)`);
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { reportSha256: string; normalized: unknown };
  assert.equal(fixture.reportSha256, sha, "the certification report is byte-identical to the pinned fixture (deterministic across runs)");
  assert.deepEqual(fixture.normalized, JSON.parse(normalized), "the normalized report matches the pinned fixture");
});

test("CAD-PARITY-020: the Archicad corpus itself is pinned and well-formed (the first-deliverable invariants)", async () => {
  assert.equal(ARCHICAD_WORKFLOWS.length, 8, "8 representative Archicad-class BIM/documentation workflows");
  const ids = new Set(ARCHICAD_WORKFLOWS.map((w) => w.id));
  assert.equal(ids.size, ARCHICAD_WORKFLOWS.length, "unique workflow ids");
  const disciplines = new Set(ARCHICAD_WORKFLOWS.map((w) => w.discipline));
  assert.ok(disciplines.size >= 4, "the corpus spans the professional disciplines (authoring, documentation, interop, collaboration)");
  for (const wf of ARCHICAD_WORKFLOWS) {
    assert.ok(wf.phases.length >= 3, `workflow ${wf.id} is an INTEGRATED multi-phase workflow`);
    assert.ok(wf.referenceBehavior.length > 100, `workflow ${wf.id} declares its Archicad reference behavior`);
    for (const phase of wf.phases) {
      assert.ok(phase.script !== undefined || phase.commands !== undefined || phase.expectations.length > 0, `phase ${wf.id}/${phase.id} has a driving surface`);
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
  assert.match(archicadCorpusSha256(), /^[0-9a-f]{64}$/, "the corpus digest is a stable sha256");
  assert.equal(archicadCorpusSha256(), archicadCorpusSha256(), "the corpus digest is deterministic");
});

test("CAD-PARITY-020: the reference basis is independently auditable (the version-pinned Graphisoft Archicad 27 reference manifest + the explicit closed command-analog map — the P019-rev2 discipline applied from the start)", async () => {
  // --- the manifest: authoritative, version-pinned, well-formed ----------
  const manifestIds = new Set(ARCHICAD_REFERENCE_MANIFEST.map((s) => s.id));
  assert.ok(ARCHICAD_REFERENCE_MANIFEST.length >= 20, "the manifest covers the Archicad-class reference family (the help anchor, stories, the element tools, zones, renovation, design options, properties, attributes, the interactive schedule, views, the layout book, revisions, publishing, IFC, teamwork, change tracking, interoperability)");
  for (const s of ARCHICAD_REFERENCE_MANIFEST) {
    assert.ok(s.id.length > 3 && s.product.length > 3 && s.title.length > 3, `manifest entry ${s.id} has id/product/title`);
    assert.ok(/^https:\/\/help\.graphisoft\.com\/AC\/27\/INT\//.test(s.locator), `manifest entry ${s.id} locator is a Graphisoft Help URL`);
    assert.ok(/AC\/27\/INT/.test(s.locator), `manifest entry ${s.id} locator is version-pinned to Archicad 27 (INT)`);
    assert.ok(s.docId.length > 3, `manifest entry ${s.id} carries its document path (the docId)`);
    assert.ok(s.scope.length > 40, `manifest entry ${s.id} declares its tool/topic scope`);
  }

  // --- every workflow cites manifest sources ------------------------------
  for (const wf of ARCHICAD_WORKFLOWS) {
    assert.ok(wf.sources.length >= 1, `workflow ${wf.id} cites at least one manifest source`);
    for (const sid of wf.sources) {
      assert.ok(manifestIds.has(sid), `workflow ${wf.id} source '${sid}' resolves in the manifest`);
    }
  }

  // --- every expectation + interop expectation cites a manifest source ---
  let expectationCount = 0;
  let interopCount = 0;
  for (const wf of ARCHICAD_WORKFLOWS) {
    for (const phase of wf.phases) {
      for (const exp of phase.expectations) {
        expectationCount += 1;
        assert.ok(manifestIds.has(exp.source), `expectation ${exp.id} cites a resolvable manifest source '${exp.source}'`);
      }
    }
    for (const io of wf.interop) {
      interopCount += 1;
      assert.ok(manifestIds.has(io.source), `interop ${io.id} cites a resolvable manifest source '${io.source}'`);
    }
  }
  assert.equal(expectationCount, 52, "52 declared expectations, every one source-bound");
  assert.equal(interopCount, 14, "14 interop probes, every one source-bound");

  // --- the command-analog map: closed, well-formed, honest -----------------
  const commandLineAnalogs = new Set(ARCHICAD_COMMAND_ANALOGS.filter((a) => a.surface === "command-line").map((a) => a.offisosSurface));
  const appApiAnalogs = new Set(ARCHICAD_COMMAND_ANALOGS.filter((a) => a.surface === "app-api").map((a) => a.offisosSurface));
  for (const a of ARCHICAD_COMMAND_ANALOGS) {
    assert.ok(manifestIds.has(a.source), `analog ${a.offisosSurface} cites a resolvable source '${a.source}'`);
    assert.ok(a.archicadReference.length > 10, `analog ${a.offisosSurface} names its Graphisoft-documented Archicad reference`);
    assert.ok(a.scope.length > 40, `analog ${a.offisosSurface} declares its honest mapping scope`);
    assert.ok(a.surface === "command-line" || a.surface === "app-api", `analog ${a.offisosSurface} declares its surface`);
    // The honest disclosure discipline: every analog scope names the
    // not-an-Archicad-command boundary explicitly.
    assert.ok(/not an Archicad command name|analog/i.test(a.scope), `analog ${a.offisosSurface} discloses the analog (never an Archicad command)`);
  }
  // The Archicad-class authoring surface set is fully modeled.
  for (const surface of ["STORY", "WALL", "SLAB", "ROOF", "DOOR", "WINDOW", "STAIR", "RAILING", "ZONE", "SPACEGRID", "OPTION", "RENOVATE", "SCHEDULE", "QTO", "PROPDEF", "SUBSET", "TITLEBLOCK", "TITLEPLACE", "REVISION", "PUBSET", "PUBLISHBOOK", "COLLABJOIN", "PRESENCE", "COMMENT", "TXN", "CKPT", "RECOVER"]) {
    assert.ok(commandLineAnalogs.has(surface), `the Offisos surface ${surface} is explicitly modeled as a semantic analog`);
  }
  // The app-api analog surfaces are modeled too.
  for (const surface of ["bim.createElements", "docs.createViews", "docs.createSheets", "property.create", "material.create / material.assign", "schedule.create / quantities.run", "collab.* (join/presence/comment/commit/merge)", "recovery.* (checkpoint/restore/list)", "bim.setRenovation / bim.setClassification / bim.setOptionMembership / bim.setActiveOption", "ifc.export / ifc.import"]) {
    assert.ok(appApiAnalogs.has(surface), `the Offisos App API surface ${surface} is explicitly modeled as a semantic analog`);
  }
  // NOTHING is presented as an Archicad command (Archicad documents no
  // command-line interface) — the map is the closed analog partition.
  assert.ok(commandLineAnalogs.size >= 27, `the command-line analog partition is complete (${commandLineAnalogs.size} entries)`);
});
