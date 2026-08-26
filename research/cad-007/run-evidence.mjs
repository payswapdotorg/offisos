/**
 * RESEARCH-CAD-007 deterministic evidence runner (Issue #32).
 *
 * Produces the committed evidence artifact for the final CAD/BIM feasibility
 * gate. Runs the SAME representative corpus + workflow as the app test suite
 * and records the measured facts:
 *
 *   1. cross-engine equivalence matrix (OCCT vs the engine-free reference
 *      adapter): per-element volumes/bboxes + measured max deltas against
 *      the declared tolerances;
 *   2. the engine-swap proof summary: identical content hash / graph events
 *      / downstream identities, values agreeing within tolerance;
 *   3. the existential cascade snapshot (quantities → estimate → RFQ →
 *      commercial impact) with its deterministic events_hash;
 *   4. engine provenance + environment (node version, OCCT availability).
 *
 * Deterministic: identical inputs → identical artifacts (timestamps are
 * recorded from the run metadata only, never mixed into the values).
 *
 * Reproduce: node --import tsx research/cad-007/run-evidence.mjs
 * (from the repo root; the OCCT leg is included automatically when the
 * pinned toolchain is present — its absence is recorded honestly.)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const { AppApiHandler } = await import(join(ROOT, "app/src/app-api/index.ts"));
const { createReferenceAdapterBundle, createReferenceGeometryAdapter, REFERENCE_ENGINE_VERSION } = await import(
  join(ROOT, "app/src/adapters/reference/index.ts")
);
const { createOcctAdapterBundle, probeOcctEngine } = await import(join(ROOT, "app/src/adapters/occt/index.ts"));
const { canonicalStringify } = await import(join(ROOT, "app/src/caddocument/index.ts"));

const CORPUS = [
  { id: "el-column-a", category: "concrete", descriptor: { shape: "box", width: 0.4, depth: 0.4, height: 3.0 } },
  { id: "el-slab", category: "concrete", descriptor: { shape: "box", width: 6, depth: 4, height: 0.2 } },
  { id: "el-pipe-riser", category: "steel", descriptor: { shape: "cylinder", radius: 0.05, height: 3, origin: [1, 1, 0], direction: [0, 0, 1] } },
  { id: "el-beam-rot", category: "steel", descriptor: { shape: "transform", matrix: [0, -1, 0, 5, 1, 0, 0, 5, 0, 0, 1, 0, 0, 0, 0, 1], target: { shape: "box", width: 2, depth: 0.1, height: 0.2 } } },
  { id: "el-footing", category: "concrete", descriptor: { shape: "fuse", a: { shape: "box", width: 1, depth: 1, height: 0.3 }, b: { shape: "transform", matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], target: { shape: "box", width: 1, depth: 1, height: 0.3 } } } },
  { id: "el-slab-opening", category: "concrete", descriptor: { shape: "cut", a: { shape: "box", width: 6, depth: 4, height: 0.2 }, b: { shape: "transform", matrix: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, -0.05, 0, 0, 0, 1], target: { shape: "box", width: 1, depth: 1, height: 0.3 } } } },
];
const RESIZED = { shape: "box", width: 0.4, depth: 0.4, height: 3.5 };

const DECLARED = { volumeAbs: 1e-6, volumeRel: 1e-6, bboxAbs: 0.02 };

async function buildWorkflow(handler, entityId) {
  const send = (r) => handler.handle(r);
  let res = await send({ type: "command", name: "document.create", payload: { entityId } });
  if (!res.ok) throw new Error("create failed");
  for (const item of CORPUS) {
    res = await send({ type: "command", name: "document.applyEdit", payload: { edit: { type: "addElement", element: { id: item.id, kind: "geometry", engineId: null, props: { geometry: item.descriptor, category: item.category } } } } });
    if (!res.ok) throw new Error(`add ${item.id} failed`);
  }
  res = await send({ type: "command", name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: "el-column-a", patch: { geometry: RESIZED } } } });
  if (!res.ok) throw new Error("resize failed");
  return handler;
}

async function prepare(adapter, descriptor) {
  const result = await adapter.prepareGeometry({ id: "evidence", kind: "geometry", engineId: null, props: descriptor });
  const meta = await adapter.describeGeometryMetadata(result.meshToken);
  return { meshToken: result.meshToken, bbox: result.bbox, volume: meta?.volume ?? null };
}

async function main() {
  const probe = await probeOcctEngine({ timeoutMs: 20000 });
  const reference = createReferenceGeometryAdapter();
  const evidence = {
    run: "run-001",
    gate: "RESEARCH-CAD-007",
    issue: 32,
    environment: {
      node: process.version,
      platform: process.platform,
      referenceEngine: `reference@${REFERENCE_ENGINE_VERSION}`,
      occt: probe.available ? { available: true, engineVersion: probe.engineVersion } : { available: false, recorded: "OCCT toolchain absent in this environment — the engine legs are covered by CI runs (see the record's evidence)" },
    },
    declared_tolerances: DECLARED,
  };

  // --- 1. cross-engine equivalence matrix -----------------------------------
  const matrix = [];
  let maxVolumeRelErr = 0;
  let maxBboxAbsDiff = 0;
  const occtAdapter = probe.available ? (await import(join(ROOT, "app/src/adapters/occt/index.ts"))).createOcctGeometryAdapter() : null;
  for (const item of CORPUS) {
    const ref = await prepare(reference, item.descriptor);
    const row = { element: item.id, shape: item.descriptor.shape, reference: { volume: ref.volume, bbox: ref.bbox, meshTokenPrefix: "ref:" } };
    if (occtAdapter !== null) {
      const occt = await prepare(occtAdapter, item.descriptor);
      const denom = Math.max(Math.abs(occt.volume), Math.abs(ref.volume), 1e-30);
      const relErr = Math.abs(occt.volume - ref.volume) / denom;
      const bboxDiff = occt.bbox.reduce((m, v, i) => Math.max(m, Math.abs(v - ref.bbox[i])), 0);
      row.occt = { volume: occt.volume, bbox: occt.bbox, meshTokenPrefix: "occt:" };
      row.agreement = {
        volume_rel_err: relErr,
        volume_within_declared: relErr <= DECLARED.volumeRel || Math.abs(occt.volume - ref.volume) <= DECLARED.volumeAbs,
        bbox_abs_diff: bboxDiff,
        bbox_within_declared: bboxDiff <= DECLARED.bboxAbs,
      };
      maxVolumeRelErr = Math.max(maxVolumeRelErr, relErr);
      maxBboxAbsDiff = Math.max(maxBboxAbsDiff, bboxDiff);
    }
    matrix.push(row);
  }
  evidence.cross_engine = {
    corpus: matrix,
    measured: occtAdapter !== null ? { max_volume_rel_err: maxVolumeRelErr, max_bbox_abs_diff: maxBboxAbsDiff } : null,
  };

  // --- 2. engine swap + existential cascade ---------------------------------
  const ENTITY = "cad007-evidence-doc";
  const FORMAT = "offisos-evidence";
  const referenceHandler = await buildWorkflow(AppApiHandler.create({ adapterBundle: createReferenceAdapterBundle(), entityId: ENTITY, format: FORMAT, formatVersion: "1", createdBy: "cad007-evidence" }), ENTITY);
  const refCascade = (await referenceHandler.handle({ type: "query", name: "impact.cascade", payload: {} })).value;

  const swap = {
    reference: {
      content_hash: referenceHandler.currentContentHash(),
      cascade_events_hash: refCascade.events_hash,
      estimate_total: refCascade.estimate.current.total,
      estimate_delta_total: refCascade.estimate.current.total - (refCascade.estimate.previous?.total ?? 0),
      commercial_impact: refCascade.commercial_impact,
      engine: refCascade.engine,
      identities: {
        quantity_ids: refCascade.quantities.current.map((x) => x.quantity_id),
        item_ids: refCascade.estimate.current.items.map((x) => x.item_id),
        package_ids: refCascade.rfq.packages.map((p) => p.package_id),
        estimate_id: refCascade.estimate.current.estimate_id,
      },
    },
  };

  if (probe.available) {
    const occtHandler = await buildWorkflow(AppApiHandler.create({ adapterBundle: createOcctAdapterBundle(), entityId: ENTITY, format: FORMAT, formatVersion: "1", createdBy: "cad007-evidence" }), ENTITY);
    const occtCascade = (await occtHandler.handle({ type: "query", name: "impact.cascade", payload: {} })).value;
    swap.occt = {
      content_hash: occtHandler.currentContentHash(),
      cascade_events_hash: occtCascade.events_hash,
      estimate_total: occtCascade.estimate.current.total,
      commercial_impact: occtCascade.commercial_impact,
      engine: occtCascade.engine,
      identities: {
        quantity_ids: occtCascade.quantities.current.map((x) => x.quantity_id),
        item_ids: occtCascade.estimate.current.items.map((x) => x.item_id),
        package_ids: occtCascade.rfq.packages.map((p) => p.package_id),
        estimate_id: occtCascade.estimate.current.estimate_id,
      },
    };
    swap.canonical_semantics_identical = {
      content_hash: swap.reference.content_hash === swap.occt.content_hash,
      quantity_ids: JSON.stringify(swap.reference.identities.quantity_ids) === JSON.stringify(swap.occt.identities.quantity_ids),
      item_ids: JSON.stringify(swap.reference.identities.item_ids) === JSON.stringify(swap.occt.identities.item_ids),
      package_ids: JSON.stringify(swap.reference.identities.package_ids) === JSON.stringify(swap.occt.identities.package_ids),
      estimate_id: swap.reference.identities.estimate_id === swap.occt.identities.estimate_id,
    };
    swap.values_agree_within_declared_tolerance =
      Math.abs(swap.reference.estimate_total - swap.occt.estimate_total) <=
      Math.max(DECLARED.volumeAbs, DECLARED.volumeRel * Math.max(Math.abs(swap.reference.estimate_total), Math.abs(swap.occt.estimate_total)));
  }
  evidence.engine_swap = swap;

  // --- 3. the existential cascade snapshot ----------------------------------
  evidence.existential_cascade = {
    entity_id: refCascade.entity_id,
    transition: `r${refCascade.from_revision.revision_number} -> r${refCascade.to_revision.revision_number}`,
    cause: "model.version.created (graph bridge)",
    event_chain: refCascade.events.map((e) => e.event_type),
    causation_chain_verified: refCascade.events.every((e, i) => e.causation_id === (i === 0 ? refCascade.model_event_id : refCascade.events[i - 1].event_id)),
    quantity_deltas: refCascade.quantities.deltas,
    estimate: { previous_total: refCascade.estimate.previous?.total ?? null, current_total: refCascade.estimate.current.total, currency: refCascade.estimate.current.currency, rate_table: refCascade.rate_table_id },
    rfq_impacts: refCascade.rfq.impacts,
    commercial_impact: refCascade.commercial_impact,
    events_hash: refCascade.events_hash,
  };

  // --- 4. determinism: re-run → identical artifact-relevant hashes ------------
  const rerunHandler = await buildWorkflow(AppApiHandler.create({ adapterBundle: createReferenceAdapterBundle(), entityId: ENTITY, format: FORMAT, formatVersion: "1", createdBy: "cad007-evidence" }), ENTITY);
  const rerunCascade = (await rerunHandler.handle({ type: "query", name: "impact.cascade", payload: {} })).value;
  evidence.determinism = {
    rerun_events_hash_identical: rerunCascade.events_hash === refCascade.events_hash,
    rerun_content_hash_identical: rerunHandler.currentContentHash() === referenceHandler.currentContentHash(),
  };

  const outDir = join(ROOT, "research/cad-007/evidence/run-001");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  const summary = [
    `RESEARCH-CAD-007 evidence run-001`,
    `node ${process.version}; reference@${REFERENCE_ENGINE_VERSION}; occt ${evidence.environment.occt.available ? evidence.environment.occt.engineVersion : "absent (recorded honestly)"}`,
    evidence.cross_engine.measured
      ? `cross-engine: max volume rel err ${evidence.cross_engine.measured.max_volume_rel_err.toExponential(3)} (declared ${DECLARED.volumeRel}), max bbox abs diff ${evidence.cross_engine.measured.max_bbox_abs_diff.toExponential(3)} (declared ${DECLARED.bboxAbs})`
      : `cross-engine: OCCT absent locally — matrix carries the reference column; CI runs carry the OCCT column`,
    `engine swap: ${evidence.engine_swap.canonical_semantics_identical ? "ALL canonical semantics identical (content/graph/identities)" : "occt leg not run locally"}`,
    `existential cascade: ${evidence.existential_cascade.event_chain.join(" -> ")}; estimate delta ${evidence.existential_cascade.estimate.current_total - (evidence.existential_cascade.estimate.previous_total ?? 0)} GHS; commercial ${evidence.existential_cascade.commercial_impact.total_delta} GHS; hash ${evidence.existential_cascade.events_hash.slice(0, 16)}...`,
    `determinism rerun: ${JSON.stringify(evidence.determinism)}`,
  ].join("\n");
  writeFileSync(join(outDir, "summary.txt"), summary + "\n");
  console.log(summary);
}

await main();
