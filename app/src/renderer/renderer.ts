/**
 * Shared CAD/BIM renderer/editor core (LOCK-017/018, §5.3, §5.5).
 *
 * Platform-independent. Talks to its host ONLY through the HostCapabilities
 * contract (transport + allowlisted capabilities). Does NOT import Electron,
 * browser APIs, FreeCAD, OpenCascade or IfcOpenShell — enforced by
 * `test/no-forbidden-imports.test.ts`.
 *
 * The renderer renders a deterministic SceneGraph from a CADDocument snapshot
 * (LOCK-017: same snapshot → same hash, for Web/Electron parity) and
 * dispatches commands/queries through the host Transport. Geometry mesh tokens
 * are read from element props (pre-computed by the App API + engine adapter
 * when building the snapshot); the renderer never calls an engine directly.
 */

import { createHash } from "node:crypto";
import type { HostCapabilities } from "../contracts/host.js";
import type { Command, CommandQueryResponse, Query } from "../contracts/app-api.js";
import type { CADDocumentSnapshot } from "../contracts/caddocument.js";
import type { SceneGraph, SceneNode } from "../contracts/scene.js";
import { canonicalStringify } from "../caddocument/index.js";

const IDENTITY_TRANSFORM: readonly number[] = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length === 16 && value.every((n) => typeof n === "number");
}

export interface Renderer {
  readonly host: HostCapabilities;
  /** Deterministic scene graph for a snapshot (same snapshot → same hash). */
  render(snapshot: CADDocumentSnapshot): SceneGraph;
  /** Dispatch a command through the host transport. */
  execute(command: Command): Promise<CommandQueryResponse>;
  /** Dispatch a query through the host transport. */
  query(query: Query): Promise<CommandQueryResponse>;
}

export function createRenderer(host: HostCapabilities): Renderer {
  const renderer: Renderer = {
    host,
    render(snapshot) {
      const nodes: SceneNode[] = [];
      for (const el of snapshot.elements) {
        const props = el.props as Record<string, unknown>;
        const meshTokenRaw = props.meshToken;
        const meshToken = typeof meshTokenRaw === "string" ? meshTokenRaw : `empty:${el.id}`;
        const transform = isNumberArray(props.transform) ? props.transform : IDENTITY_TRANSFORM;
        nodes.push({ id: el.id, meshToken, transform });
      }
      const hash = createHash("sha256")
        .update(canonicalStringify({ documentVersionId: snapshot.version.version_id, nodes }))
        .digest("hex");
      return { documentVersionId: snapshot.version.version_id, nodes, hash };
    },
    execute(command) {
      return host.transport.send(command);
    },
    query(query) {
      return host.transport.send(query);
    },
  };
  return renderer;
}
