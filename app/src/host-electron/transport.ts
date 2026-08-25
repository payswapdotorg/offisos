/**
 * Electron Host transport — allowlisted native IPC (§5.3, §5.5, §16).
 *
 * Simulates the Electron IPC channel: the request is serialized (structured-
 * clone-like JSON) and sent "over IPC", deserialized, handled, and the
 * response is serialized back. Proves the command/query contract survives the
 * IPC boundary identically to the WebSocket boundary (transport independence,
 * §5.5) so Web/Electron parity holds.
 */

import type { CommandQueryRequest, CommandQueryResponse } from "../contracts/app-api.js";
import type { Transport } from "../contracts/host.js";
import type { AppApiHandler } from "../app-api/index.js";

export class IpcTransport implements Transport {
  readonly transportId = "electron-ipc";
  constructor(private readonly handler: AppApiHandler) {}

  async send(request: CommandQueryRequest): Promise<CommandQueryResponse> {
    const ipcOut = JSON.stringify(request);
    const decoded = JSON.parse(ipcOut) as CommandQueryRequest;
    const response = await this.handler.handle(decoded);
    const ipcBack = JSON.stringify(response);
    return JSON.parse(ipcBack) as CommandQueryResponse;
  }
}
