/**
 * Web Host transport — JSON-over-wire (§5.3, §5.5, §16).
 *
 * Simulates the HTTP/WebSocket wire: the request is serialized to JSON, sent
 * "over the wire", deserialized, handled, and the response is serialized back
 * and deserialized. This proves the command/query contract survives a
 * serialization boundary (transport independence, §5.5) and that the renderer
 * never depends on a browser transport API directly.
 */

import type { CommandQueryRequest, CommandQueryResponse } from "../contracts/app-api.js";
import type { Transport } from "../contracts/host.js";
import type { AppApiHandler } from "../app-api/index.js";

export class WebSocketTransport implements Transport {
  readonly transportId = "web-ws";
  constructor(private readonly handler: AppApiHandler) {}

  async send(request: CommandQueryRequest): Promise<CommandQueryResponse> {
    const wireOut = JSON.stringify(request);
    const decoded = JSON.parse(wireOut) as CommandQueryRequest;
    const response = await this.handler.handle(decoded);
    const wireBack = JSON.stringify(response);
    return JSON.parse(wireBack) as CommandQueryResponse;
  }
}
