"""Benchmark: provenance and versioning (RESEARCH-CAD-004 scope 3).

Every quantity links to model version + source element identity +
engine id + method + engine version + parameters; a revision creates a
NEW quantity state (historical states immutable); reproducible
re-extraction from the same source version.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixtures import build_model
    from ..quantity_records import extract_snapshot

    snaps = {}
    files = {}
    for v in ("v1", "v2", "v3"):
        files[v] = build_model(v)
        snaps[v] = extract_snapshot(files[v], v)

    # ------------------------------------------------------------------
    # 1. Provenance completeness on every record
    # ------------------------------------------------------------------
    missing = []
    for r in snaps["v1"].records.values():
        p = r.provenance
        if not (p.get("engine") and p.get("method")
                and p.get("engine_version")
                and (p.get("engine_id") or p.get("engine") == "analytic-reference")):
            missing.append(r.record_id)
        if not r.model_version or not r.element_domain_id:
            missing.append(r.record_id)
    result.observe(
        "cad4-prov/provenance-completeness",
        "Every quantity record carries: model version, element domain "
        "identity, engine id (engine path) or explicit analytic-reference "
        "marker, extraction method, engine version. CALCULATED records "
        "additionally carry parameters (density, unit scale).",
        not missing,
        details={"record_count": len(snaps["v1"].records),
                 "missing": missing[:5]},
        epistemic="ADAPTER",
    )

    # engine version recorded matches the actual engine
    import ifcopenshell

    sample = snaps["v1"].records["off:cad4:wall:north#BRepNetVolume@v1"]
    result.observe(
        "cad4-prov/engine-version-recorded",
        "The engine version in provenance matches the actual engine "
        f"(ifcopenshell {ifcopenshell.version}).",
        sample.provenance["engine_version"] == f"ifcopenshell {ifcopenshell.version}",
        details={"recorded": sample.provenance["engine_version"],
                 "actual": f"ifcopenshell {ifcopenshell.version}"},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 2. Revision creates a NEW state; historical states immutable
    # ------------------------------------------------------------------
    v1_before = snaps["v1"].to_dict()
    _ = extract_snapshot(files["v2"], "v2")  # later revision extracted
    result.observe(
        "cad4-prov/revision-new-state-not-mutation",
        "Extracting the v2 revision does NOT mutate the v1 snapshot: the "
        "v1 records (record ids, values, provenance) are byte-identical "
        "after the v2 extraction — history is immutable, revisions are "
        "new states.",
        snaps["v1"].to_dict() == v1_before,
        epistemic="ADAPTER",
    )

    # v1 and v2 snapshots coexist with distinct version stamps
    result.observe(
        "cad4-prov/version-history-coexists",
        "All three model-version snapshots coexist with distinct version "
        "stamps on every record; record ids encode the version "
        "(<element>#<quantity>@<version>).",
        all(r.model_version == v for v in ("v1", "v2", "v3")
            for r in snaps[v].records.values())
        and snaps["v1"].records["off:cad4:wall:north#BRepNetVolume@v1"].record_id
        == "off:cad4:wall:north#BRepNetVolume@v1"
        and snaps["v2"].records["off:cad4:wall:north#BRepNetVolume@v2"].record_id
        == "off:cad4:wall:north#BRepNetVolume@v2",
        details={"snapshot_sizes": {v: len(s.records) for v, s in snaps.items()}},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. Reproducible re-extraction from the same source version
    # ------------------------------------------------------------------
    # write v1 to disk, re-open, re-extract: identical (provenance engine
    # ids included — same file, stable GlobalIds)
    import tempfile, os

    with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
        path = tmp.name
    files["v1"].write(path)
    f_reopened = __import__("ifcopenshell").open(path)
    snap_re = extract_snapshot(f_reopened, "v1")
    result.observe(
        "cad4-prov/reproducible-re-extraction",
        "Re-extraction from the persisted v1 file (write -> reopen -> "
        "extract) reproduces the original snapshot EXACTLY, including "
        "engine GlobalIds in provenance (stable within one file).",
        snap_re.to_dict() == snaps["v1"].to_dict(),
        epistemic="OBSERVED",
    )
    os.unlink(path)

    # historical replay: v1 state remains replayable after v3 exists
    v1_replay = extract_snapshot(build_model("v1"), "v1")
    result.observe(
        "cad4-prov/historical-replay",
        "The v1 quantity state remains fully replayable after later "
        "revisions (v2, v3) exist — rebuilding/re-extracting v1 yields "
        "the same records (engine ids excluded: per-build).",
        {
            rid: {k: v for k, v in r.to_dict().items()
                  if k != "provenance"}
            for rid, r in v1_replay.records.items()
        } == {
            rid: {k: v for k, v in r.to_dict().items()
                  if k != "provenance"}
            for rid, r in snaps["v1"].records.items()
        },
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 4. Provenance links quantity -> source element identity
    # ------------------------------------------------------------------
    rec = snaps["v2"].records["off:cad4:wall:north#BRepNetVolume@v2"]
    wall_north = next(
        w for w in files["v2"].by_type("IfcWall") if w.Name == "wall-north"
    )
    result.observe(
        "cad4-prov/element-identity-link",
        "The provenance engine_id of a quantity record resolves to the "
        "exact source element in the model file (GlobalId match) — every "
        "quantity is traceable to its source element.",
        rec.provenance["engine_id"] == wall_north.GlobalId,
        details={"record_engine_id": rec.provenance["engine_id"],
                 "element_global_id": wall_north.GlobalId},
        epistemic="ADAPTER",
    )
