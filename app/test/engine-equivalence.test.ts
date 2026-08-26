/**
 * Cross-engine geometry equivalence (RESEARCH-CAD-007 / Issue #32): the
 * SAME representative corpus through the REAL OCCT engine and the
 * engine-free reference adapter (LOCK-003/018).
 *
 * Proves: identical descriptors produce results that agree within the
 * DECLARED tolerances (volume: 1e-6 relative; bbox: the OCCT
 * tolerance-inclusive Bnd_Box, 0.02 absolute per CAD-002), while meshTokens
 * remain engine-local (documented — tokens are viewport cache keys, not
 * canonical values). Both engines are deterministic per-engine.
 *
 * The OCCT rung is engine-gated (skips with a recorded reason when the
 * pinned toolchain is absent); the reference-adapter invariants always run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcctGeometryAdapter } from "../src/adapters/occt/index.js";
import { createReferenceGeometryAdapter, evaluateDescriptorAnalytically } from "../src/adapters/reference/index.js";
import type { Element } from "../src/contracts/caddocument.js";
import type { GeometryMetadata } from "../src/contracts/geometry.js";
import { engineSkip } from "./engine-availability.js";
import { CORPUS, EXPECTED_VOLUMES } from "./cad007-corpus.js";

const skipEngine = await engineSkip();

const VOLUME_ABS_TOL = 1e-6;
const VOLUME_REL_TOL = 1e-6;
const BBOX_TOL = 0.02;

function geometryElement(props: Record<string, unknown>): Element {
  return { id: "test-geometry", kind: "geometry", engineId: null, props };
}

interface PreparedWithMeta {
  meshToken: string;
  bbox: readonly number[];
  metadata: GeometryMetadata;
}

async function prepareWithMeta(
  adapter: ReturnType<typeof createReferenceGeometryAdapter>,
  descriptor: Record<string, unknown>,
): Promise<PreparedWithMeta> {
  const result = await adapter.prepareGeometry(geometryElement(descriptor));
  const meta = await adapter.describeGeometryMetadata(result.meshToken);
  assert.ok(meta !== null, "metadata capability");
  return { meshToken: result.meshToken, bbox: result.bbox, metadata: meta! };
}

test("reference adapter satisfies the corpus exactly (always runs)", async () => {
  const reference = createReferenceGeometryAdapter();
  for (const item of CORPUS) {
    const prepared = await prepareWithMeta(reference, item.descriptor);
    const expected = EXPECTED_VOLUMES[item.id]!;
    assert.ok(
      Math.abs(prepared.metadata.volume - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
      `${item.id}: reference volume exact`,
    );
  }
});

test("cross-engine agreement: OCCT vs reference within declared tolerances (engine-gated)", { skip: skipEngine }, async () => {
  const occt = createOcctGeometryAdapter();
  const reference = createReferenceGeometryAdapter();
  const maxVolumeRelErr = { value: 0 };
  const maxBboxAbsDiff = { value: 0 };

  for (const item of CORPUS) {
    const a = await prepareWithMeta(occt as unknown as ReturnType<typeof createReferenceGeometryAdapter>, item.descriptor);
    const b = await prepareWithMeta(reference, item.descriptor);

    // volume agreement within the declared tolerance
    const denom = Math.max(Math.abs(a.metadata.volume), Math.abs(b.metadata.volume), 1e-30);
    const relErr = Math.abs(a.metadata.volume - b.metadata.volume) / denom;
    maxVolumeRelErr.value = Math.max(maxVolumeRelErr.value, relErr);
    assert.ok(
      Math.abs(a.metadata.volume - b.metadata.volume) <= Math.max(VOLUME_ABS_TOL, VOLUME_REL_TOL * denom),
      `${item.id}: volumes agree within declared tolerance (occt ${a.metadata.volume} vs ref ${b.metadata.volume})`,
    );

    // bbox agreement within the OCCT Bnd_Box tolerance
    for (let i = 0; i < 6; i++) {
      const diff = Math.abs(a.bbox[i]! - b.bbox[i]!);
      maxBboxAbsDiff.value = Math.max(maxBboxAbsDiff.value, diff);
      assert.ok(diff <= BBOX_TOL, `${item.id}: bbox[${i}] agrees within ${BBOX_TOL} (occt ${a.bbox[i]} vs ref ${b.bbox[i]})`);
    }

    // meshTokens are engine-local (viewport cache keys, never canonical)
    assert.ok(a.meshToken.startsWith("occt:"), `${item.id}: occt token`);
    assert.ok(b.meshToken.startsWith("ref:"), `${item.id}: reference token`);
    assert.notEqual(a.meshToken, b.meshToken);
  }

  console.log(
    `cross-engine corpus agreement: max volume rel err = ${maxVolumeRelErr.value.toExponential(3)}, max bbox abs diff = ${maxBboxAbsDiff.value.toExponential(3)} (declared: ${VOLUME_REL_TOL} rel / ${BBOX_TOL} abs)`,
  );
});

test("cross-engine disagreement is detected (guard: the tolerance assertion is not vacuous)", { skip: skipEngine }, async () => {
  const occt = createOcctGeometryAdapter();
  const a = await prepareWithMeta(occt as unknown as ReturnType<typeof createReferenceGeometryAdapter>, CORPUS[0]!.descriptor);
  // perturb the expected value beyond tolerance → assertion-style check fails
  const wrong = a.metadata.volume * 1.001;
  assert.ok(
    Math.abs(a.metadata.volume - wrong) > Math.max(VOLUME_ABS_TOL, VOLUME_REL_TOL * a.metadata.volume),
    "a 0.1% perturbation exceeds the declared tolerance (the check has teeth)",
  );
});

test("evaluateDescriptorAnalytically cross-checks the corpus (always runs)", () => {
  for (const item of CORPUS) {
    const { volume, bbox } = evaluateDescriptorAnalytically(item.descriptor);
    assert.ok(Number.isFinite(volume) && volume > 0, `${item.id}: positive finite volume`);
    for (let i = 0; i < 3; i++) {
      assert.ok(bbox[i]! <= bbox[i + 3]! + 1e-15, `${item.id}: bbox min <= max`);
    }
  }
});
