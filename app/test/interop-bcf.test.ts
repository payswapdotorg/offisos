/**
 * CAD-PARITY-014 (Issue #107) — BCF viewpoints + source lineage (D3): the
 * camera exchange, the container byte-determinism and the classification.
 *
 * bcfCreate topics may carry a camera viewpoint (position/direction/up,
 * perspective OR orthogonal with viewToWorldScale) and a sourceRevision
 * lineage (the caller-chosen canonical model state reference — the BCF 3.0
 * topic document reference). bcfParse returns the camera (r9-rounded wire
 * values), the selection refs (resolving back to canonical ids) and the
 * lineage. The classifyBcfTopic field classification (interop/bcf.ts) rides
 * the report vocabulary: camera fields tolerance (the declared 1e-6 bound),
 * the orthogonal flag + scale exact, lineage exact-or-unsupported, snapshots
 * UNSUPPORTED by construction (the typed decline). The container is
 * BYTE-DETERMINISTIC (the worker's fixed-date sorted-entry zip rebuild).
 * The legacy no-viewpoint payload still round-trips (backward compatible).
 *
 * Runs on the REAL bcf-client toolchain (ifcSkip-gated).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import { classifyBcfTopic, BCF_CAMERA_TOLERANCE } from "../src/interop/index.js";
import { ifcGuidFor } from "../src/ifc/index.js";
import type { IfcBcfParsedTopic, IfcBcfTopicRequest } from "../src/contracts/ifc.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { ifcSkip } from "./ifc-availability.js";

const skipIfc = await ifcSkip();

function handler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
    entityId: "interop-bcf",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "bcf-test",
  });
}

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  const e = r as unknown as { code: string; message: string };
  return { code: e.code, message: e.message };
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
];

async function seeded(): Promise<AppApiHandler> {
  const h = handler();
  await cmd(h, "document.create", { entityId: "bcf-building" });
  await cmd(h, "bim.createElements", { entities: BUILDING });
  return h;
}

interface ParsedTopic extends IfcBcfParsedTopic {
  readonly resolvedCanonicalIds: readonly (string | null)[];
}

const CAMERA = {
  cameraViewPoint: [12.5, -3.25, 7.125] as const,
  cameraDirection: [0.1, -0.9, -0.2] as const,
  cameraUpVector: [0, 1, 0] as const,
};

const SOURCE_REVISION = "ifc:933fcbd8f6b88b7996b8874641c1a62e4c45396506414a587726f30ef84bd677";

// --- the viewpoint + lineage round trip -------------------------------------------

test("ifc.bcfCreate with a camera viewpoint + sourceRevision round-trips through bcfParse", { skip: skipIfc }, async () => {
  const h = await seeded();
  const created = val<{ bcf: string; size: number; referencedCanonicalIds: number }>(await cmd(h, "ifc.bcfCreate", {
    topics: [{
      title: "Check the south wall",
      description: "The camera viewpoint pins the exact review position.",
      author: "architect",
      type: "Issue",
      status: "Open",
      comment: "Viewpoint attached.",
      commentAuthor: "reviewer",
      elementIds: ["wall-south", "wall-east"],
      viewpoint: {
        cameraViewPoint: [...CAMERA.cameraViewPoint],
        cameraDirection: [...CAMERA.cameraDirection],
        cameraUpVector: [...CAMERA.cameraUpVector],
      },
      sourceRevision: SOURCE_REVISION,
    }],
  }));
  assert.ok(created.size > 500, "a real .bcf container");
  assert.equal(created.referencedCanonicalIds, 2);

  const parsed = val<{ topics: ParsedTopic[] }>(await qq(h, "ifc.bcfParse", { bcf: created.bcf }));
  const topic = parsed.topics[0]!;
  assert.equal(topic.title, "Check the south wall");
  // The camera round-trips (the worker's r9 wire rounding — exact for these
  // authored values).
  const vp = topic.viewpoint!;
  assert.deepEqual([...vp.cameraViewPoint], [...CAMERA.cameraViewPoint]);
  assert.deepEqual([...vp.cameraDirection], [...CAMERA.cameraDirection]);
  assert.deepEqual([...vp.cameraUpVector], [...CAMERA.cameraUpVector]);
  assert.equal(vp.orthogonal, false, "a perspective camera");
  assert.equal(vp.viewToWorldScale, null);
  // The lineage: the source revision rides as the topic document reference
  // and parses back EXACTLY.
  assert.equal(topic.sourceRevision, SOURCE_REVISION);
  // The selection refs resolve back to the CANONICAL ids.
  assert.equal(topic.references.length, 2);
  assert.deepEqual([...topic.resolvedCanonicalIds].sort(), ["wall-east", "wall-south"]);

  // The field classification (interop/bcf.ts — the report vocabulary).
  const request: IfcBcfTopicRequest = {
    title: "Check the south wall",
    description: "The camera viewpoint pins the exact review position.",
    author: "architect",
    type: "Issue",
    status: "Open",
    references: ["wall-south", "wall-east"].map((id) => ifcGuidFor(id)),
    comment: "Viewpoint attached.",
    commentAuthor: "reviewer",
    viewpoint: {
      cameraViewPoint: CAMERA.cameraViewPoint,
      cameraDirection: CAMERA.cameraDirection,
      cameraUpVector: CAMERA.cameraUpVector,
    },
    sourceRevision: SOURCE_REVISION,
  };
  const fields = classifyBcfTopic(request, topic);
  const byField = new Map(fields.map((f) => [f.field, f.classification] as const));
  assert.equal(byField.get("title"), "exact");
  assert.equal(byField.get("references"), "exact");
  assert.equal(byField.get("cameraViewPoint"), "tolerance", "camera fields classify within the declared 1e-6 bound");
  assert.equal(byField.get("cameraDirection"), "tolerance");
  assert.equal(byField.get("cameraUpVector"), "tolerance");
  assert.equal(byField.get("orthogonal"), "exact");
  assert.equal(byField.get("sourceRevision"), "exact", "the lineage classifies exact when carried");
  assert.equal(byField.get("snapshot"), "unsupported", "snapshot bitmaps are the typed decline (never written)");
});

test("the orthogonal camera with viewToWorldScale round-trips + classifies", { skip: skipIfc }, async () => {
  const h = await seeded();
  const created = val<{ bcf: string }>(await cmd(h, "ifc.bcfCreate", {
    topics: [{
      title: "Orthogonal review",
      description: "d",
      elementIds: ["wall-south"],
      viewpoint: {
        cameraViewPoint: [0, 0, 50],
        cameraDirection: [0, 0, -1],
        cameraUpVector: [0, 1, 0],
        orthogonal: true,
        viewToWorldScale: 42.5,
      },
    }],
  }));
  const parsed = val<{ topics: ParsedTopic[] }>(await qq(h, "ifc.bcfParse", { bcf: created.bcf }));
  const vp = parsed.topics[0]!.viewpoint!;
  assert.equal(vp.orthogonal, true, "the orthogonal distinction survives");
  assert.equal(vp.viewToWorldScale, 42.5);

  const request: IfcBcfTopicRequest = {
    title: "Orthogonal review",
    description: "d",
    author: "architect",
    type: "Issue",
    status: "Open",
    comment: null,
    commentAuthor: null,
    references: [ifcGuidFor("wall-south")],
    viewpoint: { cameraViewPoint: [0, 0, 50], cameraDirection: [0, 0, -1], cameraUpVector: [0, 1, 0], orthogonal: true, viewToWorldScale: 42.5 },
  };
  const fields = classifyBcfTopic(request, parsed.topics[0]!);
  const byField = new Map(fields.map((f) => [f.field, f.classification] as const));
  assert.equal(byField.get("orthogonal"), "exact");
  assert.equal(byField.get("viewToWorldScale"), "exact");
  assert.equal(byField.get("sourceRevision"), "unsupported", "no lineage declared → the typed unsupported row (never guessed)");
});

// --- the container determinism -----------------------------------------------------

test("the BCF container is byte-deterministic: two builds → the identical sha256", { skip: skipIfc }, async () => {
  const h = await seeded();
  const payload = {
    topics: [{
      title: "Determinism probe",
      description: "d",
      elementIds: ["wall-south", "wall-east"],
      comment: "c",
      commentAuthor: "reviewer",
      viewpoint: {
        cameraViewPoint: [...CAMERA.cameraViewPoint],
        cameraDirection: [...CAMERA.cameraDirection],
        cameraUpVector: [...CAMERA.cameraUpVector],
      },
      sourceRevision: SOURCE_REVISION,
    }],
  };
  const a = val<{ bcf: string }>(await cmd(h, "ifc.bcfCreate", payload));
  const b = val<{ bcf: string }>(await cmd(h, "ifc.bcfCreate", payload));
  assert.equal(a.bcf, b.bcf, "two builds → byte-identical containers");
  const sha = createHash("sha256").update(Buffer.from(a.bcf, "base64")).digest("hex");
  assert.match(sha, /^[0-9a-f]{64}$/);
  // The parse result is deterministic too (the ordering + r9 discipline).
  const p1 = val<{ topics: ParsedTopic[] }>(await qq(h, "ifc.bcfParse", { bcf: a.bcf }));
  const p2 = val<{ topics: ParsedTopic[] }>(await qq(h, "ifc.bcfParse", { bcf: b.bcf }));
  assert.deepEqual(p1.topics, p2.topics);
});

// --- the legacy payload (backward compatibility) ------------------------------------

test("the legacy no-viewpoint payload still round-trips (the default camera + no lineage)", { skip: skipIfc }, async () => {
  const h = await seeded();
  // The PRE-P014 topic shape: no viewpoint, no sourceRevision.
  const created = val<{ bcf: string }>(await cmd(h, "ifc.bcfCreate", {
    topics: [{
      title: "Legacy topic",
      description: "d",
      author: "architect",
      type: "Issue",
      status: "Open",
      comment: "legacy comment",
      commentAuthor: "reviewer",
      elementIds: ["wall-south"],
    }],
  }));
  const parsed = val<{ topics: ParsedTopic[] }>(await qq(h, "ifc.bcfParse", { bcf: created.bcf }));
  const topic = parsed.topics[0]!;
  assert.equal(topic.title, "Legacy topic");
  assert.equal(topic.comments.length, 1);
  assert.equal(topic.comments[0]!.comment, "legacy comment");
  assert.deepEqual([...topic.resolvedCanonicalIds], ["wall-south"]);
  // The legacy payload carries no authored camera — the parsed topic returns
  // the container's deterministic default origin-target viewpoint; the
  // lineage is null (never guessed).
  assert.ok(topic.viewpoint !== null, "the default viewpoint is present");
  assert.equal(topic.viewpoint!.orthogonal, false);
  assert.equal(topic.sourceRevision, null);

  // The classification of a legacy request: no authored viewpoint → the
  // default-camera artifact is classified (tolerance + the note), no lineage
  // → the typed unsupported row.
  const request: IfcBcfTopicRequest = {
    title: "Legacy topic",
    description: "d",
    author: "architect",
    type: "Issue",
    status: "Open",
    references: [ifcGuidFor("wall-south")],
    comment: "legacy comment",
    commentAuthor: "reviewer",
  };
  const fields = classifyBcfTopic(request, topic);
  const byField = new Map(fields.map((f) => [f.field, f.classification] as const));
  assert.equal(byField.get("viewpoint"), "tolerance");
  assert.equal(byField.get("sourceRevision"), "unsupported");
  assert.equal(byField.get("references"), "exact");
  assert.ok(BCF_CAMERA_TOLERANCE === 1e-6, "the declared tolerance");
});

// --- the typed validation failures --------------------------------------------------

test("viewpoint validation fails typed (orthogonal without scale; non-positive scale; malformed vectors)", { skip: skipIfc }, async () => {
  const h = await seeded();
  const base = (viewpoint: unknown): unknown => ({
    topics: [{ title: "T", description: "d", elementIds: ["wall-south"], viewpoint }],
  });
  // Orthogonal REQUIRES viewToWorldScale.
  const noScale = errVal(await cmd(h, "ifc.bcfCreate", base({
    cameraViewPoint: [0, 0, 1], cameraDirection: [0, 0, -1], cameraUpVector: [0, 1, 0], orthogonal: true,
  })));
  assert.equal(noScale.code, "ifc_invalid");
  assert.match(noScale.message, /viewToWorldScale is required for orthogonal cameras/);
  // The scale must be positive.
  const badScale = errVal(await cmd(h, "ifc.bcfCreate", base({
    cameraViewPoint: [0, 0, 1], cameraDirection: [0, 0, -1], cameraUpVector: [0, 1, 0], orthogonal: true, viewToWorldScale: 0,
  })));
  assert.equal(badScale.code, "ifc_invalid");
  assert.match(badScale.message, /must be positive/);
  // The vectors must be 3 finite numbers.
  const badVector = errVal(await cmd(h, "ifc.bcfCreate", base({
    cameraViewPoint: [0, 0], cameraDirection: [0, 0, -1], cameraUpVector: [0, 1, 0],
  })));
  assert.equal(badVector.code, "ifc_invalid");
  assert.match(badVector.message, /must be an array of 3 finite numbers/);
});
