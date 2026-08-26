/**
 * Host capability and transport contracts (Architecture v1.1 LOCK-017/018,
 * §5.3, §5.5, §16).
 *
 * The shared CAD/BIM renderer core talks to its host ONLY through these
 * contracts. The renderer must not import Electron, browser APIs, FreeCAD,
 * OpenCascade or IfcOpenShell; host and engine concerns are exposed here as
 * explicit, capability-scoped contracts.
 *
 * Transport independence (§5.5): the same semantic command/query contract must
 * be testable through both the Web Host and the Electron Host. A host provides
 * a `Transport`; the renderer is agnostic to the transport implementation.
 */

import type { CommandQueryRequest, CommandQueryResponse } from "./app-api.js";

/** A transport carries a versioned command/query request and returns a
 *  versioned response. Implementations: in-process (tests), WebSocket-likes
 *  (web host), allowlisted IPC (electron host). The renderer never sees the
 *  wire format. */
export interface Transport {
  readonly transportId: string;
  send(request: CommandQueryRequest): Promise<CommandQueryResponse>;
}

/** Allowlisted native capability identifiers. Web clients never receive native
 *  process/filesystem privileges (§16). Electron native capabilities are
 *  explicitly allowlisted and isolated. */
export type NativeCapability =
  | "file.read"
  | "file.write"
  | "native-worker.exec"
  | "gpu.accelerate";

/** What a host provides to the shared renderer core. The renderer never
 *  reaches around this contract into host internals. */
export interface HostCapabilities {
  readonly hostId: "web" | "electron";
  readonly transport: Transport;
  /** Allowlisted native capabilities. Web hosts expose an empty set; Electron
   *  hosts expose an explicitly allowlisted subset. */
  readonly capabilities: ReadonlySet<NativeCapability>;
  has(capability: NativeCapability): boolean;
}
