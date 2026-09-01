/**
 * CAD-PARITY-015 (Issue #110) — Web/Electron host parity for the
 * schedules/indexes/properties/quantity workflows (§5.5, LOCK-004/017;
 * mirrors docs-host-parity).
 *
 * The SAME schedules/properties/quantities command sequence through the
 * Web Host (WebSocketTransport) and the Electron Host (IpcTransport)
 * produces identical semantic results: the minted ids, the property
 * lineage statistics, the schedule run rows/groups/totals/sha256 and the
 * revision-bound quantity takeoff report (rows, subtotals, totals, BOM,
 * skipped, reportSha256 and the RevisionRef binding). Each host drives
 * its OWN handler + bundle instance through its REAL transport.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "p015-parity",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p015-parity",
};

type Renderer = ReturnType<typeof createRenderer>;

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

async function c(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.execute({ type: "command", name: name as never, payload });
}
async function qq(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.query({ type: "query", name: name as never, payload });
}

/** The identical P015 sequence on both hosts. */
async function runP015Sequence(r: Renderer): Promise<{
  propertyDefId: string;
  scheduleId: string;
  propertiesJson: string;
  scheduleRunJson: string;
  quantitiesJson: string;
  bomJson: string;
  versionId: string;
}> {
  await c(r, "document.create", { entityId: "p015-parity-building" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
    ],
  });
  await c(r, "material.create", { name: "Concrete C30", category: "Concrete", density: 2400 });
  await c(r, "material.assign", { ids: ["wall-south", "wall-east", "slab-g"], materialId: "el-000001" });
  await c(r, "bim.setPropertySets", {
    elementId: "wall-south",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 90 }] }],
  });
  await c(r, "bim.setPropertySets", {
    elementId: "wall-east",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 60 }] }],
  });

  // The property registry + lineage statistics.
  const created = val<{ propertyDef: { id: string } }>(await c(r, "property.create", {
    name: "Fire rating", set: "PSetA", key: "FireRating", type: "number", unit: "min", appliesTo: ["bim.wall"],
  }));
  const properties = val<Record<string, unknown>>(await qq(r, "properties.list", {}));

  // The schedules/indexes engine powers: pd: column, conditions, sort, calc,
  // grouping + format.
  const scheduleCreated = val<{ schedule: { id: string } }>(await c(r, "schedule.create", {
    name: "Walls — fire rating",
    source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "material", label: "Material" },
      { key: `pd:${created.propertyDef.id}`, label: "FR", format: { unit: "min" } },
      { key: "calc:score", label: "Score", formula: { op: "mul", left: { column: `pd:${created.propertyDef.id}` }, right: { value: 2 } } },
    ],
    filter: { type: "bim.wall" },
    conditions: [{ set: "PSetA", key: "FireRating", op: "gt", value: 30 }],
    sort: [{ key: `pd:${created.propertyDef.id}`, direction: "desc" }],
    grouping: ["material"],
  }));
  const scheduleRun = val<Record<string, unknown>>(await qq(r, "schedules.run", { id: scheduleCreated.schedule.id }));

  // The quantity workflows: the revision-bound takeoff + the BOM.
  const quantities = val<Record<string, unknown>>(await qq(r, "quantities.run", {
    source: "elements", groupBy: "material",
  }));
  const bom = val<Record<string, unknown>>(await qq(r, "quantities.run", { source: "materials" }));

  // A canonical mutation + re-run: the binding tracks the head on both hosts.
  await c(r, "bim.move", { ids: ["wall-east"], dx: 0, dy: 1000, dz: 0 });
  const movedQuantities = val<Record<string, unknown>>(await qq(r, "quantities.run", {
    source: "elements", groupBy: "material",
  }));
  const movedSchedule = val<Record<string, unknown>>(await qq(r, "schedules.run", { id: scheduleCreated.schedule.id }));
  const moved = val<Record<string, unknown>>(await qq(r, "quantities.run", { source: "materials" }));

  const state = val<{ version: { version_id: string } }>(await qq(r, "document.getState", {}));

  return {
    propertyDefId: created.propertyDef.id,
    scheduleId: scheduleCreated.schedule.id,
    propertiesJson: JSON.stringify(properties),
    scheduleRunJson: JSON.stringify(scheduleRun) + JSON.stringify(movedSchedule),
    quantitiesJson: JSON.stringify(quantities) + JSON.stringify(movedQuantities),
    bomJson: JSON.stringify(bom) + JSON.stringify(moved),
    versionId: state.version.version_id,
  };
}

test("schedules/properties/quantities: Web and Electron converge to identical semantic results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runP015Sequence(web);
  const electronResult = await runP015Sequence(electron);

  assert.equal(webResult.propertyDefId, electronResult.propertyDefId, "identical minted prd- ids");
  assert.equal(webResult.scheduleId, electronResult.scheduleId, "identical minted sch- ids");
  assert.equal(webResult.propertiesJson, electronResult.propertiesJson, "identical property lineage statistics");
  assert.equal(webResult.scheduleRunJson, electronResult.scheduleRunJson, "identical schedule runs (rows/groups/totals/sha256)");
  assert.equal(webResult.quantitiesJson, electronResult.quantitiesJson, "identical quantity takeoffs (revision-bound)");
  assert.equal(webResult.bomJson, electronResult.bomJson, "identical material BOMs");
  assert.equal(webResult.versionId, electronResult.versionId, "identical version lineage");
});
