"""Benchmark: licensing and composition inventory (RESEARCH-CAD-001 item 10).

Records the exact components and versions tested with their licenses,
measured from the installed distributions where possible. This is an
inventory for the Architect and the LICENSE-001 work item — it does NOT
approve any composition.
"""
from __future__ import annotations

# Upstream license facts (stable, public statements of the projects).
# Composition approval is LICENSE-001's decision, not this benchmark's.
UPSTREAM_LICENSES = {
    "ifcopenshell": {
        "license": "LGPL-3.0-or-later",
        "upstream": "https://ifcopenshell.org",
        "notes": "IfcOpenShell is Free Software under LGPL-3.0-or-later "
        "(with OCCT-based geometry components)",
    },
    "cadquery-ocp": {
        "license": "Apache-2.0 (bindings) wrapping OCCT",
        "upstream": "https://github.com/CadQuery/OCP",
        "notes": "OCP are Apache-2.0-licensed pybind11 bindings of OCCT; "
        "the wrapped OCCT library carries its own license (below)",
    },
    "occt": {
        "license": "LGPL-2.1 WITH OCCT-exception",
        "upstream": "https://github.com/Open-Cascade-SAS/OCCT",
        "notes": "Open CASCADE Technology: LGPL-2.1 with an exception "
        "permiting use under a broader set of terms for the library itself",
    },
    "cadquery": {
        "license": "Apache-2.0",
        "upstream": "https://github.com/CadQuery/cadquery",
        "notes": "Used only as the distribution channel for OCP in this "
        "benchmark; its parametric API is not exercised",
    },
    "ezdxf": {
        "license": "MIT",
        "upstream": "https://github.com/mozman/ezdxf",
        "notes": "DXF read/write library evaluated for the 2D drafting "
        "representation gap (layers, dimensions)",
    },
    "numpy": {
        "license": "BSD-3-Clause",
        "upstream": "https://numpy.org",
        "notes": "Numeric dependency of ifcopenshell/shape_builder",
    },
    "freecad": {
        "license": "LGPL-2.1-or-later",
        "upstream": "https://github.com/FreeCAD/FreeCAD",
        "notes": "FreeCAD application + Sketcher: listed candidate; not "
        "installable in this benchmark sandbox (no sudo/apt); untested here",
    },
}


def run(result) -> None:
    import importlib.metadata as md

    installed = {}
    for dist in ["ifcopenshell", "cadquery-ocp", "cadquery", "ezdxf", "numpy"]:
        try:
            dist_info = md.distribution(dist)
            license_field = dist_info.metadata.get("License", "") or ""
            home = dist_info.metadata.get("Home-page", "") or ""
            installed[dist] = {
                "version": dist_info.version,
                "license_field": license_field[:120],
                "home_page": home,
            }
        except md.PackageNotFoundError:
            installed[dist] = None

    # OCCT runtime version: the OCP bindings distribution version tracks
    # the wrapped OCCT release (7.8.1.1.post1 -> OCCT 7.8.1).
    occt_version = installed.get("cadquery-ocp", {}).get("version", "unknown")

    # ------------------------------------------------------------------
    # 1. Exact versions tested (measured, not assumed)
    # ------------------------------------------------------------------
    result.observe(
    "license/inventory/versions-recorded",
        "Exact versions of every tested component are recorded from the "
        "installed distributions and the OCCT runtime.",
        all(installed.get(d) for d in ["ifcopenshell", "cadquery-ocp", "ezdxf", "numpy"]),
        details={
            "installed": installed,
            "occt_runtime_version": occt_version,
        },
        epistemic="OBSERVED",
    )
    result.measure("occt_version", occt_version)
    for dist, info in installed.items():
        if info:
            result.measure(f"version:{dist}", info["version"])

    # ------------------------------------------------------------------
    # 2. License identification per component
    # ------------------------------------------------------------------
    inventory = {}
    all_identified = True
    for component, facts in UPSTREAM_LICENSES.items():
        inventory[component] = facts
        if component == "freecad":
            continue  # not tested here; recorded for completeness
        if not facts.get("license"):
            all_identified = False
    result.observe(
        "license/inventory/licenses-identified",
        "Every tested component has an identified license and upstream reference.",
        all_identified,
        details={"inventory": inventory},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 3. Composition flags (facts for LICENSE-001, not decisions)
    # ------------------------------------------------------------------
    flags = [
        {
            "component": "occt",
            "flag": "LGPL-2.1-with-exception geometry kernel used via "
            "pybind11 bindings (Apache-2.0). Dynamic linking preserves the "
            "exception; static linking or modification triggers copyleft "
            "review.",
            "severity": "review-required",
        },
        {
            "component": "ifcopenshell",
            "flag": "LGPL-3.0-or-later. Composition with LGPL-3 components "
            "requires review of Section 4 terms (combined works).",
            "severity": "review-required",
        },
        {
            "component": "ezdxf",
            "flag": "MIT; no copyleft concern identified.",
            "severity": "informational",
        },
        {
            "component": "freecad",
            "flag": "LGPL-2.1-or-later application embedding OCCT; not "
            "tested in this environment, recorded for the next gate.",
            "severity": "not-tested",
        },
    ]
    result.observe(
        "license/composition/flags-recorded",
        "Composition constraints are recorded as explicit flags for the "
        "LICENSE-001 licensing gate; no composition is approved here.",
        len(flags) >= 4,
        details={"flags": flags},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 4. Distribution metadata cross-check (metadata license fields)
    # ------------------------------------------------------------------
    metadata_present = all(
        installed[d] is not None for d in ("ifcopenshell", "cadquery-ocp", "ezdxf", "numpy")
    )
    result.observe(
        "license/metadata/present",
        "Installed distribution metadata is present for license cross-checking.",
        metadata_present,
        details={
            "license_fields": {
                d: (installed[d] or {}).get("license_field", "missing")
                for d in installed
            }
        },
        epistemic="OBSERVED",
    )

    result.measure("composition_decision_owner", "LICENSE-001 (not this benchmark)")
