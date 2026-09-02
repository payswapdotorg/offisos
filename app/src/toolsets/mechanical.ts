/**
 * CAD-PARITY-018 (Issue #118) — the mechanical toolset: the deterministic
 * equipment array/pattern composition over the equipment record grammar.
 * Engine-free (LOCK-018), pure data: every cell offset (and every port
 * position offset — ports move WITH the equipment) is a fixed formula.
 */

import {
  TOOLSETS_MAX_ARRAY_CELLS,
  TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS,
  type MechEquipmentData,
} from "../contracts/toolsets.js";
import { toolsetErr } from "./errors.js";

/** Compose a rectangular equipment array: cells at origin +
 *  (col−1)·dxMm, (row−1)·dyMm (1-based, row-major order); the equipment
 *  ORIGIN and every PORT POSITION of cell (col, row) are offset by the
 *  same cell delta (ports move with the equipment). Names carry the
 *  deterministic `-<col>-<row>` suffix when the base equipment is named;
 *  port ids stay the ordinal p1..pN grammar. */
export function buildEquipmentArray(
  equipment: MechEquipmentData,
  cols: number,
  rows: number,
  dxMm: number,
  dyMm: number,
): MechEquipmentData[] {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw toolsetErr("toolset_bad_payload", "equipment array cols/rows must be integers ≥ 1");
  }
  if (cols > TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS || rows > TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `equipment array exceeds the ${TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS}-per-axis bound (got ${cols}×${rows})`,
    );
  }
  if (cols * rows > TOOLSETS_MAX_ARRAY_CELLS) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `equipment array exceeds the ${TOOLSETS_MAX_ARRAY_CELLS}-cell bound (got ${cols * rows})`,
    );
  }
  if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm)) {
    throw toolsetErr("toolset_bad_payload", "equipment array dxMm/dyMm must be finite numbers");
  }
  const out: MechEquipmentData[] = [];
  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      const dx = (col - 1) * dxMm;
      const dy = (row - 1) * dyMm;
      out.push({
        ...equipment,
        ...(equipment.name !== undefined ? { name: `${equipment.name}-${col}-${row}` } : {}),
        origin: {
          x: equipment.origin.x + dx,
          y: equipment.origin.y + dy,
          z: equipment.origin.z,
        },
        ports: equipment.ports.map((port) => ({
          ...port,
          position: {
            x: port.position.x + dx,
            y: port.position.y + dy,
            z: port.position.z,
          },
        })),
      });
    }
  }
  return out;
}
