/**
 * Construction Graph + downstream identity stability under engine GlobalId
 * change (RESEARCH-CAD-007 / Issue #32, LOCK-019).
 *
 * The critical CAD-007 proposition: replacing the engine does not change
 * canonical ConstructionOS semantics. Engine GlobalIds (the source engine's
 * ids) are PROVENANCE ONLY; canonical graph identity derives from
 * (document entity id, element id).
 *
 * Scope note (honest): the CADDocument content hash legitimately includes
 * the element's recorded `engineId` provenance field, so a document whose
 * elements carry DIFFERENT engine provenance is different CONTENT — its
 * version/revision ids and version-scoped quantity ids legitimately differ.
 * What must NOT differ — and what this test proves — is:
 *
 *   1. the graph identity MAPPING: element ↔ graph_node_id is identical
 *      across engine GlobalId variants (the Issue #32 acceptance criterion);
 *   2. the event TYPE sequence and the per-event element projections
 *      (minus provenance fields) are identical;
 *   3. downstream VERSION-FREE identities (cost item ids, RFQ package ids)
 *      and downstream structure (affected flags, categories, deltas) are
 *      identical;
 *   4. when the document bytes are engine-free (engineId null — the engine
 *      swap scenario), swapping the ENGINE BEHIND THE BOUNDARY changes
 *      nothing canonical at all: identical content hash, identical graph
 *      events, identical downstream identity skeleton, values agreeing
 *      within the declared tolerances.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { canonicalStringify } from "../src/caddocument/index.js";
import type { Command, Query } from "../src/contracts/app-api.js";
import type { ImpactCascade } from "../src/contracts/impact.js";
import type { GraphBridgeResult } from "../src/contracts/model.js";
import { CORPUS, resizedColumnDescriptor } from "./cad007-corpus.js";

const PROVENANCE_VARIANTS = ["occt:2Xyg$randomGlobalId001", "reference:completely-different-id-9f8e7d", null] as const;

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

/** Build the corpus workflow with a GIVEN engine provenance value on every
 *  element — simulating the same model produced/imported by different
 *  engines. */
async function buildWithProvenance(handler: AppApiHandler, entityId: string, engineId: string | null): Promise<void> {
  await okValue(handler, cmd("document.create", { entityId }));
  for (const item of CORPUS) {
    await okValue(handler, cmd("document.applyEdit", {
      edit: {
        type: "addElement",
        element: { id: item.id, kind: "geometry", engineId, props: { geometry: item.descriptor, category: item.category } },
      },
    }));
  }
  await okValue(handler, cmd("document.applyEdit", {
    edit: { type: "updateElement", elementId: "el-column-a", patch: { geometry: resizedColumnDescriptor() } },
  }));
}

/** The canonical identity mapping of a graph event stream: per revision,
 *  the sorted (element_id → graph_node_id) projections. Provenance-free. */
function identityMapping(events: GraphBridgeResult): unknown {
  return events.events.map((e) => ({
    event_type: e.event_type,
    revision_number: e.payload.revision.revision_number,
    elements: e.payload.elements.map((p) => ({
      element_id: p.element_id,
      graph_node_id: p.graph_node_id,
      change: p.change,
      kind: p.kind,
    })).sort((a, b) => (a.element_id < b.element_id ? -1 : 1)),
    affected: e.payload.affected,
  }));
}

test("graph identity mappings are stable when engine GlobalIds change", async () => {
  const streams: GraphBridgeResult[] = [];
  const cascades: ImpactCascade[] = [];
  for (const engineId of PROVENANCE_VARIANTS) {
    const handler = AppApiHandler.create({
      adapterBundle: createReferenceAdapterBundle(),
      entityId: "cad007-identity-doc",
      format: "offisos-reference",
      formatVersion: "1",
      createdBy: "cad007-test",
    });
    await buildWithProvenance(handler, "cad007-identity-doc", engineId);
    streams.push(await okValue<GraphBridgeResult>(handler, q("model.getGraphEvents")));
    cascades.push(await okValue<ImpactCascade>(handler, q("impact.cascade", { revision_number: 7 })));
  }

  const [a, b, c] = streams;

  // 1+2: identical identity mapping + event-type sequence + per-revision
  // element projections across ALL provenance variants.
  assert.equal(
    canonicalStringify(identityMapping(a!)),
    canonicalStringify(identityMapping(b!)),
    "occt-GlobalId vs reference-GlobalId: identical graph identity mapping",
  );
  assert.equal(
    canonicalStringify(identityMapping(a!)),
    canonicalStringify(identityMapping(c!)),
    "occt-GlobalId vs no-GlobalId: identical graph identity mapping",
  );
  // the streams themselves differ (content hash includes the provenance
  // field) — the divergence is legitimate DOCUMENT content, not graph
  // identity; every node id in the mapping is identical.
  const nodesOf = (s: GraphBridgeResult) =>
    s.events.flatMap((e) => e.payload.elements.map((p) => `${p.element_id}:${p.graph_node_id}`)).sort();
  assert.deepEqual(nodesOf(a!), nodesOf(b!));
  assert.deepEqual(nodesOf(a!), nodesOf(c!));
  assert.ok(nodesOf(a!).every((entry) => entry.includes("cg:cad-element:")));

  // 3: downstream version-FREE identities + structure identical
  const [ca, cb, cc] = cascades;
  const skeleton = (cascade: ImpactCascade) => ({
    item_ids: cascade.estimate.current.items.map((i) => i.item_id).sort(),
    package_ids: cascade.rfq.packages.map((p) => p.package_id).sort(),
    impact_structure: cascade.rfq.impacts.map((i) => [i.package_id, i.category, i.affected]).sort(),
    measured_elements: cascade.quantities.current.map((x) => x.element_id).sort(),
    graph_node_ids: cascade.quantities.current.map((x) => x.graph_node_id).sort(),
    affected_packages: [...cascade.commercial_impact.affected_package_ids].sort(),
    event_types: cascade.events.map((e) => e.event_type),
  });
  assert.equal(canonicalStringify(skeleton(ca!)), canonicalStringify(skeleton(cb!)), "downstream structure identical across GlobalIds");
  assert.equal(canonicalStringify(skeleton(ca!)), canonicalStringify(skeleton(cc!)));
  // values measured by the same engine agree bit-for-bit across variants
  assert.equal(canonicalStringify(ca!.quantities.current.map((x) => x.value)), canonicalStringify(cb!.quantities.current.map((x) => x.value)));
  assert.equal(canonicalStringify(ca!.estimate.current.total), canonicalStringify(cc!.estimate.current.total));
  // quantity ids are VERSION-SCOPED and the version ids differ (provenance
  // is document content) — documented, honest, not an identity leak
  assert.notDeepEqual(
    ca!.quantities.current.map((x) => x.quantity_id),
    cb!.quantities.current.map((x) => x.quantity_id),
    "version-scoped ids track the (different) document versions",
  );
});

test("engine swap behind the boundary: engine-free document bytes → NOTHING canonical changes (ungated rung)", async () => {
  // The same engine-free workflow (engineId null, descriptors in props)
  // through TWO different bundles: the reference engine (metadata path) and
  // the dummy bundle (labelled analytic fallback path). For the non-boolean
  // corpus both compute the exact same analytic values.
  const nonBooleanCorpus = CORPUS.filter((x) => x.id !== "el-footing" && x.id !== "el-slab-opening");

  const build = async (bundle: typeof DummyAdapterBundle | ReturnType<typeof createReferenceAdapterBundle>) => {
    const handler = AppApiHandler.create({
      adapterBundle: bundle,
      entityId: "cad007-swap-ungated",
      format: "offisos-reference",
      formatVersion: "1",
      createdBy: "cad007-test",
    });
    await okValue(handler, cmd("document.create", { entityId: "cad007-swap-ungated" }));
    for (const item of nonBooleanCorpus) {
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
    return handler;
  };

  const referenceHandler = await build(createReferenceAdapterBundle());
  const dummyHandler = await build(DummyAdapterBundle);

  // identical document content (engine never enters the document)
  assert.equal(
    referenceHandler.currentContentHash(),
    dummyHandler.currentContentHash(),
    "content hash is engine-free",
  );

  // identical graph events (byte-identical stream + hash)
  const eventsA = await okValue<GraphBridgeResult>(referenceHandler, q("model.getGraphEvents"));
  const eventsB = await okValue<GraphBridgeResult>(dummyHandler, q("model.getGraphEvents"));
  assert.equal(eventsA.events_hash, eventsB.events_hash, "graph events identical across engines");
  assert.equal(canonicalStringify(eventsA.events), canonicalStringify(eventsB.events));

  // identical downstream identities + values within declared tolerance
  const cascadeA = await okValue<ImpactCascade>(referenceHandler, q("impact.cascade", {}));
  const cascadeB = await okValue<ImpactCascade>(dummyHandler, q("impact.cascade", {}));
  assert.deepEqual(
    cascadeA.estimate.current.items.map((i) => i.item_id).sort(),
    cascadeB.estimate.current.items.map((i) => i.item_id).sort(),
    "cost item identities identical",
  );
  assert.deepEqual(
    cascadeA.rfq.packages.map((p) => p.package_id).sort(),
    cascadeB.rfq.packages.map((p) => p.package_id).sort(),
    "RFQ package identities identical",
  );
  assert.equal(cascadeA.estimate.current.estimate_id, cascadeB.estimate.current.estimate_id, "estimate identity identical (version-scoped, engine-free versions)");
  for (const qa of cascadeA.quantities.current) {
    const qb = cascadeB.quantities.current.find((x) => x.element_id === qa.element_id)!;
    const tol = Math.max(qa.declared_tolerance.absolute, qa.declared_tolerance.relative * Math.max(Math.abs(qa.value), Math.abs(qb.value)));
    assert.ok(
      Math.abs(qa.value - qb.value) <= Math.max(tol, 1e-12),
      `${qa.element_id}: values agree within declared tolerance (${qa.value} vs ${qb.value})`,
    );
  }
  // provenance is the ONLY engine-visible difference
  assert.equal(cascadeA.engine.engineId, "reference");
  assert.equal(cascadeB.engine.engineId, "dummy-geometry");
});

test("graphNodeId is a pure function of (entity, element) — engine ids never participate", async () => {
  const { graphNodeId } = await import("../src/graph/index.js");
  assert.equal(graphNodeId("e1", "el-1"), graphNodeId("e1", "el-1"));
  assert.notEqual(graphNodeId("e1", "el-1"), graphNodeId("e2", "el-1"));
  assert.notEqual(graphNodeId("e1", "el-1"), graphNodeId("e1", "el-2"));
  assert.equal(graphNodeId.length, 2, "graphNodeId takes exactly (entityId, elementId)");
});
