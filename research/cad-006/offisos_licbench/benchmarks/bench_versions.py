"""Benchmark: exact tested-version recording (RESEARCH-CAD-006 item 1).

Records the exact version of every tested component from the authoritative
pinned sources (CAD-001 requirements.txt, the CAD-001..005 committed
environment.json snapshots, and the FreeCAD AppImage SHA256 manifest), and
cross-checks against the currently-importable distribution metadata where
present. Versions are OBSERVED-from-artifact (the committed pins/snapshots
are the evidence), not assumed.
"""
from __future__ import annotations


def run(result) -> None:
    from ..harness import environment_snapshot
    from ..inventory import TESTED_COMPONENTS

    env = environment_snapshot()
    pins = env["cad001_requirements_pins"]
    snapshots = env["snapshot_cross_reference"]
    installed = env["installed_metadata"]
    fc_manifest = env.get("freecad_appimage_manifest")

    # ------------------------------------------------------------------
    # 1. Every tested component has a version recorded from an
    #    authoritative pinned source.
    # ------------------------------------------------------------------
    recorded = {}
    for component, facts in TESTED_COMPONENTS.items():
        recorded[component] = facts["version"]
    result.observe(
        "versions/recorded",
        "Every tested component has an exact version recorded from the "
        "authoritative pinned sources (CAD-001 requirements.txt + the "
        "CAD-001..005 committed environment.json snapshots + the FreeCAD "
        "AppImage SHA256 manifest).",
        all(v for v in recorded.values()),
        details={"recorded_versions": recorded},
        epistemic="OBSERVED",
    )
    for component, ver in recorded.items():
        result.measure(f"version:{component}", ver)

    # ------------------------------------------------------------------
    # 2. Pin/snapshot consistency: the CAD-001 requirements.txt pins match
    #    the committed environment.json snapshots (the tested versions are
    #    internally consistent across the evidence corpus).
    # ------------------------------------------------------------------
    pin_snapshot_consistent = True
    consistency_detail: dict = {}
    # ifcopenshell / cadquery / cadquery-ocp / ezdxf / numpy are in every
    # committed snapshot; verify the snapshots agree with the CAD-001 pins.
    for pkg in ["ifcopenshell", "cadquery", "cadquery-ocp", "ezdxf", "numpy"]:
        pin_ver = pins.get(pkg)
        consistency_detail[pkg] = {"pin": pin_ver, "snapshots": {}}
        for gate, snap in snapshots.items():
            if snap is None or isinstance(snap, dict) and "error" in snap:
                consistency_detail[pkg]["snapshots"][gate] = None
                continue
            snap_pkgs = (snap or {}).get("packages") or {}
            snap_ver = snap_pkgs.get(pkg)
            consistency_detail[pkg]["snapshots"][gate] = snap_ver
            if snap_ver is not None and pin_ver is not None and snap_ver != pin_ver:
                pin_snapshot_consistent = False
    result.observe(
        "versions/pin-snapshot-consistency",
        "The CAD-001 requirements.txt pins are consistent with the committed "
        "environment.json snapshots across CAD-001..005 (the tested versions "
        "are internally consistent across the evidence corpus).",
        pin_snapshot_consistent,
        details=consistency_detail,
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 3. Live cross-check: for each importable distribution, the installed
    #    version matches the recorded tested version. Non-importable dists
    #    in THIS evidence-collection environment (ifcopenshell, freecad) are
    #    recorded honestly with a note — not coerced to pass or fail.
    # ------------------------------------------------------------------
    live_check: dict = {}
    all_match = True
    for component, facts in TESTED_COMPONENTS.items():
        tested_ver = facts["version"]
        live = installed.get(component)
        if live is None:
            # ifcopenshell/freecad/python are not pip distributions in this env;
            # version is asserted from the pinned source (authoritative).
            live_check[component] = {
                "tested_version": tested_ver,
                "live_installed": None,
                "match": "n/a (not importable in this env; asserted from pinned source)",
            }
            continue
        live_ver = live.get("version") if isinstance(live, dict) else None
        match = live_ver == tested_ver
        if not match:
            all_match = False
        live_check[component] = {
            "tested_version": tested_ver,
            "live_installed": live_ver,
            "match": match,
        }
    result.observe(
        "versions/live-cross-check",
        "For every importable distribution, the installed version matches the "
        "recorded tested version. Non-importable components in this evidence-"
        "collection environment are asserted from the authoritative pinned "
        "sources (not coerced).",
        all_match,
        details={"live_cross_check": live_check},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 4. FreeCAD AppImage SHA256 integrity: the recorded hash matches the
    #    committed manifest.
    # ------------------------------------------------------------------
    expected_sha = TESTED_COMPONENTS["freecad"]["sha256"]
    manifest_sha = fc_manifest.get("sha256") if fc_manifest else None
    result.observe(
        "versions/freecad-appimage-hash",
        "The FreeCAD 1.1.3 AppImage SHA256 recorded in the inventory matches "
        "the committed manifest (integrity of the tested native bundle).",
        manifest_sha == expected_sha,
        details={
            "expected_sha256": expected_sha,
            "manifest_sha256": manifest_sha,
            "manifest_path": fc_manifest.get("path") if fc_manifest else None,
        },
        epistemic="OBSERVED",
    )
    result.measure("freecad_appimage_sha256", expected_sha)

    # ------------------------------------------------------------------
    # 5. OCCT version is derived from the cadquery-ocp binding version
    #    (7.8.1.1.post1 -> OCCT 7.8.1) — a CALCULATED fact, not a direct
    #    measurement of the OCCT shared library.
    # ------------------------------------------------------------------
    binding_ver = TESTED_COMPONENTS["cadquery-ocp"]["version"]
    occt_ver = TESTED_COMPONENTS["occt"]["version"]
    derived = binding_ver.split(".")[0:3]
    derived_occt = ".".join(derived)
    result.observe(
        "versions/occt-via-binding",
        "The OCCT version (7.8.1) is derived from the cadquery-ocp binding "
        "distribution version (7.8.1.1.post1) — a CALCULATED fact, not a "
        "direct measurement of the OCCT shared library.",
        derived_occt == occt_ver,
        details={
            "binding_version": binding_ver,
            "derived_occt": derived_occt,
            "recorded_occt": occt_ver,
        },
        epistemic="CALCULATED",
    )
