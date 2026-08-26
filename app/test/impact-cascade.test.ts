/**
 * The existential downstream cascade (RESEARCH-CAD-007 / Issue #32,
 * event-model.md §3): model change → model version → quantity delta →
 * estimate impact → affected RFQ → commercial impact.
 *
 * Engine-free rung (reference adapter): proves the full chain through the
 * shared App API with exact analytic values, deterministic replay, honest
 * skips (LOCK-007), persistence round-trip identity, and the causation link
 * to the model.version.created graph event.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { canonicalStringify } from "../src/caddocument/index.js";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import type { ImpactCascade } from "../src/contracts/impact.js";
import type { GraphBridgeResult } from "../src/contracts/model.js";
import { CORPUS, DEMO_RATES, EXPECTED_COLUMN_DELTA, EXPECTED_VOLUMES, resizedColumnDescriptor } from "./cad007-corpus.js";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "cad007-cascade-doc",
  format: "offisos-reference",
  formatVersion: "1",
  createdBy: "cad007-test",
};

function cmd(name: Command["name"], payload: unknown): Command {
  return { type: "command", name, payload };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}

async function ok<T>(handler: AppApiHandler, request: Command | Query): Promise<T> {
  const response = await handler.handle(request);
  assert.equal(response.ok, true, `expected ok for ${request.name}: ${JSON.stringify(response)}`);
  return (response as { ok: true; value: T }).value;
}

async function err(handler: AppApiHandler, request: Command | Query): Promise<{ ok: false; code: string; message: string }> {
  const response = await handler.handle(request);
  assert.equal(response.ok, false, `expected err for ${request.name}`);
  return response as { ok: false; code: string; message: string };
}

/** Build the corpus document + the model change (7 revisions). */
async function buildWorkflow(handler: AppApiHandler): Promise<void> {
  await ok(handler, cmd("document.create", { entityId: CONFIG.entityId }));
  for (const item of CORPUS) {
    await ok(handler, cmd("document.applyEdit", {
      edit: {
        type: "addElement",
        element: { id: item.id, kind: "geometry", engineId: "reference", props: { geometry: item.descriptor, category: item.category } },
      },
    }));
  }
  // the model change: the column grows 3.0 → 3.5 (revision 7)
  await ok(handler, cmd("document.applyEdit", {
    edit: { type: "updateElement", elementId: "el-column-a", patch: { geometry: resizedColumnDescriptor() } },
  }));
}

test("existential chain: model change → version → quantity delta → estimate → affected RFQ → commercial impact", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await buildWorkflow(handler);

  const history = await ok<{ revisions: unknown[] }>(handler, q("model.getHistory"));
  assert.equal(history.revisions.length, 7, "six adds + one update");

  const graph = await ok<GraphBridgeResult>(handler, q("model.getGraphEvents"));
  const revision7Event = graph.events.find(
    (e) => e.event_type === "model.version.created" && e.payload.revision.revision_number === 7,
  );
  assert.ok(revision7Event !== undefined, "model.version.created for revision 7 exists");

  const cascade = await ok<ImpactCascade>(handler, q("impact.cascade", { revision_number: 7 }));

  // --- the chain hangs off the graph event (causation) ---
  assert.equal(cascade.model_event_id, revision7Event.event_id, "cascade is caused by the model.version.created event");
  assert.equal(cascade.events[0]!.causation_id, revision7Event.event_id, "first downstream event caused by the graph event");
  for (let i = 1; i < cascade.events.length; i++) {
    assert.equal(cascade.events[i]!.causation_id, cascade.events[i - 1]!.event_id, "downstream causation chain");
  }
  assert.deepEqual(
    cascade.events.map((e) => e.event_type),
    [
      "quantity.recalculate.requested",
      "quantity.changed",
      "estimate.recalculated",
      "rfq.scope.impact.detected",
    ],
    "the event-model.md §3 cascade, in order",
  );

  // --- quantity deltas: exact analytic values ---
  const columnDelta = cascade.quantities.deltas.find((d) => d.element_id === "el-column-a");
  assert.ok(columnDelta !== undefined);
  assert.ok(Math.abs(columnDelta.previous! - EXPECTED_VOLUMES["el-column-a"]!) <= 1e-12, "previous volume exact");
  const resized = 0.4 * 0.4 * 3.5;
  assert.ok(Math.abs(columnDelta.current! - resized) <= 1e-12, "current volume exact");
  assert.ok(Math.abs(columnDelta.delta! - EXPECTED_COLUMN_DELTA) <= 1e-12, "delta exact (0.08)");
  // every other element unchanged (delta 0)
  for (const d of cascade.quantities.deltas.filter((x) => x.element_id !== "el-column-a")) {
    assert.ok(d.delta !== null && Math.abs(d.delta) <= 1e-12, `${d.element_id} unchanged`);
  }
  // quantities recorded with method/provenance/tolerance/uncertainty
  for (const quantity of cascade.quantities.current) {
    assert.equal(quantity.uncertainty, "CALCULATED");
    assert.equal(quantity.method, "engine-geometry-adapter", "reference adapter provides the metadata capability");
    assert.equal(quantity.engine?.engineId, "reference", "engine provenance recorded");
    assert.ok(quantity.declared_tolerance.relative >= 0, "declared tolerance present");
  }

  // --- estimate impact: exact demo-rate arithmetic ---
  const previousEstimate = cascade.estimate.previous;
  const currentEstimate = cascade.estimate.current;
  assert.ok(previousEstimate !== null, "revision 6 estimate exists");
  const columnItemId = currentEstimate.items.find((i) => i.element_id === "el-column-a")!.item_id;
  assert.equal(
    previousEstimate!.items.find((i) => i.element_id === "el-column-a")!.item_id,
    columnItemId,
    "cost item identity is VERSION-FREE (stable across estimate versions)",
  );
  const expectedDeltaTotal = EXPECTED_COLUMN_DELTA * DEMO_RATES.concrete;
  const estimateEvent = cascade.events.find((e) => e.event_type === "estimate.recalculated")!;
  const payload = estimateEvent.payload as { delta_total: number; previous_total: number | null; total: number; currency: string };
  assert.ok(Math.abs(payload.delta_total - expectedDeltaTotal) <= 1e-9, `estimate delta_total ${payload.delta_total} === ${expectedDeltaTotal}`);
  assert.ok(Math.abs((currentEstimate.total - previousEstimate!.total) - expectedDeltaTotal) <= 1e-9);
  assert.equal(payload.currency, "GHS");
  assert.equal(currentEstimate.rate_table_id, "demo-rates-2026-08");

  // --- affected RFQ: only the concrete package changes ---
  const packages = cascade.rfq.packages;
  assert.equal(packages.length, 2, "concrete + steel packages");
  const concrete = cascade.rfq.impacts.find((i) => i.category === "concrete")!;
  const steel = cascade.rfq.impacts.find((i) => i.category === "steel")!;
  assert.equal(concrete.affected, true, "concrete package affected");
  assert.equal(steel.affected, false, "steel package unaffected");
  assert.ok(Math.abs(concrete.delta_amount - expectedDeltaTotal) <= 1e-9, "concrete package delta equals estimate delta");
  assert.ok(Math.abs(steel.delta_amount) <= 1e-12, "steel package delta zero");
  // package scope keyed by canonical element ids
  const concretePackage = packages.find((p) => p.category === "concrete")!;
  assert.ok(concretePackage.scope_element_ids.includes("el-column-a"));
  assert.ok(concretePackage.scope_graph_node_ids.every((id) => id.startsWith("cg:cad-element:")));

  // --- commercial impact: the aggregate statement ---
  assert.ok(Math.abs(cascade.commercial_impact.total_delta - expectedDeltaTotal) <= 1e-9, "commercial total = package deltas");
  assert.equal(cascade.commercial_impact.affected_package_ids.length, 1);
  assert.equal(cascade.commercial_impact.affected_package_ids[0], concrete.package_id);
  assert.equal(cascade.commercial_impact.currency, "GHS");
  assert.equal(cascade.commercial_impact.affected_category_count, 1);
});

test("first-revision cascade: no previous estimate, additive deltas", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await ok(handler, cmd("document.create", { entityId: "cad007-first" }));
  await ok(handler, cmd("document.applyEdit", {
    edit: { type: "addElement", element: { id: "el-column-a", kind: "geometry", engineId: null, props: { geometry: CORPUS[0]!.descriptor, category: "concrete" } } },
  }));
  const cascade = await ok<ImpactCascade>(handler, q("impact.cascade", { revision_number: 1 }));
  assert.equal(cascade.estimate.previous, null);
  const delta = cascade.quantities.deltas[0]!;
  assert.equal(delta.previous, null, "no previous quantity at revision 1");
  assert.equal(delta.delta, null);
  const rfqEvent = cascade.events[3]! as { payload: { total_delta: number } };
  assert.ok(Math.abs(rfqEvent.payload.total_delta - 0.48 * DEMO_RATES.concrete) <= 1e-9, "first commercial impact = full amount");
});

test("determinism: identical runs are byte-identical; default revision = latest", async () => {
  const a = AppApiHandler.create(CONFIG);
  const b = AppApiHandler.create(CONFIG);
  await buildWorkflow(a);
  await buildWorkflow(b);
  const explicit = await ok<ImpactCascade>(a, q("impact.cascade", { revision_number: 7 }));
  const implicit = await ok<ImpactCascade>(b, q("impact.cascade", {}));
  assert.equal(explicit.events_hash, implicit.events_hash, "same history + engine → identical cascade hash");
  assert.equal(canonicalStringify(explicit), canonicalStringify(implicit), "byte-identical cascades");
  // re-run: stable
  const again = await ok<ImpactCascade>(a, q("impact.cascade", {}));
  assert.equal(again.events_hash, explicit.events_hash);
});

test("persistence: save → open → identical cascade (deterministic replay from persisted history)", async () => {
  const producer = AppApiHandler.create(CONFIG);
  await buildWorkflow(producer);
  const before = await ok<ImpactCascade>(producer, q("impact.cascade", {}));
  const saved = await ok<{ bytes: number[] }>(producer, cmd("document.save", {}));

  const consumerConfig = { ...CONFIG, adapterBundle: createReferenceAdapterBundle() };
  const consumer = AppApiHandler.create(consumerConfig);
  const opened = await ok<unknown>(consumer, cmd("document.open", { source: saved.bytes }));
  assert.ok(opened !== null);
  const after = await ok<ImpactCascade>(consumer, q("impact.cascade", {}));
  assert.equal(after.events_hash, before.events_hash, "cascade hash survives save/open");
  assert.equal(canonicalStringify(after.estimate), canonicalStringify(before.estimate));
});

test("epistemic honesty: non-descriptor elements are skipped as UNKNOWN, never guessed", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await ok(handler, cmd("document.create", { entityId: "cad007-skip" }));
  await ok(handler, cmd("document.applyEdit", {
    edit: { type: "addElement", element: { id: "el-legacy", kind: "geometry", engineId: null, props: { meshToken: "legacy-mesh" } } },
  }));
  await ok(handler, cmd("document.applyEdit", {
    edit: { type: "addElement", element: { id: "el-real", kind: "geometry", engineId: null, props: { geometry: CORPUS[0]!.descriptor, category: "concrete" } } },
  }));
  const cascade = await ok<ImpactCascade>(handler, q("impact.cascade", { revision_number: 2 }));
  assert.equal(cascade.quantities.current.length, 1, "only the measurable element has a quantity");
  assert.equal(cascade.quantities.current[0]!.element_id, "el-real");
  const skipped = cascade.quantities.skipped.find((s) => s.element_id === "el-legacy");
  assert.ok(skipped !== undefined, "legacy element recorded as skipped");
  assert.equal(skipped!.reason, "props-not-descriptor");
  assert.equal(skipped!.uncertainty, "UNKNOWN");
  assert.equal(cascade.estimate.current.items.length, 1, "no cost item for the skipped element");
});

test("adapters without the metadata capability use the labelled analytic fallback; booleans are honest skips", async () => {
  // dummy bundle: no MeshProvider/GeometryMetadataProvider → fallback path
  const handler = AppApiHandler.create({
    adapterBundle: DummyAdapterBundle,
    entityId: "cad007-fallback",
    format: "offisos-dummy",
    formatVersion: "1",
    createdBy: "cad007-test",
  });
  await ok(handler, cmd("document.create", { entityId: "cad007-fallback" }));
  for (const item of CORPUS.filter((x) => x.id === "el-column-a" || x.id === "el-pipe-riser" || x.id === "el-beam-rot")) {
    await ok(handler, cmd("document.applyEdit", {
      edit: { type: "addElement", element: { id: item.id, kind: "geometry", engineId: null, props: { geometry: item.descriptor, category: item.category } } },
    }));
  }
  // a boolean outside the fallback's exact classes
  await ok(handler, cmd("document.applyEdit", {
    edit: {
      type: "addElement",
      element: { id: "el-footing", kind: "geometry", engineId: null, props: { geometry: CORPUS[4]!.descriptor, category: "concrete" } },
    },
  }));
  const cascade = await ok<ImpactCascade>(handler, q("impact.cascade", {}));
  for (const quantity of cascade.quantities.current.filter((x) => x.element_id !== "el-footing")) {
    assert.equal(quantity.method, "analytic-descriptor", "fallback labelled by method");
    assert.equal(quantity.engine?.engineId, "dummy-geometry", "provenance still recorded");
  }
  const column = cascade.quantities.current.find((x) => x.element_id === "el-column-a")!;
  assert.ok(Math.abs(column.value - EXPECTED_VOLUMES["el-column-a"]!) <= 1e-12, "fallback value exact for boxes");
  const pipe = cascade.quantities.current.find((x) => x.element_id === "el-pipe-riser")!;
  assert.ok(Math.abs(pipe.value - EXPECTED_VOLUMES["el-pipe-riser"]!) <= 1e-12, "fallback value exact for cylinders");
  const footing = cascade.quantities.skipped.find((s) => s.element_id === "el-footing");
  assert.ok(footing !== undefined, "boolean outside the fallback classes is an honest skip");
  assert.equal(footing!.reason, "adapter-declined");
  assert.equal(footing!.uncertainty, "UNKNOWN");
});

test("payload validation: revision bounds and empty documents", async () => {
  const empty = AppApiHandler.create(CONFIG);
  const r = await err(empty, q("impact.cascade", {}));
  assert.equal(r.code, "bad_payload");

  const handler = AppApiHandler.create(CONFIG);
  await buildWorkflow(handler);
  const zero = await err(handler, q("impact.cascade", { revision_number: 0 }));
  assert.equal(zero.code, "bad_payload");
  const beyond = await err(handler, q("impact.cascade", { revision_number: 99 }));
  assert.equal(beyond.code, "bad_payload");
  const fractional = await err(handler, q("impact.cascade", { revision_number: 2.5 }));
  assert.equal(fractional.code, "bad_payload");
});
