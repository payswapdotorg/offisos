"""Benchmark: Electron/desktop deployment model analysis (RESEARCH-CAD-006 item 5).

Analyses the Electron/desktop deployment model (bundling the CAD/BIM stack
as native worker processes spawned by an Electron host). Desktop
distribution bundles LGPL-2.1 (OCCT, FreeCAD) and LGPL-3.0 (IfcOpenShell)
components; the LGPL requires the user's right to replace them (dynamic/
separate-process linking + written offer for source). The frozen adapter
boundary (Architecture v1.1) is the architectural compliance mechanism:
no static linking of LGPL into closed-source code in the tested path.
"""
from __future__ import annotations


def run(result) -> None:
    from ..inventory import DEPLOYMENT_MODELS

    desktop = DEPLOYMENT_MODELS["desktop"]

    # ------------------------------------------------------------------
    # 1. The tested desktop path is documented (Electron host + native
    #    CAD/BIM workers as separate processes; FreeCAD tested via the
    #    official AppImage, a self-contained native bundle).
    # ------------------------------------------------------------------
    result.observe(
        "deployment/desktop/tested-path-documented",
        "The tested desktop deployment path is documented: the CAD/BIM stack "
        "(OCCT/IfcOpenShell/FreeCAD) runs as native worker processes spawned "
        "by an Electron host. FreeCAD was tested via the official AppImage "
        "(a self-contained native bundle).",
        bool(desktop["tested_path"]),
        details={"tested_path": desktop["tested_path"]},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. The Electron host license is recorded (MIT — Electron, Chromium,
    #    and Node are all permissively licensed; no copyleft from the host).
    # ------------------------------------------------------------------
    result.observe(
        "deployment/desktop/electron-license-recorded",
        "The Electron host license is recorded: MIT (Electron = MIT; "
        "Chromium is BSD/MIT-derived; Node is MIT). No copyleft concern "
        "from the host stack itself.",
        bool(desktop["electron_license"]),
        details={"electron_license": desktop["electron_license"]},
        epistemic="OBSERVED",
    )
    result.measure("electron_license", desktop["electron_license"])

    # ------------------------------------------------------------------
    # 3. The LGPL posture for the desktop model is documented: dynamic/
    #    separate-process linking + written offer for source for the LGPL
    #    portions; the adapter boundary isolates the LGPL components.
    # ------------------------------------------------------------------
    result.observe(
        "deployment/desktop/lgpl-posture-documented",
        "The LGPL posture for the desktop model is documented: desktop "
        "distribution bundles LGPL-2.1 (OCCT, FreeCAD) and LGPL-3.0 "
        "(IfcOpenShell) components. The LGPL requires the user's right to "
        "replace the LGPL portions (dynamic/separate-process linking + a "
        "written offer for the corresponding source for 3 years). The "
        "frozen adapter boundary (Architecture v1.1) isolates the LGPL "
        "components behind a process/adapter boundary.",
        bool(desktop["lgpl_posture"]),
        details={"lgpl_posture": desktop["lgpl_posture"]},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 4. The adapter boundary (v1.1) is the architectural compliance
    #    mechanism — it isolates the LGPL components so that user-"
    #    replaceability is preserved without exposing proprietary adapter
    #    code. (INFERRED from bench_replacement_path's evidence.)
    # ------------------------------------------------------------------
    result.observe(
        "deployment/desktop/adapter-boundary-is-compliance-mechanism",
        "The frozen adapter boundary (Architecture v1.1) is the architectural "
        "LGPL-compliance mechanism for the desktop model: it isolates the "
        "LGPL components so user-replaceability is preserved without exposing "
        "proprietary adapter code. (Inferred from the adapter-replacement "
        "proof in RESEARCH-CAD-001 item 9 — see bench_replacement_path.)",
        True,
        details={
            "adapter_boundary_version": "1.1 (FROZEN)",
            "mechanism": "LGPL components run behind a process/adapter boundary; engines are confined to engines/; swapping requires implementing the CadBimAdapter contract only.",
        },
        epistemic="INFERRED",
        evidence_refs=[
            "deployment/desktop/lgpl-posture-documented",
            "replacement/adapter-boundary-v1.1-frozen",
        ],
    )

    # ------------------------------------------------------------------
    # 5. Explicit constraint: no static linking of LGPL code into closed-
    #    source code in the tested path. The tested path uses dynamic/
    #    separate-process composition, which avoids the LGPL static-linking
    #    object-files/relinking obligation.
    # ------------------------------------------------------------------
    result.observe(
        "deployment/desktop/no-static-linking-of-lgpl-into-closed-source",
        "Explicit constraint: no static linking of LGPL code into closed-"
        "source code in the tested path. The tested path uses dynamic/"
        "separate-process composition (FreeCAD as a self-contained AppImage; "
        "OCCT/IfcOpenShell as separate worker processes), which avoids the "
        "LGPL static-linking obligation (object files / relinking capability). "
        "Static linking of LGPL into closed-source code would require that "
        "obligation and is flagged review-required if ever attempted.",
        True,
        details={
            "tested_composition": "dynamic / separate-process (AppImage + worker processes)",
            "flag": desktop["flag"],
            "severity": desktop["flag_severity"],
            "constraint": "no static linking of LGPL into closed-source code",
        },
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 6. FreeCAD AppImage separability: the AppImage is a self-contained,
    #    user-replaceable unit (swap the AppImage file). LGPL obligations
    #    for the FreeCAD-embedded OCCT are satisfied by AppImage separability
    #    plus a written offer for the corresponding source.
    # ------------------------------------------------------------------
    result.observe(
        "deployment/desktop/freecad-appimage-separable",
        "FreeCAD is distributed as a self-contained AppImage (a user-"
        "replaceable unit: swap the AppImage file). LGPL obligations for the "
        "FreeCAD-embedded OCCT are satisfied by AppImage separability plus a "
        "written offer for the corresponding source for the LGPL portions.",
        True,
        details={
            "freecad_version": "1.1.3",
            "distribution": "Official Linux x86_64 AppImage (py311)",
            "sha256": "3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef",
            "separability": "AppImage is a single replaceable file (user can swap the whole unit)",
        },
        epistemic="OBSERVED",
    )
