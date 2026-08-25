# RESEARCH-CAD-006 — Findings Report

**Work item:** RESEARCH-CAD-006 (GitHub issue #6)
**Architecture version:** 1.1 (FROZEN)
**Scope (per Issue #6 directive):** exact-version licensing/composition
evidence for the stack actually tested across RESEARCH-CAD-001..005,
covering **both** the web deployment model and the Electron/desktop
deployment model. **No legal approval or production packaging change is
implied.** Composition approval is LICENSE-001's decision.
**Evidence run:** `evidence/run-001/` (30 pass / 0 fail / 0 unknown)
**Environment:** records/inventory benchmark (no CAD engine exercised);
versions asserted from the authoritative pinned sources (CAD-001
`requirements.txt`, the CAD-001..005 committed `environment.json`
snapshots, and the FreeCAD AppImage SHA256 manifest in CAD-001's
`requirements.txt`), cross-checked against the currently-importable
distribution metadata (see `evidence/run-001/environment.json`).

This report separates **measured/recorded results** from **inferred
conclusions**. Everything marked OBSERVED/CALCULATED is backed by a check
in the evidence run; INFERRED statements cite their supporting checks.
The final composition decision (proceed / proceed with constraints /
reject / ACR) belongs to LICENSE-001's legal/architect review — this gate
recommends, it does not decide, and it approves nothing.

---

## 1. Exact tested stack (OBSERVED from authoritative pinned sources)

| Component | Exact version | License | Tested in | Role |
|---|---|---|---|---|
| IfcOpenShell | 0.8.5 | LGPL-3.0-or-later | CAD-001, CAD-003, CAD-004, CAD-005 | BIM semantics + IFC I/O |
| OCCT (via cadquery-ocp) | 7.8.1 | LGPL-2.1-or-later WITH OCCT-LINKING-EXCEPTION | CAD-001, CAD-002, CAD-003, CAD-005 | 3D geometry kernel |
| cadquery-ocp (bindings) | 7.8.1.1.post1 | Apache-2.0 | CAD-001..005 (distribution channel) | OCCT Python bindings |
| cadquery | 2.6.1 | Apache-2.0 | CAD-001..005 (distribution channel only) | Distribution channel |
| ezdxf | 1.4.3 | MIT | CAD-001 | 2D drafting gap-fill (DXF) |
| numpy | 2.1.3 | BSD-3-Clause | CAD-001..005 (transitive) | Numeric arrays |
| FreeCAD | 1.1.3 (AppImage, SHA256 `3a853eb6…`) | LGPL-2.1-or-later | CAD-001, CAD-002, CAD-005 | Drafting/Sketcher/TechDraw |
| Python | 3.12.13 (local) / 3.11 (AppImage) | PSF-2.0 | runtime | Runtime |

[versions/recorded, versions/pin-snapshot-consistency, versions/live-cross-check,
versions/freecad-appimage-hash, versions/occt-via-binding]

The CAD-001 `requirements.txt` pins are internally consistent with every
committed CAD-001..005 `environment.json` snapshot. The FreeCAD AppImage
SHA256 recorded here matches the committed manifest. OCCT 7.8.1 is
CALCULATED from the cadquery-ocp binding version (7.8.1.1.post1), not
directly measured from the shared library.

## 2. License identification (OBSERVED from upstream facts + metadata cross-check)

Every component's license is identified from a stable upstream statement,
SPDX-classified, and cross-checked against the installed distribution
metadata License field where the distribution is importable.

[licenses/identified, licenses/spdx-classification, licenses/metadata-cross-check,
licenses/no-strong-gpl-in-tested-stack]

**Key finding:** No strong-copyleft **GPL** component is present in the
tested CAD/BIM stack. All copyleft present is **LGPL** (weak copyleft,
user-replaceable behind the frozen adapter boundary). OpenProject (GPLv3)
is a Project-scope candidate, **not** part of the CAD/BIM tested stack.
This is the central composition fact for LICENSE-001: **no GPL-contamination
path exists from the tested CAD/BIM stack into a closed-source composition.**

## 3. Composition flags for LICENSE-001 (no approval)

The composition flag matrix is complete: every component carries an explicit
flag and severity.

[composition/copyleft-components-flagged, composition/permissive-components-identified,
composition/flag-matrix-complete, composition/no-approval-recorded,
composition/no-gpl-contamination-path]

| Component | Flag | Severity |
|---|---|---|
| IfcOpenShell (LGPL-3.0) | Section 4 combined-works review required for distribution; adapter/process boundary preserves user-replaceability; pure SaaS not triggered | review-required-for-distribution |
| OCCT (LGPL-2.1+exception) | Dynamic/separate-process linking preserves the exception; static linking or modification triggers copyleft review; adapter boundary keeps it separately-loaded | review-required-for-static-linking |
| FreeCAD (LGPL-2.1-or-later) | Self-contained AppImage (user-replaceable as a unit); LGPL obligations satisfied by separability + written offer for source | review-required-for-attribution |
| cadquery-ocp (Apache-2.0) | Permissive bindings; wrapped OCCT carries its own LGPL (see OCCT) | informational |
| cadquery (Apache-2.0) | Permissive; distribution channel only | informational |
| ezdxf (MIT) | Permissive; no copyleft concern | informational |
| numpy (BSD-3-Clause) | Permissive; transitive | informational |
| Python (PSF-2.0) | Permissive (GPL-compatible) | informational |

**This gate approves NO composition.** The decision owner is LICENSE-001.

## 4. Web deployment model (OBSERVED + INFERRED)

[deployment/web/tested-path-documented, deployment/web/wasm-not-tested-recorded,
deployment/web/lgpl-posture-documented, deployment/web/no-lgpl-native-in-browser-tested,
deployment/web/conditional-review-flag]

- **Tested path:** headless server-side execution (FreeCADCmd/OCCT/IfcOpenShell
  in worker processes); geometry streamed to the browser as tessellated
  meshes. **No native CAD code is shipped to the browser** in the tested
  configuration — the browser receives only tessellated meshes.
- **WASM honesty:** OCCT has an emscripten/WASM build path, but
  cadquery-ocp WASM and IfcOpenShell WASM were **NOT tested** in
  CAD-001..005. The tested web path is server-side only.
- **LGPL posture:** Pure network SaaS deployment is **not** "distribution"
  under the LGPL — Section 4 combined-works obligations are not triggered
  for server-side-only use. A downloadable web client bundling LGPL native
  code (e.g. a WASM OCCT build) would trigger Section 4, and the adapter
  boundary preserves user-replaceability.
- **Conditional flag:** review is required **only** for a distributable web
  client bundling LGPL native code; pure SaaS deployment needs no
  distribution-time LGPL review.

## 5. Electron/desktop deployment model (OBSERVED + INFERRED)

[deployment/desktop/tested-path-documented, deployment/desktop/electron-license-recorded,
deployment/desktop/lgpl-posture-documented, deployment/desktop/adapter-boundary-is-compliance-mechanism,
deployment/desktop/no-static-linking-of-lgpl-into-closed-source,
deployment/desktop/freecad-appimage-separable]

- **Tested path:** the CAD/BIM stack runs as native worker processes
  spawned by an Electron host. FreeCAD was tested via the official AppImage
  (a self-contained native bundle).
- **Electron host license:** MIT (Electron = MIT; Chromium BSD/MIT-derived;
  Node MIT). No copyleft from the host stack.
- **LGPL posture:** desktop distribution bundles LGPL-2.1 (OCCT, FreeCAD)
  and LGPL-3.0 (IfcOpenShell) components. The LGPL requires the user's right
  to replace the LGPL portions (dynamic/separate-process linking + a
  written offer for the corresponding source for 3 years).
- **Compliance mechanism:** the frozen adapter boundary (Architecture v1.1)
  isolates the LGPL components behind a process/adapter boundary, enabling
  user-replaceability without exposing proprietary adapter code.
- **Explicit constraint:** **no static linking of LGPL code into closed-source
  code** in the tested path. The tested path uses dynamic/separate-process
  composition (FreeCAD as a self-contained AppImage; OCCT/IfcOpenShell as
  separate worker processes), which avoids the LGPL static-linking
  obligation (object files / relinking capability). Static linking of LGPL
  into closed-source code is flagged review-required if ever attempted.
- **FreeCAD AppImage separability:** the AppImage is a single user-replaceable
  file (swap the whole unit); LGPL obligations for the FreeCAD-embedded OCCT
  are satisfied by separability plus a written offer for source.

## 6. Adapter boundary as the LGPL-compliance mechanism (INFERRED from CAD-001 item 9)

[replacement/adapter-boundary-v1.1-frozen, replacement/adapter-replacement-proof-referenced,
replacement/lgpl-user-replaceability-preserved, replacement/final-proof-deferred-to-cad-007,
replacement/no-lgpl-right-weakening-proposed]

- The adapter boundary is **frozen at Architecture v1.1** (FROZEN in
  `governance/architecture-versions.json`), defined by spec/architecture.md,
  spec/architecture-lock.md and ACR-002.
- The adapter-replacement proof (RESEARCH-CAD-001 item 9) is the basis: the
  identical domain-level suite imports no engine modules, passes identically
  through the IfcOpenShell+OCCT adapter and a pure-Python reference adapter,
  and unsupported operations raise typed errors. Engine imports are confined
  to `offisos_cadbench/engines/`.
- The adapter/process boundary **preserves the LGPL user-replacement right**
  for every copyleft component (OCCT, IfcOpenShell, FreeCAD): a user can
  replace any of them with a compatible implementation of the
  `CadBimAdapter` contract without touching proprietary adapter code.
- **The final adapter-boundary + replacement-path + end-to-end-workflow proof
  is deferred to RESEARCH-CAD-007** (the final CAD/BIM feasibility gate, per
  the Issue #6 directive). This gate references CAD-001's existing
  replacement proof as the basis for the LGPL-compliance analysis; it does
  not re-prove the replacement path end-to-end.
- **No weakening of the LGPL user-replacement right is proposed.** The flags
  recommend dynamic/separate-process composition (the LGPL-compliant posture)
  and explicitly flag static linking of LGPL into closed-source code as
  review-required.

## 7. Limitations and explicit unknowns

1. **Records/inventory only.** This gate does not exercise the CAD/BIM
   engines; it records versions/licenses/composition facts from the
   authoritative pinned sources. It does not re-measure performance or
   re-prove capability (those are CAD-001..005's evidence).
2. **WASM not tested.** The web model's in-browser-WASM path (OCCT
   emscripten, cadquery-ocp WASM, IfcOpenShell WASM) was not exercised in
   CAD-001..005; the tested web path is server-side only. A distributable
   web client bundling LGPL WASM would need LICENSE-001 Section 4 review.
3. **Electron packaging not built.** This gate records the licensing
   posture for an Electron/desktop model; it does not build or ship an
   Electron package. Production packaging is LICENSE-001 + downstream's
   decision (out of scope per Issue #6).
4. **Metadata license fields are not authoritative.** Some installed
   distributions carry short or non-SPDX license metadata (e.g. numpy's
   field is a copyright string, not "BSD-3-Clause"). The upstream fact is
   authoritative; the metadata is a cross-reference only.
5. **No legal approval.** This gate produces evidence and flags FOR
   LICENSE-001. The composition decision (and any production packaging
   change) is LICENSE-001's, not this gate's.

## 8. Recommendation (INFERRED from the above; decision belongs to LICENSE-001)

The tested CAD/BIM stack is **licensing-composition-tractable behind the
frozen adapter boundary (Architecture v1.1) for both deployment models**,
subject to LICENSE-001's legal/architect review of the recorded flags:

- the copyleft present is **LGPL only** (no GPL contamination path);
- the adapter/process boundary **preserves the LGPL user-replacement right**
  for OCCT, IfcOpenShell and FreeCAD;
- the tested composition posture is **dynamic/separate-process** (no
  static linking of LGPL into closed-source code);
- pure network SaaS deployment triggers **no** LGPL Section 4 distribution
  obligation; a distributable web/desktop client bundling LGPL native code
  triggers Section 4, satisfied by separability + a written offer for source.

No architecture change is required or proposed by this evidence (Architecture
v1.1 remains FROZEN). The final adapter-boundary + replacement-path +
end-to-end-workflow proof is RESEARCH-CAD-007's scope.
