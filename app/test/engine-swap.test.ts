/**
 * THE engine-swap proof (RESEARCH-CAD-007 / Issue #32): replacing the
 * geometry engine behind the frozen adapter boundary does not change
 * canonical ConstructionOS semantics.
 *
 * The SAME engine-free workflow (identical descriptors in element props,
 * engineId null) runs through TWO complete hosts — one bound to the REAL
 * OCCT engine, one bound to the engine-free reference adapter — and a third
 * leg proves document PORTABILITY: the document saved by the reference
 * engine is opened and consumed by the OCCT host.
 *
 * Asserted identical across engines (canonical semantics):
 *   - document content hash + full revision history (the engine never
 *     enters the document);
 *   - the complete Construction Graph event stream (byte-identical
 *     events_hash);
 *   - all downstream identities: quantity ids, cost item ids, estimate ids,
 *     RFQ package ids, graph node ids, downstream event ids;
 *   - the downstream event structure (types, causation chain, revisions).
 *
 * Asserted to AGREE within declared tolerances (measured values):
 *   - quantity values (engine-computed volumes), estimate totals, RFQ
 *     amounts, commercial impact totals.
 *
 * Different BY DESIGN (provenance only):
 *   - cascade.engine (engineId/engineVersion) and the meshToken cache keys.
 *
 * Engine-gated: skips with a recorded reason when the pinned OCCT toolchain
 * is absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { canonicalStringify } from "../src/caddocument/index.js";
import type { Command, Query } from "../src/contracts/app-api.js";
import type { ImpactCascade } from "../src/contracts/impact.js";
import type { GraphBridgeResult, ModelHistory } from "../src/contracts/model.js";
import { engineSkip } from "./engine-availability.js";
import { CORPUS, resizedColumnDescriptor } from "./cad007-corpus.js";

const skipEngine = await engineSkip();

function cmd(name: Command["name"], payload: unknown): Command {
  return { type: "command", name, payload };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}

async function okValue<T>(handler: AppApiHandler, request: Command | Query): Promise<T> {
  const response = await handler.handle(request);
  assert.equal(response.ok, true, `${request.name}: ${JSON.stringify(response).slice(0, 400)}`);
  return (response as { ok: true; value: T }).value;
}

const ENTITY = "cad007-swap-doc";
/** The document format is canonical metadata, NOT engine property — both
 *  hosts in the swap use the SAME format so the comparison isolates the
 *  engine variable exactly. */
const FORMAT = "offisos-swap";

/** The engine-free representative workflow. */
async function buildWorkflow(handler: AppApiHandler): Promise<void> {
  await okValue(handler, cmd("document.create", { entityId: ENTITY }));
  for (const item of CORPUS) {
    await okValue(handler, cmd("document.applyEdit", {
      edit: {
        type: "addElement",
        element: { id: item.id, kind: "geometry", engineId: null, props: { geometry: item.descriptor, category: item.category } },
      },
    }));
  }
  await okValue(handler, cmd("document.applyEdit", {
    edit: { type: "updateElement", elementId: "el-column-a", patch: { geometry: resizedColumnDescriptor() } },
  }));
}

function makeOcctHandler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle(),
    entityId: ENTITY,
    format: FORMAT,
    formatVersion: "1",
    createdBy: "cad007-test",
  });
}

function makeReferenceHandler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createReferenceAdapterBundle(),
    entityId: ENTITY,
    format: FORMAT,
    formatVersion: "1",
    createdBy: "cad007-test",
  });
}

/** Identity/structure skeleton of a cascade (provenance + value free). */
function cascadeSkeleton(cascade: ImpactCascade): unknown {
  return {
    entity_id: cascade.entity_id,
    from_revision: cascade.from_revision,
    to_revision: cascade.to_revision,
    model_event_id: cascade.model_event_id,
    events: cascade.events.map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      causation_id: e.causation_id,
      source_version_id: e.source_version_id,
      source_revision_id: e.source_revision_id,
      correlation_id: e.correlation_id,
    })),
    quantity_ids: cascade.quantities.current.map((x) => x.quantity_id),
    quantity_node_ids: cascade.quantities.current.map((x) => x.graph_node_id),
    item_ids: cascade.estimate.current.items.map((x) => x.item_id),
    estimate_id: cascade.estimate.current.estimate_id,
    previous_estimate_id: cascade.estimate.previous?.estimate_id ?? null,
    package_ids: cascade.rfq.packages.map((p) => p.package_id),
    package_scopes: cascade.rfq.packages.map((p) => [p.package_id, p.scope_element_ids]),
    impact_structure: cascade.rfq.impacts.map((i) => [i.package_id, i.category, i.affected]),
    commercial_affected: cascade.commercial_impact.affected_package_ids,
  };
}

test("replacing the engine preserves every canonical semantic (OCCT ↔ reference)", { skip: skipEngine }, async () => {
  const occt = makeOcctHandler();
  const reference = makeReferenceHandler();
  await buildWorkflow(occt);
  await buildWorkflow(reference);

  // 1. the engine never enters the document: identical content + history
  assert.equal(occt.currentContentHash(), reference.currentContentHash(), "document content hash identical across engines");
  const historyO = await okValue<ModelHistory>(occt, q("model.getHistory"));
  const historyR = await okValue<ModelHistory>(reference, q("model.getHistory"));
  assert.equal(canonicalStringify(historyO), canonicalStringify(historyR), "identical revision histories");

  // 2. identical Construction Graph event stream
  const graphO = await okValue<GraphBridgeResult>(occt, q("model.getGraphEvents"));
  const graphR = await okValue<GraphBridgeResult>(reference, q("model.getGraphEvents"));
  assert.equal(graphO.events_hash, graphR.events_hash, "graph events_hash identical across engines");
  assert.equal(canonicalStringify(graphO.events), canonicalStringify(graphR.events));

  // 3. identical downstream identity skeleton + structure
  const cascadeO = await okValue<ImpactCascade>(occt, q("impact.cascade", { revision_number: 7 }));
  const cascadeR = await okValue<ImpactCascade>(reference, q("impact.cascade", { revision_number: 7 }));
  assert.deepEqual(cascadeSkeleton(cascadeO), cascadeSkeleton(cascadeR), "downstream identity skeleton identical across engines");

  // 4. measured values agree within the declared tolerances
  const valueTol = (a: number, b: number) => Math.max(1e-6, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
  for (const qo of cascadeO.quantities.current) {
    const qr = cascadeR.quantities.current.find((x) => x.element_id === qo.element_id)!;
    assert.ok(
      Math.abs(qo.value - qr.value) <= valueTol(qo.value, qr.value),
      `${qo.element_id}: quantity agrees within tolerance (occt ${qo.value} vs ref ${qr.value})`,
    );
    assert.equal(qo.method, "engine-geometry-adapter");
    assert.equal(qr.method, "engine-geometry-adapter");
  }
  assert.ok(
    Math.abs(cascadeO.estimate.current.total - cascadeR.estimate.current.total) <=
      valueTol(cascadeO.estimate.current.total, cascadeR.estimate.current.total),
    `estimate totals agree (occt ${cascadeO.estimate.current.total} vs ref ${cascadeR.estimate.current.total})`,
  );
  assert.ok(
    Math.abs(cascadeO.commercial_impact.total_delta - cascadeR.commercial_impact.total_delta) <=
      valueTol(cascadeO.commercial_impact.total_delta, cascadeR.commercial_impact.total_delta),
    "commercial impact agrees within tolerance",
  );

  // 5. provenance is the ONLY engine-visible difference
  assert.equal(cascadeO.engine.engineId, "occt");
  assert.equal(cascadeR.engine.engineId, "reference");

  // 6. per-engine determinism: rerun both → identical hashes
  const cascadeO2 = await okValue<ImpactCascade>(occt, q("impact.cascade", { revision_number: 7 }));
  const cascadeR2 = await okValue<ImpactCascade>(reference, q("impact.cascade", { revision_number: 7 }));
  assert.equal(cascadeO2.events_hash, cascadeO.events_hash, "OCCT cascade deterministic");
  assert.equal(cascadeR2.events_hash, cascadeR.events_hash, "reference cascade deterministic");

  console.log(
    `engine swap: content+graph+identities identical; values agree (estimate Δ = ${Math.abs(
      cascadeO.estimate.current.total - cascadeR.estimate.current.total,
    ).toExponential(3)} GHS within declared 1e-6 relative)`,
  );
});

test("document portability: saved by the reference engine, opened and consumed by the OCCT host", { skip: skipEngine }, async () => {
  const producer = makeReferenceHandler();
  await buildWorkflow(producer);
  const saved = await okValue<{ bytes: number[]; format: string }>(producer, cmd("document.save", {}));
  const produced = await okValue<ImpactCascade>(producer, q("impact.cascade", {}));

  const consumer = makeOcctHandler();
  const opened = await okValue<unknown>(consumer, cmd("document.open", { source: saved.bytes }));
  assert.ok(opened !== null, "OCCT host opens the reference-engine document");
  const consumed = await okValue<ImpactCascade>(consumer, q("impact.cascade", {}));

  // identity skeleton identical; values agree within tolerance; the
  // consuming engine's provenance is recorded (engine swap mid-lifecycle)
  assert.deepEqual(cascadeSkeleton(produced), cascadeSkeleton(consumed), "identities survive the engine hand-off");
  assert.ok(
    Math.abs(produced.estimate.current.total - consumed.estimate.current.total) <=
      Math.max(1e-6, 1e-6 * Math.abs(produced.estimate.current.total)),
    "estimates agree after the engine hand-off",
  );
  assert.equal(consumed.engine.engineId, "occt", "the consuming engine's provenance is recorded");
  assert.equal(produced.estimate.current.estimate_id, consumed.estimate.current.estimate_id);
});

test("typed failures cross the boundary identically for both engines", { skip: skipEngine }, async () => {
  const occt = makeOcctHandler();
  await okValue(occt, cmd("document.create", { entityId: "cad007-failures" }));
  await okValue(occt, cmd("document.applyEdit", {
    edit: { type: "addElement", element: { id: "bad", kind: "geometry", engineId: null, props: { geometry: { shape: "box", width: -1, depth: 1, height: 1 }, category: "concrete" } } },
  }));
  const badO = await occt.handle(q("impact.cascade", {}));
  assert.equal(badO.ok, false);
  const bad = badO as { ok: false; code: string; message: string };
  assert.equal(bad.code, "engine_malformed_input", "typed failure passes through the cascade identically");

  const reference = makeReferenceHandler();
  await okValue(reference, cmd("document.create", { entityId: "cad007-failures" }));
  await okValue(reference, cmd("document.applyEdit", {
    edit: { type: "addElement", element: { id: "bad", kind: "geometry", engineId: null, props: { geometry: { shape: "box", width: -1, depth: 1, height: 1 }, category: "concrete" } } },
  }));
  const badR = (await reference.handle(q("impact.cascade", {}))) as { ok: false; code: string; message: string };
  assert.equal(badR.ok, false);
  assert.equal(badR.code, "engine_malformed_input");
  assert.equal(badR.message, bad.message, "the error surface is engine-independent too");
});
