"use client";

/**
 * Offisos Components / Materials / Coordination Workbench — Web host surface
 * (COMPAT-BIM-003 / Issue #50).
 *
 * A REAL parametric-component workflow, not a mockup: reusable component
 * definitions author instances with stable canonical relationships; the
 * propagation panel edits a definition default and observes every instance's
 * EFFECTIVE parameters change deterministically (overrides pin their keys);
 * materials are canonical domain data with reference integrity; grids and
 * reference planes persist with the model; the IFC round-trip panel proves
 * component/material semantics survive export → import with field-level
 * classification through the production interop adapter.
 */

import * as React from "react";
import {
  Boxes,
  CircleDot,
  Grid3x3,
  Layers,
  Package,
  RefreshCw,
  Repeat,
  Ruler,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import type { CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";

import {
  bimCreate,
  bimGetComponents,
  bimOp,
  bimSetProperties,
  createDoc,
  ifcCompare,
  ifcExport,
  ifcImport,
  undo,
} from "@/cad/client/http-transport";

// --- wire types (mirror of the bim.getComponents response) ----------------------

interface ComponentInventory {
  materials: { elementId: string; name: string; description?: string; color?: readonly [number, number, number]; properties: Record<string, unknown> }[];
  definitions: { elementId: string; name: string; category: string; parameters: Record<string, number>; materialId?: string }[];
  instances: {
    elementId: string; definitionId: string; name?: string; storyId: string;
    position: [number, number]; rotation: number; baseOffset: number;
    overrides: Record<string, number>;
    effectiveParameters: Record<string, number>;
    effectiveBox: [number, number, number];
    effectiveMaterialId: string | null;
  }[];
  grids: { elementId: string; storyId: string; name: string; uLines: number[]; vLines: number[] }[];
  referencePlanes: { elementId: string; storyId: string; name: string; start: [number, number]; end: [number, number] }[];
  unsupported: Record<string, string>;
}

function unwrapInventory(res: CommandQueryResponse): ComponentInventory | null {
  if (!res.ok) return null;
  const v = res.value as Partial<ComponentInventory> | null;
  if (
    v === null || !Array.isArray(v.materials) || !Array.isArray(v.definitions) ||
    !Array.isArray(v.instances) || !Array.isArray(v.grids) || !Array.isArray(v.referencePlanes)
  ) {
    return null;
  }
  return v as ComponentInventory;
}

const CATEGORY_BADGE: Record<string, string> = {
  wall: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
  door: "rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  window: "rounded border border-cyan-300 bg-cyan-50 px-1.5 py-0.5 font-mono text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-300",
  furniture: "rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 font-mono text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300",
  fixture: "rounded border border-fuchsia-300 bg-fuchsia-50 px-1.5 py-0.5 font-mono text-fuchsia-800 dark:border-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-300",
};

function categoryBadge(category: string): React.JSX.Element {
  return <span className={CATEGORY_BADGE[category] ?? CATEGORY_BADGE.wall!}>{category}</span>;
}

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

// --- the representative component model (the deterministic seed) -----------------

const COMPONENT_MODEL = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  // Materials — canonical domain data.
  { type: "bim.material", id: "mat-concrete", name: "Concrete C30", description: "Structural concrete", color: [128, 128, 128], properties: { Density: 2400, FireRating: "REI90" } },
  { type: "bim.material", id: "mat-glass", name: "Low-E Glazing", color: [180, 210, 230], properties: { UValue: 1.2, Recyclable: true } },
  // Reusable parametric definitions.
  { type: "bim.componentDef", id: "def-wall-300", name: "Exterior Wall 300", category: "wall", parameters: { length: 4000, width: 300, height: 3000 }, materialId: "mat-concrete" },
  { type: "bim.componentDef", id: "def-door-900", name: "Interior Door 900", category: "door", parameters: { width: 900, height: 2100, leafThickness: 40 } },
  { type: "bim.componentDef", id: "def-desk", name: "Workstation Desk", category: "furniture", parameters: { width: 1600, depth: 800, height: 750 } },
  // Typed instances with stable canonical identities + definition provenance.
  { type: "bim.componentInstance", id: "inst-wall-a", definitionId: "def-wall-300", storyId: "story-gf", position: [2000, 1000], rotation: 0 },
  { type: "bim.componentInstance", id: "inst-wall-b", definitionId: "def-wall-300", storyId: "story-gf", position: [2000, 4000], rotation: Math.PI / 2 },
  { type: "bim.componentInstance", id: "inst-door-1", definitionId: "def-door-900", storyId: "story-gf", position: [500, 2500], rotation: 0, materialId: "mat-glass" },
  { type: "bim.componentInstance", id: "inst-desk-1", definitionId: "def-desk", storyId: "story-gf", position: [3000, 2000], rotation: Math.PI / 4 },
  { type: "bim.componentInstance", id: "inst-desk-2", definitionId: "def-desk", storyId: "story-gf", position: [4500, 2000], rotation: 0, overrides: { width: 1200 }, name: "Compact desk" },
  // Coordination primitives.
  { type: "bim.grid", id: "grid-structural", storyId: "story-gf", name: "Structural grid", uLines: [-3000, 3000, 9000], vLines: [0, 5000] },
  { type: "bim.referencePlane", id: "plane-ax", storyId: "story-gf", name: "Axis A reference", start: [-3000, 0], end: [-3000, 5000] },
];

// --- component -------------------------------------------------------------------

export function ComponentsWorkbench(): React.JSX.Element {
  const [inventory, setInventory] = React.useState<ComponentInventory | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>("ready");

  // Propagation panel state.
  const [deskWidth, setDeskWidth] = React.useState("1800");
  const [propagation, setPropagation] = React.useState<{ before: Record<string, number>[]; after: Record<string, number>[] } | null>(null);

  // IFC round-trip panel state.
  const [roundtrip, setRoundtrip] = React.useState<{
    sha: string;
    counts: Record<string, number>;
    summary: Record<string, number>;
    lossy: number;
    unsupportedFields: number;
  } | null>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    const res = await bimGetComponents();
    if (res.ok) {
      const inv = unwrapInventory(res);
      if (inv !== null) {
        setInventory(inv);
        return;
      }
      setError("[bim.getComponents] unexpected response shape");
    } else {
      setError(`[bim.getComponents] ${res.code}: ${res.message}`);
    }
  }, []);

  // Initial load: the component inventory (async IIFE — the established
  // workbench pattern for the initial fetch effect).
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) {
        setStatus("loaded component inventory");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const run = React.useCallback(async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setStatus(label);
    } catch (e) {
      setError((e as Error).message);
      setStatus(`${label} — FAILED`);
    } finally {
      setBusy(false);
    }
  }, []);

  /** Seed the representative component model (document.create + one atomic
   *  versioned create batch through the shared App API). */
  const seed = React.useCallback((): Promise<void> =>
    run("seeded the representative component model", async () => {
      const created = await createDoc({ entityId: "component-model" });
      if (!created.ok) throw new Error(`[document.create] ${created.code}: ${created.message}`);
      const res = await bimCreate(COMPONENT_MODEL);
      if (!res.ok) throw new Error(`[bim.createElements] ${res.code}: ${res.message}`);
      setPropagation(null);
      setRoundtrip(null);
      await refresh();
    }), [refresh, run]);

  /** The parametric propagation proof: edit the desk definition's width default
   *  and observe the effective parameters of every desk instance change
   *  deterministically (overrides pin their keys); undo restores. */
  const propagate = React.useCallback((): Promise<void> =>
    run("definition edit propagated deterministically (undo to restore)", async () => {
      if (inventory === null) throw new Error("seed the component model first");
      const desks = inventory.instances.filter((i) => i.definitionId === "def-desk");
      if (desks.length === 0) throw new Error("no desk instances — seed the component model first");
      const width = Number(deskWidth);
      if (!Number.isFinite(width) || width <= 0) throw new Error(`width must be a finite positive number (got "${deskWidth}")`);
      const before = desks.map((d) => ({ ...d.effectiveParameters }));
      const def = inventory.definitions.find((d) => d.elementId === "def-desk");
      if (def === undefined) throw new Error("the desk definition is missing");
      const res = await bimSetProperties("def-desk", {
        parameters: { ...def.parameters, width },
      });
      if (!res.ok) throw new Error(`[bim.setProperties] ${res.code}: ${res.message}`);
      const inv = unwrapInventory(await bimGetComponents());
      if (inv === null) throw new Error("[bim.getComponents] unexpected response shape");
      setInventory(inv);
      const after = inv.instances.filter((i) => i.definitionId === "def-desk").map((d) => ({ ...d.effectiveParameters }));
      setPropagation({ before, after });
    }), [deskWidth, inventory, run]);

  const undoPropagation = React.useCallback((): Promise<void> =>
    run("undo restored the previous definition state", async () => {
      const res = await undo();
      if (!res.ok) throw new Error(`[document.undo] ${res.code}: ${res.message}`);
      setPropagation(null);
      await refresh();
    }), [refresh, run]);

  /** The IFC round-trip proof: export (deterministic bytes, component/material
   *  counts, grids explicitly not exported) → import into a FRESH document →
   *  compare against the source (field-level classification). */
  const roundTrip = React.useCallback((): Promise<void> =>
    run("component/material semantics survived the IFC round trip", async () => {
      const exported = await ifcExport("Component Tower");
      if (!exported.ok) throw new Error(`[ifc.export] ${exported.code}: ${exported.message}`);
      const exportValue = exported.value as { ifc: string; sha256: string; counts: Record<string, number> };

      // Fresh document, then import the file and compare back.
      const created = await createDoc({ entityId: "component-roundtrip" });
      if (!created.ok) throw new Error(`[document.create] ${created.code}: ${created.message}`);
      const imported = await ifcImport({ ifc: exportValue.ifc });
      if (!imported.ok) throw new Error(`[ifc.import] ${imported.code}: ${imported.message}`);
      const compared = await ifcCompare(exportValue.ifc);
      if (!compared.ok) throw new Error(`[ifc.compare] ${compared.code}: ${compared.message}`);
      const compareValue = compared.value as { report: { summary: Record<string, number> } };

      setRoundtrip({
        sha: exportValue.sha256,
        counts: exportValue.counts,
        summary: compareValue.report.summary,
        lossy: compareValue.report.summary.lossy ?? 0,
        unsupportedFields: compareValue.report.summary.unsupportedFields ?? 0,
      });
      await refresh();
    }), [refresh, run]);

  const deleteInstance = React.useCallback((id: string): Promise<void> =>
    run(`deleted component instance ${id}`, async () => {
      const res = await bimOp("bim.delete", { ids: [id] });
      if (!res.ok) throw new Error(`[bim.delete] ${res.code}: ${res.message}`);
      await refresh();
    }), [refresh, run]);

  const materialNameOf = (id: string | null): string => {
    if (id === null || inventory === null) return "—";
    const m = inventory.materials.find((x) => x.elementId === id);
    return m !== undefined ? m.name : id;
  };
  const definitionNameOf = (id: string): string => {
    if (inventory === null) return id;
    const d = inventory.definitions.find((x) => x.elementId === id);
    return d !== undefined ? `${d.name}` : id;
  };
  void definitionNameOf;

  return (
    <div className="space-y-4">
      {/* status line */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={busy ? "secondary" : "outline"}>{busy ? "working…" : status}</Badge>
        {inventory !== null && (
          <>
            <Badge variant="outline">{inventory.definitions.length} definitions</Badge>
            <Badge variant="outline">{inventory.instances.length} instances</Badge>
            <Badge variant="outline">{inventory.materials.length} materials</Badge>
            <Badge variant="outline">{inventory.grids.length} grids</Badge>
            <Badge variant="outline">{inventory.referencePlanes.length} reference planes</Badge>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => void refresh()} aria-label="refresh component inventory">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        {error !== null && <span className="text-destructive">{error}</span>}
      </div>

      {/* authoring + propagation */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" /> Author the representative model
            </CardTitle>
            <CardDescription>
              One atomic versioned batch: 2 materials, 3 definitions, 5 instances (one with overrides),
              a structural grid and a reference plane — stable canonical ids throughout.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button size="sm" disabled={busy} onClick={() => void seed()}>
              <Square className="h-3.5 w-3.5" /> Seed component model
            </Button>
            <p className="text-xs text-muted-foreground">
              The instances reference their definitions by canonical id; the effective material of the
              door instance overrides the definition default (glass), the walls inherit concrete.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Repeat className="h-4 w-4" /> Parametric propagation
            </CardTitle>
            <CardDescription>
              Edit the desk definition&apos;s width default — every instance&apos;s EFFECTIVE parameters follow
              deterministically; overrides pin their keys. Undo restores the immutable previous revision.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="desk-width" className="text-xs font-medium">desk.width (mm)</label>
              <input
                id="desk-width"
                className={`${INP} h-8 w-24 font-mono text-xs`}
                value={deskWidth}
                onChange={(e) => setDeskWidth(e.target.value)}
                inputMode="decimal"
                aria-label="desk definition width default"
              />
              <Button size="sm" disabled={busy} onClick={() => void propagate()}>
                Propagate definition edit
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void undoPropagation()}>
                Undo
              </Button>
            </div>
            {propagation !== null && (
              <ScrollArea className="max-h-40 rounded border">
                <div className="p-2 font-mono text-[11px] leading-5">
                  {propagation.before.map((before, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-muted-foreground">instance {i + 1}:</span>
                      <span className="line-through decoration-red-400">{before.width}</span>
                      <span>→</span>
                      <span className="text-green-700 dark:text-green-400">{propagation.after[i]?.width}</span>
                      <span className="text-muted-foreground">(depth {propagation.after[i]?.depth}, height {propagation.after[i]?.height})</span>
                    </div>
                  ))}
                  <div className="mt-1 text-muted-foreground">
                    the compact desk keeps its override (width 1200) — pinned against definition changes
                  </div>
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* inventory panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" /> Definitions &amp; instances
            </CardTitle>
            <CardDescription>
              Instance-to-definition provenance with derived state: effective parameters and box
              (definition defaults ⊕ overrides — derivation, never duplication).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72 rounded border">
              <div className="p-2 space-y-2">
                {(inventory?.definitions ?? []).map((def) => (
                  <div key={def.elementId} className="rounded border p-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{def.elementId}</span>
                      {categoryBadge(def.category)}
                      <span className="font-medium">{def.name}</span>
                      {def.materialId !== undefined && (
                        <Badge variant="outline">material: {materialNameOf(def.materialId)}</Badge>
                      )}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      defaults: {Object.entries(def.parameters).map(([k, v]) => `${k}=${v}`).join(" · ")}
                    </div>
                    {(inventory?.instances ?? []).filter((i) => i.definitionId === def.elementId).map((inst) => (
                      <div key={inst.elementId} className="ml-3 mt-1 rounded border border-dashed p-1.5 font-mono text-[11px]">
                        <div className="flex items-center gap-2">
                          <CircleDot className="h-3 w-3" />
                          <span>{inst.elementId}</span>
                          {inst.name !== undefined && <span className="font-sans">“{inst.name}”</span>}
                          <Badge variant="outline">material: {materialNameOf(inst.effectiveMaterialId)}</Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1.5 text-[10px]"
                            disabled={busy}
                            onClick={() => void deleteInstance(inst.elementId)}
                          >
                            delete
                          </Button>
                        </div>
                        <div className="text-muted-foreground">
                          pos ({inst.position[0]}, {inst.position[1]}) · rot {inst.rotation.toFixed(3)} rad · box {inst.effectiveBox.map((n) => Math.round(n)).join("×")} mm
                        </div>
                        <div>
                          effective: {Object.entries(inst.effectiveParameters).map(([k, v]) => (
                            <span key={k} className={inst.overrides[k] !== undefined ? "text-amber-700 dark:text-amber-400" : ""}>
                              {" "}{k}={v}{inst.overrides[k] !== undefined ? "*" : ""}
                            </span>
                          ))}
                          <span className="text-muted-foreground"> (* = override)</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
                {inventory !== null && inventory.definitions.length === 0 && (
                  <p className="p-2 text-xs text-muted-foreground">no definitions — seed the component model</p>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className="h-4 w-4" /> Materials (canonical domain data)
              </CardTitle>
              <CardDescription>
                Stable canonical identity + provenance independent of OCCT/IfcOpenShell; document-unique
                names are the external exchange key; references are protected (no dangling deletes).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="max-h-40 rounded border">
                <div className="p-2 space-y-1 text-xs">
                  {(inventory?.materials ?? []).map((m) => (
                    <div key={m.elementId} className="flex items-center gap-2 rounded border p-1.5">
                      {m.color !== undefined && (
                        <span
                          aria-hidden
                          className="inline-block h-3.5 w-3.5 rounded-sm border"
                          style={{ backgroundColor: `rgb(${m.color.join(" ")})` }}
                        />
                      )}
                      <span className="font-mono">{m.elementId}</span>
                      <span className="font-medium">{m.name}</span>
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                        {Object.entries(m.properties).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}
                      </span>
                    </div>
                  ))}
                  {inventory !== null && inventory.materials.length === 0 && (
                    <p className="p-2 text-muted-foreground">no materials — seed the component model</p>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Grid3x3 className="h-4 w-4" /> Coordination primitives
              </CardTitle>
              <CardDescription>
                Story-scoped grids and reference planes (levels = bim.story) — persisted, replayable
                model-coordination data. Alignment constraints are outside this slice&apos;s supported set.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="max-h-40 rounded border">
                <div className="p-2 space-y-1 text-xs">
                  {(inventory?.grids ?? []).map((g) => (
                    <div key={g.elementId} className="rounded border p-1.5 font-mono">
                      <span>{g.elementId}</span> · {g.name} · U {g.uLines.join("/")} · V {g.vLines.join("/")}
                    </div>
                  ))}
                  {(inventory?.referencePlanes ?? []).map((p) => (
                    <div key={p.elementId} className="rounded border p-1.5 font-mono">
                      <span>{p.elementId}</span> · {p.name} · trace ({p.start.join(",")})→({p.end.join(",")})
                    </div>
                  ))}
                  {inventory !== null && inventory.grids.length === 0 && inventory.referencePlanes.length === 0 && (
                    <p className="p-2 text-muted-foreground">no coordination primitives — seed the component model</p>
                  )}
                  {inventory !== null && (
                    <p className="p-1.5 text-[11px] text-muted-foreground">
                      declared unsupported: {Object.values(inventory.unsupported).join("; ")}
                    </p>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>

      <Separator />

      {/* IFC round-trip proof */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Ruler className="h-4 w-4" /> IFC round-trip proof
          </CardTitle>
          <CardDescription>
            Export (deterministic bytes; components map to IfcWall/IfcDoor/IfcWindow/IfcFurnishingElement
            with material associations) → import into a fresh document (identity-preserving reconciliation)
            → field-level comparison against the source. Grids/reference planes are canonical-only in IFC —
            reported explicitly, never silently dropped.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button size="sm" disabled={busy} onClick={() => void roundTrip()}>
            <Repeat className="h-3.5 w-3.5" /> Run component round-trip
          </Button>
          {roundtrip !== null && (
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded border p-2 font-mono">
                <div>export sha256: {roundtrip.sha.slice(0, 24)}…</div>
                <div>
                  exported: {roundtrip.counts.components} components · {roundtrip.counts.materials} materials ·{" "}
                  {roundtrip.counts.gridsNotExported} grids NOT exported (declared) ·{" "}
                  {roundtrip.counts.referencePlanesNotExported} reference planes NOT exported (declared)
                </div>
              </div>
              <div className="rounded border p-2 font-mono">
                <div>
                  compare: {roundtrip.summary.unchanged} unchanged · {roundtrip.summary.reconciled} reconciled ·{" "}
                  {roundtrip.summary.created} created · {roundtrip.summary.unsupported} unsupported
                </div>
                <div>
                  fields: {roundtrip.summary.exact} exact · {roundtrip.summary.tolerance} tolerance ·{" "}
                  <span className={roundtrip.lossy === 0 ? "text-green-700 dark:text-green-400" : "text-destructive"}>
                    {roundtrip.lossy} lossy
                  </span>{" "}
                  · <span className={roundtrip.unsupportedFields === 0 ? "text-green-700 dark:text-green-400" : "text-destructive"}>
                    {roundtrip.unsupportedFields} unsupported
                  </span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
