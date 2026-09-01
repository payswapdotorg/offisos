/**
 * CAD-PARITY-015 (Issue #110) — the schedules/indexes engine extensions:
 * the pd:<prd-NNNNNN> property-definition columns, the property-driven
 * filter conditions, the deterministic multi-key sort, the bounded
 * calculated fields, the structured grouping with subtotals/totals and the
 * presentation format — every capability OPT-IN on the saved definition,
 * with the CAD-PARITY-013 response shape preserved byte-identically for
 * feature-free records (the pinned fixtures stay green).
 *
 * Engine-free paths through the dummy bundle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { DEFAULT_SCHEDULE_COLUMNS } from "../src/workspace/commands-documentation.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "schedules-p015",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p015-schedules",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errOf(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, `expected a typed failure, got: ${JSON.stringify(r).slice(0, 300)}`);
  const e = r as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p015-schedules-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000, name: "South wall" },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left", name: "Main entrance" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [0, 3000]], height: 3000 },
    ],
  }));
  await val(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete", color: [128, 128, 128], lineweight: 1.4, density: 2400 }));
  await val(await cmd(h, "material.assign", { ids: ["wall-south"], materialId: "el-000001" }));
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-south",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 90 }, { key: "Finish", value: "paint" }] },
  ] }));
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-east",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 60 }, { key: "Finish", value: "plaster" }] },
  ] }));
}

async function createSchedule(
  h: AppApiHandler,
  name: string,
  source: string,
  columns: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = val<{ schedule: { id: string } }>(await cmd(h, "schedule.create", {
    name, source, columns, ...extra,
  }));
  return created.schedule.id;
}

test("schedules P015: the extended record grammar — typed failures (sort/grouping/conditions/formula/format/pd:)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const base = [{ key: "id", label: "Id" }, { key: "ps:PSetA.FireRating", label: "FR" }];

  // sort: unknown column key / bad direction / duplicate key.
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base,
    sort: [{ key: "junk", direction: "asc" }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base,
    sort: [{ key: "id", direction: "sideways" }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base,
    sort: [{ key: "id", direction: "asc" }, { key: "id", direction: "desc" }],
  })).code, "schedule_invalid");

  // grouping: unknown column key / duplicate.
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base, grouping: ["junk"],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base, grouping: ["id", "id"],
  })).code, "schedule_invalid");

  // conditions: only on elements/components; gt needs a number; contains a string.
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "layouts", columns: [{ key: "id", label: "Id" }],
    conditions: [{ set: "PSetA", key: "FireRating", op: "gt", value: 0 }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base,
    conditions: [{ set: "PSetA", key: "FireRating", op: "gt", value: "90" }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base,
    conditions: [{ set: "PSetA", key: "Finish", op: "contains", value: 9 }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: base,
    conditions: [{ set: "PSetA", key: "bad key!", op: "eq", value: "x" }],
  })).code, "schedule_invalid");

  // pd: columns: elements/components only; the prd grammar is strict.
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "materials", columns: [{ key: "pd:prd-000001", label: "X" }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: [{ key: "pd:not-an-id", label: "X" }],
  })).code, "schedule_invalid");

  // calc: the formula is required on calc columns and forbidden elsewhere.
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: [{ key: "calc:double", label: "D" }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: [{ key: "id", label: "Id", formula: { op: "mul", left: { value: 2 }, right: { value: 2 } } }],
  })).code, "schedule_invalid");
  // operand: unknown column / calc column / non-finite literal / bad op.
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "calc:x", label: "X", formula: { op: "mul", left: { column: "junk" }, right: { value: 2 } } },
    ],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "calc:a", label: "A", formula: { op: "mul", left: { value: 2 }, right: { value: 3 } } },
      { key: "calc:b", label: "B", formula: { op: "mul", left: { column: "calc:a" }, right: { value: 3 } } },
    ],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "calc:x", label: "X", formula: { op: "modulo", left: { value: 2 }, right: { value: 3 } } },
    ],
  })).code, "schedule_invalid");

  // format: unit bound + align vocabulary.
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: [{ key: "id", label: "Id", format: { unit: "way too long" } }],
  })).code, "schedule_invalid");
  assert.equal(errOf(await cmd(h, "schedule.create", {
    name: "Bad", source: "elements", columns: [{ key: "id", label: "Id", format: { align: "center" } }],
  })).code, "schedule_invalid");

  // A fully-featured record validates (the happy path).
  const id = await createSchedule(h, "Featured", "elements", [
    { key: "id", label: "Id" },
    { key: "material", label: "Material" },
    { key: "ps:PSetA.FireRating", label: "FR" },
    { key: "calc:fr_score", label: "Score", formula: { op: "mul", left: { column: "ps:PSetA.FireRating" }, right: { value: 2 } } },
  ], {
    sort: [{ key: "ps:PSetA.FireRating", direction: "desc" }],
    grouping: ["material"],
    conditions: [{ set: "PSetA", key: "FireRating", op: "gt", value: 30 }],
  });
  assert.match(id, /^sch-\d{6}$/);
});

test("schedules P015: pd: columns resolve through the property registry — values stay in the overlay", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // The document-owned property definition (declaration only).
  const created = val<{ propertyDef: { id: string; set: string; key: string } }>(await cmd(h, "property.create", {
    name: "Fire rating", set: "PSetA", key: "FireRating", type: "number", unit: "min", appliesTo: ["bim.wall"],
  }));
  assert.match(created.propertyDef.id, /^prd-\d{6}$/);
  const pdId = created.propertyDef.id;

  const id = await createSchedule(h, "FR", "elements", [
    { key: "id", label: "Id" },
    { key: `pd:${pdId}`, label: "Fire rating" },
    { key: "ps:PSetA.FireRating", label: "FR (ps)" },
  ]);
  const run = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id }));
  const south = run.rows.find((r) => r[0] === "wall-south")!;
  // The pd: column resolves the SAME canonical overlay value as the ps: column.
  assert.equal(south[1], "90");
  assert.equal(south[1], south[2]);

  // NO parallel source of truth: a canonical mutation flows straight into the
  // pd: cell (the definition only names the address).
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-south",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 120 }] }],
  }));
  const rerun = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id }));
  assert.equal(rerun.rows.find((r) => r[0] === "wall-south")![1], "120");

  // Removing the definition renders the deterministic missing cell —
  // nothing is stored stale.
  await val(await cmd(h, "property.remove", { id: pdId }));
  const gone = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id }));
  assert.equal(gone.rows.find((r) => r[0] === "wall-south")![1], "-");
  // ...while the ps: column still resolves.
  assert.equal(gone.rows.find((r) => r[0] === "wall-south")![2], "120");
});

test("schedules P015: property-driven conditions (eq/ne/gt/lt/contains; absent never matches)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // Only wall-east carries Finish "plaster"; wall-south "paint"; others none.
  const id = await createSchedule(h, "Plaster", "elements", [{ key: "id", label: "Id" }], {
    conditions: [{ set: "PSetA", key: "Finish", op: "eq", value: "plaster" }],
  });
  const eq = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id }));
  assert.deepEqual(eq.rows.map((r) => r[0]), ["wall-east"]);

  const ne = await createSchedule(h, "Not plaster", "elements", [{ key: "id", label: "Id" }], {
    conditions: [{ set: "PSetA", key: "Finish", op: "ne", value: "plaster" }],
  });
  const neRun = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: ne }));
  // wall-south ("paint") matches ne; elements with NO Finish never match (absent ≠ ne).
  assert.deepEqual(neRun.rows.map((r) => r[0]), ["wall-south"]);

  const gt = await createSchedule(h, "FR > 60", "elements", [{ key: "id", label: "Id" }], {
    conditions: [{ set: "PSetA", key: "FireRating", op: "gt", value: 60 }],
  });
  const gtRun = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: gt }));
  assert.deepEqual(gtRun.rows.map((r) => r[0]), ["wall-south"]);

  // Two AND-ed conditions.
  const both = await createSchedule(h, "Both", "elements", [{ key: "id", label: "Id" }], {
    conditions: [
      { set: "PSetA", key: "FireRating", op: "lt", value: 90 },
      { set: "PSetA", key: "Finish", op: "contains", value: "last" },
    ],
  });
  const bothRun = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: both }));
  assert.deepEqual(bothRun.rows.map((r) => r[0]), ["wall-east"]);

  // gt with a non-number stored value never matches (typed — never coerced).
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "door-main",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: "ninety" }] }],
  }));
  const gt2 = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: gt }));
  assert.ok(!gt2.rows.some((r) => r[0] === "door-main"), "the text-valued FireRating never matches gt");
});

test("schedules P015: the deterministic multi-key sort (numeric, stable ties)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const id = await createSchedule(h, "Sorted", "elements", [
    { key: "id", label: "Id" },
    { key: "ps:PSetA.FireRating", label: "FR" },
  ], {
    sort: [{ key: "ps:PSetA.FireRating", direction: "desc" }, { key: "id", direction: "asc" }],
  });
  const run = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id }));
  // 90 (south) before 60 (east); every other row carries no FireRating
  // (missing sorts last in desc) — ties keep document order.
  assert.equal(run.rows[0]![0], "wall-south");
  assert.equal(run.rows[1]![0], "wall-east");
  // The missing-FR ties are ordered by the SECOND key (id asc): the
  // multi-key rule applies in sequence.
  const rest = run.rows.slice(2).map((r) => r[0]);
  assert.deepEqual(rest, ["door-main", "el-000001", "op-door", "space-office", "story-gf"]);
  // Ascending numeric with the missing-first convention.
  const asc = await createSchedule(h, "Asc", "elements", [
    { key: "id", label: "Id" },
    { key: "ps:PSetA.FireRating", label: "FR" },
  ], { sort: [{ key: "ps:PSetA.FireRating", direction: "asc" }] });
  const ascRun = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: asc }));
  // Ascending: the numeric cells first (60 before 90), the missing cells last.
  assert.equal(ascRun.rows[0]![0], "wall-east");
  assert.equal(ascRun.rows[1]![0], "wall-south");
  const missingTail = ascRun.rows.slice(2).map((r) => r[0]);
  assert.ok(!missingTail.includes("wall-east") && !missingTail.includes("wall-south"), "the missing cells sort last");
});

test("schedules P015: calculated fields (numeric channel; div-zero and text operands render '-')", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const id = await createSchedule(h, "Calculated", "elements", [
    { key: "id", label: "Id" },
    { key: "ps:PSetA.FireRating", label: "FR" },
    { key: "calc:score", label: "Score", formula: { op: "mul", left: { column: "ps:PSetA.FireRating" }, right: { value: 2 } } },
    { key: "calc:half", label: "Half", formula: { op: "div", left: { column: "ps:PSetA.FireRating" }, right: { value: 2 } } },
    { key: "calc:zero", label: "Zero", formula: { op: "div", left: { column: "ps:PSetA.FireRating" }, right: { value: 0 } } },
  ]);
  const run = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id }));
  const south = run.rows.find((r) => r[0] === "wall-south")!;
  assert.equal(south[2], "180"); // 90 × 2 — raw canonical numbers, no rounding
  assert.equal(south[3], "45"); // 90 / 2
  assert.equal(south[4], "-"); // division by zero is missing, never a guess
  const story = run.rows.find((r) => r[0] === "story-gf")!;
  assert.equal(story[2], "-"); // non-numeric operand → missing
  assert.equal(story[3], "-");
});

test("schedules P015: grouping with subtotals and grand totals (numeric channel; absent for feature-free records)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // Group the walls by material with a numeric calc column.
  const id = await createSchedule(h, "Grouped", "elements", [
    { key: "id", label: "Id" },
    { key: "material", label: "Material" },
    { key: "ps:PSetA.FireRating", label: "FR" },
    { key: "calc:score", label: "Score", formula: { op: "mul", left: { column: "ps:PSetA.FireRating" }, right: { value: 2 } } },
  ], {
    filter: { type: "bim.wall" },
    grouping: ["material"],
  });
  const run = val<{
    rows: readonly (readonly string[])[];
    groups: { key: readonly string[]; rowCount: number; firstRowIndex: number; subtotals: readonly (number | null)[] }[];
    totals: readonly (number | null)[];
  }>(await qq(h, "schedules.run", { id }));
  // Two groups: "Concrete C30" (wall-south) and "-" (wall-east), in row order.
  assert.deepEqual(run.groups.map((g) => g.key), [["Concrete C30"], ["-"]]);
  assert.equal(run.groups[0]!.rowCount, 1);
  assert.equal(run.groups[0]!.subtotals[2], 90); // the ps: numeric channel
  assert.equal(run.groups[0]!.subtotals[3], 180); // the calc numeric channel
  assert.equal(run.groups[1]!.subtotals[2], 60);
  assert.equal(run.groups[1]!.subtotals[3], 120);
  // Non-numeric columns subtotal to null (never a guessed zero).
  assert.equal(run.groups[0]!.subtotals[0], null);
  // Grand totals over both groups.
  assert.deepEqual(run.totals, [null, null, 150, 300]);

  // A feature-free (P013-shaped) schedule response carries NO groups/totals —
  // the byte-identical legacy shape (the pinned P013 fixture basis).
  const legacy = await createSchedule(h, "Legacy", "elements", DEFAULT_SCHEDULE_COLUMNS["elements"]!);
  const legacyRun = val<Record<string, unknown>>(await qq(h, "schedules.run", { id: legacy }));
  assert.ok(!("groups" in legacyRun), "no groups field on feature-free runs");
  assert.ok(!("totals" in legacyRun), "no totals field on feature-free runs");
  const legacyJson = JSON.stringify(legacyRun);
  assert.ok(!legacyJson.includes("\"groups\":"), "the serialized legacy response has no groups");
});

test("schedules P015: the presentation format (unit suffix; the numeric channel stays raw)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const id = await createSchedule(h, "Formatted", "elements", [
    { key: "id", label: "Id" },
    { key: "ps:PSetA.FireRating", label: "FR", format: { unit: "min", align: "right" } },
  ]);
  const run = val<{ rows: readonly (readonly string[])[]; schedule: { columns: { format?: { unit?: string; align?: string } }[] } }>(
    await qq(h, "schedules.run", { id }),
  );
  const south = run.rows.find((r) => r[0] === "wall-south")!;
  assert.equal(south[1], "90 min");
  // Missing cells stay "-".
  const story = run.rows.find((r) => r[0] === "story-gf")!;
  assert.equal(story[1], "-");
  // The format echoes on the persisted record.
  assert.deepEqual(run.schedule.columns[1]!.format, { unit: "min", align: "right" });
  // Subtotals keep the RAW numeric channel (presentation never transforms).
  const grouped = await createSchedule(h, "Grouped FR", "elements", [
    { key: "id", label: "Id" },
    { key: "ps:PSetA.FireRating", label: "FR", format: { unit: "min" } },
  ], { filter: { type: "bim.wall" }, grouping: ["id"] });
  const groupedRun = val<{ groups: { subtotals: readonly (number | null)[] }[] }>(await qq(h, "schedules.run", { id: grouped }));
  assert.equal(groupedRun.groups[0]!.subtotals[1], 90);
});

test("schedules P015: determinism + save/open/replay (document-owned definitions; update/undo)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const created = val<{ propertyDef: { id: string } }>(await cmd(h, "property.create", {
    name: "Fire rating", set: "PSetA", key: "FireRating", type: "number", unit: "min",
  }));
  const id = await createSchedule(h, "Deterministic", "elements", [
    { key: "id", label: "Id" },
    { key: `pd:${created.propertyDef.id}`, label: "FR" },
    { key: "calc:score", label: "Score", formula: { op: "mul", left: { column: `pd:${created.propertyDef.id}` }, right: { value: 2 } } },
  ], { sort: [{ key: `pd:${created.propertyDef.id}`, direction: "desc" }], grouping: ["id"] });

  const r1 = val<{ sha256: string; groups: unknown[]; totals: unknown[] }>(await qq(h, "schedules.run", { id }));
  const r2 = val<{ sha256: string; groups: unknown[]; totals: unknown[] }>(await qq(h, "schedules.run", { id }));
  assert.equal(r1.sha256, r2.sha256);
  assert.deepEqual(r1.groups, r2.groups);
  assert.deepEqual(r1.totals, r2.totals);
  assert.match(r1.sha256, /^[0-9a-f]{64}$/);

  // save → open → identical run (document-owned definitions, stable ids).
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  await val(await cmd(h, "document.open", { source: saved.bytes, entityId: "p015-reopened" }));
  const after = val<typeof r1>(await qq(h, "schedules.run", { id }));
  assert.deepEqual(after, r1);

  // The feature fields patch through updateSchedule (null removes).
  await val(await cmd(h, "schedule.update", { id, patch: { sort: null, grouping: null } }));
  const patched = val<Record<string, unknown>>(await qq(h, "schedules.run", { id }));
  assert.ok(!("groups" in patched), "the grouping removal dropped the structured fields");
  await val(await cmd(h, "document.undo", {}));
  const restored = val<typeof r1>(await qq(h, "schedules.run", { id }));
  assert.deepEqual(restored, r1);
});
