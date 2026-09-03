/**
 * CAD-PARITY-019 (Issue #122) — Web/Electron host parity for the AutoCAD
 * parity certification: the SAME version-pinned corpus (autocad-p019-corpus/1)
 * executed through the Web Host (WebSocketTransport) and the Electron Host
 * (IpcTransport) — each driving its OWN handler + bundle instance through
 * its REAL transport — produces byte-identical certification verdicts:
 * the per-workflow phase/expectation/interop/robustness results and the
 * aggregate summary converge exactly across hosts (LOCK-004; mirrors the
 * automation-p017-host-parity discipline).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import { ifcSkip } from "./ifc-availability.js";
import { runCertification, type CertDriver, type DriverResult } from "../src/certification/engine.js";
import type { Renderer } from "../src/renderer/index.js";
import type { CertificationReport } from "../src/certification/engine.js";

const skipIfc = await ifcSkip();

function makeHostRenderer(kind: "web" | "electron"): { renderer: Renderer; driver: CertDriver } {
  const handler = AppApiHandler.create({
    adapterBundle: createReferenceAdapterBundle(undefined, { ifc: createIfcInteropAdapter() }),
    entityId: `p019-parity-${kind}`,
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "p019-parity",
  });
  const renderer = createRenderer(
    kind === "web" ? new WebHost(new WebSocketTransport(handler)) : new ElectronHost(new IpcTransport(handler)),
  );
  const driver: CertDriver = {
    async command(name: string, payload: unknown): Promise<DriverResult> {
      const r = await renderer.execute({ type: "command", name: name as never, payload });
      return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.code, message: r.message };
    },
    async query(name: string, payload: unknown): Promise<DriverResult> {
      const r = await renderer.query({ type: "query", name: name as never, payload });
      return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.code, message: r.message };
    },
  };
  return { renderer, driver };
}

/** The comparable projection: every semantic verdict, with the run-unique
 *  content-addressed hex normalized (the P016/P017/P018 parity discipline). */
function comparable(report: CertificationReport): string {
  const projection = {
    corpus: report.corpus,
    workflows: report.workflows.map((w) => ({
      id: w.id,
      status: w.status,
      phases: w.phases,
      expectations: w.expectations,
      interop: w.interop,
      robustness: w.robustness,
      finalDigest: w.finalDigest,
    })),
    summary: report.summary,
  };
  return JSON.stringify(projection).replace(/[0-9a-f]{64}/g, "«sha256»");
}

test("CAD-PARITY-019: the AutoCAD parity certification converges byte-identically across the Web and Electron hosts", { skip: skipIfc }, async () => {
  const web = makeHostRenderer("web");
  const electron = makeHostRenderer("electron");

  const webRun = await runCertification(web.driver, {
    driverKind: "websocket-transport",
    basisNote: "The host-parity certification basis: the reference adapter + the pinned IfcOpenShell interop adapter through the Web host's REAL WebSocketTransport.",
  });
  const electronRun = await runCertification(electron.driver, {
    driverKind: "ipc-transport",
    basisNote: "The host-parity certification basis: the reference adapter + the pinned IfcOpenShell interop adapter through the Electron host's REAL IpcTransport.",
  });

  // The certification verdicts themselves.
  assert.equal(webRun.report.summary.verdict, "CERTIFIED", "the Web host certification verdict");
  assert.equal(electronRun.report.summary.verdict, "CERTIFIED", "the Electron host certification verdict");

  // And the full semantic verdict surfaces converge byte-identically across
  // hosts (phases, expectations, interop classifications, robustness arms,
  // the aggregate summary — the same corpus through both REAL transports).
  assert.equal(comparable(webRun.report), comparable(electronRun.report), "the certification verdict surfaces converge byte-identically across hosts");
});
