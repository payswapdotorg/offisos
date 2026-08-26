/**
 * Shared CAD/BIM renderer/editor core (LOCK-017/018, §5.3).
 *
 * Platform-independent. The same renderer instance works against any
 * HostCapabilities (web or electron). Re-exports the renderer factory and
 * interface.
 */

export { createRenderer } from "./renderer.js";
export type { Renderer } from "./renderer.js";
