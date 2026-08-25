"""Benchmark: semantic and quantity extraction scaling.

Issue #5 scope 2/3: semantic extraction and quantity extraction with
measured timings across the three fixture scales, throughput
(elements/s), and engine/adapter separation.

Measurement boundary:
- ``semantic_extraction``  ENGINE = ifcopenshell get_psets over every
                           element (the engine's property machinery);
                           ADAPTER = Offisos snapshot assembly (domain
                           ids, provenance, class mapping) + canonical
                           JSON serialization.
- ``quantity_extraction``  ENGINE = qto reads (get_psets qtos_only) +
                           OCCT BRep volume properties of the wall
                           gross solid (the geometry side of quantities);
                           ADAPTER = QuantityRecord construction with
                           provenance and version stamping.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import ifcopenshell
from ifcopenshell.util.element import get_psets

from .. import ifc_adapter, occt_engine as oe
from ..timing import measure_split_repeated


def run(bench, ctx: dict[str, Any]) -> None:
    tiers: dict[str, dict[str, Any]] = ctx["ifc_tiers"]
    base_repeats: int = ctx.get("repeats", 5)

    semantic: dict[str, Any] = {}
    quantity: dict[str, Any] = {}

    for tier_name in ("small", "medium", "large"):
        info = tiers[tier_name]
        path = info["path"]
        repeats = max(2, base_repeats // 2) if tier_name == "large" else base_repeats
        elements = info["products_total"]
        walls = info["walls"]

        # --- semantic extraction ------------------------------------------
        f = ifcopenshell.open(path)

        def _engine_psets():
            out = []
            for ifc_class in (
                "IfcWall", "IfcSlab", "IfcSpace", "IfcDoor", "IfcWindow",
                "IfcOpeningElement",
            ):
                for product in f.by_type(ifc_class):
                    out.append(get_psets(product))
            return out

        m_sem = measure_split_repeated(
            operation=f"semantic_extraction[{tier_name}]",
            boundary=(
                "ENGINE = ifcopenshell get_psets over every element "
                "(property machinery); ADAPTER = Offisos snapshot assembly "
                "(domain ids, provenance, class mapping) + canonical JSON "
                "serialization"
            ),
            engine_fn=_engine_psets,
            adapter_fn=lambda _psets: ifc_adapter.serialize_index(
                ifc_adapter.extract_domain_index(f)
            ),
            repeats=repeats,
            extra={
                "tier": tier_name,
                "elements": elements,
            },
        )
        if m_sem.samples:
            m_sem.extra["throughput_elements_per_s"] = round(
                elements / (m_sem.total_ms_samples[0] / 1000.0), 1
            )
        semantic[tier_name] = m_sem.to_dict()

        # --- quantity extraction (engine: qto reads + BRep; adapter: records)
        wall_dims = []
        for w in f.by_type("IfcWall"):
            qtos = get_psets(w, qtos_only=True).get("Qto_WallCommon", {})
            wall_dims.append(
                (qtos.get("Length", 0.0), qtos.get("Width", 0.3),
                 qtos.get("Height", 3.0))
            )

        def _engine_quantity():
            # engine side 1: qto reads
            qto_values = []
            for w in f.by_type("IfcWall"):
                qto_values.append(get_psets(w, qtos_only=True))
            # engine side 2: OCCT BRep gross volumes (geometry engine)
            breps = []
            for length, width, height in wall_dims:
                breps.append(
                    oe.volume(oe.make_box(0.0, 0.0, 0.0, length, width, height))
                )
            return qto_values, breps

        def _adapter_quantity(engine_result):
            qto_values, breps = engine_result
            records = []
            for i, ((wall), brep_vol) in enumerate(zip(f.by_type("IfcWall"), breps)):
                identity = get_psets(wall).get("Pset_OffisosIdentity", {})
                domain_id = identity.get("DomainId", f"unkeyed:{i}")
                records.append(
                    {
                        "domain_id": domain_id,
                        "BRepGrossVolume": round(brep_vol, 6),
                        "model_version": f"cad5-{tier_name}",
                        "provenance": {
                            "engine_guid": wall.GlobalId,
                            "source": "OBSERVED+BRep",
                        },
                    }
                )
            return records

        m_qty = measure_split_repeated(
            operation=f"quantity_extraction[{tier_name}]",
            boundary=(
                "ENGINE = qto reads (get_psets qtos_only) + OCCT BRep "
                "volume properties of every wall gross solid; ADAPTER = "
                "QuantityRecord construction with provenance and version "
                "stamping"
            ),
            engine_fn=_engine_quantity,
            adapter_fn=_adapter_quantity,
            repeats=repeats,
            extra={
                "tier": tier_name,
                "walls": walls,
            },
        )
        if m_qty.samples:
            m_qty.extra["throughput_walls_per_s"] = round(
                walls / (m_qty.total_ms_samples[0] / 1000.0), 1
            )
        quantity[tier_name] = m_qty.to_dict()

    bench.measure("semantic_extraction", semantic)
    bench.measure("quantity_extraction", quantity)

    for tier_name in ("small", "medium", "large"):
        sm = semantic[tier_name]
        bench.observe(
            f"semantic-extraction/{tier_name}/measured",
            f"Semantic extraction measured at {tier_name} tier "
            f"({sm['elements']} elements) with engine/adapter split, "
            "distribution and throughput.",
            condition=sm["engine_ms"].get("median", 0) > 0,
            details={
                "engine_ms_median": sm["engine_ms"]["median"],
                "adapter_ms_median": sm["adapter_ms"]["median"],
                "adapter_share": sm["adapter_share_of_total_median"],
                "throughput_elements_per_s": sm.get("throughput_elements_per_s"),
            },
            epistemic="OBSERVED",
        )
        qm = quantity[tier_name]
        bench.observe(
            f"quantity-extraction/{tier_name}/measured",
            f"Quantity extraction measured at {tier_name} tier "
            f"({qm['walls']} walls) with engine/adapter split (qto + BRep "
            "vs record assembly) and throughput.",
            condition=qm["engine_ms"].get("median", 0) > 0,
            details={
                "engine_ms_median": qm["engine_ms"]["median"],
                "adapter_ms_median": qm["adapter_ms"]["median"],
                "throughput_walls_per_s": qm.get("throughput_walls_per_s"),
            },
            epistemic="OBSERVED",
        )

    # scaling currency: per-element semantic cost
    per_element = {
        t: round(
            semantic[t]["total_ms"]["median"] / semantic[t]["elements"], 4
        )
        for t in ("small", "medium", "large")
    }
    bench.measure("semantic_extraction_per_element_ms", per_element)
    bench.observe(
        "semantic-extraction/per-element-cost-recorded",
        "Per-element semantic extraction cost recorded for all tiers.",
        condition=all(v > 0 for v in per_element.values()),
        details=per_element,
        epistemic="CALCULATED",
    )
