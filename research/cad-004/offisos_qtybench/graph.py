"""Construction Graph quantity mapping for RESEARCH-CAD-004 (scope 4).

Maps quantity snapshots to canonical Graph objects keyed by domain id
(never engine GlobalIds), preserves provenance and uncertainty states,
and exposes a CONSUMER API so applications consume Graph quantities
rather than querying engine internals. Engine independence: the graph
built from the OCCT-BRep extraction equals the graph built from the
pure-Python analytic reference snapshot.
"""
from __future__ import annotations

from typing import Any

from .quantity_records import QuantitySnapshot, QuantityState


def build_quantity_graph(snapshot: QuantitySnapshot) -> dict[str, Any]:
    """Quantity snapshot -> canonical Graph quantity objects.

    Nodes are keyed by element domain id (canonical identity). Each
    quantity on a node keeps value/unit/state/tolerance plus a provenance
    REFERENCE (record id) — the full provenance stays in the quantity
    records, addressable by record id.
    """
    nodes: dict[str, dict[str, Any]] = {}
    for record in snapshot.records.values():
        node = nodes.setdefault(record.element_domain_id, {
            "node_id": record.element_domain_id,
            "model_version": record.model_version,
            "quantities": {},
            "provenance_refs": {},
        })
        node["quantities"][record.quantity_name] = {
            "value": record.value,
            "unit": record.unit,
            "state": record.state.value,
            "tolerance": record.tolerance,
        }
        node["provenance_refs"][record.quantity_name] = record.record_id
    return {
        "graph_kind": "quantity-graph",
        "model_version": snapshot.model_version,
        "node_count": len(nodes),
        "nodes": {k: nodes[k] for k in sorted(nodes)},
    }


def graph_get_quantity(
    graph: dict[str, Any], domain_id: str, quantity_name: str
) -> dict[str, Any] | None:
    """The consumer API: read one quantity from the graph.

    This is what downstream applications (estimate/RFQ) call — no engine
    imports, no engine ids, no file access.
    """
    node = graph["nodes"].get(domain_id)
    if node is None:
        return None
    return node["quantities"].get(quantity_name)


def graph_quantity_ids(graph: dict[str, Any]) -> set[str]:
    """All canonical element ids present in the graph."""
    return set(graph["nodes"].keys())


def graph_uncertainty_summary(graph: dict[str, Any]) -> dict[str, int]:
    """Count quantity states across the graph (uncertainty visibility)."""
    counts = {"OBSERVED": 0, "CALCULATED": 0, "UNKNOWN": 0}
    for node in graph["nodes"].values():
        for q in node["quantities"].values():
            counts[q["state"]] = counts.get(q["state"], 0) + 1
    return counts


def diff_graphs(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Structural + quantity diff between two graph revisions."""
    ids_a = set(a["nodes"].keys())
    ids_b = set(b["nodes"].keys())
    changed: dict[str, list[str]] = {}
    unchanged: list[str] = []
    for nid in sorted(ids_a & ids_b):
        qa = a["nodes"][nid]["quantities"]
        qb = b["nodes"][nid]["quantities"]
        diff_q = []
        for q_name in sorted(set(qa.keys()) | set(qb.keys())):
            va = qa.get(q_name)
            vb = qb.get(q_name)
            if va is None or vb is None:
                diff_q.append(q_name)
            elif va["value"] is None or vb["value"] is None:
                if va["value"] != vb["value"] or va["state"] != vb["state"]:
                    diff_q.append(q_name)
            elif abs(va["value"] - vb["value"]) > max(
                va["tolerance"], vb["tolerance"]
            ):
                diff_q.append(q_name)
        if diff_q:
            changed[nid] = diff_q
        else:
            unchanged.append(nid)
    return {
        "added_nodes": sorted(ids_b - ids_a),
        "removed_nodes": sorted(ids_a - ids_b),
        "changed": changed,
        "unchanged": unchanged,
    }


def engine_id_independence_check(
    snapshot_a: QuantitySnapshot, snapshot_b: QuantitySnapshot
) -> dict[str, Any]:
    """Engine-id non-canonicality observation in the quantity context.

    Two independent builds of the same model version produce different
    engine GlobalIds; the quantity graph (domain-id keyed) is identical.
    """
    gids_a = {
        r.provenance.get("engine_id") for r in snapshot_a.records.values()
        if r.provenance.get("engine_id")
    }
    gids_b = {
        r.provenance.get("engine_id") for r in snapshot_b.records.values()
        if r.provenance.get("engine_id")
    }
    graph_a = build_quantity_graph(snapshot_a)
    graph_b = build_quantity_graph(snapshot_b)
    return {
        "engine_ids_disjoint": gids_a.isdisjoint(gids_b),
        "engine_ids_a_sample": sorted(gids_a)[:2],
        "engine_ids_b_sample": sorted(gids_b)[:2],
        "graphs_identical": graph_a == graph_b,
        "graph_node_ids": len(graph_a["nodes"]),
    }
