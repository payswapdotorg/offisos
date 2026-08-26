/**
 * OCCT file adapter (CAD-IMPLEMENT-002 / Issue #26).
 *
 * Implements the frozen `FileEngineAdapter` contract for the OCCT bundle.
 * "Deterministic serialization of adapter state sufficient for the existing
 * CADDocument workflow" (Issue #26 scope): the adapter state IS the CAD
 * document snapshot (elements carry their geometry descriptors + the
 * deterministic occt: meshTokens), serialized through the canonical Offisos
 * JSON serialization (LOCK-007 canonical round-trip). Native engine exchange
 * formats (STEP/BRep/FCStd) are a later production slice behind this same
 * boundary — out of scope per Issue #26 non-goals.
 */

import { ADAPTER_BOUNDARY_MARK } from "../../contracts/adapter.js";
import type { FileEngineAdapter } from "../../contracts/adapter.js";
import type { CADDocumentSnapshot } from "../../contracts/caddocument.js";
import { deserialize, rootVersion, serialize } from "../../caddocument/index.js";

const OCCT_NOW = () => new Date("2026-01-01T00:00:00.000Z").toISOString();

export const OCCT_FILE_FORMAT = "offisos-occt";

export const OcctFileAdapter: FileEngineAdapter = {
  adapterMark: ADAPTER_BOUNDARY_MARK,
  format: OCCT_FILE_FORMAT,
  async read(source: Uint8Array): Promise<CADDocumentSnapshot> {
    if (source.length === 0) {
      return {
        version: rootVersion("occt-doc", "occt-adapter", null, OCCT_NOW),
        format: OCCT_FILE_FORMAT,
        formatVersion: "1",
        sourceArtifactLineage: ["occt:empty"],
        editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
        elements: [],
      };
    }
    const text = new TextDecoder().decode(source);
    return deserialize(text);
  },
  async write(snapshot: CADDocumentSnapshot): Promise<Uint8Array> {
    return new TextEncoder().encode(serialize(snapshot));
  },
};
