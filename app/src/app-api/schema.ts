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
  // --- CAD-PARITY-007 (additive): parametric constraints ---------------
  "constraint.create": {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [
          "horizontal", "vertical", "coincident", "parallel", "perpendicular",
          "equal", "tangent", "fixed", "distance", "angle", "radius",
        ],
      },
      targets: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            anchor: { type: "string", enum: ["start", "end", "center", "midpoint"] },
          },
          required: ["id"],
        },
      },
      value: { type: "number", exclusiveMinimum: 0 },
      mode: { type: "string", enum: ["external", "internal"] },
    },
    required: ["kind", "targets"],
  },
  "constraint.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          value: { type: "number", exclusiveMinimum: 0 },
          mode: { type: "string", enum: ["external", "internal"] },
        },
      },
    },
    required: ["id", "patch"],
  },
  "constraint.remove": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
    },
    required: ["id"],
  },
  "constraint.solve": {
    type: "object",
    properties: {},
  },
  // --- CAD-PARITY-008 (additive): layouts, viewports, plot ---------------
  "layout.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 255 },
    },
    required: ["name"],
  },
  "layout.rename": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      newName: { type: "string", minLength: 1, maxLength: 255 },
    },
    required: ["newName"],
  },
  "layout.clone": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      newName: { type: "string", minLength: 1, maxLength: 255 },
    },
    required: ["newName"],
  },
  "layout.remove": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
  },
  "layout.setPageSetup": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          paperSize: { type: "string", enum: ["A4", "A3", "A2", "A1", "A0", "CUSTOM"] },
          widthMm: { type: "number", exclusiveMinimum: 0 },
          heightMm: { type: "number", exclusiveMinimum: 0 },
          orientation: { type: "string", enum: ["portrait", "landscape"] },
          marginsMm: {
            type: "object",
            properties: {
              top: { type: "number", minimum: 0 },
              right: { type: "number", minimum: 0 },
              bottom: { type: "number", minimum: 0 },
              left: { type: "number", minimum: 0 },
            },
            required: ["top", "right", "bottom", "left"],
          },
          plotScale: { type: "string", minLength: 1 },
          plotOriginMm: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          centerPlot: { type: "boolean" },
          plotStyleTable: { type: ["string", "null"], minLength: 1 },
          plotStyleKind: { type: "string", enum: ["none", "ctb", "stb"] },
          plotViewports: { type: "boolean" },
        },
      },
    },
    required: ["patch"],
  },
  "layout.activate": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
  },
  "layout.setSpace": {
    type: "object",
    properties: {
      space: { type: "string", enum: ["model", "paper"] },
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
    required: ["space"],
  },
  "viewport.create": {
    type: "object",
    properties: {
      layoutId: { type: "string", minLength: 1 },
      layoutName: { type: "string", minLength: 1 },
      corner1: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      corner2: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      view: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fit", "scale", "window"] },
          denominator: { type: "number", exclusiveMinimum: 0 },
          centerX: { type: "number" },
          centerY: { type: "number" },
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
        },
        required: ["mode"],
      },
      rotationDeg: { type: "number" },
      locked: { type: "boolean" },
    },
    required: ["corner1", "corner2", "view"],
  },
  "viewport.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          corner1: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          corner2: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          camera: {
            type: "object",
            properties: {
              centerX: { type: "number" },
              centerY: { type: "number" },
            },
            required: ["centerX", "centerY"],
          },
          scaleDenominator: { type: "number", exclusiveMinimum: 0 },
          rotationDeg: { type: "number" },
          locked: { type: "boolean" },
          layerOverrides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                layerId: { type: "string", minLength: 1 },
                visible: { type: "boolean" },
                frozen: { type: "boolean" },
              },
              required: ["layerId"],
            },
          },
        },
      },
    },
    required: ["id", "patch"],
  },
  "viewport.remove": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
    },
    required: ["id"],
  },
  "plot.export": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      format: { type: "string", enum: ["svg", "pdf", "plot-ir"] },
    },
    required: ["format"],
  },
  "plot.publish": {
    type: "object",
    properties: {
      format: { type: "string", enum: ["pdf", "svg"] },
      layoutIds: { type: "array", items: { type: "string", minLength: 1 } },
    },
    required: ["format"],
  },
  // --- CAD-PARITY-009 (additive): 3D navigation, UCS/workplanes, modeling ---
  "ucs.define": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 255 },
      origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      xAxis: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      yAxis: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      zAxis: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
    },
    required: ["name", "origin", "xAxis", "yAxis"],
  },
  "ucs.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 255 },
          origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          xAxis: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          yAxis: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          zAxis: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        },
      },
    },
    required: ["patch"],
  },
  "ucs.remove": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
  },
  "ucs.activate": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
  },
  "view3d.set": {
    type: "object",
    properties: {
      eye: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      target: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      up: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      mode: { type: "string", enum: ["orthographic", "perspective"] },
      orthoHalfHeight: { type: "number", exclusiveMinimum: 0 },
      fovDeg: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 180 },
    },
  },
  "view3d.fit": {
    type: "object",
    properties: {
      aspect: { type: "number", exclusiveMinimum: 0 },
      mode: { type: "string", enum: ["orthographic", "perspective"] },
    },
  },
  "view3d.standard": {
    type: "object",
    properties: {
      view: { type: "string", enum: ["top", "bottom", "front", "back", "left", "right", "iso"] },
      aspect: { type: "number", exclusiveMinimum: 0 },
      mode: { type: "string", enum: ["orthographic", "perspective"] },
    },
    required: ["view"],
  },
  "model3d.box": {
    type: "object",
    properties: {
      width: { type: "number", exclusiveMinimum: 0 },
      depth: { type: "number", exclusiveMinimum: 0 },
      height: { type: "number", exclusiveMinimum: 0 },
      at: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      ucsId: { type: "string", minLength: 1 },
      ucsName: { type: "string", minLength: 1 },
    },
    required: ["width", "depth", "height"],
  },
  "model3d.cylinder": {
    type: "object",
    properties: {
      radius: { type: "number", exclusiveMinimum: 0 },
      height: { type: "number", exclusiveMinimum: 0 },
      at: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      ucsId: { type: "string", minLength: 1 },
      ucsName: { type: "string", minLength: 1 },
    },
    required: ["radius", "height"],
  },
  "model3d.extrude": {
    type: "object",
    properties: {
      profile: {
        type: "array",
        minItems: 3,
        items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      },
      height: { type: "number", exclusiveMinimum: 0 },
      baseZ: { type: "number" },
      at: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      ucsId: { type: "string", minLength: 1 },
      ucsName: { type: "string", minLength: 1 },
    },
    required: ["profile", "height"],
  },
  "model3d.move": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
      delta: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      ucsId: { type: "string", minLength: 1 },
      ucsName: { type: "string", minLength: 1 },
    },
    required: ["elementId", "delta"],
  },
  "model3d.rotate": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
      axis: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      deg: { type: "number" },
      base: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      ucsId: { type: "string", minLength: 1 },
      ucsName: { type: "string", minLength: 1 },
    },
    required: ["elementId", "axis", "deg"],
  },
  "model3d.scale": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
      factor: { type: "number", exclusiveMinimum: 0 },
      base: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      ucsId: { type: "string", minLength: 1 },
      ucsName: { type: "string", minLength: 1 },
    },
    required: ["elementId", "factor"],
  },
  "sectionplane.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 255 },
      origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      normal: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
    },
    required: ["name", "origin", "normal"],
  },
  // CAD-PARITY-010 (additive): boolean solids and bounded mesh entities.
  "model3d.boolean": {
    type: "object",
    properties: {
      op: { type: "string", enum: ["union", "difference", "intersection"] },
      elementIds: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ["op", "elementIds"],
  },
  "model3d.tessellate": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
      quality: { type: "string", enum: ["low", "medium", "full"] },
    },
    required: ["elementId"],
  },
  "sectionplane.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 255 },
          origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          normal: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        },
      },
    },
    required: ["patch"],
  },
  "sectionplane.remove": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
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
                // CAD-PARITY-011 (additive, Issue #97): the Archicad-class
                // authoring entities.
                "bim.roof",
                "bim.stair",
                "bim.railing",
                "bim.zone",
                "bim.optionGroup",
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
            // COMPAT-BIM-003 (additive) + CAD-PARITY-012 (Issue #102): the
            // shared entity bag carries BOTH category vocabularies — the
            // component categories (COMPAT-BIM-003) and the material
            // categories (the 8-value P012 parity vocabulary). The schema is
            // the coarse wire shape; the handler validates strictly per
            // entity type through the strict constructors.
            category: {
              type: "string",
              enum: [
                "wall", "door", "window", "furniture", "fixture",
                "Concrete", "Steel", "Masonry", "Timber", "Glass", "Insulation", "Finishes", "Generic",
              ],
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
            // CAD-PARITY-012 (additive, Issue #102): the material parity
            // fields (validated strictly by the handlers — the schema is the
            // coarse wire shape).
            lineweight: { type: "number", minimum: 0.5, maximum: 8 },
            density: { type: "number", exclusiveMinimum: 0 },
            uLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
            vLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
            // CAD-PARITY-011 (additive, Issue #97): the Archicad-class
            // authoring entity fields (validated strictly by the handler —
            // the schema is the coarse wire shape).
            ridgeAxis: { type: "string", enum: ["x", "y"] },
            topStoryId: { type: "string" },
            direction: { $ref: "#/$defs/vec2" },
            stepCount: { type: "integer", minimum: 2, maximum: 24 },
            tread: { type: "number", exclusiveMinimum: 0 },
            landingLength: { type: "number", minimum: 0 },
            side: { type: "string", enum: ["left", "right"] },
            spaceIds: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
            options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string" } },
            activeOption: { type: "string" },
            meta: {
              type: "object",
              properties: {
                classificationRef: { type: "string" },
                propertySets: {
                  type: "array",
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      properties: {
                        type: "array",
                        maxItems: 32,
                        items: {
                          type: "object",
                          properties: {
                            key: { type: "string" },
                            value: {},
                          },
                          required: ["key", "value"],
                        },
                      },
                    },
                    required: ["name", "properties"],
                  },
                },
                renovationStatus: { type: "string", enum: ["existing", "new", "to-be-demolished"] },
                optionGroupId: { type: "string" },
                option: { type: "string" },
              },
            },
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
  // CAD-PARITY-011 (additive, Issue #97): the meta/lifecycle command
  // surface — classification, structured property sets, renovation state,
  // design-option membership and the active option.
  "bim.setClassification": {
    type: "object",
    properties: {
      elementId: { type: "string" },
      classificationRef: { type: ["string", "null"] },
    },
    required: ["elementId", "classificationRef"],
  },
  "bim.setPropertySets": {
    type: "object",
    properties: {
      elementId: { type: "string" },
      propertySets: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            properties: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  value: {},
                },
                required: ["key", "value"],
              },
            },
          },
          required: ["name", "properties"],
        },
      },
    },
    required: ["elementId", "propertySets"],
  },
  "bim.setRenovation": {
    type: "object",
    properties: {
      elementId: { type: "string" },
      status: { type: "string", enum: ["existing", "new", "to-be-demolished"] },
    },
    required: ["elementId", "status"],
  },
  "bim.setOptionMembership": {
    type: "object",
    properties: {
      elementId: { type: "string" },
      optionGroupId: { type: ["string", "null"] },
      option: { type: ["string", "null"] },
    },
    required: ["elementId", "optionGroupId", "option"],
  },
  "bim.setActiveOption": {
    type: "object",
    properties: {
      optionGroupId: { type: "string" },
      option: { type: "string" },
    },
    required: ["optionGroupId", "option"],
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
            // CAD-PARITY-014 (additive, Issue #107): the camera viewpoint +
            // the source lineage (coarse wire shape — the handler validates
            // strictly; LOCK-007).
            viewpoint: {
              type: "object",
              properties: {
                cameraViewPoint: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                cameraDirection: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                cameraUpVector: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                orthogonal: { type: "boolean" },
                viewToWorldScale: { type: "number", exclusiveMinimum: 0 },
              },
              required: ["cameraViewPoint", "cameraDirection", "cameraUpVector"],
            },
            sourceRevision: { type: "string" },
          },
          required: ["title", "description"],
        },
      },
    },
    required: ["topics"],
  },
  // CAD-PARITY-014 (additive, Issue #107): the bounded DXF import (the
  // coarse wire shape — base64 of the ASCII DXF text; the handler guards
  // the DWG magic + parses + validates strictly).
  "dxf.import": {
    type: "object",
    properties: {
      dxf: { type: "string", minLength: 1 },
    },
    required: ["dxf"],
  },

  // --- CAD-PARITY-012 (additive, Issue #102): materials, grids and revision
  // clouds. Coarse wire shapes; the handlers validate strictly (the 8-value
  // category vocabulary, the lineweight range, the strictly-ascending u/v
  // line sets and the non-degenerate rectangle — LOCK-007 typed failures). ---
  "material.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      category: {
        type: "string",
        enum: ["Concrete", "Steel", "Masonry", "Timber", "Glass", "Insulation", "Finishes", "Generic"],
      },
      color: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3 },
      lineweight: { type: "number", minimum: 0.5, maximum: 8 },
      density: { type: "number", exclusiveMinimum: 0 },
      description: { type: "string" },
    },
    required: ["name", "category"],
  },
  "material.update": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1 },
          category: {
            type: "string",
            enum: ["Concrete", "Steel", "Masonry", "Timber", "Glass", "Insulation", "Finishes", "Generic"],
          },
          color: { type: ["array", "null"], items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3 },
          lineweight: { type: ["number", "null"], minimum: 0.5, maximum: 8 },
          density: { type: ["number", "null"], exclusiveMinimum: 0 },
          description: { type: ["string", "null"] },
        },
      },
    },
    required: ["elementId", "patch"],
  },
  "material.remove": {
    type: "object",
    properties: { elementId: { type: "string", minLength: 1 } },
    required: ["elementId"],
  },
  "material.assign": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      materialId: { type: ["string", "null"] },
    },
    required: ["ids", "materialId"],
  },
  "grid.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      storyId: { type: "string", minLength: 1 },
      uLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
      vLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
    },
    required: ["uLines", "vLines"],
  },
  "grid.update": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1 },
          uLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
          vLines: { type: "array", minItems: 1, maxItems: 64, items: { type: "number" } },
        },
      },
    },
    required: ["elementId", "patch"],
  },
  "revcloud.create": {
    type: "object",
    properties: {
      cornerA: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
      cornerB: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
      layer: { type: "string", minLength: 1 },
    },
    required: ["cornerA", "cornerB"],
  },

  // --- CAD-PARITY-013 (additive, Issue #104): the documentation production
  // commands (coarse wire shapes; the handlers validate strictly through the
  // shared document grammar — LOCK-007 typed failures). ---
  "navigator.createFolder": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      parentId: { type: ["string", "null"], minLength: 1 },
    },
    required: ["name"],
  },
  "navigator.createSubset": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      parentId: { type: ["string", "null"], minLength: 1 },
      prefix: { type: "string", minLength: 1, maxLength: 12 },
      numbering: { type: "string", enum: ["none", "custom"] },
      customNumber: { type: "string", minLength: 1, maxLength: 8 },
    },
    required: ["name"],
  },
  "navigator.removeNode": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  "titleblock.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      widthMm: { type: "number", minimum: 20, maximum: 500 },
      heightMm: { type: "number", minimum: 20, maximum: 300 },
      rowHeightMm: { type: "number", minimum: 4, maximum: 60 },
      rows: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            label: { type: "string", minLength: 1, maxLength: 40 },
            field: { type: "string", enum: ["layoutName", "sheetNumber", "revisions", "text"] },
            value: { type: "string", minLength: 1, maxLength: 80 },
          },
          required: ["label", "field"],
        },
      },
    },
    required: ["name", "widthMm", "heightMm", "rowHeightMm", "rows"],
  },
  "titleblock.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          widthMm: { type: "number", minimum: 20, maximum: 500 },
          heightMm: { type: "number", minimum: 20, maximum: 300 },
          rowHeightMm: { type: "number", minimum: 4, maximum: 60 },
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1, maxLength: 40 },
                field: { type: "string", enum: ["layoutName", "sheetNumber", "revisions", "text"] },
                value: { type: "string", minLength: 1, maxLength: 80 },
              },
              required: ["label", "field"],
            },
          },
        },
      },
    },
    required: ["id", "patch"],
  },
  "titleblock.remove": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  "schedule.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      source: {
        type: "string",
        enum: ["elements", "components", "materials", "views", "layouts", "sheets"],
      },
      filter: {
        type: "object",
        properties: {
          type: { type: "string", minLength: 1 },
          storyId: { type: "string", minLength: 1 },
        },
      },
      columns: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1, maxLength: 40 },
            // CAD-PARITY-015 (additive, Issue #110): the calculated-field
            // formula (calc:<name> columns only) + the deterministic
            // presentation format (any column).
            formula: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add", "sub", "mul", "div"] },
                left: { $ref: "#/$defs/scheduleOperand" },
                right: { $ref: "#/$defs/scheduleOperand" },
              },
              required: ["op", "left", "right"],
            },
            format: {
              type: "object",
              properties: {
                unit: { type: "string", minLength: 1, maxLength: 8 },
                align: { type: "string", enum: ["left", "right"] },
              },
            },
          },
          required: ["key", "label"],
        },
      },
      // CAD-PARITY-015 (additive, Issue #110): the optional deterministic
      // sort rules, grouping keys and property-driven filter conditions.
      sort: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1 },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["key", "direction"],
        },
      },
      grouping: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string", minLength: 1 },
      },
      conditions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            set: { type: "string", minLength: 1, maxLength: 64 },
            key: { type: "string", minLength: 1 },
            op: { type: "string", enum: ["eq", "ne", "gt", "lt", "contains"] },
            value: { type: ["string", "number", "boolean"] },
          },
          required: ["set", "key", "op", "value"],
        },
      },
    },
    required: ["name", "source", "columns"],
    $defs: {
      scheduleOperand: {
        oneOf: [
          {
            type: "object",
            properties: { column: { type: "string", minLength: 1 } },
            required: ["column"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  "schedule.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          source: {
            type: "string",
            enum: ["elements", "components", "materials", "views", "layouts", "sheets"],
          },
          filter: {
            type: ["object", "null"],
            properties: {
              type: { type: "string", minLength: 1 },
              storyId: { type: "string", minLength: 1 },
            },
          },
          columns: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                key: { type: "string", minLength: 1 },
                label: { type: "string", minLength: 1, maxLength: 40 },
                formula: {
                  type: "object",
                  properties: {
                    op: { type: "string", enum: ["add", "sub", "mul", "div"] },
                    left: { $ref: "#/$defs/scheduleOperand" },
                    right: { $ref: "#/$defs/scheduleOperand" },
                  },
                  required: ["op", "left", "right"],
                },
                format: {
                  type: "object",
                  properties: {
                    unit: { type: "string", minLength: 1, maxLength: 8 },
                    align: { type: "string", enum: ["left", "right"] },
                  },
                },
              },
              required: ["key", "label"],
            },
          },
          // CAD-PARITY-015 (additive, Issue #110).
          sort: {
            type: ["array", "null"],
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                key: { type: "string", minLength: 1 },
                direction: { type: "string", enum: ["asc", "desc"] },
              },
              required: ["key", "direction"],
            },
          },
          grouping: { type: ["array", "null"], minItems: 1, maxItems: 3, items: { type: "string", minLength: 1 } },
          conditions: {
            type: ["array", "null"],
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                set: { type: "string", minLength: 1, maxLength: 64 },
                key: { type: "string", minLength: 1 },
                op: { type: "string", enum: ["eq", "ne", "gt", "lt", "contains"] },
                value: { type: ["string", "number", "boolean"] },
              },
              required: ["set", "key", "op", "value"],
            },
          },
        },
      },
    },
    $defs: {
      scheduleOperand: {
        oneOf: [
          {
            type: "object",
            properties: { column: { type: "string", minLength: 1 } },
            required: ["column"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["id", "patch"],
  },
  "schedule.remove": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  // --- CAD-PARITY-015 (additive, Issue #110): the property-definition
  // registry command payloads. ---
  "property.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      set: { type: "string", minLength: 1, maxLength: 64 },
      key: { type: "string", minLength: 1 },
      type: { type: "string", enum: ["text", "number", "boolean"] },
      unit: { type: "string", minLength: 1, maxLength: 16 },
      appliesTo: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1 } },
    },
    required: ["name", "set", "key", "type"],
  },
  "property.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          set: { type: "string", minLength: 1, maxLength: 64 },
          key: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["text", "number", "boolean"] },
          unit: { type: ["string", "null"], minLength: 1, maxLength: 16 },
          appliesTo: { type: ["array", "null"], minItems: 1, maxItems: 12, items: { type: "string", minLength: 1 } },
        },
      },
    },
    required: ["id", "patch"],
  },
  "property.remove": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  "revision.add": {
    type: "object",
    properties: {
      code: { type: "string", minLength: 1, maxLength: 12 },
      description: { type: "string", maxLength: 200 },
      issued: { type: "boolean" },
      layoutIds: { type: "array", items: { type: "string", minLength: 1 } },
    },
    required: ["code"],
  },
  "revision.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          code: { type: "string", minLength: 1, maxLength: 12 },
          description: { type: "string", maxLength: 200 },
          issued: { type: "boolean" },
          layoutIds: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
    required: ["id", "patch"],
  },
  "revision.remove": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  "publisher.create": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["layout", "subset"] },
            id: { type: "string", minLength: 1 },
            format: { type: "string", enum: ["pdf", "svg", "plot-ir"] },
          },
          required: ["kind", "id", "format"],
        },
      },
    },
    required: ["name", "items"],
  },
  "publisher.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["layout", "subset"] },
                id: { type: "string", minLength: 1 },
                format: { type: "string", enum: ["pdf", "svg", "plot-ir"] },
              },
              required: ["kind", "id", "format"],
            },
          },
        },
      },
    },
    required: ["id", "patch"],
  },
  "publisher.remove": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  "publisher.run": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  "layout.update": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        minProperties: 1,
        properties: {
          subsetId: { type: ["string", "null"], minLength: 1 },
          masterId: { type: ["string", "null"], minLength: 1 },
          titleBlockPlacement: {
            type: ["object", "null"],
            properties: {
              titleBlockId: { type: "string", minLength: 1 },
              xMm: { type: "number" },
              yMm: { type: "number" },
            },
            required: ["titleBlockId", "xMm", "yMm"],
          },
          revisionIds: {
            type: ["array", "null"],
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    required: ["patch"],
  },
  // --- CAD-PARITY-016 (additive, Issue #112): the collaboration/recovery/
  // scale command payloads. ---
  "recovery.checkpoint": { type: "object", properties: {} },
  "recovery.restore": {
    type: "object",
    properties: {
      checkpointId: { type: "string", minLength: 1 },
    },
  },
  "recovery.autosave": { type: "object", properties: {} },
  "collab.join": {
    type: "object",
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      role: { type: "string", enum: ["viewer", "commenter", "editor"] },
    },
    required: ["userId", "role"],
  },
  "collab.presence": {
    type: "object",
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
    },
    required: ["userId"],
  },
  "collab.comment": {
    type: "object",
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      body: { type: "string", minLength: 1, maxLength: 500 },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["document", "element", "revision"] },
          id: { type: "string", minLength: 1 },
          revisionRef: { type: "string", minLength: 1 },
        },
        required: ["kind"],
      },
    },
    required: ["userId", "body"],
  },
  "collab.resolveComment": {
    type: "object",
    properties: {
      commentId: { type: "string", minLength: 1 },
      userId: { type: "string", minLength: 1, maxLength: 64 },
    },
    required: ["commentId", "userId"],
  },
  "collab.commit": {
    type: "object",
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      baseVersion: { type: "integer", minimum: 0 },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["addElement", "removeElement", "updateElement", "setProps"],
            },
            elementId: { type: "string", minLength: 1 },
            element: { type: "object" },
            patch: { type: "object" },
          },
          required: ["type"],
        },
      },
    },
    required: ["userId", "baseVersion", "edits"],
  },
  "collab.merge": {
    type: "object",
    properties: {
      transactionId: { type: "string", minLength: 1 },
      userId: { type: "string", minLength: 1, maxLength: 64 },
      strategy: { type: "string", enum: ["rebase", "discard"] },
    },
    required: ["transactionId", "userId", "strategy"],
  },
  "jobs.create": {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["docs.regenerate", "quantity.recalculate", "model.stream.warm"] },
      params: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["elements", "components", "materials"] },
          groupBy: { type: "string", enum: ["none", "type", "story", "material"] },
          pageSize: { type: "integer", minimum: 10, maximum: 500 },
        },
      },
    },
    required: ["kind"],
  },
  "jobs.tick": {
    type: "object",
    properties: {
      jobId: { type: "string", minLength: 1 },
    },
    required: ["jobId"],
  },
  // --- CAD-PARITY-017 (additive, Issue #116): the automation/extension
  // API command payloads (coarse wire shapes; the handlers + the
  // automation core validate strictly with typed declines). ---
  "automation.authenticate": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
      role: { type: "string", enum: ["viewer", "commenter", "editor"] },
    },
    required: ["principalId", "role"],
  },
  "automation.registerScript": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
      script: { type: "object" },
    },
    required: ["principalId", "script"],
  },
  "automation.runScript": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
      scriptId: { type: "string", minLength: 1 },
    },
    required: ["principalId", "scriptId"],
  },
  "automation.deleteScript": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
      scriptId: { type: "string", minLength: 1 },
    },
    required: ["principalId", "scriptId"],
  },
  "automation.subscribe": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
      scope: { type: "string", enum: ["document", "project", "jobs"] },
      kinds: { type: "array", minItems: 1, items: { type: "string" } },
    },
    required: ["principalId", "scope"],
  },
  "automation.unsubscribe": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
      subscriptionId: { type: "string", minLength: 1 },
    },
    required: ["principalId", "subscriptionId"],
  },
  "automation.registerExtension": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
      extension: { type: "object" },
    },
    required: ["principalId", "extension"],
  },
  // --- CAD-PARITY-018 (additive, Issue #118): the specialized-toolsets
  // API command payloads (coarse wire shapes; the handlers + the toolsets
  // core validate strictly with typed declines). ---
  "toolset.archWallRun": {
    type: "object",
    properties: {
      storyId: { type: "string", minLength: 1 },
      polyline: {
        type: "array",
        minItems: 2,
        maxItems: 64,
        items: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
        },
      },
      widthMm: { type: "number", exclusiveMinimum: 0 },
      heightMm: { type: "number", exclusiveMinimum: 0 },
      name: { type: "string", minLength: 1, maxLength: 48 },
      junctions: { type: "string", enum: ["none", "openings"] },
    },
    required: ["storyId", "polyline", "widthMm", "heightMm"],
  },
  "toolset.archHostedOpening": {
    type: "object",
    properties: {
      wallId: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["door", "window"] },
      tAlongWall: { type: "number", minimum: 0 },
      widthMm: { type: "number", exclusiveMinimum: 0 },
      heightMm: { type: "number", exclusiveMinimum: 0 },
      sillMm: { type: "number", minimum: 0 },
      swing: { type: "string", enum: ["left", "right"] },
      name: { type: "string", minLength: 1, maxLength: 48 },
    },
    required: ["wallId", "kind", "tAlongWall", "widthMm", "heightMm"],
  },
  "toolset.archRoof": {
    type: "object",
    properties: {
      storyId: { type: "string", minLength: 1 },
      corner1: { type: "object" },
      corner2: { type: "object" },
      ridgeAxis: { type: "string", enum: ["x", "y"] },
      heightMm: { type: "number", exclusiveMinimum: 0 },
      baseOffsetMm: { type: "number", minimum: 0 },
      topStoryId: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1, maxLength: 48 },
    },
    required: ["storyId", "corner1", "corner2", "heightMm"],
  },
  "toolset.archStairRun": {
    type: "object",
    properties: {
      storyId: { type: "string", minLength: 1 },
      topStoryId: { type: "string", minLength: 1 },
      start: { type: "object" },
      directionDeg: { type: "number", minimum: 0 },
      widthMm: { type: "number", exclusiveMinimum: 0 },
      stepCount: { type: "integer", minimum: 2, maximum: 24 },
      treadMm: { type: "number", exclusiveMinimum: 0 },
      baseOffsetMm: { type: "number", minimum: 0 },
      landingLengthMm: { type: "number", minimum: 0 },
      railings: { type: "string", enum: ["none", "left", "right", "both"] },
      handrailHeightMm: { type: "number", exclusiveMinimum: 0 },
      name: { type: "string", minLength: 1, maxLength: 48 },
    },
    required: ["storyId", "topStoryId", "start", "widthMm", "stepCount", "treadMm"],
  },
  "toolset.archSpaceGrid": {
    type: "object",
    properties: {
      storyId: { type: "string", minLength: 1 },
      origin: { type: "object" },
      cols: { type: "integer", minimum: 1, maximum: 32 },
      rows: { type: "integer", minimum: 1, maximum: 32 },
      cellWidthMm: { type: "number", exclusiveMinimum: 0 },
      cellHeightMm: { type: "number", exclusiveMinimum: 0 },
      prefix: { type: "string", minLength: 1, maxLength: 32 },
      heightMm: { type: "number", exclusiveMinimum: 0 },
      baseOffsetMm: { type: "number", minimum: 0 },
    },
    required: ["storyId", "origin", "cols", "rows", "cellWidthMm", "cellHeightMm"],
  },
  "toolset.archDimChain": {
    type: "object",
    properties: {
      points: {
        type: "array",
        minItems: 2,
        maxItems: 128,
        items: { type: "object" },
      },
      offsetMm: { type: "number" },
      layer: { type: "string", minLength: 1, maxLength: 32 },
    },
    required: ["points"],
  },
  "toolset.archComponentArray": {
    type: "object",
    properties: {
      definitionId: { type: "string", minLength: 1 },
      storyId: { type: "string", minLength: 1 },
      origin: { type: "object" },
      cols: { type: "integer", minimum: 1, maximum: 32 },
      rows: { type: "integer", minimum: 1, maximum: 32 },
      dxMm: { type: "number", minimum: 0 },
      dyMm: { type: "number", minimum: 0 },
      rotation: { type: "number", minimum: 0 },
      baseOffsetMm: { type: "number", minimum: 0 },
      namePrefix: { type: "string", minLength: 1, maxLength: 32 },
    },
    required: ["definitionId", "storyId", "origin", "cols", "rows", "dxMm", "dyMm"],
  },
  "toolset.mepAddRun": {
    type: "object",
    properties: {
      run: { type: "object" },
    },
    required: ["run"],
  },
  "toolset.mepSetRun": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      run: { type: "object" },
    },
    required: ["id", "run"],
  },
  "toolset.mepRemoveRun": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
    },
    required: ["id"],
  },
  "toolset.mepConnect": {
    type: "object",
    properties: {
      runId: { type: "string", minLength: 1 },
      at: { type: "string", enum: ["start", "end"] },
      target: { type: "object" },
    },
    required: ["runId", "at", "target"],
  },
  "toolset.mechAddEquipment": {
    type: "object",
    properties: {
      equipment: { type: "object" },
    },
    required: ["equipment"],
  },
  "toolset.mechSetEquipment": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      equipment: { type: "object" },
    },
    required: ["id", "equipment"],
  },
  "toolset.mechRemoveEquipment": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
    },
    required: ["id"],
  },
  "toolset.mechArray": {
    type: "object",
    properties: {
      equipmentId: { type: "string", minLength: 1 },
      cols: { type: "integer", minimum: 1, maximum: 32 },
      rows: { type: "integer", minimum: 1, maximum: 32 },
      dxMm: { type: "number" },
      dyMm: { type: "number" },
    },
    required: ["equipmentId", "cols", "rows", "dxMm", "dyMm"],
  },
  "toolset.rasterAddSource": {
    type: "object",
    properties: {
      source: { type: "object" },
    },
    required: ["source"],
  },
  "toolset.rasterAttach": {
    type: "object",
    properties: {
      reference: { type: "object" },
    },
    required: ["reference"],
  },
  "toolset.rasterSetReference": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      reference: { type: "object" },
    },
    required: ["id", "reference"],
  },
  "toolset.rasterRemoveReference": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
    },
    required: ["id"],
  },
  "toolset.rasterCommitTrace": {
    type: "object",
    properties: {
      referenceId: { type: "string", minLength: 1 },
      vectorIndices: { type: "array", minItems: 1, items: { type: "integer", minimum: 0 } },
    },
    required: ["referenceId"],
  },
  // --- COMPAT-CAD-004 (additive, Issue #121): the bounded consolidated
  // parametrics/associative/patterns commands. ---
  "pattern.mirror": {
    type: "object",
    properties: {
      ids: { type: "array", minItems: 1, maxItems: 256, items: { type: "string", minLength: 1 } },
      p1: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
      p2: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
      eraseSource: { type: "boolean" },
    },
    required: ["ids", "p1", "p2", "eraseSource"],
  },
  "assoc.refresh": { type: "object", properties: {} },
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
  // CAD-PARITY-011 (additive, Issue #97): the classification/options/
  // lifecycle queries.
  "bim.getClassification": { type: "object", properties: {} },
  "bim.getOptions": { type: "object", properties: {} },
  "bim.getLifecycle": {
    type: "object",
    properties: {
      elementId: { type: "string" },
    },
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
      format: { type: "string", enum: ["sheet-ir", "pdf", "svg", "dwg"] },
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
  // CAD-PARITY-007 (additive): the constraints inventory + diagnostics.
  "constraints.list": { type: "object", properties: {} },
  "constraints.diagnostics": { type: "object", properties: {} },
  // CAD-PARITY-008 (additive): the layout inventory + the plot preview.
  "layouts.list": { type: "object", properties: {} },
  "plot.preview": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
  },
  // CAD-PARITY-009 (additive): the 3D navigation/UCS/modeling queries.
  "ucs.list": { type: "object", properties: {} },
  "view3d.state": { type: "object", properties: {} },
  "model3d.pick": {
    type: "object",
    properties: {
      screenX: { type: "number" },
      screenY: { type: "number" },
      viewport: {
        type: "object",
        properties: {
          width: { type: "number", exclusiveMinimum: 0 },
          height: { type: "number", exclusiveMinimum: 0 },
        },
        required: ["width", "height"],
      },
      subEntity: { type: "boolean" },
      // CAD-PARITY-010 (additive): the per-element topology-aware pick — name
      // the solid (and optionally filter the kind: face/edge/vertex).
      elementId: { type: "string", minLength: 1 },
      subEntityKind: { type: "string", enum: ["face", "edge", "vertex"] },
      tolerance: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["screenX", "screenY", "viewport"],
  },
  "model3d.sectionPreview": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      exact: { type: "boolean" },
    },
  },
  "model3d.mesh": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
      // CAD-PARITY-010 (additive): the closed LOD preset vocabulary — when
      // present the mesh is served at that quality through the bounded
      // revision-tied cache (progressive delivery).
      quality: { type: "string", enum: ["low", "medium", "full"] },
    },
    required: ["elementId"],
  },
  // CAD-PARITY-010 (additive): the exact-section, topology and cache-evidence
  // queries.
  "model3d.section": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      elementId: { type: "string", minLength: 1 },
    },
  },
  "model3d.topology": {
    type: "object",
    properties: {
      elementId: { type: "string", minLength: 1 },
    },
    required: ["elementId"],
  },
  "model3d.cacheStats": { type: "object", properties: {} },
  // --- CAD-PARITY-012 (additive, Issue #102): the components/materials/
  // coordination read surfaces (computed fresh, no payload). ---
  "components.list": { type: "object", properties: {} },
  "materials.list": { type: "object", properties: {} },
  "materials.bom": { type: "object", properties: {} },
  "grids.list": { type: "object", properties: {} },
  "coordination.clash": { type: "object", properties: {} },
  // --- CAD-PARITY-013 (additive, Issue #104): the documentation production
  // read surfaces (non-mutating, computed fresh). ---
  "navigator.tree": { type: "object", properties: {} },
  "schedules.list": { type: "object", properties: {} },
  // --- CAD-PARITY-015 (additive, Issue #110): the properties/quantities
  // query payloads. ---
  "properties.list": { type: "object", properties: {} },
  "quantities.run": {
    type: "object",
    properties: {
      source: { type: "string", enum: ["elements", "components", "materials"] },
      groupBy: { type: "string", enum: ["none", "type", "story", "material"] },
      filter: {
        type: "object",
        properties: {
          type: { type: "string", minLength: 1 },
          storyId: { type: "string", minLength: 1 },
        },
      },
    },
    required: ["source"],
  },
  "quantities.rules": { type: "object", properties: {} },
  "schedules.run": {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
  },
  "revisions.list": { type: "object", properties: {} },
  "publisher.list": { type: "object", properties: {} },
  "docs.exchangeReport": { type: "object", properties: {} },
  // CAD-PARITY-014 (additive, Issue #107): the file-interoperability read
  // surfaces (coarse wire shapes; the handlers validate strictly).
  "dxf.export": { type: "object", properties: {} },
  "interop.exchangeReport": { type: "object", properties: {} },
  "interop.archivalList": { type: "object", properties: {} },
  "interop.roundtripReport": {
    type: "object",
    properties: {
      format: { type: "string", enum: ["ifc", "dxf"] },
    },
    required: ["format"],
  },
  // CAD-PARITY-018 (additive, Issue #118 criterion 14 — the corrective
  // interop coverage): the specialized-toolsets typed-outcome report (no
  // payload — a pure classification over the current document state).
  "interop.toolsetsReport": { type: "object", properties: {} },
  // --- CAD-PARITY-016 (additive, Issue #112): the collaboration/recovery/
  // scale query payloads. ---
  "recovery.list": { type: "object", properties: {} },
  "collab.state": { type: "object", properties: {} },
  "collab.comments": { type: "object", properties: {} },
  "collab.activity": { type: "object", properties: {} },
  "collab.transactions": { type: "object", properties: {} },
  "jobs.list": { type: "object", properties: {} },
  "jobs.get": {
    type: "object",
    properties: {
      jobId: { type: "string", minLength: 1 },
    },
    required: ["jobId"],
  },
  "model.stream": {
    type: "object",
    properties: {
      pageIndex: { type: "integer", minimum: 0 },
      pageSize: { type: "integer", minimum: 10, maximum: 500 },
    },
    required: ["pageIndex"],
  },
  "model.streamStats": { type: "object", properties: {} },
  "xrefs.status": { type: "object", properties: {} },
  "xrefs.probe": {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      sourceHash: { type: "string", minLength: 1 },
    },
    required: ["name", "sourceHash"],
  },
  "perf.budgets": { type: "object", properties: {} },
  // --- CAD-PARITY-017 (additive, Issue #116): the automation/extension
  // API query payloads. ---
  "automation.capabilities": { type: "object", properties: {} },
  "automation.principals": { type: "object", properties: {} },
  "automation.scripts": { type: "object", properties: {} },
  "automation.runs": { type: "object", properties: {} },
  "automation.events": {
    type: "object",
    properties: {
      principalId: { type: "string", minLength: 1, maxLength: 64 },
    },
    required: ["principalId"],
  },
  "automation.extensions": { type: "object", properties: {} },
  // --- CAD-PARITY-018 (additive, Issue #118): the specialized-toolsets
  // API query payloads. ---
  "toolset.capabilities": { type: "object", properties: {} },
  "toolset.listRecords": {
    type: "object",
    properties: {
      toolset: { type: "string", enum: ["mep", "mechanical", "raster"] },
      kind: { type: "string", enum: ["mep.run", "mech.equipment", "raster.source", "raster.reference"] },
    },
  },
  "toolset.mepValidateRoute": {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
    },
    required: ["id"],
  },
  "toolset.mepClashReport": {
    type: "object",
    properties: {
      clearanceMm: { type: "number", minimum: 0 },
    },
  },
  "toolset.rasterStatus": { type: "object", properties: {} },
  "toolset.rasterTrace": {
    type: "object",
    properties: {
      referenceId: { type: "string", minLength: 1 },
    },
    required: ["referenceId"],
  },
  // --- COMPAT-CAD-004 (additive, Issue #121): the bounded consolidated
  // parametrics/associative/patterns queries. ---
  "parametrics.capabilities": { type: "object", properties: {} },
  "assoc.report": { type: "object", properties: {} },
  // CAD-PARITY-019 rev 2 (additive, the architect review on PR #125): the
  // certification corpus catalog (no payload — pure derived data over the
  // version-pinned corpus).
  "certification.corpusCatalog": { type: "object", properties: {} },
  // CAD-PARITY-020 (additive, Issue #123): the derived ARCHICAD corpus
  // catalog (no payload — pure derived data over the version-pinned
  // Archicad-class corpus).
  "certification.archicadCatalog": { type: "object", properties: {} },
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
