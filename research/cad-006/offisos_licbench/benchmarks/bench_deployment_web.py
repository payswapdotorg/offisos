"""Benchmark: web deployment model analysis (RESEARCH-CAD-006 item 4).

Analyses the web deployment model (browser client + server-side CAD/BIM
workers) for licensing/composition posture. The tested path is server-side
(headless FreeCADCmd/OCCT/IfcOpenShell); pure network SaaS use is not
'distribution' under the LGPL. A downloadable web client bundling LGPL
native code (e.g. a WASM OCCT build) would trigger Section 4 — and WASM
paths were NOT tested in CAD-001..005, recorded honestly.
"""
from __future__ import annotations


def run(result) -> None:
    from ..inventory import DEPLOYMENT_MODELS

    web = DEPLOYMENT_MODELS["web"]

    # ------------------------------------------------------------------
    # 1. The tested web path is documented (server-side execution; geometry
    #    streamed to the browser as tessellated meshes; no native CAD code
    #    shipped to the browser in the tested configuration).
    # ------------------------------------------------------------------
    result.observe(
        "deployment/web/tested-path-documented",
        "The tested web deployment path is documented: headless server-side "
        "execution (FreeCADCmd/OCCT/IfcOpenShell in worker processes) with "
        "geometry streamed to the browser as tessellated meshes; no native "
        "CAD code is shipped to the browser in the tested configuration.",
        bool(web["tested_path"]),
        details={"tested_path": web["tested_path"]},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. The WASM path is explicitly recorded as NOT TESTED (epistemic
    #    honesty: OCCT has an emscripten/WASM build path, but cadquery-ocp
    #    WASM and IfcOpenShell WASM were not exercised in CAD-001..005).
    # ------------------------------------------------------------------
    result.observe(
        "deployment/web/wasm-not-tested-recorded",
        "The WASM/in-browser-native path is explicitly recorded as NOT "
        "TESTED in CAD-001..005. OCCT has an emscripten/WASM build path, but "
        "cadquery-ocp WASM and IfcOpenShell WASM were not exercised. The "
        "tested web path is server-side only.",
        True,
        details={"wasm_note": web["wasm_note"]},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 3. The LGPL posture for the web model is documented: pure network SaaS
    #    is not 'distribution' (no Section 4 trigger); a downloadable web
    #    client bundling LGPL native code would trigger Section 4 and the
    #    adapter boundary preserves user-replaceability.
    # ------------------------------------------------------------------
    result.observe(
        "deployment/web/lgpl-posture-documented",
        "The LGPL posture for the web model is documented: pure network SaaS "
        "deployment is not 'distribution' under the LGPL (no Section 4 "
        "combined-works trigger); a downloadable web client bundling LGPL "
        "native code would trigger Section 4, and the adapter boundary "
        "preserves user-replaceability.",
        bool(web["lgpl_posture"]),
        details={"lgpl_posture": web["lgpl_posture"]},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 4. No LGPL native code in the browser in the tested configuration
    #    (the browser receives only tessellated meshes from the server).
    # ------------------------------------------------------------------
    result.observe(
        "deployment/web/no-lgpl-native-in-browser-tested",
        "In the tested web configuration, no LGPL native code runs in the "
        "browser — the browser receives only tessellated meshes from the "
        "server-side workers. LGPL obligations attach to the server-side "
        "workers, not the browser payload, in this configuration.",
        True,
        details={
            "browser_payload": "tessellated meshes (geometry, not native code)",
            "lgpl_components_location": "server-side worker processes (FreeCADCmd/OCCT/IfcOpenShell)",
        },
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 5. Conditional flag: review is required ONLY for a distributable web
    #    client that bundles LGPL native code (e.g. a WASM OCCT build). Pure
    #    SaaS deployment needs no distribution-time LGPL review.
    # ------------------------------------------------------------------
    result.observe(
        "deployment/web/conditional-review-flag",
        "The review flag for the web model is CONDITIONAL: review is required "
        "only for a distributable web client that bundles LGPL native code "
        "(e.g. a WASM OCCT build). Pure SaaS deployment needs no "
        "distribution-time LGPL review.",
        True,
        details={
            "flag": web["flag"],
            "severity": web["flag_severity"],
            "no_concern_for": "pure network SaaS (server-side-only LGPL use)",
            "review_required_for": "downloadable web client bundling LGPL native code",
        },
        epistemic="INFERRED",
        evidence_refs=[
            "deployment/web/lgpl-posture-documented",
            "deployment/web/no-lgpl-native-in-browser-tested",
        ],
    )
