/**
 * Electron Host (§5.3, §16, LOCK-017/018).
 *
 * Provides HostCapabilities to the shared renderer. Electron native
 * capabilities are explicitly allowlisted and isolated (§16): file.read,
 * file.write and native-worker.exec are exposed; gpu.accelerate is reserved for
 * a future worker. The host provides the transport; heavy CAD/BIM engines may
 * run in native workers through the same App API contract.
 */

import type { HostCapabilities, NativeCapability, Transport } from "../contracts/host.js";

const ELECTRON_CAPABILITIES: ReadonlySet<NativeCapability> = new Set<NativeCapability>([
  "file.read",
  "file.write",
  "native-worker.exec",
]);

export class ElectronHost implements HostCapabilities {
  readonly hostId = "electron" as const;
  readonly capabilities: ReadonlySet<NativeCapability> = ELECTRON_CAPABILITIES;
  constructor(readonly transport: Transport) {}
  has(capability: NativeCapability): boolean {
    return this.capabilities.has(capability);
  }
}
