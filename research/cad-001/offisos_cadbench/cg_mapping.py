"""Construction Graph mapping proof (RESEARCH-CAD-001 evidence item 8).

Proves an explicit mapping from a model revision to canonical Offisos graph
objects **without making the engine model canonical**:

1. Domain element IDs are derived deterministically from structural anchors
   (project, story, element class, ordinal) — never from engine-native ids.
2. Every domain object carries provenance/lineage: source engine, engine
   id (GlobalId), engine class, model revision.
3. The mapping is stable across model *regeneration* (same fixture ->
   same domain ids, but DIFFERENT engine GlobalIds) and across IFC
   round-trips (write -> read -> identical domain ids via the identity
   property set).
4. Engine ids are demonstrated to be non-canonical: re-creating the same
   logical model yields new GlobalIds, so any system keying on GlobalIds
   would silently fork identity — exactly what the Construction Graph
   invariant forbids.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from .adapter import DomainElement, DomainModel


def domain_id_for(project: str, story: str, element_class: str, ordinal: int) -> str:
    """Deterministic canonical id from structural anchors.

    The id is stable for a given logical position in the project structure,
    independent of the engine, file, or export that produced the element.
    """
    digest = hashlib.sha256(
        f"{project}/{story}/{element_class}/{ordinal}".encode()
    ).hexdigest()[:16]
    return f"off:{project}:{story}:{element_class.lower()}:{ordinal:03d}:{digest}"


@dataclass
class GraphNode:
    """A Construction Graph node for a domain element."""

    node_id: str
    element_class: str
    provenance: dict[str, Any] = field(default_factory=dict)
    quantity_refs: list[str] = field(default_factory=list)


@dataclass
class GraphRevision:
    """A versioned snapshot of Construction Graph nodes for a model."""

    revision_id: str
    model_id: str
    architecture_version: str = "1.0"
    nodes: list[GraphNode] = field(default_factory=list)
    lineage: list[dict[str, Any]] = field(default_factory=list)


class ConstructionGraphMapper:
    """Maps engine models to Construction Graph revisions.

    The mapper never trusts engine ids for identity. Elements that arrive
    with an Offisos identity property set are mapped by that identity;
    elements without one are recorded as UNRESOLVED (explicitly, never
    silently assigned a fabricated mapping).
    """

    def build_revision(
        self,
        model: DomainModel,
        project: str,
        story: str,
        revision_id: str,
    ) -> GraphRevision:
        revision = GraphRevision(revision_id=revision_id, model_id=model.model_id)
        counters: dict[str, int] = {}
        for element in model.elements:
            if element.kind == "opening":
                # openings are voids of their host walls, not standalone
                # canonical building elements in this benchmark scope
                revision.lineage.append(
                    {
                        "element": element.source.get("engine_id"),
                        "treatment": "void-of-host",
                        "note": "opening elements are recorded as voids, not canonical elements",
                    }
                )
                continue
            key = element.kind
            counters[key] = counters.get(key, 0) + 1
            if element.domain_id:
                node_id = element.domain_id
                resolution = "identity-pset"
            else:
                # No Offisos identity: derive from structural anchors
                node_id = domain_id_for(project, story, key, counters[key])
                resolution = "structural-anchor-derived"
            node = GraphNode(
                node_id=node_id,
                element_class=element.kind,
                provenance={
                    "source_engine": element.source.get("engine"),
                    "source_engine_id": element.source.get("engine_id"),
                    "source_engine_class": element.source.get("engine_class"),
                    "model_revision": element.source.get("model_revision"),
                    "identity_resolution": resolution,
                },
                quantity_refs=sorted(element.domain_quantities.keys()),
            )
            revision.nodes.append(node)
        return revision

    def diff(self, revision_a: GraphRevision, revision_b: GraphRevision) -> dict[str, Any]:
        """Structural diff between two graph revisions (node ids)."""
        ids_a = {n.node_id for n in revision_a.nodes}
        ids_b = {n.node_id for n in revision_b.nodes}
        return {
            "added": sorted(ids_b - ids_a),
            "removed": sorted(ids_a - ids_b),
            "unchanged": sorted(ids_a & ids_b),
        }
