/**
 * Construction Graph bridge (CAD-IMPLEMENT-003, LOCK-019, event-model.md
 * §1/§2/§4, ADR-003/ADR-007, §2.7 uncertainty).
 *
 * The bridge consumes ONLY the explicit domain contracts (contracts/model.ts)
 * and produces the deterministic graph-facing event stream: one model.created
 * for the base + one model.version.created per revision, each carrying the
 * revision reference, affected elements, provenance and an explicit
 * uncertainty state. Engine ids are provenance only — canonical graph node
 * identity derives from the stable document element id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CADDocument, canonicalStringify } from "../src/caddocument/index.js";
import { bridgeModelHistory, graphNodeId } from "../src/graph/index.js";
import type { GraphModelEvent, ModelHistory } from "../src/contracts/model.js";
import type { Element } from "../src/contracts/caddocument.js";

const OWNER = "bridge-test";

function el(id: string, meshToken: string, engineId: string | null = null): Element {
  return { id, kind: "geometry", engineId, props: { meshToken } };
}

function buildHistory(): ModelHistory {
  const doc = CADDocument.empty("bridge-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1", "occt") });
  doc.execute({ type: "addElement", element: el("e2", "m2") });
  doc.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m1b" } });
  doc.undo();
  doc.redo();
  doc.execute({ type: "removeElement", elementId: "e2" });
  return doc.history;
}

test("emits one model.created for the base and one model.version.created per revision", () => {
  const history = buildHistory();
  const result = bridgeModelHistory(history);
  assert.equal(result.events.length, history.revisions.length + 1);
  assert.equal(result.events[0]?.event_type, "model.created");
  for (let i = 1; i < result.events.length; i++) {
    assert.equal(result.events[i]?.event_type, "model.version.created");
  }
  assert.match(result.events_hash, /^[0-9a-f]{64}$/);
});

test("every event carries the full event-model.md §4 envelope fields", () => {
  const result = bridgeModelHistory(buildHistory());
  for (const event of result.events) {
    assert.equal(typeof event.event_id, "string");
    assert.ok(event.event_id.length > 0);
    assert.ok(event.event_type === "model.created" || event.event_type === "model.version.created");
    assert.equal(event.event_version, "1");
    assert.equal(event.occurred_at, "2026-01-01T00:00:00.000Z", "fixed deterministic timestamp");
    assert.equal(event.actor_type, "application");
    assert.equal(event.actor_id, OWNER);
    assert.equal(event.source_entity_id, "bridge-doc");
    assert.ok(event.source_version_id.length > 0);
    assert.ok(event.source_revision_id.length > 0);
    assert.equal(event.correlation_id, "bridge-doc");
    // payload completeness: revision + affected + elements + provenance + uncertainty
    assert.ok(event.payload.revision.revision_id.length > 0);
    assert.ok(Array.isArray(event.payload.affected.added));
    assert.ok(Array.isArray(event.payload.affected.removed));
    assert.ok(Array.isArray(event.payload.affected.updated));
    assert.ok(Array.isArray(event.payload.elements));
    assert.equal(event.payload.provenance.document_entity_id, "bridge-doc");
    assert.ok(event.payload.uncertainty.geometry_provenance !== undefined);
    assert.ok(event.payload.uncertainty.semantics === "UNKNOWN");
  }
});

test("causation chain links every event to its predecessor; model.created is the root", () => {
  const result = bridgeModelHistory(buildHistory());
  const [first, ...rest] = result.events;
  assert.ok(first);
  assert.equal(first.causation_id, null);
  let previous: GraphModelEvent | undefined = first;
  for (const event of rest) {
    assert.ok(previous);
    assert.equal(event.causation_id, previous.event_id, "event causation must chain");
    previous = event;
  }
  // event ids are unique.
  const ids = new Set(result.events.map((e) => e.event_id));
  assert.equal(ids.size, result.events.length);
});

test("revision events carry the recorded revision reference and delta", () => {
  const history = buildHistory();
  const result = bridgeModelHistory(history);
  for (let k = 1; k <= history.revisions.length; k++) {
    const event = result.events[k];
    const revision = history.revisions[k - 1];
    assert.ok(event && revision);
    assert.equal(event.source_revision_id, revision.revision_id);
    assert.equal(event.source_version_id, revision.version.version_id);
    assert.equal(event.payload.revision.revision_number, k);
    assert.equal(event.payload.revision.version_number, revision.version.version_number);
    assert.equal(event.payload.revision.parent_version_id, revision.version.parent_version_id);
    assert.equal(event.payload.revision.content_hash, revision.content_hash);
    assert.deepEqual(event.payload.affected, revision.delta);
    assert.equal(event.payload.provenance.origin, revision.note);
  }
});

test("engine ids are provenance only — graph node identity derives from the element id", () => {
  const history = buildHistory();
  const result = bridgeModelHistory(history);

  // e1 is added WITH engine provenance in revision 1.
  const e1Event = result.events.find(
    (e) => e.payload.elements.some((p) => p.element_id === "e1" && p.change === "added"),
  );
  assert.ok(e1Event);
  const e1Projection = e1Event.payload.elements.find((p) => p.element_id === "e1");
  assert.ok(e1Projection);
  assert.equal(e1Projection.engineId, "occt", "engine id recorded as provenance");
  assert.equal(e1Projection.document_entity_id, "bridge-doc");
  assert.equal(e1Projection.uncertainty.geometry_provenance, "OBSERVED");

  // The SAME element id with a DIFFERENT (or absent) engine id maps to the
  // SAME graph node id — engine ids never participate in canonical identity.
  const withEngine = graphNodeId("bridge-doc", "e1");
  assert.equal(e1Projection.graph_node_id, withEngine);
  assert.ok(!withEngine.includes("occt"), "graph node id must not embed the engine id");

  // e2 (engineId null) → UNKNOWN geometry provenance, still a stable node id.
  const e2Event = result.events.find(
    (e) => e.payload.elements.some((p) => p.element_id === "e2" && p.change === "added"),
  );
  assert.ok(e2Event);
  const e2Projection = e2Event.payload.elements.find((p) => p.element_id === "e2");
  assert.ok(e2Projection);
  assert.equal(e2Projection.engineId, null);
  assert.equal(e2Projection.uncertainty.geometry_provenance, "UNKNOWN");
  assert.equal(e2Projection.uncertainty.identity, "OBSERVED");
  assert.equal(e2Projection.uncertainty.semantics, "UNKNOWN");
  assert.equal(e2Projection.graph_node_id, graphNodeId("bridge-doc", "e2"));
  assert.notEqual(e2Projection.graph_node_id, withEngine);
});

test("graph node ids are stable across revisions and scoped to the document entity", () => {
  const doc = CADDocument.empty("bridge-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  doc.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m2" } });
  doc.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m3" } });
  const result = bridgeModelHistory(doc.history);
  const projections = result.events
    .slice(1)
    .flatMap((e) => e.payload.elements)
    .filter((p) => p.element_id === "e1");
  assert.equal(projections.length, 3);
  for (const p of projections) {
    assert.equal(p.graph_node_id, projections[0]?.graph_node_id, "same element id → same graph node across revisions");
  }
  // Different document entity → different node id (identity is document-scoped).
  assert.notEqual(graphNodeId("bridge-doc", "e1"), graphNodeId("other-doc", "e1"));
});

test("revision-level uncertainty: OBSERVED / UNKNOWN / MIXED", () => {
  const doc = CADDocument.empty("unc-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("a", "m1", "occt") }); // OBSERVED
  doc.execute({ type: "addElement", element: el("b", "m2") }); // UNKNOWN
  doc.execute({ type: "addElement", element: el("c", "m3", "occt") }); // OBSERVED
  doc.execute({ type: "updateElement", elementId: "a", patch: { note: 1 } }); // affects a (occt) → OBSERVED
  doc.execute({ type: "updateElement", elementId: "b", patch: { note: 2 } }); // affects b (null) → UNKNOWN
  doc.execute({ type: "setProps", elementId: "a", patch: { note: 3, extra: true } });
  // A genuine no-op update: patching the CURRENT values changes no content.
  doc.execute({ type: "updateElement", elementId: "a", patch: { note: 3, extra: true } });
  const result = bridgeModelHistory(doc.history);
  const revisionEvents = result.events.filter((e) => e.event_type === "model.version.created");
  assert.equal(revisionEvents[0]?.payload.uncertainty.geometry_provenance, "OBSERVED");
  assert.equal(revisionEvents[1]?.payload.uncertainty.geometry_provenance, "UNKNOWN");
  assert.equal(revisionEvents[2]?.payload.uncertainty.geometry_provenance, "OBSERVED");
  assert.equal(revisionEvents[3]?.payload.uncertainty.geometry_provenance, "OBSERVED");
  assert.equal(revisionEvents[4]?.payload.uncertainty.geometry_provenance, "UNKNOWN");
  // No-op revision: no affected elements → no provenance asserted (OBSERVED).
  const last = revisionEvents[revisionEvents.length - 1];
  assert.ok(last);
  assert.deepEqual(last.payload.affected.updated, [], "no-op update produces an empty delta");
  assert.equal(last.payload.uncertainty.geometry_provenance, "OBSERVED");
});

test("MIXED uncertainty when one revision affects elements with and without engine provenance", () => {
  // The MIXED case arises naturally at the model.created base of a legacy
  // artifact opened with mixed engine provenance.
  const opened = CADDocument.empty("mix3-doc", "offisos-dummy", "1", OWNER);
  const snapshot = {
    version: opened.snapshot().version,
    format: "offisos-dummy",
    formatVersion: "1",
    sourceArtifactLineage: [],
    editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
    elements: [el("x", "m1", "occt"), el("y", "m2", null)],
  };
  const reopened = CADDocument.open(snapshot as never, OWNER);
  const result = bridgeModelHistory(reopened.history);
  const created = result.events[0];
  assert.ok(created);
  assert.equal(created.event_type, "model.created");
  assert.equal(created.payload.uncertainty.geometry_provenance, "MIXED");
  assert.deepEqual(created.payload.affected.added, ["x", "y"]);
});

test("the bridge is deterministic: same history → byte-identical events", () => {
  const history = buildHistory();
  const a = bridgeModelHistory(history);
  const b = bridgeModelHistory(history);
  assert.equal(canonicalStringify(a.events), canonicalStringify(b.events));
  assert.equal(a.events_hash, b.events_hash);
  // Events are frozen (immutable).
  for (const event of a.events as GraphModelEvent[]) {
    assert.ok(Object.isFrozen(event), "events must be frozen");
  }
  assert.throws(
    () => {
      (a.events as GraphModelEvent[]).push(a.events[0] as GraphModelEvent);
    },
    /not extensible|frozen/,
  );
});

test("the bridge consumes domain contracts only — no engine or host internals", () => {
  const bridgeSource = readFileSync(
    fileURLToPath(new URL("../src/graph/bridge.ts", import.meta.url)),
    "utf8",
  );
  const indexSource = readFileSync(
    fileURLToPath(new URL("../src/graph/index.ts", import.meta.url)),
    "utf8",
  );
  for (const source of [bridgeSource, indexSource]) {
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.ok(specifiers.length > 0, "the bridge must import its contracts");
    for (const specifier of specifiers) {
      assert.match(
        specifier,
        /^(\.\.\/)?(contracts\/[a-z-]+|caddocument\/[a-z-]+|node:crypto)(\.js)?$|^\.\/[a-z-]+\.js$/,
        `unexpected bridge import: ${specifier}`,
      );
      assert.doesNotMatch(specifier, /adapters|host-web|host-electron|electron|freecad|opencascade|occt|ifcopenshell/i, `forbidden bridge import: ${specifier}`);
    }
  }
});
