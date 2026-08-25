/**
 * Electron main-process entry (§5.3, §16).
 *
 * This is the integration point where the Electron main process would create a
 * BrowserWindow loading the shared renderer and wire the IpcTransport to a
 * native-side AppApiHandler running in the main process (or a native worker).
 * CAD-IMPLEMENT-001 proves the host layer + transport contract; the actual
 * `require("electron")` bootstrapping is deferred to a packaging work item and
 * is intentionally not imported here so the host layer remains testable without
 * the Electron runtime installed.
 *
 * When the packaging work item lands, this file will:
 *   1. `app.whenReady()` → create BrowserWindow loading the renderer bundle.
 *   2. Construct an ElectronHost(IpcTransport(handler)) where handler runs in
 *      the main process with the allowlisted native capabilities above.
 *   3. Expose only the allowlisted native capabilities to the renderer via the
 *      HostCapabilities contract (§16: no unscoped native access).
 */

export const ELECTRON_HOST_INTEGRATION_NOTE =
  "Electron main bootstrap is deferred to the packaging work item; the host layer + transport contract are proven by test/host-parity.test.ts.";
