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
      vec2: {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
      },
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
            // COMPAT-CAD-002 (additive): extrusion-derived solids.
            type: "object",
            properties: {
              shape: { const: "extrude" },
              profile: {
                type: "array",
                minItems: 3,
                maxItems: 64,
                items: { $ref: "#/$defs/vec2" },
              },
              height: { type: "number", exclusiveMinimum: 0 },
              base: { $ref: "#/$defs/vec3" },
            },
            required: ["shape", "profile", "height"],
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
  // --- CAD-PARITY-003 (additive, Issue #78): canonical 2D entity commands.
  // The payload is the coarse wire shape; the shared entity-ops core
  // validates the geometry strictly (LOCK-007).
  "entity.create": {
    type: "object",
    properties: {
      entities: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "line",
                "polyline",
                "circle",
                "arc",
                "ellipse",
                "spline",
                "point",
                "ray",
                "xline",
                "region",
              ],
            },
            layer: { type: "string" },
          },
          required: ["type"],
        },
      },
    },
    required: ["entities"],
  },
  "entity.modify": {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: [
          "move",
          "copy",
          "rotate",
          "scale",
          "mirror",
          "offset",
          "trim",
          "extend",
          "stretch",
          "fillet",
          "chamfer",
          "break",
          "join",
          "explode",
          "setGeometry",
        ],
      },
    },
    required: ["op"],
  },
  // --- COMPAT-CAD-001 (additive, api-contract.md §8): 2D drafting surface.
  // Entity inputs mirror src/drafting/entities.ts (validated strictly by the
  // handler — the schema is the coarse wire shape).
  "drafting.createEntities": {
    type: "object",
    properties: {
      entities: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: ["line", "polyline", "circle", "arc", "rectangle", "dim-linear", "dim-radius"],
            },
            layer: { type: "string" },
            from: { $ref: "#/$defs/vec2" },
            to: { $ref: "#/$defs/vec2" },
            points: { type: "array", minItems: 2, items: { $ref: "#/$defs/vec2" } },
            closed: { type: "boolean" },
            center: { $ref: "#/$defs/vec2" },
            radius: { type: "number", exclusiveMinimum: 0 },
            startAngle: { type: "number" },
            endAngle: { type: "number" },
            corner1: { $ref: "#/$defs/vec2" },
            corner2: { $ref: "#/$defs/vec2" },
            p1: { $ref: "#/$defs/vec2" },
            p2: { $ref: "#/$defs/vec2" },
            mode: { type: "string", enum: ["aligned", "horizontal", "vertical"] },
            offset: { type: "number" },
            target: { type: "string" },
          },
          required: ["type"],
        },
      },
    },
    required: ["entities"],
    $defs: {
      vec2: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    },
  },
  "drafting.move": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string" } },
      dx: { type: "number" },
      dy: { type: "number" },
    },
    required: ["ids", "dx", "dy"],
  },
  "drafting.copy": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string" } },
      dx: { type: "number" },
      dy: { type: "number" },
    },
    required: ["ids", "dx", "dy"],
  },
  "drafting.delete": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string" } },
    },
    required: ["ids"],
  },
  "drafting.trim": {
    type: "object",
    properties: {
      targetId: { type: "string" },
      pick: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    },
    required: ["targetId", "pick"],
  },
  "drafting.extend": {
    type: "object",
    properties: {
      targetId: { type: "string" },
      pick: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    },
    required: ["targetId", "pick"],
  },
  "drafting.setSettings": {
    type: "object",
    properties: {
      settings: { type: "object" },
    },
    required: ["settings"],
  },
  "drafting.addLayer": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      visible: { type: "boolean" },
      // CAD-PARITY-004 additive layer fields.
      frozen: { type: "boolean" },
      locked: { type: "boolean" },
      linetype: { type: "string", minLength: 1 },
      lineweight: { type: "number" },
      transparency: { type: "integer", minimum: 0, maximum: 90 },
      plot: { type: "boolean" },
      description: { type: "string" },
    },
    required: ["name"],
  },
  "drafting.updateLayer": {
    type: "object",
    properties: {
      layerId: { type: "string" },
      patch: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
          visible: { type: "boolean" },
          // CAD-PARITY-004 additive layer patch fields.
          frozen: { type: "boolean" },
          locked: { type: "boolean" },
          linetype: { type: "string", minLength: 1 },
          lineweight: { type: "number" },
          transparency: { type: "integer", minimum: 0, maximum: 90 },
          plot: { type: "boolean" },
          description: { type: "string" },
        },
        minProperties: 1,
      },
    },
    required: ["layerId", "patch"],
  },
  "drafting.removeLayer": {
    type: "object",
    properties: {
      layerId: { type: "string" },
    },
    required: ["layerId"],
  },

  // --- CAD-PARITY-004 (additive, Issue #80): layers, properties, styles ---
  "entity.setDisplay": {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, minItems: 1 },
      patch: {
        type: "object",
        properties: {
          color: { type: "string" },
          linetype: { type: "string" },
          lineweight: { type: ["number", "string"] },
          transparency: { type: ["integer", "string"] },
          layer: { type: "string" },
        },
        minProperties: 1,
      },
    },
    required: ["ids", "patch"],
  },
  "layer.setActive": {
    type: "object",
    properties: {
      layerId: { type: "string" },
    },
    required: ["layerId"],
  },
  "layer.applyStandard": {
    type: "object",
    properties: {
      standard: { type: "string", enum: ["architectural", "mechanical"] },
    },
    required: ["standard"],
  },
  "layer.isolate": {
    type: "object",
    properties: {
      layerIds: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["layerIds"],
  },
  "layer.unisolate": { type: "object", properties: {} },
  // --- CAD-PARITY-005 (additive, Issue #82): annotation commands ---
  "annotation.create": {
    type: "object",
    properties: {
      entities: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "text",
                "mtext",
                "dim-linear",
                "dim-radius",
                "dim-diameter",
                "dim-angular",
                "leader",
                "mleader",
              ],
            },
            layer: { type: "string" },
          },
          required: ["type"],
        },
      },
    },
    required: ["entities"],
  },
  "annotation.update": {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, minItems: 1 },
      patch: { type: "object", minProperties: 1 },
    },
    required: ["ids", "patch"],
  },
  "annotation.remeasure": {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
    },
  },
  // --- CAD-PARITY-006 (additive, Issue #84): blocks/attributes/xrefs ---
  // Coarse wire shapes; the shared blocks core validates strictly.
  "block.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      basePoint: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
      fromElementIds: { type: "array", minItems: 1, items: { type: "string" } },
      entities: { type: "array", items: { type: "object" } },
      description: { type: "string" },
    },
    required: ["name", "basePoint"],
  },
  "block.insert": {
    type: "object",
    properties: {
      name: { type: "string" },
      blockId: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      scale: { type: "number", exclusiveMinimum: 0 },
      rotation: { type: "number" },
      layer: { type: "string" },
      attributes: {
        type: "array",
        items: {
          type: "object",
          properties: { tag: { type: "string" }, value: { type: "string" } },
          required: ["tag", "value"],
        },
      },
    },
    required: ["x", "y"],
  },
  "block.update": {
    type: "object",
    properties: {
      name: { type: "string" },
      blockId: { type: "string" },
      patch: { type: "object", minProperties: 1 },
    },
    required: ["patch"],
  },
  "block.remove": {
    type: "object",
    properties: {
      name: { type: "string" },
      blockId: { type: "string" },
    },
  },
  "attribute.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      tag: { type: "string", minLength: 1 },
      value: { type: ["string", "null"] },
    },
    required: ["id", "tag"],
  },
  "xref.attach": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
      x: { type: "number" },
      y: { type: "number" },
      scale: { type: "number", exclusiveMinimum: 0 },
      rotation: { type: "number" },
      layer: { type: "string" },
      content: { type: "object" },
    },
    required: ["name", "path"],
  },
  "xref.detach": {
    type: "object",
    properties: {
      name: { type: "string" },
      xrefId: { type: "string" },
    },
  },
  "xref.reload": {
    type: "object",
    properties: {
      name: { type: "string" },
      xrefId: { type: "string" },
      content: { type: "object" },
    },
    required: ["content"],
  },
  "layerState.save": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
    },
    required: ["name"],
  },
  "layerState.restore": {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  "layerState.remove": {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  "ltype.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      description: { type: "string" },
      pattern: { type: "array", items: { type: "number", exclusiveMinimum: 0 }, minItems: 2 },
    },
    required: ["name", "pattern"],
  },
  "ltype.update": {
    type: "object",
    properties: {
      name: { type: "string" },
      patch: {
        type: "object",
        properties: {
          description: { type: "string" },
          pattern: { type: "array", items: { type: "number", exclusiveMinimum: 0 }, minItems: 2 },
        },
        minProperties: 1,
      },
    },
    required: ["name", "patch"],
  },
  "ltype.remove": {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  "textStyle.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      font: { type: "string", enum: ["sans", "mono", "serif"] },
      height: { type: "number", minimum: 0 },
      widthFactor: { type: "number", exclusiveMinimum: 0 },
      obliqueAngle: { type: "number", minimum: -85, maximum: 85 },
    },
    required: ["name"],
  },
  "textStyle.update": {
    type: "object",
    properties: {
      name: { type: "string" },
      patch: {
        type: "object",
        properties: {
          font: { type: "string", enum: ["sans", "mono", "serif"] },
          height: { type: "number", minimum: 0 },
          widthFactor: { type: "number", exclusiveMinimum: 0 },
          obliqueAngle: { type: "number", minimum: -85, maximum: 85 },
        },
        minProperties: 1,
      },
    },
    required: ["name", "patch"],
  },
  "textStyle.remove": {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  "dimStyle.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      textHeight: { type: "number", exclusiveMinimum: 0 },
      arrowSize: { type: "number", exclusiveMinimum: 0 },
      scale: { type: "number", exclusiveMinimum: 0 },
      precision: { type: "integer", minimum: 0, maximum: 6 },
    },
    required: ["name"],
  },
  "dimStyle.update": {
    type: "object",
    properties: {
      name: { type: "string" },
      patch: {
        type: "object",
        properties: {
          textHeight: { type: "number", exclusiveMinimum: 0 },
          arrowSize: { type: "number", exclusiveMinimum: 0 },
          scale: { type: "number", exclusiveMinimum: 0 },
          precision: { type: "integer", minimum: 0, maximum: 6 },
        },
        minProperties: 1,
      },
    },
    required: ["name", "patch"],
  },
  "dimStyle.remove": {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  // --- COMPAT-CAD-002 (additive, api-contract.md §8): 3D/BIM authoring
  // surface. Entity inputs mirror src/bim/elements.ts (validated strictly by
  // the handler — the schema is the coarse wire shape).
  "bim.createElements": {
    type: "object",
    properties: {
      entities: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: [
                "bim.story",
                "bim.wall",
                "bim.slab",
                "bim.opening",
                "bim.door",
                "bim.window",
                "bim.space",
                // COMPAT-BIM-003 (additive): components / materials /
                // coordination.
                "bim.componentDef",
                "bim.componentInstance",
                "bim.material",
                "bim.grid",
                "bim.referencePlane",
              ],
            },
            name: { type: "string" },
            level: { type: "number" },
            height: { type: "number", exclusiveMinimum: 0 },
            storyId: { type: "string" },
            start: { $ref: "#/$defs/vec2" },
            end: { $ref: "#/$defs/vec2" },
            width: { type: "number", exclusiveMinimum: 0 },
            baseOffset: { type: "number" },
            corner1: { $ref: "#/$defs/vec2" },
            corner2: { $ref: "#/$defs/vec2" },
            thickness: { type: "number", exclusiveMinimum: 0 },
            hostId: { type: "string" },
            distance: { type: "number", minimum: 0 },
            sill: { type: "number", minimum: 0 },
            openingId: { type: "string" },
            swing: { type: "string", enum: ["left", "right"] },
            leafThickness: { type: "number", exclusiveMinimum: 0 },
            footprint: {
              type: "array",
              minItems: 3,
              maxItems: 64,
              items: { $ref: "#/$defs/vec2" },
            },
            // COMPAT-BIM-003 (additive).
            category: {
              type: "string",
              enum: ["wall", "door", "window", "furniture", "fixture"],
            },
            parameters: { type: "object" },
            definitionId: { type: "string" },
            position: { $ref: "#/$defs/vec2" },
            rotation: { type: "number" },
            overrides: { type: "object" },
            materialId: { type: "string" },
            description: { type: "string" },
            color: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3 },
            properties: { type: "object" },
            uLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
            vLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
          },
          required: ["type"],
        },
      },
    },
    required: ["entities"],
    $defs: {
      vec2: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    },
  },
  "bim.move": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string" } },
      dx: { type: "number" },
      dy: { type: "number" },
      dz: { type: "number" },
    },
    required: ["ids", "dx", "dy", "dz"],
  },
  "bim.copy": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string" } },
      dx: { type: "number" },
      dy: { type: "number" },
      dz: { type: "number" },
    },
    required: ["ids", "dx", "dy", "dz"],
  },
  "bim.delete": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string" } },
    },
    required: ["ids"],
  },
  "bim.setProperties": {
    type: "object",
    properties: {
      elementId: { type: "string" },
      patch: { type: "object", minProperties: 1 },
    },
    required: ["elementId", "patch"],
  },
  "bim.setSettings": {
    type: "object",
    properties: {
      settings: {
        type: "object",
        properties: {
          camera: {
            type: "object",
            properties: {
              preset: { type: "string", enum: ["iso", "top", "front", "right"] },
            },
            required: ["preset"],
          },
        },
      },
    },
    required: ["settings"],
  },
  "bim.buildGeometry": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string" } },
    },
  },
  // COMPAT-CAD-003 (additive): construction documentation commands.
  "docs.createViews": {
    type: "object",
    properties: {
      views: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["plan", "elevation", "section", "detail"] },
            title: { type: "string" },
            storyId: { type: "string" },
            direction: { type: "string", enum: ["front", "back", "left", "right"] },
            sectionAxis: { type: "string", enum: ["x", "y"] },
            sectionOffset: { type: "number" },
            sourceViewId: { type: "string" },
            region: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number", exclusiveMinimum: 0 },
                h: { type: "number", exclusiveMinimum: 0 },
              },
              required: ["x", "y", "w", "h"],
            },
            detailScale: { type: "number", exclusiveMinimum: 0 },
            scale: { type: "number", exclusiveMinimum: 0 },
          },
          required: ["kind", "title"],
        },
      },
    },
    required: ["views"],
  },
  "docs.updateView": {
    type: "object",
    properties: {
      viewId: { type: "string" },
      patch: { type: "object" },
    },
    required: ["viewId", "patch"],
  },
  "docs.removeView": {
    type: "object",
    properties: { viewId: { type: "string" } },
    required: ["viewId"],
  },
  "docs.createSheets": {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            titleBlock: {
              type: "object",
              properties: {
                projectName: { type: "string" },
                sheetTitle: { type: "string" },
                sheetNumber: { type: "string" },
                author: { type: "string" },
                date: { type: "string" },
              },
              required: ["projectName", "sheetTitle", "sheetNumber"],
            },
            viewPlacements: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  viewId: { type: "string" },
                  x: { type: "number" },
                  y: { type: "number" },
                  w: { type: "number", exclusiveMinimum: 0 },
                  h: { type: "number", exclusiveMinimum: 0 },
                },
                required: ["viewId", "x", "y", "w", "h"],
              },
            },
          },
          required: ["title", "titleBlock", "viewPlacements"],
        },
      },
    },
    required: ["sheets"],
  },
  "docs.updateSheet": {
    type: "object",
    properties: {
      sheetId: { type: "string" },
      patch: { type: "object" },
    },
    required: ["sheetId", "patch"],
  },
  "docs.removeSheet": {
    type: "object",
    properties: { sheetId: { type: "string" } },
    required: ["sheetId"],
  },
  "docs.addAnnotations": {
    type: "object",
    properties: {
      annotations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["docs.dim", "docs.tag", "docs.note"] },
            viewId: { type: "string" },
            refIds: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
            axis: { type: "string", enum: ["x", "y"] },
            mode: { type: "string", enum: ["overall", "clear"] },
            offset: { type: "number" },
            targetId: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            text: { type: "string" },
          },
          required: ["type", "viewId"],
        },
      },
    },
    required: ["annotations"],
  },
  "docs.removeAnnotations": {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" } } },
    required: ["ids"],
  },
  "docs.regenerate": { type: "object", properties: {} },

  // COMPAT-IFC-001 (additive): IFC/openBIM interoperability commands.
  "ifc.export": { type: "object", properties: { projectName: { type: "string" } } },
  "ifc.import": {
    type: "object",
    properties: {
      ifc: { type: "string" },
      defaultStoryHeight: { type: "number" },
      defaultSpaceHeight: { type: "number" },
    },
    required: ["ifc"],
  },
  "ifc.bcfCreate": {
    type: "object",
    properties: {
      topics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            author: { type: "string" },
            type: { type: "string" },
            status: { type: "string" },
            comment: { type: "string" },
            commentAuthor: { type: "string" },
            elementIds: { type: "array", items: { type: "string" } },
          },
          required: ["title", "description"],
        },
      },
    },
    required: ["topics"],
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
  // COMPAT-CAD-001 (additive): deterministic snap resolution. Tolerance,
  // kinds and gridSize default to the document's drafting settings.
  "drafting.snap": {
    type: "object",
    properties: {
      point: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      tolerance: { type: "number", exclusiveMinimum: 0 },
      kinds: {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
          enum: ["endpoint", "intersection", "center", "midpoint", "quadrant", "on-object", "grid"],
        },
      },
      gridSize: { type: "number", exclusiveMinimum: 0 },
      exclude: { type: "array", items: { type: "string" } },
    },
    required: ["point"],
  },
  // CAD-PARITY-003 (additive, Issue #78): the shared precision engine as
  // queries — same inputs as the host renderers (parity by construction).
  "precision.snap": {
    type: "object",
    properties: {
      cursor: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      settings: {
        type: "object",
        properties: {
          osnapModes: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "endpoint",
                "midpoint",
                "center",
                "quadrant",
                "intersection",
                "node",
                "nearest",
                "perpendicular",
                "tangent",
              ],
            },
          },
          ortho: { type: "boolean" },
          polar: { type: "boolean" },
          polarAnglesDeg: { type: "array", items: { type: "number" } },
          gridSnap: { type: "boolean" },
          gridSize: { type: "number", exclusiveMinimum: 0 },
          aperture: { type: "number", exclusiveMinimum: 0 },
          tracking: { type: "boolean" },
        },
      },
      lastPoint: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    },
    required: ["cursor"],
  },
  "precision.pick": {
    type: "object",
    properties: {
      cursor: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      aperture: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["cursor"],
  },
  "precision.window": {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["window", "crossing"] },
      min: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      max: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    },
    required: ["mode", "min", "max"],
  },
  // COMPAT-CAD-002 (additive): BIM structure, semantics and standard cameras.
  "bim.getBuilding": { type: "object", properties: {} },
  // COMPAT-BIM-003 (additive): the component/material/coordination inventory
  // with derived state (effective parameters, effective materials).
  "bim.getComponents": { type: "object", properties: {} },
  "bim.getSemantics": {
    type: "object",
    properties: {
      elementId: { type: "string" },
    },
  },
  "bim.camera": {
    type: "object",
    properties: {
      preset: { type: "string", enum: ["iso", "top", "front", "right"] },
    },
    required: ["preset"],
  },
  // COMPAT-CAD-003 (additive): documentation queries.
  "docs.listViews": { type: "object", properties: {} },
  "docs.getViewGeometry": {
    type: "object",
    properties: { viewId: { type: "string" } },
    required: ["viewId"],
  },
  "docs.listSheets": { type: "object", properties: {} },
  "docs.exportSheet": {
    type: "object",
    properties: {
      sheetId: { type: "string" },
      format: { type: "string", enum: ["sheet-ir", "pdf", "dwg"] },
    },
    required: ["sheetId", "format"],
  },

  // COMPAT-IFC-001 (additive): IFC/openBIM read-only surfaces.
  "ifc.probe": { type: "object", properties: {} },
  "ifc.compare": {
    type: "object",
    properties: { ifc: { type: "string" } },
    required: ["ifc"],
  },
  "ifc.idsValidate": {
    type: "object",
    properties: { ifc: { type: "string" }, ids: { type: "string" } },
    required: ["ids"],
  },
  "ifc.bcfParse": {
    type: "object",
    properties: { bcf: { type: "string" } },
    required: ["bcf"],
  },
  "ifc.listImports": { type: "object", properties: {} },
  // CAD-PARITY-006 (additive): the inventory queries take no payload.
  "blocks.list": { type: "object", properties: {} },
  "xrefs.list": { type: "object", properties: {} },
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
