"""Construction Graph mapping for RESEARCH-CAD-003 (issue #3 scope 5).

Proves the reproducible mapping from an IFC model version to canonical
Graph objects where engine/IFC objects remain **source representations**
rather than the Graph's canonical identity:

- canonical node ids are the Offisos domain ids (identity property set),
  never GlobalIds;
- every node records provenance (source engine, GlobalId, IFC class,
  model revision, identity-resolution method);
- engine GlobalIds are demonstrated to be unstable across regeneration
  while the canonical node ids are stable;
- fields are classified explicitly as PRESERVED / LOSSY / UNSUPPORTED /
  INFERRED / OPAQUE-LINEAGE.
"""
from __future__ import annotations

from typing import Any


def build_graph_revision(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Map a semantic snapshot to a Construction Graph revision.

    Openings are recorded as void lineage of their hosts, not canonical
    nodes. Elements without an identity property set would be resolved by
    structural anchors (recorded via identity_resolution); the fixture
    always carries identity psets, so resolution is 'identity-pset'.
    """
    nodes: list[dict[str, Any]] = []
    void_lineage: list[dict[str, Any]] = []
    for element in snapshot["elements"].values():
        if element["ifc_class"] == "IfcOpeningElement":
            void_lineage.append({
                "source_engine_id": element["global_id"],
                "treatment": "void-of-host",
                "note": "openings are voids of their host walls, not canonical elements",
            })
            continue
        nodes.append({
            "node_id": element["domain_id"],
            "element_class": element["domain_kind"],
            "provenance": {
                "source_engine": "ifcopenshell",
                "source_engine_id": element["global_id"],
                "source_ifc_class": element["ifc_class"],
                "model_revision": element["model_revision"],
                "identity_resolution": (
                    "identity-pset" if element["identity_pset_found"] else "unresolved"
                ),
            },
            "property_refs": sorted(element["properties"].keys()),
            "quantity_refs": sorted(element["quantities"].keys()),
        })
    nodes.sort(key=lambda n: n["node_id"])
    return {
        "revision_id": f"cg:{snapshot.get('model_revision', 'unknown')}",
        "nodes": nodes,
        "void_lineage": sorted(void_lineage, key=lambda v: v["source_engine_id"]),
        "relationship_counts": dict(snapshot["relationships"]),
        "units": snapshot["units"],
    }


def diff_graph_revisions(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Structural diff between two graph revisions by canonical node id."""
    ids_a = {n["node_id"] for n in a["nodes"]}
    ids_b = {n["node_id"] for n in b["nodes"]}
    return {
        "added": sorted(ids_b - ids_a),
        "removed": sorted(ids_a - ids_b),
        "unchanged": sorted(ids_a & ids_b),
    }


def classify_fields(roundtrip_changed: dict[str, Any]) -> dict[str, list[str]]:
    """Classify semantic fields by round-trip behavior.

    `roundtrip_changed` is the compare_snapshots diff between an original
    snapshot and its exported+reimported counterpart. Fields appearing in
    `changed` with value differences are LOSSY; everything asserted
    stable in the benchmark is PRESERVED. UNSUPPORTED/INFERRED/OPAQUE
    classifications come from the documented analysis (see report.md).
    """
    lossy: set[str] = set()
    for _domain_id, changes in roundtrip_changed.items():
        for field in changes:
            lossy.add(field)
    return {
        "PRESERVED": [
            "domain identity (Pset_OffisosIdentity.DomainId/DomainKind/ModelRevision)",
            "IFC class",
            "element name",
            "typed property values (IfcLabel/IfcBoolean/IfcReal)",
            "quantity set values",
            "project length unit",
            "object placements (translation components)",
            "voids/fills/containment/aggregation relationship counts",
            "door/window OverallWidth/OverallHeight",
        ],
        "LOSSY": sorted(lossy),
        "UNSUPPORTED": [
            "IFC4X3_ONLY entities in an IFC4 file (schema-scoped by design)",
        ],
        "INFERRED": [
            "none: no inferred values are promoted to observed facts in this pipeline",
        ],
        "OPAQUE-LINEAGE": [
            "geometry representation contents (recorded as representation references; "
            "BRep/tessellation contents are engine-opaque and validated through "
            "quantity invariants, not byte comparison)",
        ],
    }
