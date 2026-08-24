"""Benchmark: failure modes (RESEARCH-CAD-001 execution rule 5).

Explicit failure cases with typed outcomes — unsupported operation,
malformed input, invalid geometry, lossy conversion, ambiguous quantity.
Every failure must surface as a typed error or an explicit UNKNOWN state,
never as silent fallback.
"""
from __future__ import annotations


def run(result) -> None:
    from ..engines.ifc_adapter import IfcOpenShellAdapter
    from ..adapter import InvalidInputError, UnsupportedOperationError, QuantityState

    adapter = IfcOpenShellAdapter()

    # ------------------------------------------------------------------
    # 1. Malformed IFC input
    # ------------------------------------------------------------------
    with open("/tmp/malformed.ifc", "w") as f:
        f.write("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('','BROKEN'));\n")
        f.write("This is not a valid STEP physical file body.\nEND-ISO-10303-21;\n")
    typed_error = False
    try:
        adapter.import_ifc("/tmp/malformed.ifc", "bad")
    except InvalidInputError:
        typed_error = True
    except Exception:
        typed_error = False
    result.observe(
        "failure/malformed-ifc/typed-error",
        "Malformed IFC input raises the adapter's typed InvalidInputError.",
        typed_error,
        details={"file": "truncated/garbled STEP content"},
        epistemic="NATIVE",
    )

    # missing file
    typed_error = False
    try:
        adapter.import_ifc("/tmp/definitely-missing-9999.ifc", "missing")
    except InvalidInputError:
        typed_error = True
    except Exception:
        typed_error = False
    result.observe(
        "failure/missing-file/typed-error",
        "Missing file raises the typed InvalidInputError.",
        typed_error, epistemic="ADAPTER",
    )

    # empty file
    open("/tmp/empty.ifc", "w").close()
    typed_error = False
    try:
        adapter.import_ifc("/tmp/empty.ifc", "empty")
    except InvalidInputError:
        typed_error = True
    except Exception:
        typed_error = False
    result.observe(
        "failure/empty-file/typed-error",
        "Empty file raises the typed InvalidInputError.",
        typed_error, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. Invalid geometry: zero-extent solid raises Standard_DomainError
    # ------------------------------------------------------------------
    from OCP.gp import gp_Pnt
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepCheck import BRepCheck_Analyzer
    domain_error = False
    try:
        BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 0.0, 1.0, 1.0).Shape()
    except Exception as exc:
        domain_error = "DomainError" in type(exc).__name__
    result.observe(
        "failure/invalid-geometry/zero-extent",
        "Zero-extent geometry raises OCCT Standard_DomainError (typed engine failure).",
        domain_error,
        details={"exception": "Standard_DomainError"}, epistemic="NATIVE",
    )

    # self-intersecting/bowtie quad: build a face from the bowtie wire,
    # extrude it, and check validity
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
    from OCP.gp import gp_Vec, gp_Dir

    bowtie = BRepBuilderAPI_MakePolygon()
    bowtie.Add(gp_Pnt(0, 0, 0))
    bowtie.Add(gp_Pnt(1, 1, 0))
    bowtie.Add(gp_Pnt(1, 0, 0))
    bowtie.Add(gp_Pnt(0, 1, 0))
    bowtie.Close()
    face = BRepBuilderAPI_MakeFace(bowtie.Wire()).Face()
    prism = BRepPrimAPI_MakePrism(face, gp_Vec(0, 0, 1)).Shape()
    invalid_detected = not BRepCheck_Analyzer(prism).IsValid()
    result.observe(
        "failure/invalid-geometry/self-intersecting-detected",
        "Self-intersecting (bowtie) profile produces a shape that OCCT's "
        "BRepCheck_Analyzer flags as invalid — detected, not silently accepted.",
        invalid_detected,
        details={"verdict": "BRepCheck_Analyzer reports invalid"},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 3. Lossy conversion: disjoint fuse yields a two-lump compound,
    #    not a single solid — surface area reveals the loss
    # ------------------------------------------------------------------
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox as MKBox
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp
    from OCP.TopAbs import TopAbs_ShapeEnum

    box1 = MKBox(gp_Pnt(0, 0, 0), 1, 1, 1).Shape()
    box2 = MKBox(gp_Pnt(5, 5, 5), 1, 1, 1).Shape()
    fused = BRepAlgoAPI_Fuse(box1, box2)
    fused.Build()
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(fused.Shape(), props, True)
    # volumes add (2.0) but the result is not a single solid
    from OCP.TopExp import TopExp_Explorer

    explorer = TopExp_Explorer(fused.Shape(), TopAbs_ShapeEnum.TopAbs_SOLID)
    solid_count = 0
    while explorer.More():
        solid_count += 1
        explorer.Next()
    result.observe(
        "failure/lossy-conversion/disjoint-fuse-compound",
        "Fusing two disjoint solids produces a compound of 2 solids with the "
        "correct total volume — the 'single solid' expectation is lost, and "
        "the loss is measurable, not silent.",
        solid_count == 2 and abs(props.Mass() - 2.0) <= 1e-9,
        details={"solids": solid_count, "volume": props.Mass(),
                 "expected_solid_count": 1, "note": "callers must check topology"},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Ambiguous quantity: ghost wall -> UNKNOWN (not 0)
    # ------------------------------------------------------------------
    import ifcopenshell
    import ifcopenshell.api

    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="P")
    ifcopenshell.api.run("unit.assign_unit", f)
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="S")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="B")
    storey = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="G")
    ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[building], relating_object=site)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=building)
    ghost = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name="Ghost")
    ifcopenshell.api.run("spatial.assign_container", f, products=[ghost], relating_structure=storey)
    f.write("/tmp/ghost-failure.ifc")
    gm = adapter.import_ifc("/tmp/ghost-failure.ifc", "ghost")
    adapter.extract_quantities(gm)
    ge = next(e for e in gm.elements if e.kind == "wall")
    gq = ge.domain_quantities.get("NetVolume")
    result.observe(
        "failure/ambiguous-quantity/unknown-not-zero",
        "A wall without geometry or quantities yields UNKNOWN with value None "
        "— the system never fabricates a 0 quantity (LOCK-007).",
        gq is not None and gq.state == QuantityState.UNKNOWN and gq.value is None,
        details={"state": gq.state.value if gq else None},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 5. Unsupported operation on the reference adapter
    # ------------------------------------------------------------------
    from ..engines.reference_adapter import ReferenceAdapter

    ref = ReferenceAdapter()
    m = ref.create_model("u")
    try:
        ref.import_ifc("/tmp/openings-smoke.ifc", "x")
        unsupported = False
    except UnsupportedOperationError:
        unsupported = True
    except Exception:
        unsupported = False
    result.observe(
        "failure/unsupported-operation/typed",
        "Unsupported capability (IFC import on the reference engine) raises "
        "the typed UnsupportedOperationError.",
        unsupported, epistemic="ADAPTER",
    )
