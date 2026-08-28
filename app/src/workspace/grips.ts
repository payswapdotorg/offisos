/**
 * CAD-PARITY-002 grip system (Issue #75; CAD-P-004 "grips and contextual
 * editing", CAD-UX-003 contextual editing parity).
 *
 * Grips are the drag handles of a SELECTED entity: endpoints/vertices for
 * lines/polylines/walls, corners for rectangles/slabs, center + radius for
 * circles/arcs, plus one MOVE grip (drag the whole entity). Pure and
 * deterministic: gripsFor maps an element to its handles; gripDrag maps a
 * dragged handle to App API commands (stretch grips re-validate the entity
 * through the canonical strict constructors — never a raw unvalidated props
 * patch; move grips reuse the versioned drafting.move / bim.move commands).
 */

import type { Element } from "../contracts/caddocument.js";
import { makeArc, makeCircle, makeLine, makePolyline, makeRectangle } from "../drafting/entities.js";
import type { Vec2 } from "../drafting/precision.js";
import type { AppApiCommandPlanEntry } from "./types.js";

export interface GripHandle {
  readonly id: string;
  readonly kind: "stretch" | "move" | "radius";
  readonly point: Vec2;
  readonly label: string;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function vec(v: unknown): Vec2 | null {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [v[0], v[1]];
  }
  return null;
}

/** The pickable drag handles of one element (empty for unsupported kinds). */
export function gripsFor(el: Element): readonly GripHandle[] {
  const props = el.props as Record<string, unknown>;
  const grips: GripHandle[] = [];

  if (el.kind === "geometry" && props.drafting === true) {
    switch (props.type) {
      case "line": {
        const from = vec(props.from);
        const to = vec(props.to);
        if (from !== null) grips.push({ id: "from", kind: "stretch", point: from, label: "start" });
        if (to !== null) grips.push({ id: "to", kind: "stretch", point: to, label: "end" });
        if (from !== null && to !== null) {
          grips.push({ id: "move", kind: "move", point: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], label: "move" });
        }
        break;
      }
      case "polyline": {
        const points = Array.isArray(props.points) ? props.points : [];
        points.forEach((p, i) => {
          const v = vec(p);
          if (v !== null) grips.push({ id: `v${i}`, kind: "stretch", point: v, label: `vertex ${i + 1}` });
        });
        break;
      }
      case "circle": {
        const center = vec(props.center);
        const radius = num(props.radius);
        if (center !== null && radius !== null) {
          grips.push({ id: "center", kind: "stretch", point: center, label: "center" });
          grips.push({ id: "radius-e", kind: "radius", point: [center[0] + radius, center[1]], label: "radius" });
          grips.push({ id: "radius-w", kind: "radius", point: [center[0] - radius, center[1]], label: "radius" });
          grips.push({ id: "radius-n", kind: "radius", point: [center[0], center[1] + radius], label: "radius" });
          grips.push({ id: "radius-s", kind: "radius", point: [center[0], center[1] - radius], label: "radius" });
        }
        break;
      }
      case "arc": {
        const center = vec(props.center);
        const radius = num(props.radius);
        const startAngle = num(props.startAngle);
        const endAngle = num(props.endAngle);
        if (center !== null && radius !== null && startAngle !== null && endAngle !== null) {
          grips.push({ id: "center", kind: "stretch", point: center, label: "center" });
          grips.push({
            id: "start",
            kind: "stretch",
            point: [center[0] + radius * Math.cos(startAngle), center[1] + radius * Math.sin(startAngle)],
            label: "start",
          });
          grips.push({
            id: "end",
            kind: "stretch",
            point: [center[0] + radius * Math.cos(endAngle), center[1] + radius * Math.sin(endAngle)],
            label: "end",
          });
        }
        break;
      }
      case "rectangle": {
        const corner1 = vec(props.corner1);
        const corner2 = vec(props.corner2);
        if (corner1 !== null) grips.push({ id: "corner1", kind: "stretch", point: corner1, label: "corner 1" });
        if (corner2 !== null) grips.push({ id: "corner2", kind: "stretch", point: corner2, label: "corner 2" });
        if (corner1 !== null && corner2 !== null) {
          grips.push({ id: "move", kind: "move", point: [(corner1[0] + corner2[0]) / 2, (corner1[1] + corner2[1]) / 2], label: "move" });
        }
        break;
      }
      default:
        break;
    }
    return grips;
  }

  if (el.kind === "bim" && props.type === "bim.wall") {
    const start = vec(props.start);
    const end = vec(props.end);
    if (start !== null) grips.push({ id: "start", kind: "stretch", point: start, label: "wall start" });
    if (end !== null) grips.push({ id: "end", kind: "stretch", point: end, label: "wall end" });
    if (start !== null && end !== null) {
      grips.push({ id: "move", kind: "move", point: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2], label: "move wall" });
    }
    return grips;
  }

  if (el.kind === "bim" && props.type === "bim.slab") {
    const corner1 = vec(props.corner1);
    const corner2 = vec(props.corner2);
    if (corner1 !== null) grips.push({ id: "corner1", kind: "stretch", point: corner1, label: "slab corner 1" });
    if (corner2 !== null) grips.push({ id: "corner2", kind: "stretch", point: corner2, label: "slab corner 2" });
    return grips;
  }

  return grips;
}

export interface GripEditResult {
  readonly appApi: readonly AppApiCommandPlanEntry[];
  readonly echo: readonly string[];
}

/**
 * Map a dragged grip to App API commands. Stretch/radius grips re-validate
 * through the canonical strict constructors (LOCK-007 — malformed results
 * throw instead of silently patching); the MOVE grip emits a versioned
 * transform command.
 */
export function gripDrag(el: Element, gripId: string, to: Vec2): GripEditResult | null {
  const props = el.props as Record<string, unknown>;

  if (el.kind === "geometry" && props.drafting === true) {
    const layer = typeof props.layer === "string" ? props.layer : "0";
    switch (props.type) {
      case "line": {
        if (gripId === "move") {
          return moveResult(el, to);
        }
        const from = vec(props.from);
        const to0 = vec(props.to);
        if (from === null || to0 === null) return null;
        const newFrom = gripId === "from" ? to : from;
        const newTo = gripId === "to" ? to : to0;
        const validated = makeLine({ type: "line", layer, from: [...newFrom], to: [...newTo] });
        return {
          appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
          echo: [`STRETCH: line '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
        };
      }
      case "polyline": {
        const points = Array.isArray(props.points) ? props.points.map((p) => vec(p)) : [];
        const closed = props.closed === true;
        const index = Number(gripId.slice(1));
        if (!Number.isInteger(index) || index < 0 || index >= points.length || points.some((p) => p === null)) return null;
        const newPoints = points.map((p, i) => (i === index ? [...to] : [...(p as Vec2)])) as Vec2[];
        const validated = makePolyline({ type: "polyline", layer, points: newPoints, closed });
        return {
          appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
          echo: [`STRETCH: polyline '${el.id}' vertex ${index + 1} → (${to[0]},${to[1]}).`],
        };
      }
      case "circle": {
        const center = vec(props.center);
        if (center === null) return null;
        if (gripId === "center") {
          const radius = num(props.radius);
          if (radius === null) return null;
          const validated = makeCircle({ type: "circle", layer, center: [...to], radius });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: circle '${el.id}' center → (${to[0]},${to[1]}).`],
          };
        }
        if (gripId.startsWith("radius")) {
          const radius = Math.hypot(to[0] - center[0], to[1] - center[1]);
          if (!(radius > 0)) return { appApi: [], echo: ["STRETCH: circle radius must be positive — grip edit rejected."] };
          const validated = makeCircle({ type: "circle", layer, center: [...center], radius });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: circle '${el.id}' radius → ${radius}.`],
          };
        }
        return null;
      }
      case "arc": {
        const center = vec(props.center);
        const radius = num(props.radius);
        const startAngle = num(props.startAngle);
        const endAngle = num(props.endAngle);
        if (center === null || radius === null || startAngle === null || endAngle === null) return null;
        if (gripId === "center") {
          const validated = makeArc({ type: "arc", layer, center: [...to], radius, startAngle, endAngle });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: arc '${el.id}' center → (${to[0]},${to[1]}).`],
          };
        }
        if (gripId === "start" || gripId === "end") {
          const newAngle = Math.atan2(to[1] - center[1], to[0] - center[0]);
          const newStart = gripId === "start" ? newAngle : startAngle;
          let newEnd = gripId === "end" ? newAngle : endAngle;
          if (newEnd <= newStart) newEnd += 2 * Math.PI;
          const validated = makeArc({ type: "arc", layer, center: [...center], radius, startAngle: newStart, endAngle: newEnd });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: arc '${el.id}' ${gripId} angle → ${((newAngle * 180) / Math.PI).toFixed(1)}°.`],
          };
        }
        return null;
      }
      case "rectangle": {
        if (gripId === "move") {
          return moveResult(el, to);
        }
        const corner1 = vec(props.corner1);
        const corner2 = vec(props.corner2);
        if (corner1 === null || corner2 === null) return null;
        const newCorner1 = gripId === "corner1" ? to : corner1;
        const newCorner2 = gripId === "corner2" ? to : corner2;
        const validated = makeRectangle({ type: "rectangle", layer, corner1: [...newCorner1], corner2: [...newCorner2] });
        return {
          appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
          echo: [`STRETCH: rectangle '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
        };
      }
      default:
        return null;
    }
  }

  if (el.kind === "bim" && props.type === "bim.wall") {
    if (gripId === "move") {
      return moveResult(el, to);
    }
    const start = vec(props.start);
    const end = vec(props.end);
    const storyId = props.storyId;
    const width = num(props.width);
    const height = num(props.height);
    if (start === null || end === null || typeof storyId !== "string" || width === null || height === null) return null;
    const patch: Record<string, unknown> =
      gripId === "start"
        ? { start: [...to], end: [...end] }
        : { start: [...start], end: [...to] };
    // Validate through bim.setProperties semantics (the App API re-validates
    // the resulting entity — LOCK-007).
    return {
      appApi: [{ name: "bim.setProperties", payload: { elementId: el.id, patch } }],
      echo: [`STRETCH: wall '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
    };
  }

  if (el.kind === "bim" && props.type === "bim.slab") {
    const corner1 = vec(props.corner1);
    const corner2 = vec(props.corner2);
    if (corner1 === null || corner2 === null) return null;
    const patch: Record<string, unknown> =
      gripId === "corner1"
        ? { corner1: [...to], corner2: [...corner2] }
        : { corner1: [...corner1], corner2: [...to] };
    return {
      appApi: [{ name: "bim.setProperties", payload: { elementId: el.id, patch } }],
      echo: [`STRETCH: slab '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
    };
  }

  return null;
}

function moveResult(el: Element, to: Vec2): GripEditResult | null {
  const props = el.props as Record<string, unknown>;
  let center: Vec2 | null = null;
  if (el.kind === "geometry" && props.type === "line") {
    const from = vec(props.from);
    const end = vec(props.to);
    if (from !== null && end !== null) center = [(from[0] + end[0]) / 2, (from[1] + end[1]) / 2];
  } else if (el.kind === "geometry" && props.type === "rectangle") {
    const corner1 = vec(props.corner1);
    const corner2 = vec(props.corner2);
    if (corner1 !== null && corner2 !== null) center = [(corner1[0] + corner2[0]) / 2, (corner1[1] + corner2[1]) / 2];
  } else if (el.kind === "bim" && props.type === "bim.wall") {
    const start = vec(props.start);
    const end = vec(props.end);
    if (start !== null && end !== null) center = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  }
  if (center === null) return null;
  const dx = to[0] - center[0];
  const dy = to[1] - center[1];
  if (el.kind === "bim") {
    return {
      appApi: [{ name: "bim.move", payload: { ids: [el.id], dx, dy, dz: 0 } }],
      echo: [`MOVE: '${el.id}' by (${dx},${dy}).`],
    };
  }
  return {
    appApi: [{ name: "drafting.move", payload: { ids: [el.id], dx, dy } }],
    echo: [`MOVE: '${el.id}' by (${dx},${dy}).`],
  };
}
