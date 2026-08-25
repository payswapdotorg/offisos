"""Downstream estimate/RFQ contract evidence for RESEARCH-CAD-004 (scope 6).

CONTRACT-LEVEL ONLY (issue #4 non-goals: no production estimate or RFQ
implementation). These typed contracts and deterministic derivations
prove that quantity outputs have sufficient stable identity and
semantics to feed the frozen estimate/RFQ interfaces:

- :class:`EstimateLineItem` — derived deterministically from a Graph
  quantity (quantity ref + unit rate), carrying provenance refs.
- :class:`RfqScope` — groups line items into an RFQ package.
- :func:`derive_estimate` / :func:`rfq_impact` — deterministic
  derivations; the impact analysis shows exactly which scopes a model
  revision touches.

Everything consumes the CONSUMER API (graph quantities), never engine
internals — no ifcopenshell/OCP imports in this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .graph import build_quantity_graph, graph_get_quantity

# Deterministic rate fixture (evidence only — NOT a pricing engine):
# rate table keyed by (element kind, quantity name).
RATE_TABLE: dict[tuple[str, str], tuple[float, str]] = {
    ("wall", "BRepNetVolume"): (650.0, "EUR/m^3"),     # concrete wall supply
    ("wall", "BRepWeight"): (0.11, "EUR/kg"),          # reinforcement proxy
    ("slab", "GrossVolume"): (600.0, "EUR/m^3"),
    ("window", "OverallArea"): (320.0, "EUR/m^2"),     # glazing package
    ("door", "OverallArea"): (480.0, "EUR/m^2"),
    ("space", "GrossFloorArea"): (24.0, "EUR/m^2"),    # finishing proxy
}

# Deterministic RFQ package assignment (evidence only):
# element kind -> RFQ scope.
RFQ_PACKAGES: dict[str, str] = {
    "wall": "RFQ-STRUCTURAL",
    "slab": "RFQ-STRUCTURAL",
    "window": "RFQ-FENESTRATION",
    "door": "RFQ-FENESTRATION",
    "space": "RFQ-FITOUT",
}


@dataclass(frozen=True)
class EstimateLineItem:
    """One deterministic estimate line derived from a Graph quantity."""

    line_id: str                    # EST:<domain_id>#<quantity>@<version>
    rfq_scope: str
    element_domain_id: str
    quantity_name: str
    model_version: str
    quantity_value: float
    quantity_unit: str
    quantity_state: str
    unit_rate: float
    rate_unit: str
    amount: float
    provenance_ref: str            # quantity record id (full provenance)


@dataclass(frozen=True)
class RfqScope:
    """An RFQ package with its line items and deterministic total."""

    scope_id: str
    line_item_ids: tuple[str, ...]
    total_amount: float


def _element_kind(domain_id: str) -> str:
    # fillings first: their ids embed the host wall id
    # (off:cad4:wall:south:window-2 is a WINDOW, not a wall)
    if ":window" in domain_id or domain_id.endswith(":window"):
        return "window"
    if ":door" in domain_id:
        return "door"
    if ":wall:" in domain_id or domain_id.endswith(":wall"):
        return "wall"
    if ":slab:" in domain_id:
        return "slab"
    if ":space:" in domain_id:
        return "space"
    return "unknown"


def derive_estimate(snapshot) -> list[EstimateLineItem]:
    """Derive estimate line items from a quantity snapshot via the Graph.

    Deterministic: the same snapshot always yields the same items in the
    same order. UNKNOWN quantities are skipped (never priced from a
    fabricated value); their existence remains visible in the graph.
    """
    graph = build_quantity_graph(snapshot)
    items: list[EstimateLineItem] = []
    for domain_id in sorted(graph["nodes"].keys()):
        kind = _element_kind(domain_id)
        node = graph["nodes"][domain_id]
        for quantity_name in sorted(node["quantities"].keys()):
            rate = RATE_TABLE.get((kind, quantity_name))
            if rate is None:
                continue
            q = node["quantities"][quantity_name]
            if q["value"] is None or q["state"] == "UNKNOWN":
                continue  # epistemic honesty: no pricing from UNKNOWN
            unit_rate, rate_unit = rate
            items.append(EstimateLineItem(
                line_id=f"EST:{domain_id}#{quantity_name}@{snapshot.model_version}",
                rfq_scope=RFQ_PACKAGES[kind],
                element_domain_id=domain_id,
                quantity_name=quantity_name,
                model_version=snapshot.model_version,
                quantity_value=q["value"],
                quantity_unit=q["unit"],
                quantity_state=q["state"],
                unit_rate=unit_rate,
                rate_unit=rate_unit,
                amount=round(q["value"] * unit_rate, 6),
                provenance_ref=node["provenance_refs"][quantity_name],
            ))
    return items


def group_rfq_scopes(items: list[EstimateLineItem]) -> list[RfqScope]:
    """Group line items into RFQ scopes with deterministic totals."""
    by_scope: dict[str, list[EstimateLineItem]] = {}
    for item in items:
        by_scope.setdefault(item.rfq_scope, []).append(item)
    scopes = []
    for scope_id in sorted(by_scope.keys()):
        members = sorted(by_scope[scope_id], key=lambda i: i.line_id)
        scopes.append(RfqScope(
            scope_id=scope_id,
            line_item_ids=tuple(i.line_id for i in members),
            total_amount=round(sum(i.amount for i in members), 6),
        ))
    return scopes


def rfq_impact(
    items_before: list[EstimateLineItem], items_after: list[EstimateLineItem]
) -> dict[str, Any]:
    """Which RFQ scopes does a model revision impact?

    Deterministic: a scope is impacted iff it contains at least one
    changed line item (amount, value or state) or a added/removed line.
    """
    # compare on the version-independent line key: line ids embed the
    # model version (EST:<element>#<quantity>@<version>), so cross-version
    # comparison must strip it
    def _key(i: EstimateLineItem) -> str:
        return i.line_id.split("@")[0]

    before = {_key(i): i for i in items_before}
    after = {_key(i): i for i in items_after}
    changed_lines = sorted(
        lid for lid in before.keys() & after.keys()
        if abs(before[lid].amount - after[lid].amount) > 1e-6
        or before[lid].quantity_value != after[lid].quantity_value
        or before[lid].quantity_state != after[lid].quantity_state
    )
    added = sorted(after.keys() - before.keys())
    removed = sorted(before.keys() - after.keys())
    impacted = sorted({
        after[lid].rfq_scope for lid in changed_lines if lid in after
    } | {after[lid].rfq_scope for lid in added} | {
        before[lid].rfq_scope for lid in removed
    })
    return {
        "changed_line_items": changed_lines,
        "added_line_items": added,
        "removed_line_items": removed,
        "impacted_scopes": impacted,
        "unimpacted_scopes": sorted(
            {i.rfq_scope for i in after.values()} - set(impacted)
        ),
    }
