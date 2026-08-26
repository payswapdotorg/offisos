/**
 * Web Host (§5.3, §16, LOCK-017/018).
 *
 * Provides HostCapabilities to the shared renderer. Web clients never receive
 * native process/filesystem privileges (§16): the capability set is empty.
 * Heavy CAD/BIM work is delegated to backend workers through the App API over
 * the transport contract; the host provides only the transport.
 */

import type { HostCapabilities, NativeCapability, Transport } from "../contracts/host.js";

const WEB_CAPABILITIES: ReadonlySet<NativeCapability> = new Set();

export class WebHost implements HostCapabilities {
  readonly hostId = "web" as const;
  readonly capabilities: ReadonlySet<NativeCapability> = WEB_CAPABILITIES;
  constructor(readonly transport: Transport) {}
  has(capability: NativeCapability): boolean {
    return this.capabilities.has(capability);
  }
}
