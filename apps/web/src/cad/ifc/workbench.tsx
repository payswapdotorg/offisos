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
 * CAD-PARITY-014 (Issue #107, additive): the Interoperability surface gains
 * the file-exchange sections — BCF camera viewpoints + source lineage (the
 * extended ifc.bcfCreate/bcfParse), the bounded DXF R2000 exchange
 * (dxf.export / dxf.import — ONE atomic versioned import), the Sheet IR →
 * deterministic pdf/svg writers (docs.exportSheet), and the archival /
 * exchange / round-trip registry (interop.archivalList /
 * interop.exchangeReport / interop.roundtripReport). Every surface degrades
 * honestly: the DXF/sheet/registry surfaces run engine-free; the ifc.*
 * surfaces fail typed ifc_unavailable when the toolchain is absent.
 *
 * Every mutation goes through fetch("/api/cad") exactly like the Electron
 * host (Web/Electron parity, §5.5). Client-safety: only the pure BIM entity
 * parser (`bim/elements.js`) and the transport are imported — the
 * IfcOpenShell interop engine stays server-side behind the frozen ifc.* App
 * API (LOCK-003/018).
 */

import * as React from "react";
import {
  ArrowLeftRight,
  Boxes,
  Download,
  FileCode2,
  FileDown,
  FileText,
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
  dxfExport,
  dxfImport,
  docsExportSheet,
  getState,
  ifcBcfCreate,
  ifcBcfParse,
  ifcCompare,
  ifcExport,
  ifcIdsValidate,
  ifcImport,
  ifcListImports,
  ifcProbe,
  interopArchivalList,
  interopExchangeReport,
  interopRoundtripReport,
  unwrapDxfExport,
  unwrapDxfImport,
  unwrapDocsExport,
  unwrapDocsExportSheet,
  unwrapIfcBcfCreate,
  unwrapIfcBcfParse,
  unwrapIfcCompare,
  unwrapIfcExport,
  unwrapIfcIdsValidate,
  unwrapIfcImport,
  unwrapIfcListImports,
  unwrapIfcProbe,
  unwrapInteropArchivalList,
  unwrapInteropExchangeReport,
  unwrapInteropRoundtripReport,
} from "@/cad/client/http-transport";
import type {
  DocsExportResult,
  DocsExportSheetResult,
  DxfExportResult,
  DxfImportResult,
  InteropArchivalListResult,
  InteropExchangeReport,
  InteropRoundtripReportResult,
  IfcBcfCreateResult,
  IfcBcfParseResult,
  IfcBcfTopicRequest,
  IfcBcfViewpoint,
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

/** CAD-PARITY-014: the archival legal-classification chip palette
 *  (open-standard=green, published-spec=sky, proprietary-declined=red). */
const ARCHIVAL_LEGAL_CLASS: Record<"open-standard" | "published-spec" | "proprietary-declined", string> = {
  "open-standard": "rounded border border-green-300 bg-green-50 px-1.5 py-0.5 font-mono text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
  "published-spec": "rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  "proprietary-declined": "rounded border border-red-300 bg-red-50 px-1.5 py-0.5 font-mono text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
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

/** Decode base64 back to ASCII text (the DXF exchange round trip — the DXF
 *  payload is ASCII, so the latin-1 decode of atob is exact). */
function base64ToText(b64: string): string {
  return atob(b64);
}

/** Encode ASCII text as base64 (the dxf.import wire payload). */
function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
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

  // --- CAD-PARITY-014 (Issue #107): BCF viewpoint + lineage ------------------
  // The optional camera fields (world metres — the IFC convention). Defaults:
  // camera at the origin looking down −Z with +Y up (the workbench's honest
  // "no model camera yet" default; unchecking the toggle sends the legacy
  // topic shape without a viewpoint).
  const [bcfViewpointOn, setBcfViewpointOn] = React.useState(true);
  const [bcfViewpointForm, setBcfViewpointForm] = React.useState({
    camX: "0", camY: "0", camZ: "0",
    dirX: "0", dirY: "0", dirZ: "-1",
    upX: "0", upY: "1", upZ: "0",
  });
  const [bcfSourceRevision, setBcfSourceRevision] = React.useState("");

  // --- CAD-PARITY-014: DXF exchange ---------------------------------------------
  const [dxfResult, setDxfResult] = React.useState<DxfExportResult | null>(null);
  const [dxfInput, setDxfInput] = React.useState("");
  const [dxfImportResult, setDxfImportResult] = React.useState<DxfImportResult | null>(null);

  // --- CAD-PARITY-014: sheet export (Sheet IR → pdf/svg) -----------------------
  const [sheetIdForm, setSheetIdForm] = React.useState("");
  const [sheetFormat, setSheetFormat] = React.useState<"pdf" | "svg" | "sheet-ir">("pdf");
  const [sheetResult, setSheetResult] = React.useState<DocsExportResult | DocsExportSheetResult | null>(null);

  // --- CAD-PARITY-014: archival / exchange / round-trip registry ---------------
  const [archival, setArchival] = React.useState<InteropArchivalListResult | null>(null);
  const [exchange, setExchange] = React.useState<InteropExchangeReport | null>(null);
  const [roundtrip, setRoundtrip] = React.useState<InteropRoundtripReportResult | null>(null);

  // --- derived from the snapshot (pure client-side parse, same core as server) --

  const bimEntities = React.useMemo(() => {
    const out: BimEntity[] = [];
    for (const el of snapshot?.elements ?? []) {
      const entity = elementToBimEntitySafe(el);
      if (entity !== null) out.push(entity);
    }
    return out;
  }, [snapshot]);

  // CAD-PARITY-014: the current documentation sheets (the sheet-export select
  // source — the snapshot's docsSheets, absent-when-empty) + the effective
  // selection (falls back to the first sheet while the form is unset or its
  // sheet was removed).
  const sheets = React.useMemo(() => snapshot?.docsSheets ?? [], [snapshot]);
  const sheetId =
    sheetIdForm !== "" && sheets.some((s) => s.id === sheetIdForm)
      ? sheetIdForm
      : (sheets[0]?.id ?? "");
  const version = snapshot?.version?.version_number ?? 0;

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

  // CAD-PARITY-014: the registry surfaces re-query on every document version
  // bump (the DocumentationPanel version-keyed loading pattern): the archival
  // registry is static legal evidence, the exchange report's counts track the
  // current documentation tables. Both run engine-free — they stay functional
  // when the IFC toolchain is absent.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [archRes, exchRes] = await Promise.all([interopArchivalList(), interopExchangeReport()]);
      if (cancelled) return;
      if (!archRes.ok) {
        setError(`[interop.archivalList] ${archRes.code}: ${archRes.message}`);
      } else {
        const arch = unwrapInteropArchivalList(archRes);
        if (arch === null) {
          setError("[interop.archivalList] unexpected response shape");
        } else {
          setArchival(arch);
        }
      }
      if (!exchRes.ok) {
        setError(`[interop.exchangeReport] ${exchRes.code}: ${exchRes.message}`);
      } else {
        const exch = unwrapInteropExchangeReport(exchRes);
        if (exch === null) {
          setError("[interop.exchangeReport] unexpected response shape");
        } else {
          setExchange(exch);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

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
        // CAD-PARITY-014: the exchange surfaces are equally stale on a fresh
        // document (the registry tables themselves re-query per version).
        setDxfResult(null);
        setDxfImportResult(null);
        setSheetResult(null);
        setRoundtrip(null);
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
        const topic: IfcBcfTopicRequest = {
          title,
          description: bcfForm.description,
          author: bcfForm.author.trim() !== "" ? bcfForm.author.trim() : undefined,
          type: bcfForm.type.trim() !== "" ? bcfForm.type.trim() : undefined,
          status: bcfForm.status.trim() !== "" ? bcfForm.status.trim() : undefined,
          comment: bcfForm.comment.trim() !== "" ? bcfForm.comment.trim() : undefined,
          commentAuthor: bcfForm.commentAuthor.trim() !== "" ? bcfForm.commentAuthor.trim() : undefined,
          elementIds: bcfElements,
        };
        // CAD-PARITY-014 (D3): the optional camera viewpoint + the source
        // lineage — validated client-side (finite numbers) before the wire;
        // the strict server-side validation is the boundary (LOCK-007).
        if (bcfViewpointOn) {
          const f = bcfViewpointForm;
          const viewpoint: IfcBcfViewpoint = {
            cameraViewPoint: [
              toNum(f.camX, "cameraViewPoint[0]"),
              toNum(f.camY, "cameraViewPoint[1]"),
              toNum(f.camZ, "cameraViewPoint[2]"),
            ],
            cameraDirection: [
              toNum(f.dirX, "cameraDirection[0]"),
              toNum(f.dirY, "cameraDirection[1]"),
              toNum(f.dirZ, "cameraDirection[2]"),
            ],
            cameraUpVector: [
              toNum(f.upX, "cameraUpVector[0]"),
              toNum(f.upY, "cameraUpVector[1]"),
              toNum(f.upZ, "cameraUpVector[2]"),
            ],
          };
          topic.viewpoint = viewpoint;
        }
        const sourceRevision = bcfSourceRevision.trim();
        if (sourceRevision !== "") {
          topic.sourceRevision = sourceRevision;
        }
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
            const viewpointNote = topic.viewpoint !== undefined ? "camera viewpoint + " : "";
            const lineageNote = topic.sourceRevision !== undefined ? "source lineage" : "no lineage";
            setStatus(`created + downloaded offisos-topic.bcf (${bcf.size.toLocaleString()} bytes, ${bcf.referencedCanonicalIds} referenced guid(s), ${viewpointNote}${lineageNote}) — parse it to verify the round trip`);
          }
        } else {
          setBcfResult(null);
        }
      } catch (e) {
        setError(`[ifc.bcfCreate] ${(e as Error).message}`);
      }
    })();
  }, [bcfForm, bcfElements, bcfViewpointOn, bcfViewpointForm, bcfSourceRevision, exec]);

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
          const withViewpoint = parsed.topics.filter((t) => t.viewpoint !== null).length;
          setStatus(`BCF round trip — ${parsed.topics.length} topic(s) parsed, ${resolved} reference(s) resolved to canonical ids, ${withViewpoint} with a camera viewpoint`);
        }
      } else {
        setBcfParsed(null);
      }
    })();
  }, [bcfResult, exec]);

  // --- CAD-PARITY-014 actions: DXF exchange ------------------------------------

  const onDxfExport = React.useCallback(() => {
    void (async () => {
      setStatus("exporting the drafting surface to DXF… (deterministic R2000 ASCII — no engine needed)");
      const res = await exec("dxf.export", () => dxfExport());
      if (res.ok) {
        const ex = unwrapDxfExport(res);
        if (ex === null) {
          setError("[dxf.export] unexpected response shape");
          setDxfResult(null);
        } else {
          setDxfResult(ex);
          const skipped = ex.counts.skipped > 0
            ? `, ${ex.counts.skipped} skipped (${ex.skippedKinds.join(", ")})`
            : "";
          setStatus(`exported DXF · ${ex.size.toLocaleString()} bytes · ${ex.counts.exported} entities${skipped} · sha256 ${ex.sha256.slice(0, 16)}…`);
        }
      } else {
        setDxfResult(null);
      }
    })();
  }, [exec]);

  const onDownloadDxf = React.useCallback(() => {
    if (dxfResult === null) return;
    downloadBlob(base64ToBlob(dxfResult.bytesBase64, "application/dxf"), "offisos-export.dxf");
    setStatus(`downloaded offisos-export.dxf (${dxfResult.size.toLocaleString()} bytes, sha256 ${dxfResult.sha256.slice(0, 16)}…)`);
  }, [dxfResult]);

  /** Stage the last export's ASCII text into the import field (the
   *  ifc-import-use-export pattern — the round trip should reconcile
   *  all-unchanged into the same document). */
  const onDxfUseExport = React.useCallback(() => {
    if (dxfResult === null) return;
    setDxfInput(base64ToText(dxfResult.bytesBase64));
    setStatus("staged the last DXF export text — importing it into the same document should reconcile all-unchanged");
  }, [dxfResult]);

  const onDxfImportRun = React.useCallback(() => {
    void (async () => {
      try {
        const text = dxfInput.trim();
        if (text === "") {
          throw new Error("paste DXF ASCII text or stage the last export first");
        }
        setStatus("importing the DXF… (ONE atomic revision: linetypes + layers + elements)");
        const res = await exec("dxf.import", () => dxfImport({ dxf: textToBase64(text) }));
        if (res.ok) {
          const imp = unwrapDxfImport(res);
          if (imp === null) {
            setError("[dxf.import] unexpected response shape");
            setDxfImportResult(null);
          } else {
            setDxfImportResult(imp);
            setStatus(`DXF import — created ${imp.created} (unit ${imp.report.unit}, ×${imp.report.scaleToMm} → mm) · report hash ${imp.reportHash.slice(0, 12)}…`);
          }
        } else {
          setDxfImportResult(null);
        }
      } catch (e) {
        setError(`[dxf.import] ${(e as Error).message}`);
      }
    })();
  }, [dxfInput, exec]);

  // --- CAD-PARITY-014 actions: sheet export (Sheet IR → pdf/svg) ---------------

  const onSheetExport = React.useCallback(() => {
    void (async () => {
      try {
        const id = sheetId;
        if (id === "") {
          throw new Error("select a sheet first (documentation sheets are created in the Documentation view)");
        }
        setStatus(`exporting sheet ${id} as ${sheetFormat}… (the deterministic writer — byte-identical on every host)`);
        const res = await exec("docs.exportSheet", () => docsExportSheet(id, sheetFormat));
        if (res.ok) {
          if (sheetFormat === "sheet-ir") {
            // The canonical IR arm — its own legacy mirror (DocsExportResult:
            // ir + canonical + hash — the frozen P013 interchange contract).
            const ir = unwrapDocsExport(res);
            if (ir === null) {
              setError("[docs.exportSheet] unexpected response shape");
              setSheetResult(null);
            } else {
              setSheetResult(ir);
              setStatus(`exported ${id} → canonical Sheet IR (${ir.canonical.length.toLocaleString()} bytes, sha256 ${ir.hash.slice(0, 16)}…) — the frozen P013 interchange contract`);
            }
          } else {
            const ex = unwrapDocsExportSheet(res);
            if (ex === null) {
              setError("[docs.exportSheet] unexpected response shape");
              setSheetResult(null);
            } else {
              setSheetResult(ex);
              setStatus(`exported ${id} → ${ex.format} (${ex.size.toLocaleString()} bytes, sha256 ${ex.sha256.slice(0, 16)}…, irHash ${ex.irHash.slice(0, 12)}…)`);
            }
          }
        } else {
          setSheetResult(null);
        }
      } catch (e) {
        setError(`[docs.exportSheet] ${(e as Error).message}`);
      }
    })();
  }, [sheetId, sheetFormat, exec]);

  const onSheetDownload = React.useCallback(() => {
    if (sheetResult === null || sheetResult.format === "sheet-ir") return;
    if (sheetResult.format === "pdf" && sheetResult.bytesBase64 !== undefined) {
      downloadBlob(base64ToBlob(sheetResult.bytesBase64, "application/pdf"), `${sheetResult.sheetId}.pdf`);
      setStatus(`downloaded ${sheetResult.sheetId}.pdf (${sheetResult.size.toLocaleString()} bytes)`);
    } else if (sheetResult.format === "svg" && sheetResult.text !== undefined) {
      downloadBlob(new Blob([sheetResult.text], { type: "image/svg+xml" }), `${sheetResult.sheetId}.svg`);
      setStatus(`downloaded ${sheetResult.sheetId}.svg (${sheetResult.text.length.toLocaleString()} chars)`);
    }
  }, [sheetResult]);

  // --- CAD-PARITY-014 actions: round-trip verification -------------------------

  /** interop.roundtripReport — the DRY verification loops. The dxf arm is
   *  pure TS; the ifc arm fails typed ifc_unavailable without the toolchain
   *  (surfaced through the standard error banner — the honest behavior). */
  const onRoundtrip = React.useCallback(
    (format: "ifc" | "dxf") => {
      void (async () => {
        setStatus(`running the ${format.toUpperCase()} round-trip verification… (dry run — nothing is written)`);
        const res = await exec("interop.roundtripReport", () => interopRoundtripReport(format));
        if (res.ok) {
          const rt = unwrapInteropRoundtripReport(res);
          if (rt === null) {
            setError("[interop.roundtripReport] unexpected response shape");
            setRoundtrip(null);
          } else {
            setRoundtrip(rt);
            if (rt.format === "dxf") {
              setStatus(`DXF round trip — ${rt.report.summary.unchanged}/${rt.report.elements.length} elements unchanged within 1e-5 mm · report hash ${rt.reportHash.slice(0, 12)}…`);
            } else {
              const docNote = rt.documentation !== undefined ? ` + ${rt.documentation.summary.unchanged} doc record(s) unchanged` : "";
              setStatus(`IFC round trip — ${rt.elements.summary.unchanged}/${rt.elements.elements.length} elements unchanged${docNote} · report hash ${rt.reportHash.slice(0, 12)}…`);
            }
          }
        } else {
          setRoundtrip(null);
        }
      })();
    },
    [exec],
  );

  // --- render ---------------------------------------------------------------------

  const counts = exportResult?.counts;
  const docCounts = exportResult?.documentation;
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
                      {/* CAD-PARITY-014 (additive): the IfcGroup documentation
                          carrier counts — present only when at least one
                          documentation table is non-empty. */}
                      {docCounts !== undefined && (
                        <>
                          <Badge variant="secondary" className="font-mono" data-testid="ifc-export-doc-counts">
                            doc records: {docCounts.views + docCounts.layouts + docCounts.navigatorNodes + docCounts.titleBlocks + docCounts.schedules + docCounts.revisions + docCounts.publisherSets}
                          </Badge>
                          {docCounts.sheetsNotExported > 0 && (
                            <Badge variant="outline" className="font-mono">sheets not exported: {docCounts.sheetsNotExported}</Badge>
                          )}
                        </>
                      )}
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

            <Separator />

            {/* CAD-PARITY-014: DXF exchange panel */}
            <div data-testid="interop-dxf-section">
              <div className="text-sm font-semibold mb-1">DXF exchange</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                dxf.export / dxf.import — the bounded deterministic DXF R2000 ASCII interchange of the 2D
                drafting surface: LINE/CIRCLE/ARC/ELLIPSE/LWPOLYLINE/SPLINE/POINT/RAY/XLINE/TEXT + the
                layer/linetype tables + $INSUNITS. Out-of-boundary constructs are skipped and counted
                (never silent); the proprietary DWG binary is the typed decline. No engine needed — the
                writer/reader are pure shared-core code.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="interop-dxf-export"
                  disabled={busy}
                  onClick={onDxfExport}
                  title="dxf.export — the bounded deterministic DXF R2000 ASCII text (identical state → identical bytes)"
                >
                  <FileText aria-hidden="true" />
                  Export DXF
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="interop-dxf-download"
                  disabled={busy || dxfResult === null}
                  onClick={onDownloadDxf}
                  title="download the exported text as offisos-export.dxf"
                >
                  <Download aria-hidden="true" />
                  Download .dxf
                </Button>
              </div>
              {dxfResult !== null && (
                <div data-testid="interop-dxf-result" className="mt-2 rounded border bg-muted/40 p-2.5 text-xs">
                  <p className="font-mono break-all">sha256 {dxfResult.sha256}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono">R2000 ASCII</Badge>
                    <Badge variant="outline" className="font-mono">{dxfResult.size.toLocaleString()} bytes</Badge>
                    <Badge variant="secondary" className="font-mono">{dxfResult.counts.exported} entities exported</Badge>
                    {dxfResult.counts.skipped > 0 && (
                      <Badge variant="secondary" className="font-mono">{dxfResult.counts.skipped} skipped</Badge>
                    )}
                    {Object.entries(dxfResult.counts.byKind).map(([kind, count]) => (
                      <Badge key={kind} variant="outline" className="font-mono">{kind} ×{count}</Badge>
                    ))}
                    {dxfResult.skippedKinds.map((kind) => (
                      <span key={kind} className={FIELD_CLASS_CLASS.unsupported} title="skipped out-of-boundary construct (counted, never silent)">
                        {kind}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <textarea
                data-testid="interop-dxf-input"
                aria-label="DXF ASCII payload"
                className="w-full min-h-20 border rounded px-2 py-1 text-xs font-mono bg-transparent break-all"
                placeholder="paste DXF ASCII text…"
                value={dxfInput}
                onChange={(e) => setDxfInput(e.target.value)}
                spellCheck={false}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="interop-dxf-use-export"
                  disabled={busy || dxfResult === null}
                  onClick={onDxfUseExport}
                  title="stage the last export's text — importing it into the same document should reconcile all-unchanged"
                >
                  Use last export
                </Button>
                <Button
                  size="sm"
                  data-testid="interop-dxf-import-run"
                  disabled={busy}
                  onClick={onDxfImportRun}
                  title="dxf.import — ONE atomic versioned command (linetypes + layers + elements; ids minted by the document)"
                >
                  Import DXF
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  pasting a DWG binary is the typed dwg_unsupported decline (detected, never parsed)
                </span>
              </div>
              {dxfImportResult !== null && (
                <div data-testid="interop-dxf-import-result" className="mt-2 rounded border bg-muted/30 p-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="font-mono">created {dxfImportResult.created}</Badge>
                    <Badge variant="outline" className="font-mono" title={dxfImportResult.report.sourceSha256}>source {truncate(dxfImportResult.report.sourceSha256, 12)}</Badge>
                    <Badge variant="outline" className="font-mono">unit {dxfImportResult.report.unit} ×{dxfImportResult.report.scaleToMm} → mm</Badge>
                    <span className="font-mono text-muted-foreground" title={dxfImportResult.reportHash}>report {truncate(dxfImportResult.reportHash, 16)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className={ACTION_CLASS.created}>+{dxfImportResult.report.counts.elements} elements</span>
                    <span className={ACTION_CLASS.created}>+{dxfImportResult.report.counts.layers} layers</span>
                    <span className={ACTION_CLASS.created}>+{dxfImportResult.report.counts.ltypes} ltypes</span>
                    {dxfImportResult.report.unsupported.map((u) => (
                      <span key={u.type} className={FIELD_CLASS_CLASS.unsupported} title={`unsupported construct (skipped + counted, never approximated)`}>
                        {u.type} ×{u.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <Separator />

            {/* CAD-PARITY-014: sheet export panel (Sheet IR → pdf/svg) */}
            <div data-testid="interop-sheet-section">
              <div className="text-sm font-semibold mb-1">Sheet export (Sheet IR → PDF / SVG)</div>
              <p className="text-xs text-muted-foreground mb-1.5">
                docs.exportSheet — one documentation sheet through the canonical Sheet IR or the
                deterministic writers (the Sheet IR bridges onto the existing plot writers —
                byte-identical on every host; the irHash binds the output to the unchanged IR).
                Sheets are created in the Documentation view.
              </p>
              <div className="grid grid-cols-2 gap-2 items-start text-sm">
                <Field label="sheet">
                  <select
                    data-testid="interop-sheet-select"
                    aria-label="Documentation sheet"
                    className={INP}
                    value={sheetId}
                    onChange={(e) => setSheetIdForm(e.target.value)}
                  >
                    {sheets.length === 0 && <option value="">no sheets in this document</option>}
                    {sheets.map((s) => (
                      <option key={s.id} value={s.id}>{s.id} · {s.title}</option>
                    ))}
                  </select>
                </Field>
                <Field label="format">
                  <select
                    data-testid="interop-sheet-format"
                    aria-label="Sheet export format"
                    className={INP}
                    value={sheetFormat}
                    onChange={(e) => setSheetFormat(e.target.value as "pdf" | "svg" | "sheet-ir")}
                  >
                    <option value="pdf">pdf</option>
                    <option value="svg">svg</option>
                    <option value="sheet-ir">sheet-ir</option>
                  </select>
                </Field>
              </div>
              <p data-testid="interop-sheet-dwg-note" className="mt-1 text-[11px] leading-snug text-muted-foreground">
                DWG is a typed decline (proprietary) — DXF is the open interchange path.
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button
                  size="sm"
                  data-testid="interop-sheet-export-run"
                  disabled={busy || sheetId === ""}
                  onClick={onSheetExport}
                  title="docs.exportSheet — the canonical Sheet IR or the deterministic pdf/svg writers"
                >
                  <FileDown aria-hidden="true" />
                  Export sheet
                </Button>
                {sheetResult !== null && sheetResult.format !== "sheet-ir" && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="interop-sheet-download"
                    disabled={busy}
                    onClick={onSheetDownload}
                    title={sheetResult.format === "pdf" ? "download the deterministic PDF bytes" : "download the deterministic SVG text"}
                  >
                    <Download aria-hidden="true" />
                    Download .{sheetResult.format}
                  </Button>
                )}
              </div>
              {sheetResult !== null && (
                <div data-testid="interop-sheet-result" className="mt-2 rounded border bg-muted/40 p-2.5 text-xs">
                  <p className="font-mono break-all">
                    {sheetResult.format === "sheet-ir"
                      ? `irHash ${sheetResult.hash}`
                      : `sha256 ${sheetResult.sha256}`}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono">{sheetResult.format}</Badge>
                    <Badge variant="outline" className="font-mono">{sheetResult.sheetId}</Badge>
                    <Badge variant="outline" className="font-mono">
                      {(sheetResult.format === "sheet-ir" ? sheetResult.canonical.length : sheetResult.size).toLocaleString()} bytes
                    </Badge>
                    {sheetResult.format !== "sheet-ir" && (
                      <Badge variant="outline" className="font-mono" title={sheetResult.irHash}>ir {truncate(sheetResult.irHash, 12)}</Badge>
                    )}
                  </div>
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
              {/* CAD-PARITY-014 (D3): the optional camera viewpoint + source lineage. */}
              <div className="mt-2 rounded border bg-muted/20 p-2">
                <label className="flex items-center gap-1.5 text-xs font-medium">
                  <input
                    type="checkbox"
                    data-testid="interop-bcf-viewpoint-toggle"
                    checked={bcfViewpointOn}
                    onChange={(e) => setBcfViewpointOn(e.target.checked)}
                    aria-label="include a camera viewpoint"
                  />
                  Camera viewpoint (world metres — camera / direction / up)
                </label>
                {bcfViewpointOn && (
                  <div className="mt-1.5 grid grid-cols-[max-content_1fr_1fr_1fr] gap-1.5 items-center text-xs">
                    <span className="text-muted-foreground font-medium">cameraViewPoint</span>
                    <input className={INP} data-testid="interop-bcf-camera-x" aria-label="camera view point x" value={bcfViewpointForm.camX} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, camX: e.target.value }))} placeholder="x" />
                    <input className={INP} data-testid="interop-bcf-camera-y" aria-label="camera view point y" value={bcfViewpointForm.camY} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, camY: e.target.value }))} placeholder="y" />
                    <input className={INP} data-testid="interop-bcf-camera-z" aria-label="camera view point z" value={bcfViewpointForm.camZ} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, camZ: e.target.value }))} placeholder="z" />
                    <span className="text-muted-foreground font-medium">cameraDirection</span>
                    <input className={INP} data-testid="interop-bcf-dir-x" aria-label="camera direction x" value={bcfViewpointForm.dirX} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, dirX: e.target.value }))} placeholder="x" />
                    <input className={INP} data-testid="interop-bcf-dir-y" aria-label="camera direction y" value={bcfViewpointForm.dirY} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, dirY: e.target.value }))} placeholder="y" />
                    <input className={INP} data-testid="interop-bcf-dir-z" aria-label="camera direction z" value={bcfViewpointForm.dirZ} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, dirZ: e.target.value }))} placeholder="z" />
                    <span className="text-muted-foreground font-medium">cameraUpVector</span>
                    <input className={INP} data-testid="interop-bcf-up-x" aria-label="camera up vector x" value={bcfViewpointForm.upX} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, upX: e.target.value }))} placeholder="x" />
                    <input className={INP} data-testid="interop-bcf-up-y" aria-label="camera up vector y" value={bcfViewpointForm.upY} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, upY: e.target.value }))} placeholder="y" />
                    <input className={INP} data-testid="interop-bcf-up-z" aria-label="camera up vector z" value={bcfViewpointForm.upZ} onChange={(e) => setBcfViewpointForm((f) => ({ ...f, upZ: e.target.value }))} placeholder="z" />
                  </div>
                )}
                <div className="mt-1.5">
                  <input
                    className={INP}
                    data-testid="interop-bcf-source-rev"
                    aria-label="BCF source revision (model state reference)"
                    value={bcfSourceRevision}
                    onChange={(e) => setBcfSourceRevision(e.target.value)}
                    placeholder="the model state reference, e.g. the save sha256"
                  />
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  The viewpoint rides as the BCF 3.0 VisualizationInfo camera (perspective here; parsed
                  back within the declared 1e-6 tolerance); the source revision rides as the topic's
                  document reference (description "offisos-source-model-revision") and parses back
                  exactly. Uncheck for the legacy topic shape (origin-target camera, no lineage).
                </p>
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
                      {/* CAD-PARITY-014: the parsed camera viewpoint + the source
                          lineage — the round-trip evidence (null is honest). */}
                      <p data-testid="interop-bcf-parsed-viewpoint" className="mt-0.5 font-mono">
                        {topic.viewpoint !== null
                          ? `viewpoint: camera (${topic.viewpoint.cameraViewPoint.join(", ")}) · dir (${topic.viewpoint.cameraDirection.join(", ")}) · up (${topic.viewpoint.cameraUpVector.join(", ")}) · ${topic.viewpoint.orthogonal ? `orthogonal ×${topic.viewpoint.viewToWorldScale ?? "?"}` : "perspective"}`
                          : "viewpoint: none (the legacy topic shape)"}
                      </p>
                      <p data-testid="interop-bcf-parsed-source-rev" className="mt-0.5 font-mono">
                        {topic.sourceRevision !== null
                          ? `source revision: ${truncate(topic.sourceRevision, 24)}`
                          : "source revision: none"}
                      </p>
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

        <Separator />

        {/* CAD-PARITY-014 (Issue #107): the archival / exchange / round-trip
            registry — the legal compatibility surface (engine-free). */}
        <div data-testid="interop-registry-section">
          <div className="text-sm font-semibold mb-1">Archival registry · exchange classification · round trips</div>
          <p className="text-xs text-muted-foreground mb-2">
            interop.archivalList — the legal compatibility surface of every carrier (open standards,
            published specs, the proprietary DWG decline; the determinism column marks sha256
            evidence) · interop.exchangeReport — the authoritative per-concept classification
            (exact/tolerance/lossy/unsupported) · interop.roundtripReport — the DRY verification
            loops (nothing is written; the ifc loop needs the IFC adapter — a typed ifc_unavailable
            failure without the toolchain is the honest result, shown in the error banner).
          </p>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1">
                <span className="text-xs font-medium">Archival formats</span>
                {archival !== null && <Badge variant="outline" className="font-mono">{archival.contract}</Badge>}
              </div>
              <div data-testid="interop-archival-rows" className="overflow-x-auto rounded border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-2 py-1.5 font-medium">format</th>
                      <th className="px-2 py-1.5 font-medium">legal</th>
                      <th className="px-2 py-1.5 font-medium">carrier</th>
                      <th className="px-2 py-1.5 font-medium">determinism</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(archival?.rows ?? []).map((row) => (
                      <tr key={row.format} className="border-b last:border-b-0 align-top" title={row.bounded}>
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">{row.format}</td>
                        <td className="px-2 py-1.5">
                          <span className={ARCHIVAL_LEGAL_CLASS[row.legal]}>{row.legal}</span>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">{row.carrier}</td>
                        <td className="px-2 py-1.5">
                          {row.determinism.sha256Available ? (
                            <span className="font-mono text-green-700 dark:text-green-400">sha256 ✓</span>
                          ) : (
                            <span className="font-mono text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {archival === null && (
                      <tr>
                        <td colSpan={4} className="px-2 py-1.5 text-muted-foreground">loading the archival registry…</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1">
                <span className="text-xs font-medium">Exchange classification</span>
                {exchange !== null && <Badge variant="outline" className="font-mono">{exchange.contract}</Badge>}
              </div>
              <div data-testid="interop-exchange-rows" className="overflow-x-auto rounded border max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-2 py-1.5 font-medium">concept</th>
                      <th className="px-2 py-1.5 font-medium">classification</th>
                      <th className="px-2 py-1.5 font-medium">note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(exchange?.classifications ?? []).map((row) => (
                      <tr key={row.concept} className="border-b last:border-b-0 align-top">
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">{row.concept}</td>
                        <td className="px-2 py-1.5">
                          <span className={FIELD_CLASS_CLASS[row.classification as IfcFieldClassification]}>{row.classification}</span>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{row.note}</td>
                      </tr>
                    ))}
                    {exchange === null && (
                      <tr>
                        <td colSpan={3} className="px-2 py-1.5 text-muted-foreground">loading the exchange classification…</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {exchange !== null && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">current document:</span>
                  <Badge variant="outline" className="font-mono">{exchange.counts.elements} elements</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.layers} layers</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.views} views</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.sheets} sheets</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.layouts} layouts</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.titleBlocks} title blocks</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.schedules} schedules</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.revisions} revisions</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.publisherSets} publisher sets</Badge>
                  <Badge variant="outline" className="font-mono">{exchange.counts.navigatorNodes} navigator nodes</Badge>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button
              size="sm"
              variant="secondary"
              data-testid="interop-roundtrip-dxf"
              disabled={busy}
              onClick={() => onRoundtrip("dxf")}
              title="interop.roundtripReport 'dxf' — export → parse → the DRY mapping with the per-field 1e-5 mm classification (pure TS, nothing is written)"
            >
              <ArrowLeftRight aria-hidden="true" />
              Round-trip DXF
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="interop-roundtrip-ifc"
              disabled={busy}
              onClick={() => onRoundtrip("ifc")}
              title="interop.roundtripReport 'ifc' — export → parse → the DRY element + documentation reconciliation (needs the IFC adapter; typed ifc_unavailable without it)"
            >
              <ArrowLeftRight aria-hidden="true" />
              Round-trip IFC
            </Button>
          </div>
          {roundtrip !== null && (
            <div data-testid="interop-roundtrip-result" className="mt-2 rounded border bg-muted/30 p-2.5 text-xs">
              <p className="font-mono break-all" title={roundtrip.sourceSha256}>source sha256 {truncate(roundtrip.sourceSha256, 24)}</p>
              {roundtrip.format === "dxf" ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="font-mono">dxf</Badge>
                  <span className={ACTION_CLASS.unchanged}>unchanged {roundtrip.report.summary.unchanged}</span>
                  <span className={ACTION_CLASS.reconciled}>reconciled {roundtrip.report.summary.reconciled}</span>
                  <span className={ACTION_CLASS.unsupported}>unsupported {roundtrip.report.summary.unsupported}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className={FIELD_CLASS_CLASS.exact}>exact {roundtrip.report.summary.exact}</span>
                  <span className={FIELD_CLASS_CLASS.tolerance}>tolerance {roundtrip.report.summary.tolerance}</span>
                  <span className={FIELD_CLASS_CLASS.lossy}>lossy {roundtrip.report.summary.lossy}</span>
                  <span className="text-muted-foreground">
                    · {roundtrip.report.source.exported} exported · layers {roundtrip.report.layers.matched} matched
                  </span>
                  {roundtrip.report.unsupported.map((u) => (
                    <span key={u.type} className={FIELD_CLASS_CLASS.unsupported}>{u.type} ×{u.count}</span>
                  ))}
                </div>
              ) : (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="font-mono">ifc</Badge>
                  <span className={ACTION_CLASS.unchanged}>elements unchanged {roundtrip.elements.summary.unchanged}</span>
                  <span className={ACTION_CLASS.reconciled}>reconciled {roundtrip.elements.summary.reconciled}</span>
                  <span className={ACTION_CLASS.unsupported}>unsupported {roundtrip.elements.summary.unsupported}</span>
                  {roundtrip.documentation !== undefined && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span className={ACTION_CLASS.unchanged}>doc records unchanged {roundtrip.documentation.summary.unchanged}</span>
                      <span className={ACTION_CLASS.created}>doc created {roundtrip.documentation.summary.created}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">
                    · fields: exact {roundtrip.elements.summary.exact}, tolerance {roundtrip.elements.summary.tolerance}, lossy {roundtrip.elements.summary.lossy}
                  </span>
                </div>
              )}
              <p className="mt-1 font-mono text-muted-foreground" title={roundtrip.reportHash}>report {truncate(roundtrip.reportHash, 24)}</p>
            </div>
          )}
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
