/**
 * CAD-PARITY-014 (Issue #107) — the archival format registry (D6):
 * `interop.archivalList`.
 *
 * The LEGAL COMPATIBILITY surface of the work item: every exchange carrier
 * classified by its legal status ("open-standard" = an ISO/consortium open
 * standard; "published-spec" = a published interchange specification or an
 * open documented format; "proprietary-declined" = a proprietary format we
 * explicitly do not write or read), the app-api carrier command/query, the
 * determinism evidence (whether a sha256 content hash is available for the
 * artifact) and the bounded notes. The registry is STATIC evidence —
 * determinism by construction.
 *
 * Pure + engine-free (LOCK-018).
 */

/** The registry's contract identity. */
export const INTEROP_ARCHIVAL_CONTRACT = "offisos-interop-archival/1";

export type ArchivalLegalClassification = "open-standard" | "published-spec" | "proprietary-declined";

export interface ArchivalRow {
  /** The format identity. */
  readonly format: string;
  readonly legal: ArchivalLegalClassification;
  /** The app-api surface that produces (or declines) the format. */
  readonly carrier: string;
  /** Determinism evidence: is a sha256 content hash available for the
   *  artifact this carrier returns? */
  readonly determinism: { readonly sha256Available: boolean };
  readonly bounded: string;
}

export interface ArchivalRegistry {
  readonly contract: typeof INTEROP_ARCHIVAL_CONTRACT;
  readonly rows: readonly ArchivalRow[];
}

/** The archival registry (the committed rows, fixed order). */
export const ARCHIVAL_REGISTRY: ArchivalRegistry = {
  contract: INTEROP_ARCHIVAL_CONTRACT,
  rows: [
    {
      format: "offisos-1 JSON",
      legal: "open-standard",
      carrier: "document.save",
      determinism: { sha256Available: true },
      bounded: "The native save format: the canonical JSON snapshot (canonicalStringify — recursively sorted keys) written through the file adapter; open and unrestricted, deterministic bytes on every host.",
    },
    {
      format: "IFC STEP",
      legal: "open-standard",
      carrier: "ifc.export",
      determinism: { sha256Available: true },
      bounded: "buildingSMART open standard (IFC4): the bounded building model + identity psets + the IfcGroup documentation carrier; byte-deterministic through the pinned IfcOpenShell 0.8.5 worker.",
    },
    {
      format: "DXF ASCII",
      legal: "published-spec",
      carrier: "dxf.export",
      determinism: { sha256Available: true },
      bounded: "The published AutoCAD interchange specification (R2000 ASCII): the bounded writer/reader entity vocabulary (geometry + layers/linetypes + $INSUNITS); out-of-boundary constructs are skipped and counted.",
    },
    {
      format: "PDF",
      legal: "open-standard",
      carrier: "docs.exportSheet (pdf) + publisher.run",
      determinism: { sha256Available: true },
      bounded: "ISO 32000 (the minimal deterministic PDF 1.4 writer): vector paths, standard-14 Helvetica, uncompressed content streams, no timestamps — derived from the Sheet IR / Plot IR.",
    },
    {
      format: "SVG",
      legal: "open-standard",
      carrier: "docs.exportSheet (svg) + plot.export",
      determinism: { sha256Available: true },
      bounded: "W3C SVG 1.1: the standalone deterministic SVG writer (fixed element order, 6-decimal formatting, exact-curve contract) derived from the Sheet IR / Plot IR.",
    },
    {
      format: "BCF",
      legal: "open-standard",
      carrier: "ifc.bcfCreate",
      determinism: { sha256Available: true },
      bounded: "The open buildingSMART BCF-XML v3 coordination channel (topics + selection references + camera viewpoints + the source-revision document reference); byte-deterministic containers; snapshot bitmaps unsupported (typed).",
    },
    {
      format: "DWG",
      legal: "proprietary-declined",
      carrier: "— (typed dwg_unsupported decline)",
      determinism: { sha256Available: false },
      bounded: "The proprietary DWG binary is NOT supported — reading or writing it is an explicit typed decline (dwg_unsupported); reverse engineering is a work-item non-goal. DXF is the open interchange path for the same content class.",
    },
  ],
};

/** The registry listing (the query payload builder — static). */
export function archivalList(): ArchivalRegistry {
  return ARCHIVAL_REGISTRY;
}
