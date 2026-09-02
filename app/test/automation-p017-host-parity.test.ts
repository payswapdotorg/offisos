/**
 * CAD-PARITY-017 (Issue #116) — Web/Electron host parity for the
 * automation/extension/API workflows (§5.5, LOCK-004/017; mirrors
 * collab-p016-host-parity).
 *
 * The SAME P017 command/query sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) produces
 * identical semantic results: the capability discovery table, the
 * registered principal roster, the script inventory, the deterministic run
 * outcomes (revision-bound step outcomes + the reproducible outcome
 * digests), the scoped event feeds, the subscription/extension records and
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
  entityId: "p017-parity",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p017-parity",
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

interface P017SequenceResult {
  capabilitiesJson: string;
  principalsJson: string;
  scriptsJson: string;
  runJson: string;
  runsJson: string;
  eventsJson: string;
  subscriptionsJson: string;
  extensionsJson: string;
  failedRunJson: string;
  deleteJson: string;
  contentHash: string;
}

/** The identical P017 sequence on both hosts. */
async function runP017Sequence(r: Renderer): Promise<P017SequenceResult> {
  await c(r, "document.create", { entityId: "p017-parity-building" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    ],
  });

  // The versioned capability discovery surface (identical on both hosts).
  const capabilities = val<unknown>(await qq(r, "automation.capabilities"));

  // The principal + the governed scripts.
  const authenticate = val<{ principal: unknown }>(
    await c(r, "automation.authenticate", { principalId: "parity-bot", role: "editor" }),
  );
  const patchScript = {
    name: "parity-patch",
    profileId: "standard",
    apiVersion: "1",
    description: "the parity patch script",
    steps: [
      { stepId: "inspect", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
      {
        stepId: "patch",
        kind: "appApi",
        request: {
          type: "command",
          name: "document.applyEdit",
          payload: { edit: { type: "setProps", elementId: "wall-south", patch: { FireRating: 90 } } },
        },
      },
      { stepId: "verify", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
    ],
  };
  const script = val<{ script: unknown }>(
    await c(r, "automation.registerScript", { principalId: "parity-bot", script: patchScript }),
  );

  // The deterministic run (revision-bound outcomes + the reproducible
  // digest) + the run history.
  const run = val<{ run: unknown; documentVersion: number; contentHash: string }>(
    await c(r, "automation.runScript", { principalId: "parity-bot", scriptId: "scr-000001" }),
  );
  const runs = val<{ runs: unknown }>(await qq(r, "automation.runs"));

  // A failing run (onError abort — the typed failure is recorded, never
  // hidden): the script patches a non-existent element.
  const failingScript = {
    name: "parity-fail",
    profileId: "standard",
    apiVersion: "1",
    steps: [
      {
        stepId: "bad",
        kind: "appApi",
        request: {
          type: "command",
          name: "document.applyEdit",
          payload: { edit: { type: "setProps", elementId: "no-such-wall", patch: { x: 1 } } },
        },
      },
    ],
  };
  await c(r, "automation.registerScript", { principalId: "parity-bot", script: failingScript });
  const failedRun = val<{ run: unknown }>(
    await c(r, "automation.runScript", { principalId: "parity-bot", scriptId: "scr-000002" }),
  );

  // The scoped event subscriptions + the derived feed (the collab activity
  // of this sequence flows through the project scope).
  const subscribe = val<{ subscription: unknown }>(
    await c(r, "automation.subscribe", { principalId: "parity-bot", scope: "project" }),
  );
  await c(r, "automation.subscribe", { principalId: "parity-bot", scope: "document" });
  const events = val<unknown>(await qq(r, "automation.events", { principalId: "parity-bot" }));

  // The extension manifest (capability-scoped DATA).
  const extension = {
    extensionId: "parity-ext",
    name: "Parity Extension",
    version: "1.0.0",
    profileId: "standard",
    apiVersion: "1",
    capabilities: ["document.getVersion"],
    scripts: [
      {
        name: "parity-ext-read",
        profileId: "standard",
        apiVersion: "1",
        steps: [
          { stepId: "read", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
        ],
      },
    ],
  };
  const registered = val<unknown>(
    await c(r, "automation.registerExtension", { principalId: "parity-bot", extension }),
  );
  const extensions = val<{ extensions: unknown }>(await qq(r, "automation.extensions"));

  // The script lifecycle: remove the extension script (owner) — the
  // inventory converges.
  const extScriptId = (registered as { scripts: { id: string }[] }).scripts[0]!.id;
  const removed = val<{ script: unknown }>(
    await c(r, "automation.deleteScript", { principalId: "parity-bot", scriptId: extScriptId }),
  );

  const principals = val<{ principals: unknown }>(await qq(r, "automation.principals"));
  const scripts = val<{ scripts: unknown }>(await qq(r, "automation.scripts"));

  const stable = (x: unknown): string => JSON.stringify(x);
  return {
    capabilitiesJson: stable(capabilities),
    principalsJson: stable(principals),
    scriptsJson: stable(scripts),
    runJson: stable(run),
    runsJson: stable(runs),
    eventsJson: stable(events),
    subscriptionsJson: stable(subscribe),
    extensionsJson: stable(extensions),
    failedRunJson: stable(failedRun),
    deleteJson: stable(removed),
    contentHash: "",
  };
}

test("automation/extension: Web and Electron converge to identical semantic results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runP017Sequence(web);
  const electronResult = await runP017Sequence(electron);

  // The semantic surfaces converge byte-exactly across hosts (the discovery
  // table, the principals, the scripts, the deterministic run outcomes +
  // digests, the derived event feeds, the subscriptions, the extensions,
  // the typed failed runs, the lifecycle).
  assert.equal(webResult.capabilitiesJson, electronResult.capabilitiesJson);
  assert.equal(webResult.principalsJson, electronResult.principalsJson);
  assert.equal(webResult.scriptsJson, electronResult.scriptsJson);
  assert.equal(webResult.runJson, electronResult.runJson);
  assert.equal(webResult.runsJson, electronResult.runsJson);
  assert.equal(webResult.eventsJson, electronResult.eventsJson);
  assert.equal(webResult.subscriptionsJson, electronResult.subscriptionsJson);
  assert.equal(webResult.extensionsJson, electronResult.extensionsJson);
  assert.equal(webResult.failedRunJson, electronResult.failedRunJson);
  assert.equal(webResult.deleteJson, electronResult.deleteJson);

  // And the canonical documents converge to the same content hash (the
  // governed script steps applied identically on both hosts).
  assert.equal(webHandler.currentContentHash(), electronHandler.currentContentHash());
});
