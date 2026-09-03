// CAD-PARITY-020 / Issue #123: Web host Archicad-class parity certification
// smoke — the TWENTIETH workspace smoke.
//
// Drives the VERSION-PINNED Archicad-class BIM/documentation workflow corpus
// (archicad-p020-corpus/1, app/src/certification/corpus-archicad.ts) through
// the REAL web app over HTTP: every workflow's command-line script compiles
// through the SHARED prompt-engine command registry (with the
// shell-mirroring story activation and the documentation context tables),
// every emitted App API plan executes through the running dev server, every
// declared reference expectation is assessed with its honest outcome
// classification, and the cross-cutting arms (save→open→save content
// round-trip, undo/redo atomicity, replay determinism, the DRY IFC
// round-trip probes, the toolsets interop matrix incl. the honest LOSSY
// structured-arrays boundary, the DXF 2D-carrier skip boundary, the sheet
// export surfaces) run against the REAL server. The semantic verdict
// surfaces must match the pinned fixture byte-identically (the same
// normalized verdicts the app-suite certification test pins on the
// in-process basis — the parity basis across the app suite and the Web
// host). Perf budgets are wall-clock asserted per workflow and NEVER
// pinned.
//
// Engine boundary (LOCK-018): the certification stream runs in REFERENCE
// mode (OFFISOS_GEOMETRY_ENGINE=reference) with the pinned IfcOpenShell
// interop adapter (OFFISOS_IFC_WORKER) — the deterministic parity-fixture
// basis (the same basis family the VERIFIED P019 certification used).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-020-certification.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

const { runCertification, pinnedProjection, reportSha256, P020_ARCHICAD_CORPUS_BUNDLE } = await import(join(REPO_ROOT, "app", "src", "certification", "engine.ts"));

const step = (name) => console.log(`CERTIFICATION P020 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};

// --- the HTTP driver over the REAL web app --------------------------------

async function send(body) {
  const res = await fetch(`${BASE}/api/cad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api: "1", body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const driver = {
  async command(name, payload) {
    return send({ type: "command", name, payload });
  },
  async query(name, payload) {
    return send({ type: "query", name, payload });
  },
};

// --- the certification run -------------------------------------------------

step(`corpus run against ${BASE} (the version-pinned Archicad-class BIM/documentation workflow corpus)`);
const { report } = await runCertification(driver, {
  driverKind: "web-http",
  corpus: P020_ARCHICAD_CORPUS_BUNDLE,
  basisNote: "The web-smoke certification basis: the REAL Next.js web app over HTTP (the reference adapter + the pinned IfcOpenShell interop adapter bound at the wiring point), driven through the shared prompt-engine command registry; the Offisos surfaces are the declared Graphisoft Archicad 27 semantic analogs.",
});

step("the certification verdict");
assert(report.summary.verdict === "CERTIFIED", `the verdict (summary: ${JSON.stringify(report.summary)})`);
assert(report.summary.workflowsPassed === report.summary.workflows, "every workflow passes");
assert(report.summary.expectations.failed === 0, "zero failed expectations");
assert(report.summary.interop.failed === 0, "zero failed interop probes");
for (const wf of report.workflows) {
  assert(wf.status === "pass", `workflow ${wf.id} passes`);
  assert(wf.robustness.roundTrip === "pass", `workflow ${wf.id}: round-trip`);
  assert(wf.robustness.undoRedo === "pass", `workflow ${wf.id}: undo/redo atomicity`);
  assert(wf.robustness.replayStable === "pass", `workflow ${wf.id}: replay determinism`);
}

step(`the certification summary: ${report.summary.workflows} workflows, ${report.summary.expectations.total} expectations (${report.summary.expectations.exact} exact / ${report.summary.expectations.lossy} lossy / ${report.summary.expectations.unsupported} unsupported), ${report.summary.interop.total} interop probes (${report.summary.interop.exact} exact / ${report.summary.interop.lossy} lossy / ${report.summary.interop.unsupported} unsupported)`);

// --- the pinned fixture (the semantic verdict surfaces) --------------------
// The SAME pinnedProjection the app-suite certification test pins (the
// engine's deterministic basis-excluded projection — the parity basis
// ACROSS hosts: the same corpus through the in-process renderer and the
// REAL web app over HTTP must produce the byte-identical projection).
const normalized = pinnedProjection(report);
const sha = reportSha256(normalized);
console.log(`CERTIFICATION P020 SMOKE: pinned verdict-projection sha256 ${sha}`);

if (WRITE_FIXTURE) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify({ reportSha256: sha, normalized: JSON.parse(normalized) }, null, 2)}\n`);
  console.log("CERTIFICATION P020 SMOKE: fixture written (regenerate deliberately with --write-fixture)");
} else if (!existsSync(FIXTURE_PATH)) {
  console.log("CERTIFICATION P020 SMOKE: fixture absent — created");
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify({ reportSha256: sha, normalized: JSON.parse(normalized) }, null, 2)}\n`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(
    fixture.reportSha256 === sha,
    `the web-host certification projection must be byte-identical to the pinned fixture (the app-suite parity basis): fixture ${fixture.reportSha256} ≠ smoke ${sha}`,
  );
  console.log("CERTIFICATION P020 SMOKE: verdict projection byte-identical to the pinned fixture — pass");
}

// --- the catalog drift guard (the P019-rev2 stale-workbench lesson) --------
// The Certification workbench's corpus selector renders the ARCHICAD corpus
// catalog through the REAL app's certification.archicadCatalog query
// (nothing hard-coded) — the query must return the CANONICAL derived
// catalog, and its counts must agree with THIS smoke run's report (the
// drift guard through the real web app).
{
  const { archicadCorpusCatalog, ARCHICAD_CORPUS_REFERENCE } = await import(join(REPO_ROOT, "app", "src", "certification", "corpus-archicad.ts"));
  const r = await send({ type: "query", name: "certification.archicadCatalog", payload: {} });
  if (!r.ok) throw new Error(`ASSERTION FAILED: certification.archicadCatalog declined: ${JSON.stringify(r).slice(0, 200)}`);
  const canonical = archicadCorpusCatalog();
  assert(
    JSON.stringify(r.value) === JSON.stringify(canonical),
    "the real web app's certification.archicadCatalog returns the canonical derived catalog (the single source of truth the workbench renders)",
  );
  const cat = r.value;
  assert(cat.corpus.version === ARCHICAD_CORPUS_REFERENCE.corpusVersion, "the catalog pins the current corpus version");
  assert(cat.totals.workflows === report.summary.workflows, "the catalog workflow count equals the certification report");
  assert(cat.totals.expectations === report.summary.expectations.total, "the catalog expectation count equals the certification report");
  assert(cat.totals.interop === report.summary.interop.total, "the catalog interop count equals the certification report");
  console.log(`CERTIFICATION P020 SMOKE: the canonical ARCHICAD corpus catalog derived live through the real app — ${cat.totals.workflows} workflows / ${cat.totals.phases} phases / ${cat.totals.expectations} expectations / ${cat.totals.interop} interop probes (rev ${cat.corpus.version}, sha256 ${cat.corpus.sha256.slice(0, 12)}…) — no drift, pass`);
}
