'use client';

/**
 * Offisos professional CAD/BIM workspace — Web host surface
 * (CAD-PARITY-002 / Issue #75, CAD/BIM Product Architecture v1.0 FROZEN
 * under ConstructionOS Architecture v1.1).
 *
 * The page IS the professional workspace shell (spec/cad-bim/ui.md):
 * application menu + ribbon + command search, tool palette, Model canvas
 * with view tabs, properties/layers/navigator palettes, command line with
 * prompt state, status bar with drafting-aid toggles, keyboard-first
 * shortcuts and responsive behavior. The legacy five-workbench surfaces
 * (3D BIM, Documentation, IFC interoperability, Components) remain fully
 * accessible as workspace views; the 2D drafting surface is superseded by
 * the command-driven Model canvas (same drafting core, same App API).
 *
 * Client component. Talks to the backend ONLY via fetch('/api/cad', ...)
 * through the typed transport. Imports NO module that transitively imports
 * `node:crypto` — the shared workspace core
 * (`@offisos/cad-app-shell/workspace`) is engine-free and host-free
 * (LOCK-003/018); mutations flow only through App API command plans
 * produced by the deterministic prompt engine (§5.3, LOCK-004 parity).
 */

import { WorkspaceShell } from "@/cad/workspace/shell";

export default function Home(): React.JSX.Element {
  return <WorkspaceShell />;
}
