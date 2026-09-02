/**
 * CAD-PARITY-018 (Issue #118) — Web/Electron host parity for the
 * specialized-toolsets workflows (§5.5, LOCK-004/017; mirrors
 * automation-p017-host-parity).
 *
 * The SAME P018 command/query sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) produces
 * identical semantic results: the capability discovery table, the
 * architecture composition outcomes (wall runs, hosted openings), the
 * specialized-record inventory, the MEP run/equipment records with the
 * in-record connections, the deterministic route validation and
 * clash/clearance diagnostics, the raster source/reference records with
 * the fresh status derivation and the typed non-authoritative trace, the
 * trace-commit canonical elements, the save/open round-trip inventory and
 * the canonical content hash. Each host drives its OWN handler + bundle
 * instance through its REAL transport.
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
  entityId: "p018-parity",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p018-parity",
};

type Renderer = ReturnType<typeof createRenderer>;

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

async function c(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.execute({ type: "command", name: name as never, payload });
}
async function qq(r: Renderer, name: string, payload: unknown = {}): Promise<CommandQueryResponse> {
  return r.query({ type: "query", name: name as never, payload });
}

interface P018SequenceResult {
  capabilitiesJson: string;
  wallRunJson: string;
  hostedOpeningJson: string;
  mepRunJson: string;
  equipmentJson: string;
  connectJson: string;
  routeJson: string;
  clashJson: string;
  arrayJson: string;
  rasterSourceJson: string;
  rasterAttachJson: string;
  rasterStatusJson: string;
  rasterTraceJson: string;
  commitTraceJson: string;
  listRecordsJson: string;
  reopenedRecordsJson: string;
  typedDeclinesJson: string;
  contentHash: string;
}

/** The identical P018 sequence on both hosts. */
async function runP018Sequence(r: Renderer): Promise<P018SequenceResult> {
  await c(r, "document.create", { entityId: "p018-parity-building" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.story", id: "story-1", name: "First Floor", level: 3000, height: 3000 },
      { type: "bim.componentDef", id: "def-desk", name: "Workstation Desk", category: "furniture", parameters: { width: 1600, depth: 800, height: 750 } },
    ],
  });

  // The versioned capability discovery surface (identical on both hosts).
  const capabilities = val<unknown>(await qq(r, "toolset.capabilities"));

  // The architecture composition (ONE atomic element batch per command).
  const wallRun = val<{ created: string[]; wallCount: number; walls: readonly { id: string; name: string }[] }>(
    await c(r, "toolset.archWallRun", {
      storyId: "story-gf",
      polyline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 5000 }],
      widthMm: 300,
      heightMm: 3000,
      name: "run",
      junctions: "openings",
    }),
  );
  const hostedOpening = val<{ created: string[]; openingId: string; fillId: string }>(
    await c(r, "toolset.archHostedOpening", {
      wallId: wallRun.walls[0]!.id,
      kind: "door",
      tAlongWall: 2500,
      widthMm: 900,
      heightMm: 2100,
      sillMm: 0,
    }),
  );

  // The MEP run + the equipment with ports + the in-record connection.
  const mepRun = val<{ record: unknown }>(
    await c(r, "toolset.mepAddRun", {
      run: {
        domain: "pipe",
        shape: "round",
        nominalSize: 32,
        name: "cw-1",
        segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } }],
      },
    }),
  );
  const equipment = val<{ record: unknown }>(
    await c(r, "toolset.mechAddEquipment", {
      equipment: {
        kind: "pump",
        name: "pump-a",
        origin: { x: -500, y: 0, z: 0 },
        ports: [
          { id: "p1", kind: "supply", position: { x: 100, y: 0, z: 0 }, nominal: 32, domain: "pipe" },
          { id: "p2", kind: "return", position: { x: -100, y: 0, z: 0 }, nominal: 32, domain: "pipe" },
          { id: "p3", kind: "supply", position: { x: 0, y: 200, z: 0 }, nominal: 300, domain: "duct" },
        ],
      },
    }),
  );
  const connect = val<{ connection: unknown; record: unknown }>(
    await c(r, "toolset.mepConnect", {
      runId: (mepRun as { record: { id: string } }).record.id,
      at: "start",
      target: { kind: "equipment", equipmentId: (equipment as { record: { id: string } }).record.id, portId: "p1" },
    }),
  );

  // The deterministic derivations (route validation + clash report).
  const route = val<unknown>(await qq(r, "toolset.mepValidateRoute", { id: (mepRun as { record: { id: string } }).record.id }));
  const clash = val<unknown>(await qq(r, "toolset.mepClashReport", { clearanceMm: 100 }));

  // The mechanical array (ports move with each instance).
  const array = val<{ created: string[]; count: number }>(
    await c(r, "toolset.mechArray", {
      equipmentId: (equipment as { record: { id: string } }).record.id,
      cols: 2,
      rows: 2,
      dxMm: 2000,
      dyMm: 2000,
    }),
  );

  // The raster/underlay records + the derived views + the commit.
  const rasterSource = val<{ record: unknown }>(
    await c(r, "toolset.rasterAddSource", {
      source: {
        sourceRef: "underlay/site-plan.png",
        contentDigest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        widthPx: 1000,
        heightPx: 600,
        lineWork: [
          { x1: 100, y1: 100, x2: 900, y2: 100 },
          { x1: 100, y1: 300, x2: 900, y2: 300 },
        ],
      },
    }),
  );
  const rasterAttach = val<{ record: unknown }>(
    await c(r, "toolset.rasterAttach", {
      reference: {
        sourceRef: "underlay/site-plan.png",
        declaredDigest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        transform: { origin: { x: 0, y: 0 }, scale: 0.5, rotationDeg: 0 },
        visible: true,
      },
    }),
  );
  const rasterStatus = val<unknown>(await qq(r, "toolset.rasterStatus"));
  const rasterTrace = val<unknown>(await qq(r, "toolset.rasterTrace", { referenceId: (rasterAttach as { record: { id: string } }).record.id }));
  const commitTrace = val<{ created: string[]; committed: number; trace: { notice: string; authoritative: boolean } }>(
    await c(r, "toolset.rasterCommitTrace", { referenceId: (rasterAttach as { record: { id: string } }).record.id }),
  );

  // The specialized-record inventory.
  const listRecords = val<unknown>(await qq(r, "toolset.listRecords"));

  // The save/open round-trip: the specialized records survive the reopen
  // (document-owned canonical state, not host state).
  const saved = val<{ bytes: string }>(await c(r, "document.save", {}));
  await c(r, "document.open", { source: saved.bytes });
  const reopenedRecords = val<unknown>(await qq(r, "toolset.listRecords"));

  // The typed declines (identical failure semantics on both hosts).
  const hostMissing = await c(r, "toolset.archWallRun", {
    storyId: "no-such-story",
    polyline: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    widthMm: 200,
    heightMm: 3000,
  });
  const notFound = await qq(r, "toolset.mepValidateRoute", { id: "tls-999999" });
  const referenceMissing = await c(r, "toolset.rasterAttach", {
    reference: {
      sourceRef: "unregistered.png",
      declaredDigest: "0",
      transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
      visible: true,
    },
  });
  const domainMismatch = await c(r, "toolset.mepConnect", {
    runId: (mepRun as { record: { id: string } }).record.id,
    at: "end",
    target: { kind: "equipment", equipmentId: (equipment as { record: { id: string } }).record.id, portId: "p3" },
  });

  const stable = (x: unknown): string => JSON.stringify(x);
  return {
    capabilitiesJson: stable(capabilities),
    wallRunJson: stable(wallRun),
    hostedOpeningJson: stable(hostedOpening),
    mepRunJson: stable(mepRun),
    equipmentJson: stable(equipment),
    connectJson: stable(connect),
    routeJson: stable(route),
    clashJson: stable(clash),
    arrayJson: stable(array),
    rasterSourceJson: stable(rasterSource),
    rasterAttachJson: stable(rasterAttach),
    rasterStatusJson: stable(rasterStatus),
    rasterTraceJson: stable(rasterTrace),
    commitTraceJson: stable(commitTrace),
    listRecordsJson: stable(listRecords),
    reopenedRecordsJson: stable(reopenedRecords),
    typedDeclinesJson: stable([hostMissing, notFound, referenceMissing, domainMismatch]),
    contentHash: "",
  };
}

test("specialized toolsets: Web and Electron converge to identical semantic results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runP018Sequence(web);
  const electronResult = await runP018Sequence(electron);

  // The semantic surfaces converge byte-exactly across hosts (the discovery
  // table, the architecture composition outcomes, the MEP/mechanical/raster
  // records, the deterministic derivations, the trace commit, the inventory
  // before and after the save/open round-trip, the typed declines).
  assert.equal(webResult.capabilitiesJson, electronResult.capabilitiesJson);
  assert.equal(webResult.wallRunJson, electronResult.wallRunJson);
  assert.equal(webResult.hostedOpeningJson, electronResult.hostedOpeningJson);
  assert.equal(webResult.mepRunJson, electronResult.mepRunJson);
  assert.equal(webResult.equipmentJson, electronResult.equipmentJson);
  assert.equal(webResult.connectJson, electronResult.connectJson);
  assert.equal(webResult.routeJson, electronResult.routeJson);
  assert.equal(webResult.clashJson, electronResult.clashJson);
  assert.equal(webResult.arrayJson, electronResult.arrayJson);
  assert.equal(webResult.rasterSourceJson, electronResult.rasterSourceJson);
  assert.equal(webResult.rasterAttachJson, electronResult.rasterAttachJson);
  assert.equal(webResult.rasterStatusJson, electronResult.rasterStatusJson);
  assert.equal(webResult.rasterTraceJson, electronResult.rasterTraceJson);
  assert.equal(webResult.commitTraceJson, electronResult.commitTraceJson);
  assert.equal(webResult.listRecordsJson, electronResult.listRecordsJson);
  assert.equal(webResult.reopenedRecordsJson, electronResult.reopenedRecordsJson);
  assert.equal(webResult.typedDeclinesJson, electronResult.typedDeclinesJson);

  // The typed declines are the expected ones (the parity above is parity of
  // REAL typed failures, not parity of accidental successes).
  const declines = JSON.parse(webResult.typedDeclinesJson) as { ok: boolean; code?: string }[];
  assert.equal(declines[0]!.code, "toolset_host_not_found");
  assert.equal(declines[1]!.code, "toolset_not_found");
  assert.equal(declines[2]!.code, "toolset_reference_missing");
  assert.equal(declines[3]!.code, "toolset_unsupported");

  // And the canonical documents converge to the same content hash (the
  // specialized records and the committed trace elements applied
  // identically on both hosts).
  assert.equal(webHandler.currentContentHash(), electronHandler.currentContentHash());
});
