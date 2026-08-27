"use client";

/**
 * Offisos IFC / openBIM Workbench — Web host surface (COMPAT-IFC-001 /
 * Issue #47, Architecture v1.1 FROZEN).
 *
 * A REAL openBIM interoperability workflow, not a mockup: deterministic IFC4
 * export through `ifc.export` (byte-identical for equal inputs — the
 * determinism proof button re-exports and compares the sha256), IFC import +
 * reconciliation through `ifc.import` (ONE atomic versioned command with a
 * field-level exact/tolerance/lossy/unsupported report and declared
 * fallbacks recorded, never silent), the dry-run `ifc.compare`, IDS
 * specification validation through `ifc.idsValidate` (per-entity results
 * bound to canonical provenance), BCF issue round trips through
 * `ifc.bcfCreate` / `ifc.bcfParse` (references resolve back to canonical
 * ids — BCF is a transport contract, never the system of record), and the
 * persisted deterministic import records (`ifc.listImports`). Typed errors
 * ifc_unavailable / ifc_invalid / ifc_unsupported are displayed honestly.
 *
 * Every mutation goes through fetch("/api/cad") exactly like the Electron
 * host (Web/Electron parity, §5.5). Client-safety: only the pure BIM entity
 * parser (`bim/elements.js`) and the transport are imported — the
 * IfcOpenShell interop engine stays server-side behind the frozen ifc.* App
 * API (LOCK-003/018).
 */

import * as React from "react";
import {
  Boxes,
  Download,
  FileCode2,
  GitCompareArrows,
  MessageSquareWarning,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { CommandQueryResponse, ErrResult } from "@offisos/cad-app-shell/contracts/app-api";
import { elementToBimEntitySafe, type BimEntity } from "@offisos/cad-app-shell/bim/elements.js";

import {
  bimCreate,
  createDoc,
  getState,
  ifcBcfCreate,
  ifcBcfParse,
  ifcCompare,
  ifcExport,
  ifcIdsValidate,
  ifcImport,
  ifcListImports,
  ifcProbe,
  unwrapIfcBcfCreate,
  unwrapIfcBcfParse,
  unwrapIfcCompare,
  unwrapIfcExport,
  unwrapIfcIdsValidate,
  unwrapIfcImport,
  unwrapIfcListImports,
  unwrapIfcProbe,
} from "@/cad/client/http-transport";
import type {
  IfcBcfCreateResult,
  IfcBcfParseResult,
  IfcCompareResult,
  IfcElementAction,
  IfcElementReport,
  IfcExportResult,
  IfcFieldClassification,
  IfcFieldResult,
  IfcIdsValidateResult,
  IfcImportRecord,
  IfcImportResult,
  IfcProbeResult,
} from "@/cad/client/http-transport";

// --- constants + helpers ------------------------------------------------------

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

/** The representative building (ifc-roundtrip test-suite precedent: the
 *  docs/bim building + a rotated wall so the placement-rotation
 *  reconstruction is exercised): 1 story, 4 walls (incl. wall-rot, rotated),
 *  slab, 2 openings, door, window, space — ONE atomic bim.createElements
 *  batch with explicit same-batch ids. */
const SEED_BUILDING: readonly Record<string, unknown>[] = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-rot", storyId: "story-gf", start: [1000, 2000], end: [4000, 5000], width: 250, height: 2800, baseOffset: 200 },
  { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
  { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
  { type: "bim.opening", id: "op-door-rot", hostId: "wall-rot", distance: 1000, width: 800, height: 2000, sill: 100 },
  { type: "bim.door", id: "door-main", openingId: "op-door", swing: "right", leafThickness: 45 },
  { type: "bim.window", id: "window-rot", openingId: "op-door-rot" },
  { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
];

/** IDS prefill: the fire-rating spec (test-suite fixture precedent) — every
 *  IFCWALL must declare Pset_OffisosCustom.FireRating. */
const IDS_PREFILL = `<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
    <info>
        <title>Fire rating declared</title>
    </info>
    <specifications>
        <specification name="Walls must declare fire ratings" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
            <applicability minOccurs="1" maxOccurs="unbounded">
                <entity>
                    <name>
                        <simpleValue>IFCWALL</simpleValue>
                    </name>
                </entity>
            </applicability>
            <requirements>
                <property dataType="IFCLABEL" cardinality="required">
                    <propertySet>
                        <simpleValue>Pset_OffisosCustom</simpleValue>
                    </propertySet>
                    <baseName>
                        <simpleValue>FireRating</simpleValue>
                    </baseName>
                </property>
            </requirements>
        </specification>
    </specifications>
</ids>`;

/** Field-classification chip palette (exact=green, tolerance=amber,
 *  lossy=red, unsupported=gray). */
const FIELD_CLASS_CLASS: Record<IfcFieldClassification, string> = {
  exact: "rounded border border-green-300 bg-green-50 px-1.5 py-0.5 font-mono text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
  tolerance: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  lossy: "rounded border border-red-300 bg-red-50 px-1.5 py-0.5 font-mono text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  unsupported: "rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 font-mono text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

/** Per-element action chip palette. */
const ACTION_CLASS: Record<IfcElementAction, string> = {
  created: "rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  reconciled: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  unchanged: "rounded border border-green-300 bg-green-50 px-1.5 py-0.5 font-mono text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
  unsupported: "rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 font-mono text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

function fieldTitle(f: IfcFieldResult): string {
  const parts: string[] = [`${f.field} — ${f.classification}`];
  if (f.expected !== undefined) parts.push(`expected: ${String(f.expected)}`);
  if (f.actual !== undefined) parts.push(`actual: ${String(f.actual)}`);
  if (f.tolerance !== undefined) parts.push(`tolerance: ${f.tolerance} mm`);
  if (f.note !== undefined) parts.push(f.note);
  return parts.join(" · ");
}

function truncate(s: string, n = 18): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function toNum(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a finite number (got "${value}")`);
  }
  return n;
}

function entityLabel(e: BimEntity): string {
  const short = e.type.replace("bim.", "");
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? `${e.id} · ${short} “${name}”` : `${e.id} · ${short}`;
}

/** Browser base64 helpers (no Node APIs in the renderer). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(b64: string, type: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Every non-unchanged element of a comparison report (the honest diff). */
function reportDiff(report: { elements: readonly IfcElementReport[] }): IfcElementReport[] {
  return report.elements.filter((e) => e.action !== "unchanged");
}

// --- component -----------------------------------------------------------------

export function IfcWorkbench(): React.JSX.Element {
  // --- document + interop state ------------------------------------------------
  const [snapshot, setSnapshot] = React.useState<CADDocumentSnapshot | null>(null);
  const [probe, setProbe] = React.useState<IfcProbeResult | null>(null);
  const [records, setRecords] = React.useState<IfcImportRecord[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>("ready");

  // --- export panel --------------------------------------------------------------
  const [exportResult, setExportResult] = React.useState<IfcExportResult | null>(null);
  const [determinism, setDeterminism] = React.useState<{ identical: boolean; sha: string } | null>(null);

  // --- import panel ---------------------------------------------------------------
  const [importInput, setImportInput] = React.useState("");
  const [storyHeightForm, setStoryHeightForm] = React.useState("");
  const [spaceHeightForm, setSpaceHeightForm] = React.useState("");
  const [importResult, setImportResult] = React.useState<IfcImportResult | null>(null);
  const importFileRef = React.useRef<HTMLInputElement>(null);

  // --- compare / IDS panels ---------------------------------------------------------
  const [compareResult, setCompareResult] = React.useState<IfcCompareResult | null>(null);
  const [idsXml, setIdsXml] = React.useState(IDS_PREFILL);
  const [idsResult, setIdsResult] = React.useState<IfcIdsValidateResult | null>(null);

  // --- BCF panel ---------------------------------------------------------------------
  const [bcfForm, setBcfForm] = React.useState({
    title: "Verify wall fire rating",
    description: "The referenced walls must be checked against the IDS fire-rating specification.",
    author: "architect",
    type: "Issue",
    status: "Open",
    comment: "Checked against IDS: missing rating.",
    commentAuthor: "reviewer",
  });
  const [bcfElements, setBcfElements] = React.useState<string[]>([]);
  const [bcfResult, setBcfResult] = React.useState<IfcBcfCreateResult | null>(null);
  const [bcfParsed, setBcfParsed] = React.useState<IfcBcfParseResult | null>(null);

  // --- derived from the snapshot (pure client-side parse, same core as server) --

  const bimEntities = React.useMemo(() => {
    const out: BimEntity[] = [];
    for (const el of snapshot?.elements ?? []) {
      const entity = elementToBimEntitySafe(el);
      if (entity !== null) out.push(entity);
    }
    return out;
  }, [snapshot]);

  // --- refresh + exec (the docs-workbench proven pattern) ------------------------

  const refresh = React.useCallback(async (): Promise<void> => {
    const [stateRes, listRes] = await Promise.all([getState(), ifcListImports()]);
    if (stateRes.ok) {
      setSnapshot(stateRes.value as CADDocumentSnapshot);
    } else {
      setError(`[document.getState] ${stateRes.code}: ${stateRes.message}`);
    }
    if (listRes.ok) {
      const listed = unwrapIfcListImports(listRes);
      if (listed !== null) {
        setRecords(listed);
      } else {
        setError("[ifc.listImports] unexpected response shape");
      }
    } else {
      setError(`[ifc.listImports] ${listRes.code}: ${listRes.message}`);
    }
  }, []);

  // Initial load: probe the interop toolchain + document/import-record state.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      const probeRes = await ifcProbe();
      if (!cancelled) {
        setProbe(unwrapIfcProbe(probeRes));
        if (!probeRes.ok) {
          setError(`[ifc.probe] ${probeRes.code}: ${probeRes.message}`);
        }
      }
      await refresh();
      if (!cancelled) {
        setStatus("loaded IFC interop state");
        setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /** Run one async operation with the busy guard, typed-error surfacing and
   *  the trailing refresh. */
  const exec = React.useCallback(
    async (label: string, fn: () => Promise<CommandQueryResponse>): Promise<CommandQueryResponse> => {
      setBusy(true);
      setError(null);
      let res: CommandQueryResponse;
      try {
        res = await fn();
      } catch (e) {
        res = { ok: false, code: "unexpected", message: (e as Error).message, retryable: false };
      }
      if (!res.ok) {
        setError(`[${label}] ${res.code}: ${res.message}`);
      }
      await refresh();
      setBusy(false);
      return res;
    },
    [refresh],
  );

  // --- actions -------------------------------------------------------------------

  /** One-click representative model: document.create + the canonical IFC
   *  building in ONE atomic bim.createElements batch. */
  const onSeed = React.useCallback(() => {
    void (async () => {
      setBusy(true);
      setError(null);
      setStatus("seeding the representative building…");
      const fail = async (label: string, res: ErrResult): Promise<void> => {
        setError(`[${label}] ${res.code}: ${res.message}`);
        await refresh();
        setBusy(false);
      };
      try {
        const r0 = await createDoc({ entityId: "ifc-workbench" });
        if (!r0.ok) {
          await fail("document.create", r0);
          return;
        }
        const r1 = await bimCreate([...SEED_BUILDING]);
        if (!r1.ok) {
          await fail("bim.createElements", r1);
          return;
        }
        // Fresh document: interop results from the previous document are stale.
        setExportResult(null);
        setDeterminism(null);
        setImportResult(null);
        setCompareResult(null);
        setIdsResult(null);
        setBcfResult(null);
        setBcfParsed(null);
        setBcfElements([]);
        setStatus(
          "seeded the representative building — 11 BIM elements (1 story, 4 walls incl. the rotated wall-rot, slab, 2 openings, door, window, space) in 1 atomic revision",
        );
        await refresh();
      } catch (e) {
        setError(`[seed] unexpected: ${(e as Error).message}`);
        await refresh();
      } finally {
        setBusy(false);
      }
    })();
  }, [refresh]);

  const onExport = React.useCallback(() => {
    void (async () => {
      setStatus("exporting the model to IFC… (the IfcOpenShell worker builds deterministic bytes)");
      const res = await exec("ifc.export", () => ifcExport());
      if (res.ok) {
        const ex = unwrapIfcExport(res);
        if (ex === null) {
          setError("[ifc.export] unexpected response shape");
          setExportResult(null);
        } else {
          setExportResult(ex);
          const c = ex.counts;
          setStatus(
            `exported ${ex.schema} · ${ex.size.toLocaleString()} bytes · ${c.stories} story, ${c.walls} walls, ${c.slabs} slab, ${c.openings} openings, ${c.doors} door, ${c.windows} window, ${c.spaces} space`,
          );
        }
      } else {
        setExportResult(null);
      }
    })();
  }, [exec]);

  /** Determinism proof: export TWICE, assert the sha256 is identical. */
  const onDeterminism = React.useCallback(() => {
    void (async () => {
      setBusy(true);
      setError(null);
      setStatus("proving export determinism — building the file twice…");
      try {
        const r1 = await ifcExport();
        const r2 = await ifcExport();
        if (!r1.ok) {
          setError(`[ifc.export #1] ${r1.code}: ${r1.message}`);
        } else if (!r2.ok) {
          setError(`[ifc.export #2] ${r2.code}: ${r2.message}`);
        } else {
          const e1 = unwrapIfcExport(r1);
          const e2 = unwrapIfcExport(r2);
          if (e1 === null || e2 === null) {
            setError("[ifc.export] unexpected response shape");
            setDeterminism(null);
          } else {
            const identical = e1.sha256 === e2.sha256 && e1.size === e2.size;
            setDeterminism({ identical, sha: e2.sha256 });
            setExportResult(e2);
            setStatus(
              identical
                ? `determinism proven — two independent exports are byte-identical (sha256 ${e2.sha256.slice(0, 16)}…)`
                : "determinism FAILED — two exports of the same model diverged",
            );
          }
        }
      } catch (e) {
        setError(`[ifc.determinism] unexpected: ${(e as Error).message}`);
      } finally {
        await refresh();
        setBusy(false);
      }
    })();
  }, [refresh]);

  const onDownloadIfc = React.useCallback(() => {
    if (exportResult === null) return;
    downloadBlob(base64ToBlob(exportResult.ifc, "application/x-step"), "offisos-export.ifc");
    setStatus(`downloaded offisos-export.ifc (${exportResult.size.toLocaleString()} bytes, sha256 ${exportResult.sha256.slice(0, 16)}…)`);
  }, [exportResult]);

  const onImportFileChosen = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        const b64 = bytesToBase64(new Uint8Array(buffer));
        setImportInput(b64);
        setStatus(`loaded ${file.name} (${b64.length.toLocaleString()} base64 chars) — ready to import`);
      } catch (err) {
        setError(`[Import file] failed to read file: ${(err as Error).message}`);
      } finally {
        if (importFileRef.current) importFileRef.current.value = "";
      }
    },
    [],
  );

  const onUseLastExport = React.useCallback(() => {
    if (exportResult === null) return;
    setImportInput(exportResult.ifc);
    setStatus("staged the last export for import — it should reconcile all-unchanged");
  }, [exportResult]);

  const onImport = React.useCallback(() => {
    void (async () => {
      try {
        const b64 = importInput.trim();
        if (b64 === "") {
          throw new Error("paste base64, load a .ifc file, or stage the last export first");
        }
        const payload: { ifc: string; defaultStoryHeight?: number; defaultSpaceHeight?: number } = { ifc: b64 };
        if (storyHeightForm.trim() !== "") {
          const n = toNum(storyHeightForm, "defaultStoryHeight");
          if (n <= 0) throw new Error("defaultStoryHeight must be > 0 (mm)");
          payload.defaultStoryHeight = n;
        }
        if (spaceHeightForm.trim() !== "") {
          const n = toNum(spaceHeightForm, "defaultSpaceHeight");
          if (n <= 0) throw new Error("defaultSpaceHeight must be > 0 (mm)");
          payload.defaultSpaceHeight = n;
        }
        setStatus("importing + reconciling the IFC file…");
        const res = await exec("ifc.import", () => ifcImport(payload));
        if (res.ok) {
          const imp = unwrapIfcImport(res);
          if (imp === null) {
            setError("[ifc.import] unexpected response shape");
            setImportResult(null);
          } else {
            setImportResult(imp);
            const s = imp.report.summary;
            setStatus(
              `import ${imp.record.id} — created ${s.created}, reconciled ${s.reconciled}, unchanged ${s.unchanged}, unsupported ${s.unsupported} (report hash ${imp.reportHash.slice(0, 12)}…)`,
            );
          }
        } else {
          setImportResult(null);
        }
      } catch (e) {
        setError(`[ifc.import] ${(e as Error).message}`);
      }
    })();
  }, [importInput, storyHeightForm, spaceHeightForm, exec]);

  const onCompare = React.useCallback(() => {
    if (exportResult === null) return;
    void (async () => {
      setStatus("comparing the last export against the current model (dry run)…");
      const res = await exec("ifc.compare", () => ifcCompare(exportResult.ifc));
      if (res.ok) {
        const cmp = unwrapIfcCompare(res);
        if (cmp === null) {
          setError("[ifc.compare] unexpected response shape");
          setCompareResult(null);
        } else {
          setCompareResult(cmp);
          const s = cmp.report.summary;
          setStatus(
            `compare — created ${s.created}, reconciled ${s.reconciled}, unchanged ${s.unchanged}, unsupported ${s.unsupported} (report hash ${cmp.reportHash.slice(0, 12)}…)`,
          );
        }
      } else {
        setCompareResult(null);
      }
    })();
  }, [exportResult, exec]);

  const onIdsValidate = React.useCallback(() => {
    void (async () => {
      try {
        const xml = idsXml.trim();
        if (xml === "") throw new Error("paste an IDS specification XML first");
        setStatus("validating the IDS specification against the current document's export…");
        const res = await exec("ifc.idsValidate", () => ifcIdsValidate(xml));
        if (res.ok) {
          const ids = unwrapIfcIdsValidate(res);
          if (ids === null) {
            setError("[ifc.idsValidate] unexpected response shape");
            setIdsResult(null);
          } else {
            setIdsResult(ids);
            const spec = ids.specs[0];
            const passed = spec?.entities.filter((en) => en.passed).length ?? 0;
            setStatus(
              `IDS validated (${ids.schema}) — ${ids.specs.length} spec(s)` +
                (spec !== undefined ? `, ${passed}/${spec.entities.length} applicable entities pass` : ""),
            );
          }
        } else {
          setIdsResult(null);
        }
      } catch (e) {
        setError(`[ifc.idsValidate] ${(e as Error).message}`);
      }
    })();
  }, [idsXml, exec]);

  const onBcfCreate = React.useCallback(() => {
    void (async () => {
      try {
        const title = bcfForm.title.trim();
        if (title === "") throw new Error("a topic needs a title");
        const topic = {
          title,
          description: bcfForm.description,
          author: bcfForm.author.trim() !== "" ? bcfForm.author.trim() : undefined,
          type: bcfForm.type.trim() !== "" ? bcfForm.type.trim() : undefined,
          status: bcfForm.status.trim() !== "" ? bcfForm.status.trim() : undefined,
          comment: bcfForm.comment.trim() !== "" ? bcfForm.comment.trim() : undefined,
          commentAuthor: bcfForm.commentAuthor.trim() !== "" ? bcfForm.commentAuthor.trim() : undefined,
          elementIds: bcfElements,
        };
        setStatus("building the .bcf container…");
        const res = await exec("ifc.bcfCreate", () => ifcBcfCreate([topic]));
        if (res.ok) {
          const bcf = unwrapIfcBcfCreate(res);
          if (bcf === null) {
            setError("[ifc.bcfCreate] unexpected response shape");
            setBcfResult(null);
          } else {
            setBcfResult(bcf);
            setBcfParsed(null);
            downloadBlob(base64ToBlob(bcf.bcf, "application/zip"), "offisos-topic.bcf");
            setStatus(`created + downloaded offisos-topic.bcf (${bcf.size.toLocaleString()} bytes, ${bcf.referencedCanonicalIds} referenced guid(s)) — parse it to verify the round trip`);
          }
        } else {
          setBcfResult(null);
        }
      } catch (e) {
        setError(`[ifc.bcfCreate] ${(e as Error).message}`);
      }
    })();
  }, [bcfForm, bcfElements, exec]);

  const onBcfParse = React.useCallback(() => {
    if (bcfResult === null) return;
    void (async () => {
      setStatus("parsing the .bcf container back…");
      const res = await exec("ifc.bcfParse", () => ifcBcfParse(bcfResult.bcf));
      if (res.ok) {
        const parsed = unwrapIfcBcfParse(res);
        if (parsed === null) {
          setError("[ifc.bcfParse] unexpected response shape");
          setBcfParsed(null);
        } else {
          setBcfParsed(parsed);
          const resolved = parsed.topics.flatMap((t) => t.resolvedCanonicalIds).filter((id) => id !== null).length;
          setStatus(`BCF round trip — ${parsed.topics.length} topic(s) parsed, ${resolved} reference(s) resolved to canonical ids`);
        }
      } else {
        setBcfParsed(null);
      }
    })();
  }, [bcfResult, exec]);

  // --- render ---------------------------------------------------------------------

  const counts = exportResult?.counts;
  const compareDiff = compareResult !== null ? reportDiff(compareResult.report) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>IFC / openBIM Workbench</CardTitle>
        <CardDescription>
          Native IFC interoperability from the BIM model: deterministic IFC4 export (byte-identical for equal
          inputs), import + reconciliation with field-level exact/tolerance/lossy/unsupported classification,
          dry-run comparison, IDS specification validation bound to canonical ids, BCF issue round trips and
          persisted import records — every operation through the shared App API (COMPAT-IFC-001).
          GlobalIds are provenance only; canonical identity is the system of record.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error !== null && (
          <div role="alert" className="mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}
        <div
          data-testid="ifc-op-status"
          data-state={busy ? "busy" : error !== null ? "error" : "done"}
          className="mb-2 rounded border bg-muted/40 px-2.5 py-1.5 text-xs"
          role="status"
          aria-label="IFC operation status"
        >
          {busy ? "working… " : ""}
          {status}
        </div>
        <div
          data-testid="ifc-status"
          data-state={probe === null ? "probing" : probe.available ? "available" : "unavailable"}
          className="mb-3 flex flex-wrap items-center gap-2 rounded border px-2.5 py-1.5 text-xs"
          role="status"
          aria-label="IFC interop engine status"
        >
          {probe === null ? (
            <span className="text-muted-foreground">probing the IFC interop toolchain…</span>
          ) : probe.available ? (
            <>
              <span className="rounded border border-green-300 bg-green-50 px-1.5 py-0.5 font-medium text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                IFC interop available
              </span>
              <Badge variant="outline" className="font-mono">IfcOpenShell {probe.engineVersion}</Badge>
              <span className="text-muted-foreground">ifc.* commands/queries through the frozen adapter boundary</span>
            </>
          ) : (
            <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              IFC interop unavailable — {probe.message ?? "no interop adapter is bound to this host's engine bundle"}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-4">
          {/* --- left: export + import + compare --------------------------------- */}
          <div className="flex flex-col gap-4">
            {/* Export panel */}
            <div>
              <div className="text-sm font-semibold mb-1">Export</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                ifc.export — the model as a deterministic IFC4 file (identity psets carry the canonical ids;
                GlobalIds derive from them; version metadata never enters the file).
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" data-testid="ifc-export" disabled={busy} onClick={onExport} title="ifc.export — deterministic IFC4 bytes">
                  <FileCode2 aria-hidden="true" />
                  Export IFC
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="ifc-determinism"
                  disabled={busy}
                  onClick={onDeterminism}
                  title="export twice and assert the sha256 is identical — the byte-determinism proof"
                >
                  <ShieldCheck aria-hidden="true" />
                  Prove determinism
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="ifc-export-download"
                  disabled={busy || exportResult === null}
                  onClick={onDownloadIfc}
                  title="download the exported bytes as offisos-export.ifc"
                >
                  <Download aria-hidden="true" />
                  Download .ifc
                </Button>
              </div>
              {exportResult !== null && (
                <div data-testid="ifc-export-hash" className="mt-2 rounded border bg-muted/40 p-2.5 text-xs">
                  <p className="font-mono break-all">sha256 {exportResult.sha256}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono">{exportResult.schema}</Badge>
                    <Badge variant="outline" className="font-mono">{exportResult.size.toLocaleString()} bytes</Badge>
                    <Badge variant="outline" className="font-mono">IfcOpenShell {exportResult.engineVersion}</Badge>
                  </div>
                  {counts !== undefined && (
                    <div data-testid="ifc-export-counts" className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="font-mono">{counts.stories} stories</Badge>
                      <Badge variant="secondary" className="font-mono">{counts.walls} walls</Badge>
                      <Badge variant="secondary" className="font-mono">{counts.slabs} slabs</Badge>
                      <Badge variant="secondary" className="font-mono">{counts.openings} openings</Badge>
                      <Badge variant="secondary" className="font-mono">{counts.doors} doors</Badge>
                      <Badge variant="secondary" className="font-mono">{counts.windows} windows</Badge>
                      <Badge variant="secondary" className="font-mono">{counts.spaces} spaces</Badge>
                    </div>
                  )}
                </div>
              )}
              {determinism !== null && (
                <div data-testid="ifc-determinism-result" className="mt-2">
                  {determinism.identical ? (
                    <span className="inline-flex flex-wrap items-center gap-1 rounded border border-green-300 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                      ✓ byte-identical — two independent exports share sha256 {determinism.sha}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                      ✗ hashes diverge — the export is NOT deterministic
                    </span>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Import panel */}
            <div>
              <div className="text-sm font-semibold mb-1">Import + reconcile</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                ifc.import — parse + reconcile an IFC file into the canonical model as ONE atomic versioned
                command (created elements + patches + the deterministic import record). Paste base64, load a
                .ifc file, or stage the last export.
              </p>
              <textarea
                data-testid="ifc-import-input"
                aria-label="IFC base64 payload"
                className="w-full min-h-20 border rounded px-2 py-1 text-xs font-mono bg-transparent break-all"
                placeholder="base64 IFC payload…"
                value={importInput}
                onChange={(e) => setImportInput(e.target.value)}
                spellCheck={false}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => importFileRef.current?.click()}
                  title="read a .ifc file as base64 into the payload field"
                >
                  <Upload aria-hidden="true" />
                  Load .ifc file…
                </Button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".ifc,.IFC,text/plain"
                  className="sr-only"
                  aria-hidden="true"
                  tabIndex={-1}
                  onChange={onImportFileChosen}
                />
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="ifc-import-use-export"
                  disabled={busy || exportResult === null}
                  onClick={onUseLastExport}
                  title="stage the last export — importing it into the same document should reconcile all-unchanged"
                >
                  Use last export
                </Button>
                <Button size="sm" data-testid="ifc-import-run" disabled={busy} onClick={onImport} title="ifc.import — reconcile into the current document (1 atomic revision)">
                  Import + reconcile
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5 items-start text-sm">
                <Field label="defaultStoryHeight (mm) — declared fallback">
                  <input className={INP} aria-label="default story height fallback" value={storyHeightForm} onChange={(e) => setStoryHeightForm(e.target.value)} placeholder="e.g. 3000 (optional)" />
                </Field>
                <Field label="defaultSpaceHeight (mm) — declared fallback">
                  <input className={INP} aria-label="default space height fallback" value={spaceHeightForm} onChange={(e) => setSpaceHeightForm(e.target.value)} placeholder="e.g. 3000 (optional)" />
                </Field>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Declared fallbacks — recorded in the report, never silent: applied when the source file lacks
                story/space heights (external files), listed under declaredFallbacks below.
              </p>

              {importResult !== null && (
                <div className="mt-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="font-mono" data-testid="ifc-import-record-id">{importResult.record.id}</Badge>
                    <Badge variant="outline" className="font-mono">{importResult.record.schema}</Badge>
                    <Badge variant="outline" className="font-mono" title={importResult.record.sourceHash}>source {truncate(importResult.record.sourceHash, 12)}</Badge>
                    <Badge variant="outline" className="font-mono" title={importResult.reportHash}>report {truncate(importResult.reportHash, 12)}</Badge>
                    <span className="text-muted-foreground">
                      {importResult.record.lengthUnitName ?? "?"}{importResult.record.lengthUnitPrefix ? ` · ${importResult.record.lengthUnitPrefix}` : ""} → mm ×{importResult.record.scaleToMm}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={ACTION_CLASS.created}>created {importResult.report.summary.created}</span>
                    <span className={ACTION_CLASS.reconciled}>reconciled {importResult.report.summary.reconciled}</span>
                    <span className={ACTION_CLASS.unchanged}>unchanged {importResult.report.summary.unchanged}</span>
                    <span className={ACTION_CLASS.unsupported}>unsupported {importResult.report.summary.unsupported}</span>
                    <span className="text-muted-foreground">fields:</span>
                    <span className={FIELD_CLASS_CLASS.exact}>exact {importResult.report.summary.exact}</span>
                    <span className={FIELD_CLASS_CLASS.tolerance}>tolerance {importResult.report.summary.tolerance}</span>
                    <span className={FIELD_CLASS_CLASS.lossy}>lossy {importResult.report.summary.lossy}</span>
                    <span className={FIELD_CLASS_CLASS.unsupported}>unsupported {importResult.report.summary.unsupportedFields}</span>
                  </div>

                  <div data-testid="ifc-report" className="mt-2 overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left">
                          <th className="px-2 py-1.5 font-medium">canonical id</th>
                          <th className="px-2 py-1.5 font-medium">ifcClass</th>
                          <th className="px-2 py-1.5 font-medium">action</th>
                          <th className="px-2 py-1.5 font-medium">fields (exact/tolerance/lossy/unsupported)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importResult.report.elements.map((el, i) => (
                          <tr key={el.canonicalId ?? `${el.ifcClass}-${i}`} className="border-b last:border-b-0 align-top" data-testid={`ifc-report-row-${el.canonicalId ?? i}`}>
                            <td className="px-2 py-1.5 font-mono whitespace-nowrap">{el.canonicalId ?? "—"}</td>
                            <td className="px-2 py-1.5 font-mono whitespace-nowrap">{el.ifcClass}</td>
                            <td className="px-2 py-1.5">
                              <span className={ACTION_CLASS[el.action]}>{el.action}</span>
                              {el.globalId !== null && (
                                <span className="ml-1 font-mono text-muted-foreground" title={`GlobalId provenance: ${el.globalId}`}>
                                  {truncate(el.globalId, 10)}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex flex-wrap gap-1">
                                {el.fields.length === 0 && <span className="text-muted-foreground">—</span>}
                                {el.fields.map((f, j) => (
                                  <span key={`${f.field}-${j}`} title={fieldTitle(f)} className={FIELD_CLASS_CLASS[f.classification]}>
                                    {f.field}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {importResult.report.declaredFallbacks.length > 0 && (
                    <div data-testid="ifc-report-fallbacks" className="mt-2">
                      <p className="text-xs font-medium">Declared fallbacks (recorded, never silent):</p>
                      <ul className="mt-1 space-y-0.5">
                        {importResult.report.declaredFallbacks.map((f, i) => (
                          <li key={i} className="font-mono text-xs text-amber-800 dark:text-amber-300">· {f}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Compare panel */}
            <div>
              <div className="text-sm font-semibold mb-1">Compare (dry run)</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                ifc.compare — reconcile the last export against the CURRENT canonical state without touching
                the document: the all-unchanged proof, or the honest diff.
              </p>
              <Button
                size="sm"
                data-testid="ifc-compare"
                disabled={busy || exportResult === null}
                onClick={onCompare}
                title="ifc.compare on the last export (field-level, no mutation)"
              >
                <GitCompareArrows aria-hidden="true" />
                Compare last export
              </Button>
              {compareResult !== null && (
                <div data-testid="ifc-compare-result" className="mt-2 rounded border bg-muted/30 p-2.5 text-xs">
                  {compareDiff.length === 0 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded border border-green-300 bg-green-50 px-2 py-0.5 font-medium text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                        ✓ all {compareResult.report.elements.length} elements unchanged — zero drift
                      </span>
                      <span className="font-mono text-muted-foreground" title={compareResult.reportHash}>report {truncate(compareResult.reportHash, 16)}</span>
                    </div>
                  ) : (
                    <div>
                      <p className="font-medium">
                        {compareDiff.length} element(s) differ:
                      </p>
                      <ScrollArea className="max-h-48 mt-1 pr-2">
                        <ul className="space-y-1 font-mono">
                          {compareDiff.map((el, i) => (
                            <li key={el.canonicalId ?? i} className="break-all">
                              <span className={ACTION_CLASS[el.action]}>{el.action}</span>{" "}
                              {el.canonicalId ?? "—"} · {el.ifcClass}
                              <span className="text-muted-foreground">
                                {" "}
                                ({el.fields.filter((f) => f.classification !== "exact").map((f) => f.field).join(", ") || "no field detail"})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </ScrollArea>
                      <p className="mt-1 font-mono text-muted-foreground" title={compareResult.reportHash}>report {truncate(compareResult.reportHash, 16)}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* --- right: seed + IDS + BCF + records ------------------------------- */}
          <div className="flex flex-col gap-4">
            {/* Seed */}
            <div>
              <div className="text-sm font-semibold mb-1">Representative model</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                One click resets the document (document.create) and seeds the canonical IFC building —
                1 story, 4 walls including the rotated wall-rot, slab, 2 openings, door, window, space —
                in one atomic bim.createElements batch.
              </p>
              <Button
                size="sm"
                variant="secondary"
                data-testid="ifc-seed"
                disabled={busy}
                onClick={onSeed}
                title="document.create + bim.createElements (the ifc-roundtrip test-suite building)"
              >
                <Boxes aria-hidden="true" />
                Seed demo building
              </Button>
            </div>

            <Separator />

            {/* IDS panel */}
            <div>
              <div className="text-sm font-semibold mb-1">IDS validation</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                ifc.idsValidate — validate a buildingSMART IDS specification against the current document's
                export. Per-entity results are bound to canonical provenance (the identity pset DomainId;
                null for external entities). Prefilled: IFCWALL must declare
                Pset_OffisosCustom.FireRating.
              </p>
              <textarea
                data-testid="ifc-ids-xml"
                aria-label="IDS specification XML"
                className="w-full min-h-28 border rounded px-2 py-1 text-xs font-mono bg-transparent"
                value={idsXml}
                onChange={(e) => setIdsXml(e.target.value)}
                spellCheck={false}
              />
              <Button size="sm" className="mt-1.5" data-testid="ifc-ids-run" disabled={busy} onClick={onIdsValidate} title="ifc.idsValidate — per-entity pass/fail with canonical binding">
                Validate IDS
              </Button>
              {idsResult !== null && (
                <div data-testid="ifc-ids-results" className="mt-2 rounded border bg-muted/30 p-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono">{idsResult.schema}</Badge>
                    {idsResult.specs.map((spec, i) => (
                      <Badge key={i} variant={spec.status === "pass" ? "default" : "destructive"} className="font-mono">
                        {spec.name}: {spec.status}
                      </Badge>
                    ))}
                  </div>
                  {idsResult.specs.map((spec, i) => (
                    <div key={i} className="mt-1.5">
                      <p className="font-medium">{spec.entities.filter((e) => e.passed).length}/{spec.entities.length} applicable entities pass</p>
                      <ScrollArea className="max-h-56 mt-1 pr-2">
                        <ul className="space-y-1 font-mono">
                          {spec.entities.map((en, j) => (
                            <li key={j} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              <span className={en.passed ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
                                {en.passed ? "✓ pass" : "✗ fail"}
                              </span>
                              <span title={en.globalId}>{truncate(en.globalId, 12)}</span>
                              <span className="text-muted-foreground">→</span>
                              <span>{en.canonicalId ?? "external (null)"}</span>
                              <span className="text-muted-foreground">{en.ifcClass ?? "?"}{en.name ? ` “${en.name}”` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      </ScrollArea>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* BCF panel */}
            <div>
              <div className="text-sm font-semibold mb-1">BCF issues</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                ifc.bcfCreate → ifc.bcfParse — build a BCF-XML v3 .bcf container referencing canonical
                elements (IfcGuids derive from the canonical ids), download it, then parse it back: every
                reference resolves to a canonical element id or an honest null. BCF is a transport
                contract, never the system of record.
              </p>
              <div className="grid grid-cols-1 gap-x-2 gap-y-1.5 items-start text-sm">
                <Field label="title">
                  <input className={INP} aria-label="BCF topic title" value={bcfForm.title} onChange={(e) => setBcfForm((f) => ({ ...f, title: e.target.value }))} />
                </Field>
                <Field label="description">
                  <input className={INP} aria-label="BCF topic description" value={bcfForm.description} onChange={(e) => setBcfForm((f) => ({ ...f, description: e.target.value }))} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="author">
                    <input className={INP} aria-label="BCF topic author" value={bcfForm.author} onChange={(e) => setBcfForm((f) => ({ ...f, author: e.target.value }))} />
                  </Field>
                  <Field label="type">
                    <input className={INP} aria-label="BCF topic type" value={bcfForm.type} onChange={(e) => setBcfForm((f) => ({ ...f, type: e.target.value }))} />
                  </Field>
                  <Field label="status">
                    <input className={INP} aria-label="BCF topic status" value={bcfForm.status} onChange={(e) => setBcfForm((f) => ({ ...f, status: e.target.value }))} />
                  </Field>
                  <Field label="comment author">
                    <input className={INP} aria-label="BCF comment author" value={bcfForm.commentAuthor} onChange={(e) => setBcfForm((f) => ({ ...f, commentAuthor: e.target.value }))} />
                  </Field>
                </div>
                <Field label="comment">
                  <input className={INP} aria-label="BCF topic comment" value={bcfForm.comment} onChange={(e) => setBcfForm((f) => ({ ...f, comment: e.target.value }))} />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground mt-2 mb-1">
                Referenced elements (canonical ids — {bcfElements.length} selected):
              </p>
              <div data-testid="ifc-bcf-elements" className="rounded border max-h-40 overflow-y-auto p-1.5">
                {bimEntities.length === 0 ? (
                  <p className="text-xs text-muted-foreground p-1">No BIM elements — seed the model first.</p>
                ) : (
                  <ul className="grid grid-cols-1 gap-0.5">
                    {bimEntities.map((en) => (
                      <li key={en.id}>
                        <label className="flex items-center gap-1.5 text-xs rounded px-1 py-0.5 hover:bg-accent cursor-pointer">
                          <input
                            type="checkbox"
                            checked={bcfElements.includes(en.id)}
                            onChange={(e) => {
                              setBcfElements((prev) =>
                                e.target.checked ? [...prev, en.id] : prev.filter((id) => id !== en.id),
                              );
                            }}
                            aria-label={`reference element ${en.id}`}
                          />
                          <span className="font-mono truncate">{entityLabel(en)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button size="sm" data-testid="ifc-bcf-create" disabled={busy} onClick={onBcfCreate} title="ifc.bcfCreate — build + download the .bcf container">
                  <MessageSquareWarning aria-hidden="true" />
                  Create + download .bcf
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="ifc-bcf-parse"
                  disabled={busy || bcfResult === null}
                  onClick={onBcfParse}
                  title="ifc.bcfParse — parse the created container back; references resolve to canonical ids or null"
                >
                  Parse round trip
                </Button>
              </div>
              {bcfResult !== null && (
                <div className="mt-2 rounded border bg-muted/30 px-2.5 py-1.5 text-xs">
                  <span className="font-mono">offisos-topic.bcf</span> · {bcfResult.size.toLocaleString()} bytes ·{" "}
                  {bcfResult.referencedCanonicalIds} referenced guid(s)
                </div>
              )}
              {bcfParsed !== null && (
                <div data-testid="ifc-bcf-parsed" className="mt-2 rounded border bg-muted/30 p-2.5 text-xs">
                  {bcfParsed.topics.map((topic, i) => (
                    <div key={topic.guid} className={i > 0 ? "mt-2 border-t pt-2" : ""}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium">{topic.title}</span>
                        <Badge variant="outline" className="font-mono">{topic.type}</Badge>
                        <Badge variant="outline" className="font-mono">{topic.status}</Badge>
                        <span className="font-mono text-muted-foreground" title={topic.guid}>{truncate(topic.guid, 12)}</span>
                      </div>
                      <p className="mt-0.5 text-muted-foreground">{topic.description}</p>
                      {topic.comments.map((c, j) => (
                        <p key={j} className="mt-0.5">
                          <span className="font-mono">{c.author}</span>{" "}
                          <span className="text-muted-foreground">({c.date})</span>: {c.comment}
                        </p>
                      ))}
                      <p className="mt-1 font-medium">References → canonical ids:</p>
                      <ul className="mt-0.5 space-y-0.5 font-mono">
                        {topic.references.map((guid, j) => {
                          const resolved = topic.resolvedCanonicalIds[j] ?? null;
                          return (
                            <li key={j} className="break-all">
                              <span title={guid}>{truncate(guid, 12)}</span>{" "}
                              <span className="text-muted-foreground">→</span>{" "}
                              {resolved !== null ? (
                                <span className="text-green-700 dark:text-green-400">{resolved}</span>
                              ) : (
                                <span className="text-muted-foreground">null (unresolvable — never fabricated)</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* Import records */}
            <div>
              <div className="text-sm font-semibold mb-1">Import records</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                ifc.listImports — the persisted deterministic import records (`if-NNNNNN`, monotonic, never
                reused). They survive save/open and replay with the document.
              </p>
              <div data-testid="ifc-records">
                <ScrollArea className="max-h-72 pr-2">
                  {records === null || records.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No imports yet — run one above.</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {records.map((rec) => (
                        <li key={rec.id} data-testid={`ifc-record-${rec.id}`} className="rounded border px-2 py-1.5 text-xs">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-mono">{rec.id}</span>
                            <Badge variant="outline" className="font-mono">{rec.schema}</Badge>
                            <span className="font-mono text-muted-foreground" title={rec.sourceHash}>source {truncate(rec.sourceHash, 10)}</span>
                            <span className="font-mono text-muted-foreground" title={rec.reportHash}>report {truncate(rec.reportHash, 10)}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className={ACTION_CLASS.created}>+{rec.summary.created}</span>
                            <span className={ACTION_CLASS.reconciled}>~{rec.summary.reconciled}</span>
                            <span className={ACTION_CLASS.unchanged}>={rec.summary.unchanged}</span>
                            <span className={ACTION_CLASS.unsupported}>?{rec.summary.unsupported}</span>
                            <span className="text-muted-foreground">
                              {rec.lengthUnitName ?? "?"}{rec.lengthUnitPrefix ? ` · ${rec.lengthUnitPrefix}` : ""} → mm ×{rec.scaleToMm} · {rec.mapping.length} mapped
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- small form helpers ---------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
