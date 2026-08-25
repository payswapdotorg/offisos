/**
 * CAD/BIM App API v1 (§5.3, §5.5, api-contract.md).
 *
 * The semantic command/query contract that sits below the hosts and above the
 * CAD/BIM engine. Exported: the handler, wire schemas, and idempotency cache.
 * The renderer and hosts talk to this contract through any Transport; the
 * same contract is testable through both the Web Host and the Electron Host
 * (§5.5, transport independence).
 */

export { AppApiHandler } from "./contract.js";
export type { AppApiHandlerOptions } from "./contract.js";
export { IdempotencyCache } from "./idempotency.js";
export {
  COMMAND_PAYLOAD_SCHEMAS,
  QUERY_PAYLOAD_SCHEMAS,
  WIRE_ENVELOPE_SCHEMA,
  APP_API_VERSIONS,
} from "./schema.js";
