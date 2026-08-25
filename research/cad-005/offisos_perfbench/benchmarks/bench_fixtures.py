"""Benchmark: fixture tiers and their documented characteristics.

Issue #5 scope 1: "Fixture tiers — small architectural model; medium
construction model; larger stress model representative of anticipated
professional use; IFC fixtures with increasing entity/geometry counts."

This module builds the corpus once, records every tier's documented
characteristics (entity counts, element counts, file sizes, geometric
totals, SHA256) and proves fixture *structural determinism* (rebuilding
produces identical structure; byte-identity is impossible because IFC
GlobalIds are regenerated per build — the CAD-001 finding, restated as
an explicit nondeterminism datum rather than hidden).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..fixtures import (
    FCSTD_TIERS,
    IFC_TIERS,
    OCCT_TIERS,
    write_ifc_tier,
)


def run(bench, ctx: dict[str, Any]) -> None:
    workdir: Path = ctx["workdir"]
    fixtures_dir = workdir / "fixtures"
    fixtures_dir.mkdir(parents=True, exist_ok=True)

    tiers: dict[str, dict[str, Any]] = {}
    for tier_name, spec in IFC_TIERS.items():
        path = fixtures_dir / f"ifc-{tier_name}.ifc"
        info = write_ifc_tier(spec, path)
        tiers[tier_name] = info
        bench.measure(f"ifc_{tier_name}", info)

    # Documented characteristics per tier (issue #5: "documented
    # characteristics").
    ordered = [tiers["small"], tiers["medium"], tiers["large"]]
    for info in ordered:
        bench.observe(
            f"ifc/{info['tier']}/characteristics",
            f"IFC {info['tier']} tier documented: {info['products_total']} "
            f"IfcProducts, {info['step_entities']} STEP entities, "
            f"{info['walls']} walls, {info['file_size_bytes']} bytes.",
            condition=info["products_total"] > 0 and info["walls"] > 0,
            details={
                "products": info["products_total"],
                "step_entities": info["step_entities"],
                "walls": info["walls"],
                "doors": info["doors"],
                "windows": info["windows"],
                "spaces": info["spaces"],
                "openings": info["openings"],
                "file_size_bytes": info["file_size_bytes"],
                "total_wall_length_m": info["total_wall_length_m"],
                "total_wall_gross_volume_m3": info["total_wall_gross_volume_m3"],
                "sha256": info["sha256"],
            },
            epistemic="OBSERVED",
        )

    # Increasing entity/geometry counts across tiers (scaling monotonicity).
    bench.observe(
        "ifc/tiers/increasing",
        "IFC fixture entity and geometry counts increase across the three "
        "scales (small < medium < large).",
        condition=(
            tiers["small"]["step_entities"] < tiers["medium"]["step_entities"]
            < tiers["large"]["step_entities"]
            and tiers["small"]["walls"] < tiers["medium"]["walls"]
            < tiers["large"]["walls"]
        ),
        details={
            "step_entities": [
                tiers[t]["step_entities"] for t in ("small", "medium", "large")
            ],
            "walls": [tiers[t]["walls"] for t in ("small", "medium", "large")],
            "file_size_bytes": [
                tiers[t]["file_size_bytes"] for t in ("small", "medium", "large")
            ],
        },
        epistemic="CALCULATED",
    )

    # Scaling ratios (the comparability currency across environments).
    s, m, l = (tiers[t] for t in ("small", "medium", "large"))
    bench.measure(
        "scaling",
        {
            "entity_ratio_medium_over_small": round(
                m["step_entities"] / s["step_entities"], 2
            ),
            "entity_ratio_large_over_medium": round(
                l["step_entities"] / m["step_entities"], 2
            ),
            "size_ratio_large_over_small": round(
                l["file_size_bytes"] / s["file_size_bytes"], 2
            ),
        },
    )

    # Structural determinism of fixture generation (rebuild -> same
    # structure; GlobalIds differ by design).
    rebuild_dir = workdir / "fixtures-rebuild"
    rebuild_dir.mkdir(parents=True, exist_ok=True)
    for tier_name in ("small", "medium", "large"):
        info2 = write_ifc_tier(
            IFC_TIERS[tier_name], rebuild_dir / f"ifc-{tier_name}.ifc"
        )
        info1 = tiers[tier_name]
        structurally_equal = (
            info2["step_entities"] == info1["step_entities"]
            and info2["products_total"] == info1["products_total"]
            and info2["walls"] == info1["walls"]
            and info2["doors"] == info1["doors"]
            and info2["windows"] == info1["windows"]
            and info2["spaces"] == info1["spaces"]
            and abs(info2["total_wall_length_m"] - info1["total_wall_length_m"])
            < 1e-9
        )
        byte_identical = info2["sha256"] == info1["sha256"]
        bench.observe(
            f"ifc/{tier_name}/structural_determinism",
            f"Rebuilding the {tier_name} fixture reproduces identical "
            "structure (entity counts, element counts, geometric totals).",
            condition=structurally_equal,
            details={
                "structurally_equal": structurally_equal,
                "byte_identical": byte_identical,
                "sha256_first": info1["sha256"],
                "sha256_second": info2["sha256"],
                "note": (
                    "Byte-identity is not expected: IFC GlobalIds are "
                    "regenerated per build (CAD-001 finding; engine "
                    "nondeterminism restated as an explicit datum)."
                ),
            },
            epistemic="OBSERVED",
        )

    # OCCT + FCStd tier specs documented (built in their own benchmarks).
    bench.measure(
        "occt_tiers", {t: spec.describe() for t, spec in OCCT_TIERS.items()}
    )
    bench.measure(
        "fcstd_tiers", {t: spec.describe() for t, spec in FCSTD_TIERS.items()}
    )
    bench.observe(
        "occt/tiers/increasing",
        "OCCT workload tiers increase across the three scales "
        "(primitives, plate holes, boolean chain length).",
        condition=(
            OCCT_TIERS["small"].primitives < OCCT_TIERS["medium"].primitives
            < OCCT_TIERS["large"].primitives
        ),
        details={
            t: OCCT_TIERS[t].describe() for t in ("small", "medium", "large")
        },
        epistemic="CALCULATED",
    )
    bench.observe(
        "fcstd/tiers/increasing",
        "FreeCAD FCStd workload tiers increase across the three scales "
        "(wall features, parametric cut features).",
        condition=(
            FCSTD_TIERS["small"].walls < FCSTD_TIERS["medium"].walls
            < FCSTD_TIERS["large"].walls
        ),
        details={
            t: FCSTD_TIERS[t].describe() for t in ("small", "medium", "large")
        },
        epistemic="CALCULATED",
    )

    ctx["ifc_tiers"] = tiers
