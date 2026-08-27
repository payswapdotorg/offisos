/**
 * COMPAT-IFC-001 — IDS validation + BCF topic contracts through the proven
 * research toolchain (IfcTester 0.8.5 + bcf-client 0.8.5, worker-bound).
 *
 * IDS: per-entity validation results bound to canonical provenance (the
 * identity pset DomainId), with the controlled-mutation flip (FAILED →
 * PASSED) the research benchmark proved. BCF: topics reference canonical
 * elements by their derived IfcGuids; the container round-trips and the
 * references resolve back to canonical ids — BCF is a transport contract,
 * never the system of record (Issue #47).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppApiHandler } from "../src/app-api/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { ifcSkip } from "./ifc-availability.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const IDS_XML = readFileSync(`${FIXTURES}/ids-fire-rating.xml`, "utf8");

const skipIfc = await ifcSkip();

function handler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
    entityId: "ifc-idsbcf",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "ifc-test",
  });
}

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

const BUILDING = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
];

async function seeded(): Promise<AppApiHandler> {
  const h = handler();
  await cmd(h, "document.create", { entityId: "idsbcf" });
  await cmd(h, "bim.createElements", { entities: BUILDING });
  return h;
}

interface IdsEntity {
  globalId: string;
  canonicalId: string | null;
  ifcClass: string | null;
  name: string | null;
  passed: boolean;
}
interface IdsSpec {
  name: string;
  status: "pass" | "fail";
  entities: IdsEntity[];
}

// --- IDS -------------------------------------------------------------------------

test("ifc.idsValidate discriminates per entity and binds results to canonical provenance", { skip: skipIfc }, async () => {
  const h = await seeded();
  // no wall carries FireRating yet → the required-property spec fails for ALL
  const result = val<{ specs: IdsSpec[]; schema: string }>(await qq(h, "ifc.idsValidate", { ids: IDS_XML }));
  assert.equal(result.schema, "IFC4");
  const spec = result.specs[0]!;
  assert.equal(spec.status, "fail");
  assert.equal(spec.entities.length, 3, "three applicable walls");
  assert.ok(spec.entities.every((e) => e.passed === false), "all fail without the property");
  // canonical provenance binding: every entity resolves to its canonical id
  assert.deepEqual(
    spec.entities.map((e) => e.canonicalId).sort(),
    ["wall-east", "wall-north", "wall-south"],
  );
});

test("ifc.idsValidate tracks the controlled mutation (FAILED → PASSED flip)", { skip: skipIfc }, async () => {
  const h = await seeded();
  // author the FireRating on ONE wall through the low-level custom-prop path
  await cmd(h, "document.applyEdit", { edit: { type: "updateElement", elementId: "wall-south", patch: { FireRating: "REI60" } } });
  const result = val<{ specs: IdsSpec[] }>(await qq(h, "ifc.idsValidate", { ids: IDS_XML }));
  const spec = result.specs[0]!;
  assert.equal(spec.status, "fail", "the spec still fails overall (2 of 3 walls lack the rating)");
  const south = spec.entities.find((e) => e.canonicalId === "wall-south")!;
  assert.equal(south.passed, true, "wall-south now PASSES (REI60 declared)");
  assert.equal(spec.entities.filter((e) => e.passed).length, 1, "exactly one passes — per-entity discrimination");
});

test("ifc.idsValidate fails typed on malformed IDS XML", { skip: skipIfc }, async () => {
  const h = await seeded();
  const r = await qq(h, "ifc.idsValidate", { ids: "not xml at all" });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "ifc_invalid");
});

// --- BCF ---------------------------------------------------------------------------

test("ifc.bcfCreate → ifc.bcfParse round trip resolves references back to canonical ids", { skip: skipIfc }, async () => {
  const h = await seeded();
  const created = val<{ bcf: string; size: number }>(await cmd(h, "ifc.bcfCreate", {
    topics: [{
      title: "Verify wall-north fire rating",
      description: "The north wall must be checked against the IDS specification.",
      author: "architect",
      type: "Issue",
      status: "Open",
      comment: "Checked against IDS: missing rating.",
      commentAuthor: "reviewer",
      elementIds: ["wall-north", "wall-east"],
    }],
  }));
  assert.ok(created.size > 500, "a real .bcf container");

  const parsed = val<{ topics: { title: string; type: string; status: string; comments: { author: string; comment: string; date: string }[]; references: string[]; resolvedCanonicalIds: (string | null)[] }[] }>(
    await qq(h, "ifc.bcfParse", { bcf: created.bcf }),
  );
  const topic = parsed.topics[0]!;
  assert.equal(topic.title, "Verify wall-north fire rating");
  assert.equal(topic.type, "Issue");
  assert.equal(topic.status, "Open");
  assert.equal(topic.comments.length, 1);
  assert.equal(topic.comments[0]!.author, "reviewer");
  assert.equal(topic.comments[0]!.comment, "Checked against IDS: missing rating.");
  assert.equal(topic.references.length, 2, "both IfcGuid references survive");
  // references resolve back to the CANONICAL ids (derived-guid matching)
  assert.deepEqual(
    [...topic.resolvedCanonicalIds].sort(),
    ["wall-east", "wall-north"],
    "BCF references resolve to canonical element provenance",
  );
});

test("ifc.bcfCreate rejects unknown element ids typed", { skip: skipIfc }, async () => {
  const h = await seeded();
  const r = await cmd(h, "ifc.bcfCreate", {
    topics: [{ title: "T", description: "d", elementIds: ["wall-does-not-exist"] }],
  });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "ifc_invalid");
  assert.match((r as { message: string }).message, /does not exist in the document/);
});

test("ifc.bcfParse resolves external guids to null honestly (no guessing)", { skip: skipIfc }, async () => {
  const h = await seeded();
  // a topic referencing an element NOT in the document resolves to null —
  // BCF references never fabricate canonical identity
  const created = val<{ bcf: string }>(await cmd(h, "ifc.bcfCreate", {
    topics: [{ title: "External ref", description: "d", elementIds: ["wall-south"] }],
  }));
  const h2 = handler(); // a DIFFERENT document without the wall
  await cmd(h2, "document.create", { entityId: "other" });
  const parsed = val<{ topics: { resolvedCanonicalIds: (string | null)[] }[] }>(await qq(h2, "ifc.bcfParse", { bcf: created.bcf }));
  assert.deepEqual(parsed.topics[0]!.resolvedCanonicalIds, [null], "unresolvable reference → explicit null");
});
