/**
 * CAD-PARITY-014 (Issue #107) — the bounded DXF R2000 ASCII interchange:
 * the deterministic writer, the bounded reader and the import mapping.
 *
 * Covers the writer determinism (two exports → byte-identical), the full
 * writable entity vocabulary incl. the layer/linetype tables, the
 * export→import round trip (positions/values exact, byte-identical
 * re-export), the unsupported classification (dims/regions/BIM skipped +
 * counted — LOCK-007), THE DWG typed decline (the proprietary binary
 * boundary), the unit normalization + the unsupported-unit decline, the
 * R2000 structural sanity (section order, EOF, handle monotonicity) and
 * the empty-document bounded decision (an ok zero-entity export).
 *
 * Pure TS — runs EVERYWHERE (the dummy bundle; no engine, no skips).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import {
  dxfUnitFactor,
  hexToAci,
  aciToHex,
  looksLikeDwg,
  dxfFmt,
  DXF_INSUNITS_MM,
  DXF_ACADVER,
} from "../src/interop/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "interop-dxf",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "interop-dxf-test",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  const e = r as unknown as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

interface ElementProps {
  readonly id: string;
  readonly kind: string;
  readonly props: Record<string, unknown>;
}

interface ExportResult {
  readonly format: string;
  readonly bytesBase64: string;
  readonly size: number;
  readonly sha256: string;
  readonly counts: { readonly exported: number; readonly skipped: number; readonly byKind: Record<string, number> };
  readonly skippedKinds: readonly string[];
}

/** The representative drafting surface: two layers (one with a user
 *  linetype), every writable geometry kind, a text annotation and a dim
 *  annotation (OUTSIDE the boundary — skipped + counted). */
async function seeded(): Promise<{ h: AppApiHandler; wallLayerId: string }> {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "dxf-drawing" });
  const wallLayer = val<{ layerId: string }>(await cmd(h, "drafting.addLayer", {
    name: "A-Walls",
    color: "#ff0000",
    linetype: "Dashed",
    lineweight: 0.35,
  }));
  val(await cmd(h, "ltype.create", { name: "Custom-Dash", description: "user pattern", pattern: [4, 2] }));
  val(await cmd(h, "drafting.addLayer", { name: "B-Doors", color: "#0000ff", frozen: false, locked: true, linetype: "Custom-Dash" }));
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 50 },
    { type: "line", layer: wallLayer.layerId, x1: 0, y1: 10, x2: 200.25, y2: 10, color: "#00ff00" },
    { type: "polyline", layer: wallLayer.layerId, vertices: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }], closed: true },
    { type: "circle", layer: "0", cx: 50.5, cy: 60.5, r: 12.25 },
    { type: "arc", layer: "0", cx: 0, cy: 0, r: 40, startAngle: 0, endAngle: Math.PI / 2 },
    { type: "ellipse", layer: "0", cx: 100, cy: 100, rx: 30, ry: 12, rotation: Math.PI / 6 },
    { type: "spline", layer: "0", controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 40, y: 30 }, { x: 60, y: 0 }], degree: 3 },
    { type: "point", layer: "0", x: 7, y: 8 },
    { type: "ray", layer: "0", x1: 0, y1: 0, x2: 10, y2: 10 },
    { type: "xline", layer: wallLayer.layerId, x1: 5, y1: 5, x2: 15, y2: 5 },
  ] }));
  val(await cmd(h, "annotation.create", { entities: [
    { type: "text", layer: "0", x: 12.5, y: 90, height: 3.5, rotation: 0, value: "DXF TEXT 1" },
    { type: "dim-linear", layer: "0", p1: { x: 0, y: 0 }, p2: { x: 100, y: 50 }, mode: "aligned", offset: 10 },
  ] }));
  return { h, wallLayerId: wallLayer.layerId };
}

/** Export → decode the ASCII text (helper). */
async function exportText(h: AppApiHandler): Promise<{ result: ExportResult; text: string }> {
  const result = val<ExportResult>(await qq(h, "dxf.export", {}));
  assert.equal(result.format, "dxf");
  return { result, text: Buffer.from(result.bytesBase64, "base64").toString("utf8") };
}

// --- determinism + coverage --------------------------------------------------------

test("dxf.export is byte-deterministic and covers the full writable vocabulary", async () => {
  const { h } = await seeded();
  const a = await exportText(h);
  const b = await exportText(h);
  assert.equal(a.result.sha256, b.result.sha256, "two exports → identical sha256");
  assert.equal(a.result.bytesBase64, b.result.bytesBase64, "two exports → byte-identical");
  assert.equal(a.result.size, a.text.length);
  assert.match(a.result.sha256, /^[0-9a-f]{64}$/);
  // The full vocabulary: 9 geometry kinds + TEXT; the dim annotation is
  // skipped + counted (LOCK-007 — never silently approximated).
  assert.deepEqual(a.result.counts.byKind, {
    ARC: 1, CIRCLE: 1, ELLIPSE: 1, LINE: 2, LWPOLYLINE: 1, POINT: 1, RAY: 1, SPLINE: 1, TEXT: 1, XLINE: 1,
  });
  assert.equal(a.result.counts.exported, 11);
  assert.equal(a.result.counts.skipped, 1);
  assert.deepEqual(a.result.skippedKinds, ["annotation.dim-linear"]);
});

test("dxf.export emits the R2000 structure: sections in order, EOF, monotonic handles, mm units", async () => {
  const { h } = await seeded();
  const { text } = await exportText(h);
  const lines = text.split("\n");
  assert.equal(lines[lines.length - 1], "", "the text is LF-terminated");
  // The pair stream: sections in fixed order HEADER → TABLES → ENTITIES.
  const sections: string[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i] === "0" && lines[i + 1] === "SECTION") {
      sections.push(lines[i + 3]!); // 0 SECTION / 2 <name>
    }
  }
  assert.deepEqual(sections, ["HEADER", "TABLES", "ENTITIES"]);
  assert.ok(text.trimEnd().endsWith("0\nEOF"), "the file ends with the EOF marker");
  // Exactly the three declared header variables (no timestamps, nothing
  // beyond): $ACADVER, $INSUNITS and the $EXTMIN/$EXTMAX extents pair.
  const variableCount = (text.match(/\$[A-Z]+/g) ?? []).length;
  assert.equal(variableCount, 4, "$ACADVER + $INSUNITS + $EXTMIN + $EXTMAX (the extents pair)");
  // $ACADVER R2000 + $INSUNITS mm (the variable name is a 9-code VALUE —
  // the variable's own value follows its 1/70-code pair).
  const acadverIndex = lines.indexOf("$ACADVER");
  assert.equal(lines[acadverIndex + 2], DXF_ACADVER);
  const insunitsIndex = lines.indexOf("$INSUNITS");
  assert.equal(lines[insunitsIndex + 2], String(DXF_INSUNITS_MM));
  // Handles: strictly increasing (5-code pairs after the first one).
  const handles: number[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i] === "5") handles.push(Number.parseInt(lines[i + 1]!, 16));
  }
  assert.ok(handles.length > 3, "the tables + entities carry handles");
  for (let i = 1; i < handles.length; i += 1) {
    assert.ok(handles[i]! > handles[i - 1]!, `handle monotonicity at index ${i}`);
  }
  assert.equal(handles[0], 0x100, "handles start at 0x100");
  // LTYPE table for every referenced linetype (Dashed + the user pattern +
  // Continuous for the default layer) + the LAYER table for both layers.
  for (const name of ["Continuous", "Dashed", "Custom-Dash", "A-Walls", "B-Doors"]) {
    assert.ok(lines.includes(name), `the table entry '${name}' is emitted`);
  }
});

// --- the round trip ----------------------------------------------------------------

test("dxf.export → dxf.import round trips the geometry, layers and linetypes exactly", async () => {
  const { h } = await seeded();
  const { result: exported } = await exportText(h);

  // A FRESH handler: import the bytes (ONE versioned command).
  const h2 = AppApiHandler.create(CONFIG);
  await cmd(h2, "document.create", { entityId: "dxf-imported" });
  const imported = val<{
    report: { unit: string; scaleToMm: number; counts: { elements: number; layers: number; ltypes: number; unsupported: number } };
    reportHash: string;
    created: number;
  }>(await cmd(h2, "dxf.import", { dxf: exported.bytesBase64 }));
  assert.equal(imported.report.unit, "mm");
  assert.equal(imported.report.scaleToMm, 1);
  assert.equal(imported.report.counts.elements, 11);
  assert.equal(imported.report.counts.layers, 2, "A-Walls + B-Doors created (the default 0 already exists)");
  assert.equal(imported.created, 14, "11 elements + 2 layers + 1 user linetype record");
  assert.equal(imported.report.counts.unsupported, 0);

  // The re-export of the imported document is BYTE-IDENTICAL to the source
  // export (the full closed loop: document order, layers by name, geometry
  // values — the 6-decimal format round-trips every authored value).
  const round = await exportText(h2);
  assert.equal(round.result.sha256, exported.sha256, "the re-export is byte-identical to the source export");

  // The imported geometry is exact (positions/values through getState).
  const state = val<{ elements: ElementProps[] }>(await qq(h2, "document.getState", {}));
  const byType = new Map<string, Record<string, unknown>>();
  for (const el of state.elements) byType.set(`${el.props.type}:${byType.size}`, el.props);
  const geoms = state.elements.filter((el) => el.kind === "geometry").map((el) => el.props);
  const line = geoms.find((g) => g.type === "line" && g.x1 === 0 && g.y1 === 0 && g.x2 === 100);
  assert.ok(line !== undefined, "the line round-trips exactly");
  assert.equal(line.y2, 50);
  const circle = geoms.find((g) => g.type === "circle");
  assert.deepEqual([circle?.cx, circle?.cy, circle?.r], [50.5, 60.5, 12.25]);
  const arc = geoms.find((g) => g.type === "arc");
  assert.equal(arc?.endAngle, Math.PI / 2);
  const ellipse = geoms.find((g) => g.type === "ellipse");
  // The ellipse axes/rotation cross the 6-decimal format bound: the
  // major-axis endpoint + ratio decode reconstructs (rx, ry, rotation)
  // within the DECLARED round-trip tolerance (1e-5 mm — the classification
  // reports these rows as tolerance, not exact).
  assert.ok(Math.abs((ellipse?.rx as number) - 30) <= 1e-5);
  assert.ok(Math.abs((ellipse?.ry as number) - 12) <= 1e-5);
  assert.ok(Math.abs((ellipse?.rotation as number) - Math.PI / 6) <= 1e-5);
  const spline = geoms.find((g) => g.type === "spline");
  assert.equal((spline?.controlPoints as { x: number }[]).length, 4);
  assert.equal(spline?.degree, 3);
  const texts = state.elements.filter((el) => el.kind === "annotation" && el.props.type === "text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0]!.props.value, "DXF TEXT 1");
  assert.equal(texts[0]!.props.height, 3.5);
  // Layers round-trip by NAME with their properties.
  const layers = val<{ layers: { name: string; color: string; linetype?: string; lineweight?: number; locked?: boolean }[] }>(
    await qq(h2, "document.getState", {}),
  ).layers;
  const walls = layers.find((l) => l.name === "A-Walls")!;
  assert.equal(walls.linetype, "Dashed");
  assert.equal(walls.lineweight, 0.35);
  assert.equal(layers.find((l) => l.name === "B-Doors")?.locked, true);
  // The user linetype came across as a document ltype record (referenced
  // by the B-Doors layer — the writer emits every REFERENCED linetype).
  const state2 = val<{ ltypes?: { name: string; pattern: number[] }[] }>(await qq(h2, "document.getState", {}));
  const custom = state2.ltypes?.find((l) => l.name === "Custom-Dash");
  assert.ok(custom !== undefined, "the user linetype was created");
  assert.deepEqual(custom.pattern, [4, 2]);
});

test("dxf.import is ONE atomic versioned command (one revision, one undo)", async () => {
  const { h } = await exportSeed();
  const { result } = await exportText(h);
  const h2 = AppApiHandler.create(CONFIG);
  await cmd(h2, "document.create", { entityId: "dxf-versioned" });
  const before = val<{ version_number: number }>(await qq(h2, "document.getVersion", {}));
  val(await cmd(h2, "dxf.import", { dxf: result.bytesBase64 }));
  const after = val<{ version_number: number }>(await qq(h2, "document.getVersion", {}));
  assert.equal(after.version_number, before.version_number + 1, "one revision");
  // Undo restores the pre-import state.
  val(await cmd(h2, "document.undo", {}));
  const undone = val<{ elements: unknown[]; layers: { name: string }[] }>(await qq(h2, "document.getState", {}));
  assert.equal(undone.elements.length, 0);
  assert.deepEqual(undone.layers.map((l) => l.name), ["0"]);
});

async function exportSeed(): Promise<{ h: AppApiHandler }> {
  const { h } = await seeded();
  return { h };
}

// --- the DWG boundary + units ------------------------------------------------------

test("dxf.import declines the proprietary DWG binary typed (THE explicit boundary)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "dxf-dwg-guard" });
  // "AC1015" + binary padding (the DWG magic: AC + version digits + NULs).
  const dwg = Buffer.concat([
    Buffer.from("AC1015", "ascii"),
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0x00, 0x1a]),
  ]);
  const declined = errVal(await cmd(h, "dxf.import", { dxf: dwg.toString("base64") }));
  assert.equal(declined.code, "dwg_unsupported");
  assert.match(declined.message, /proprietary DWG binary/);
});

test("dxf.import normalizes the declared units and declines undeclared ones typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "dxf-units" });
  // An inch-unit DXF (a bounded hand-written file): 1 in → 25.4 mm.
  const inches = [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1015",
    "9", "$INSUNITS", "70", "1",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "5", "100", "8", "0",
    "10", "1", "20", "0", "30", "0", "11", "2", "21", "0", "31", "0",
    "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
  const imported = val<{ report: { unit: string; scaleToMm: number; counts: { elements: number } } }>(
    await cmd(h, "dxf.import", { dxf: Buffer.from(inches, "utf8").toString("base64") }),
  );
  assert.equal(imported.report.unit, "in");
  assert.equal(imported.report.scaleToMm, 25.4);
  const state = val<{ elements: ElementProps[] }>(await qq(h, "document.getState", {}));
  const line = state.elements.find((el) => el.props.type === "line")!;
  assert.equal(line.props.x1, 25.4);
  assert.equal(line.props.x2, 50.8);

  // Unitless (0) / out-of-vocabulary values fail dxf_unsupported — no guessing.
  for (const insunits of [0, 3, 99]) {
    const unitless = [
      "0", "SECTION", "2", "HEADER",
      "9", "$ACADVER", "1", "AC1015",
      "9", "$INSUNITS", "70", String(insunits),
      "0", "ENDSEC", "0", "EOF", "",
    ].join("\n");
    const h2 = AppApiHandler.create(CONFIG);
    await cmd(h2, "document.create", { entityId: "dxf-unitless" });
    const declined = errVal(await cmd(h2, "dxf.import", { dxf: Buffer.from(unitless, "utf8").toString("base64") }));
    assert.equal(declined.code, "dxf_unsupported", `INSUNITS ${insunits} is declined typed`);
    assert.match(declined.message, /unsupported \$INSUNITS/);
  }
});

test("dxf.import classifies unsupported constructs per type (never fabricated)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "dxf-unsupported" });
  // A bounded hand-written file: one LINE (supported) + INSERT + MTEXT +
  // DIMENSION + 3DFACE (all outside the boundary — skipped + counted).
  const file = [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1015",
    "9", "$INSUNITS", "70", "4",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "5", "100", "8", "0", "10", "0", "20", "0", "30", "0", "11", "10", "21", "0", "31", "0",
    "0", "INSERT", "5", "101", "8", "0", "2", "SOME-BLOCK", "10", "0", "20", "0", "30", "0",
    "0", "MTEXT", "5", "102", "8", "0", "1", "rich text", "10", "0", "20", "0", "40", "2.5",
    "0", "DIMENSION", "5", "103", "8", "0", "1", "DIM", "10", "0", "20", "0", "30", "0",
    "0", "3DFACE", "5", "104", "8", "0", "10", "0", "20", "0", "30", "0", "11", "1", "21", "0", "31", "0", "13", "0", "23", "1", "33", "0",
    "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
  const imported = val<{
    report: { counts: { elements: number; unsupported: number }; unsupported: { type: string; count: number }[] };
  }>(await cmd(h, "dxf.import", { dxf: Buffer.from(file, "utf8").toString("base64") }));
  assert.equal(imported.report.counts.elements, 1, "only the LINE was created");
  assert.equal(imported.report.counts.unsupported, 4);
  assert.deepEqual(
    imported.report.unsupported.map((u) => [u.type, u.count]).sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : 1)),
    [["3DFACE", 1], ["DIMENSION", 1], ["INSERT", 1], ["MTEXT", 1]],
  );
});

test("the empty document exports a valid EMPTY DXF (the bounded ok decision)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "dxf-empty" });
  const { result, text } = await exportText(h);
  assert.equal(result.counts.exported, 0);
  assert.deepEqual(result.counts.byKind, {});
  assert.deepEqual(result.skippedKinds, []);
  assert.ok(text.includes("ENTITIES"), "the ENTITIES section exists");
  assert.ok(text.trimEnd().endsWith("0\nEOF"), "the file ends with EOF");
  // And the empty export re-imports cleanly (zero created, ok).
  const h2 = AppApiHandler.create(CONFIG);
  await cmd(h2, "document.create", { entityId: "dxf-empty-import" });
  const imported = val<{ report: { counts: { elements: number } }; created: number }>(
    await cmd(h2, "dxf.import", { dxf: result.bytesBase64 }),
  );
  assert.equal(imported.report.counts.elements, 0);
  assert.equal(imported.created, 0);
});

// --- the shared mapping vocabulary (pure) -------------------------------------------

test("the bounded ACI mapping: palette-exact hex, black duality, documented approximation", () => {
  // Palette-exact values.
  assert.deepEqual(hexToAci("#ff0000"), { aci: 1, exact: true });
  assert.deepEqual(hexToAci("#00ffff"), { aci: 4, exact: true });
  assert.deepEqual(hexToAci("#808080"), { aci: 8, exact: true });
  // The documented black/white duality: #000000 → ACI 7.
  assert.deepEqual(hexToAci("#000000"), { aci: 7, exact: true });
  // A non-palette hex approximates to the NEAREST palette entry (lossy).
  const approx = hexToAci("#fe0102");
  assert.equal(approx.aci, 1);
  assert.equal(approx.exact, false);
  // The reverse table.
  assert.equal(aciToHex(1).hex, "#ff0000");
  assert.equal(aciToHex(7).hex, "#ffffff");
  assert.equal(aciToHex(250).hex, "#333333");
  assert.equal(aciToHex(120).exact, false, "the foreign hue grid approximates");
  // Round-trip identity for palette values. NOTE the documented tie rule:
  // ACI 7 and ACI 255 are BOTH #ffffff — hex→ACI resolves the tie to the
  // LOWEST index (7), so 255 is exact ACI→hex but not a hex→ACI identity.
  for (const entry of [1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252, 253, 254]) {
    const hex = aciToHex(entry).hex;
    assert.equal(hexToAci(hex).aci, entry, `palette ACI ${entry} round-trips`);
  }
  assert.equal(aciToHex(255).hex, "#ffffff");
  assert.equal(hexToAci("#ffffff").aci, 7, "the white tie resolves to the lowest ACI (documented)");
});

test("dxfUnitFactor + looksLikeDwg + dxfFmt: the shared boundary vocabulary", () => {
  assert.deepEqual(dxfUnitFactor(4), { unit: "mm", factor: 1 });
  assert.deepEqual(dxfUnitFactor(1), { unit: "in", factor: 25.4 });
  assert.deepEqual(dxfUnitFactor(2), { unit: "ft", factor: 304.8 });
  assert.deepEqual(dxfUnitFactor(5), { unit: "cm", factor: 10 });
  assert.deepEqual(dxfUnitFactor(6), { unit: "m", factor: 1000 });
  assert.equal(dxfUnitFactor(null), null);
  assert.equal(dxfUnitFactor(0), null);
  assert.equal(dxfUnitFactor(99), null);
  // The DWG magic detection.
  assert.equal(looksLikeDwg(Buffer.from("AC1015\0\0\0", "latin1")), true);
  assert.equal(looksLikeDwg(Buffer.from("AC1012\0", "latin1")), true);
  assert.equal(looksLikeDwg(Buffer.from("  0\nSECTION\n", "ascii")), false, "ASCII DXF text is never DWG");
  assert.equal(looksLikeDwg(Buffer.from("AC10", "ascii")), false, "too short");
  // The 6-decimal deterministic format.
  assert.equal(dxfFmt(1.5), "1.5");
  assert.equal(dxfFmt(0.1234567), "0.123457");
  assert.equal(dxfFmt(-0), "0");
  assert.equal(dxfFmt(100), "100");
});
