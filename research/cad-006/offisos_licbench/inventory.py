"""Authoritative licensing/composition data model for RESEARCH-CAD-006.

The exact TESTED components and their licenses, drawn from stable upstream
statements (mirroring RESEARCH-CAD-001's bench_licensing.py UPSTREAM_LICENSES
facts, refined with the CAD-001..005 test coverage and the deployment-model
analysis). Versions are asserted from the authoritative pinned sources; the
benchmark modules cross-check these against the live environment.

Composition approval is LICENSE-001's decision, not this gate's. The flags
here are facts FOR that gate, not decisions.
"""
from __future__ import annotations

# The exact TESTED stack across RESEARCH-CAD-001..005.
# version: exact version asserted from CAD-001 requirements.txt + the
#   committed environment.json snapshots (see harness.environment_snapshot
#   -> snapshot_cross_reference).
TESTED_COMPONENTS: dict[str, dict] = {
    "ifcopenshell": {
        "version": "0.8.5",
        "license": "LGPL-3.0-or-later",
        "license_explanation": "IfcOpenShell is Free Software under LGPL-3.0-or-later (with OCCT-based geometry components).",
        "upstream": "https://ifcopenshell.org",
        "distribution": "PyPI sdist/wheel; bundles OCCT-based geometry components",
        "tested_in": ["CAD-001", "CAD-003", "CAD-004", "CAD-005"],
        "role": "BIM semantics + IFC I/O (authoring, round-trip, semantic extraction)",
        "composition_flag": (
            "LGPL-3.0-or-later. Section 4 (combined works) review required for "
            "distributable compositions; the frozen adapter/process boundary "
            "preserves user-replaceability. Pure network SaaS use is not "
            "'distribution' and does not trigger Section 4."
        ),
        "flag_severity": "review-required-for-distribution",
    },
    "occt": {
        "version": "7.8.1",
        "binding_version": "7.8.1.1.post1",  # cadquery-ocp distribution version
        "license": "LGPL-2.1-or-later WITH OCCT-LINKING-EXCEPTION",
        "license_explanation": (
            "Open CASCADE Technology: LGPL-2.1-or-later with an exception "
            "permitting use under a broader set of terms for the library itself."
        ),
        "upstream": "https://github.com/Open-Cascade-SAS/OCCT",
        "distribution": "C++ library; Python bindings via OCP (Apache-2.0 pybind11)",
        "tested_in": ["CAD-001", "CAD-002", "CAD-003", "CAD-005"],
        "role": "3D geometry kernel (BRep, booleans, tessellation, STEP I/O)",
        "composition_flag": (
            "LGPL-2.1-with-exception. Dynamic linking / separate-process use "
            "preserves the exception; static linking or modification triggers "
            "copyleft review. The frozen adapter boundary keeps OCCT as a "
            "separately-loaded dynamic component (user-replaceable)."
        ),
        "flag_severity": "review-required-for-static-linking",
    },
    "cadquery-ocp": {
        "version": "7.8.1.1.post1",
        "license": "Apache-2.0",
        "license_explanation": "OCP are Apache-2.0-licensed pybind11 bindings of OCCT; the wrapped OCCT library carries its own license (see occt).",
        "upstream": "https://github.com/CadQuery/OCP",
        "distribution": "PyPI wheel (Apache-2.0 pybind11 bindings wrapping OCCT)",
        "tested_in": ["CAD-001", "CAD-002", "CAD-003", "CAD-004", "CAD-005"],
        "role": "Distribution channel for OCCT; parametric API not exercised",
        "composition_flag": (
            "Apache-2.0 permissive bindings; the WRAPPED OCCT carries its own "
            "LGPL-2.1-with-exception license (see occt). No standalone copyleft "
            "concern from the bindings themselves."
        ),
        "flag_severity": "informational",
    },
    "cadquery": {
        "version": "2.6.1",
        "license": "Apache-2.0",
        "license_explanation": "Used only as the distribution channel for OCP in the tested stack; its parametric API is not exercised.",
        "upstream": "https://github.com/CadQuery/cadquery",
        "distribution": "PyPI; distribution channel only",
        "tested_in": ["CAD-001", "CAD-002", "CAD-003", "CAD-004", "CAD-005"],
        "role": "Distribution channel only (parametric API not exercised)",
        "composition_flag": "Apache-2.0 permissive; no copyleft concern.",
        "flag_severity": "informational",
    },
    "ezdxf": {
        "version": "1.4.3",
        "license": "MIT",
        "license_explanation": "DXF read/write library evaluated for the 2D drafting representation gap (layers, dimensions).",
        "upstream": "https://github.com/mozman/ezdxf",
        "distribution": "PyPI wheel",
        "tested_in": ["CAD-001"],
        "role": "2D drafting representation gap-filler (DXF layers/dimensions)",
        "composition_flag": "MIT permissive; no copyleft concern.",
        "flag_severity": "informational",
    },
    "numpy": {
        "version": "2.1.3",
        "license": "BSD-3-Clause",
        "license_explanation": "Numeric dependency of ifcopenshell/ocp shape building.",
        "upstream": "https://numpy.org",
        "distribution": "PyPI wheel; transitive dependency",
        "tested_in": ["CAD-001", "CAD-002", "CAD-003", "CAD-004", "CAD-005"],
        "role": "Numeric arrays (transitive)",
        "composition_flag": "BSD-3-Clause permissive; no copyleft concern.",
        "flag_severity": "informational",
    },
    "freecad": {
        "version": "1.1.3",
        "license": "LGPL-2.1-or-later",
        "license_explanation": "FreeCAD application + Sketcher/Draft/TechDraw: LGPL-2.1-or-later, embedding OCCT.",
        "upstream": "https://github.com/FreeCAD/FreeCAD",
        "distribution": "Official Linux x86_64 AppImage (py311); self-contained native bundle",
        "sha256": "3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef",
        "tested_in": ["CAD-001", "CAD-002", "CAD-005"],
        "role": "2D drafting (Draft), constraint solving (Sketcher), drawing production (TechDraw), FCStd persistence",
        "composition_flag": (
            "LGPL-2.1-or-later application embedding OCCT; distributed as a "
            "self-contained AppImage (already dynamically composed). User-"
            "replaceable as a unit (swap the AppImage); LGPL obligations "
            "satisfied by AppImage separability plus a written offer for the "
            "corresponding source for the LGPL portions."
        ),
        "flag_severity": "review-required-for-attribution",
    },
    "python": {
        "version": "3.12.13",
        "license": "PSF-2.0 (Python Software Foundation License)",
        "license_explanation": "CPython reference interpreter; the AppImage bundles py311.",
        "upstream": "https://www.python.org",
        "distribution": "CPython; AppImage bundles py311",
        "tested_in": ["CAD-001", "CAD-002", "CAD-003", "CAD-004", "CAD-005"],
        "role": "Runtime",
        "composition_flag": "PSF-2.0 permissive (GPL-compatible); no copyleft concern.",
        "flag_severity": "informational",
    },
}

# The two deployment models this gate must cover per the Issue #6 directive.
DEPLOYMENT_MODELS: dict[str, dict] = {
    "web": {
        "title": "Web deployment model (browser client + server-side CAD/BIM workers)",
        "tested_path": (
            "Headless server-side execution: FreeCADCmd / OCCT (via OCP) / "
            "IfcOpenShell run in worker processes; geometry is streamed to the "
            "browser as tessellated meshes; no native CAD code is shipped to "
            "the browser in the tested configuration."
        ),
        "wasm_note": (
            "OCCT has an emscripten/WASM build path; cadquery-ocp WASM and "
            "IfcOpenShell WASM were NOT tested in CAD-001..005. The tested web "
            "path is server-side, not in-browser WASM."
        ),
        "client_stack": "Browser + canvas/WebGL viewer (tessellated meshes from server); no LGPL native code in the browser in the tested configuration.",
        "lgpl_posture": (
            "Pure network SaaS deployment does not constitute 'distribution' "
            "under the LGPL; Section 4 (combined works) obligations are not "
            "triggered for server-side-only use. If a downloadable web client "
            "bundles LGPL native code (e.g. a WASM OCCT build), Section 4 "
            "applies and the adapter boundary preserves user-replaceability."
        ),
        "flag": "no-concern-for-pure-saas; review-required-for-distributable-web-client",
        "flag_severity": "review-required-conditional",
    },
    "desktop": {
        "title": "Electron/desktop deployment model (bundling the CAD/BIM stack)",
        "tested_path": (
            "The CAD/BIM stack (OCCT/IfcOpenShell/FreeCAD) runs as native "
            "worker processes spawned by an Electron host. FreeCAD was tested "
            "via the official AppImage (a self-contained native bundle)."
        ),
        "electron_license": "MIT (Electron = MIT; Chromium BSD/MIT-derived; Node MIT)",
        "client_stack": "Electron host (MIT) + native CAD/BIM workers (LGPL-2.1/LGPL-3.0) as separate processes; no LGPL code is statically linked into closed-source code in the tested path.",
        "lgpl_posture": (
            "Desktop distribution bundles LGPL-2.1 (OCCT, FreeCAD) and "
            "LGPL-3.0 (IfcOpenShell) components. The LGPL requires the user's "
            "right to replace the LGPL portions (dynamic linking / separate "
            "files plus a written offer for the corresponding source for 3 "
            "years). The frozen adapter boundary (Architecture v1.1) isolates "
            "the LGPL components behind a process/adapter boundary, enabling "
            "user-replaceability without exposing proprietary adapter code. "
            "Static linking of LGPL code into closed-source code would require "
            "object files / relinking capability; the tested path uses "
            "dynamic/separate-process composition, which avoids this."
        ),
        "flag": (
            "review-required; adapter-boundary-is-the-compliance-mechanism; "
            "dynamic-or-separate-process-linking-required (no static linking "
            "of LGPL into closed-source code)"
        ),
        "flag_severity": "review-required",
    },
}

# The adapter boundary (frozen at Architecture v1.1) is the LGPL-compliance
# mechanism. Proven by RESEARCH-CAD-001 item 9 (adapter replacement proof):
# the domain-level test suite imports no engine modules; engines are
# confined to offisos_cadbench/engines/; swapping requires implementing the
# CadBimAdapter contract only; unsupported operations raise typed errors.
ADAPTER_BOUNDARY = {
    "version": "1.1",
    "status": "FROZEN",
    "defined_by": [
        "spec/architecture.md",
        "spec/architecture-lock.md",
        "governance/architecture-changes/ACR-002-cad-bim-web-desktop-client-topology.md",
    ],
    "proof_reference": "RESEARCH-CAD-001 item 9 (adapter boundary and replacement proof)",
    "lgpl_significance": (
        "The adapter/process boundary isolates LGPL-licensed CAD/BIM components "
        "(OCCT, IfcOpenShell, FreeCAD) so that they remain user-replaceable in "
        "both deployment models. This is the architectural mechanism that makes "
        "LGPL composition tractable without weakening the LGPL user-replacement "
        "right."
    ),
}

# The set of components whose licenses are copyleft (require review for
# distribution) — used by bench_composition to raise the review flags.
COPYLEFT_COMPONENTS = {
    name: facts
    for name, facts in TESTED_COMPONENTS.items()
    if facts["license"].startswith("LGPL")
    or facts["license"].startswith("GPL")
}

# Permissive-only components (no copyleft concern).
PERMISSIVE_COMPONENTS = {
    name: facts
    for name, facts in TESTED_COMPONENTS.items()
    if name not in COPYLEFT_COMPONENTS
}
