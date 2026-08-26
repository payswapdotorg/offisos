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
  // CAD-IMPLEMENT-002 (additive, api-contract.md §8): realize an
  // engine-independent GeometryDescriptor through the geometry engine
  // adapter. The recursive descriptor schema mirrors
  // contracts/geometry.ts (box / cylinder / transform / fuse / cut).
  "geometry.prepare": {
    type: "object",
    properties: {
      geometry: { $ref: "#/$defs/geometryDescriptor" },
      tessellation: {
        type: "object",
        properties: {
          linearDeflection: { type: "number", exclusiveMinimum: 0 },
          angularDeflection: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
    required: ["geometry"],
    $defs: {
      vec3: {
        type: "array",
        items: { type: "number" },
        minItems: 3,
        maxItems: 3,
      },
      matrix16: {
        type: "array",
        items: { type: "number" },
        minItems: 16,
        maxItems: 16,
      },
      geometryDescriptor: {
        oneOf: [
          {
            type: "object",
            properties: {
              shape: { const: "box" },
              width: { type: "number", exclusiveMinimum: 0 },
              depth: { type: "number", exclusiveMinimum: 0 },
              height: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["shape", "width", "depth", "height"],
          },
          {
            type: "object",
            properties: {
              shape: { const: "cylinder" },
              radius: { type: "number", exclusiveMinimum: 0 },
              height: { type: "number", exclusiveMinimum: 0 },
              origin: { $ref: "#/$defs/vec3" },
              direction: { $ref: "#/$defs/vec3" },
            },
            required: ["shape", "radius", "height"],
          },
          {
            type: "object",
            properties: {
              shape: { const: "transform" },
              matrix: { $ref: "#/$defs/matrix16" },
              target: { $ref: "#/$defs/geometryDescriptor" },
            },
            required: ["shape", "matrix", "target"],
          },
          {
            type: "object",
            properties: {
              shape: { const: "fuse" },
              a: { $ref: "#/$defs/geometryDescriptor" },
              b: { $ref: "#/$defs/geometryDescriptor" },
            },
            required: ["shape", "a", "b"],
          },
          {
            type: "object",
            properties: {
              shape: { const: "cut" },
              a: { $ref: "#/$defs/geometryDescriptor" },
              b: { $ref: "#/$defs/geometryDescriptor" },
            },
            required: ["shape", "a", "b"],
          },
        ],
      },
    },
  },
};

export const QUERY_PAYLOAD_SCHEMAS: Readonly<Record<QueryName, object>> = {
  "document.getState": { type: "object", properties: {} },
  "document.getVersion": { type: "object", properties: {} },
  "document.canUndo": { type: "object", properties: {} },
  "document.canRedo": { type: "object", properties: {} },
  "document.getSelection": { type: "object", properties: {} },
  // CAD-IMPLEMENT-003 (additive, api-contract.md §8): revision/Graph surface.
  "model.getHistory": { type: "object", properties: {} },
  "model.getGraphEvents": { type: "object", properties: {} },
  "model.replay": {
    type: "object",
    properties: {
      revision_number: { type: "number", minimum: 0 },
    },
    required: ["revision_number"],
  },
  // RESEARCH-CAD-007 (additive, api-contract.md §8): the deterministic
  // downstream cascade for one model transition (default: the latest
  // revision) — quantities → estimate → affected RFQ → commercial impact.
  "impact.cascade": {
    type: "object",
    properties: {
      revision_number: { type: "number", minimum: 1 },
    },
  },
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
