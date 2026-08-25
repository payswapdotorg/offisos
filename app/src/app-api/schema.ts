/**
 * Wire contract schemas for the CAD/BIM App API v1 (api-contract.md §1, §7, §8).
 *
 * These JSON Schemas are the stable, inspectable definition of the command/
 * query contract. Additive changes preserve backward compatibility; breaking
 * changes create a new API version (api-contract.md §8). The contract exposes
 * construction-domain capabilities, not internal engine details (§1, §12).
 */

import type { CommandName, QueryName } from "../contracts/app-api.js";

export const COMMAND_PAYLOAD_SCHEMAS: Readonly<Record<CommandName, object>> = {
  "document.create": {
    type: "object",
    properties: {
      entityId: { type: "string" },
      format: { type: "string" },
      formatVersion: { type: "string" },
      createdBy: { type: "string" },
    },
  },
  "document.open": {
    type: "object",
    properties: {
      snapshot: { type: "object" },
      source: { type: "array", items: { type: "number" } },
    },
  },
  "document.applyEdit": {
    type: "object",
    properties: {
      edit: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["addElement", "removeElement", "updateElement", "setProps"] },
          elementId: { type: "string" },
          element: { type: "object" },
          patch: { type: "object" },
        },
        required: ["type"],
      },
    },
    required: ["edit"],
  },
  "document.setSelection": {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
    },
    required: ["ids"],
  },
  "document.undo": { type: "object", properties: {} },
  "document.redo": { type: "object", properties: {} },
  "document.serialize": { type: "object", properties: {} },
  "document.deserialize": {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  "document.save": { type: "object", properties: {} },
};

export const QUERY_PAYLOAD_SCHEMAS: Readonly<Record<QueryName, object>> = {
  "document.getState": { type: "object", properties: {} },
  "document.getVersion": { type: "object", properties: {} },
  "document.canUndo": { type: "object", properties: {} },
  "document.canRedo": { type: "object", properties: {} },
  "document.getSelection": { type: "object", properties: {} },
};

export const WIRE_ENVELOPE_SCHEMA = {
  type: "object",
  properties: {
    api: { type: "string", const: "1" },
    body: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["command", "query"] },
        name: { type: "string" },
        payload: {},
        idempotencyKey: { type: "string" },
      },
      required: ["type", "name"],
    },
  },
  required: ["api", "body"],
} as const;

export const APP_API_VERSIONS = ["1"] as const;
