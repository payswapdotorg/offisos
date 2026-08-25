"""Benchmark: 3D geometry capabilities (RESEARCH-CAD-001 evidence item 2).

Core solids, booleans, transforms, validity checking and assembly/compound
behavior — all against OCCT through OCP with exact analytic assertions.
"""
from __future__ import annotations

import time


def run(result) -> None:
    from OCP.gp import gp_Pnt, gp_Vec, gp_Ax1, gp_Ax2, gp_Dir, gp_Trsf
    from OCP.BRepPrimAPI import (
        BRepPrimAPI_MakeBox,
        BRepPrimAPI_MakeCylinder,
        BRepPrimAPI_MakeSphere,
        BRepPrimAPI_MakeTorus,
    )
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse, BRepAlgoAPI_Cut, BRepAlgoAPI_Common
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.TopoDS import TopoDS_Compound
    from OCP.BRep import BRep_Builder

    def volume(shape) -> float:
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, props, True)
        return props.Mass()

    # ------------------------------------------------------------------
    # 1. Primitive solids with exact volumes
    # ------------------------------------------------------------------
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 2.0, 3.0, 4.0).Shape()
    result.assert_close(
        "3d/primitives/box-volume",
        "Box primitive volume is exact (2x3x4 = 24 m^3).",
        volume(box), 24.0, 1e-9, epistemic="NATIVE",
    )
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 1.5, 4.0).Shape()
    result.assert_close(
        "3d/primitives/cylinder-volume",
        "Cylinder primitive volume is exact (pi r^2 h = 9 pi).",
        volume(cyl), 3.141592653589793 * 1.5 * 1.5 * 4.0, 1e-6, epistemic="NATIVE",
    )
    sph = BRepPrimAPI_MakeSphere(gp_Pnt(0, 0, 0), 2.0).Shape()
    result.assert_close(
        "3d/primitives/sphere-volume",
        "Sphere primitive volume is exact (4/3 pi r^3).",
        volume(sph), 4.0 / 3.0 * 3.141592653589793 * 8.0, 1e-6, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. Booleans with exact analytic expectations
    # ------------------------------------------------------------------
    a = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 2.0, 2.0, 2.0).Shape()
    b = BRepPrimAPI_MakeBox(gp_Pnt(1, 1, 0), 2.0, 2.0, 2.0).Shape()

    fuse = BRepAlgoAPI_Fuse(a, b)
    fuse.Build()
    result.observe("3d/booleans/fuse-done", "Fuse boolean completes.", fuse.IsDone(), epistemic="NATIVE")
    result.assert_close(
        "3d/booleans/fuse-volume",
        "Fuse volume = 8 + 8 - overlap 2 = 14 m^3 exactly (overlap is 1x1x2).",
        volume(fuse.Shape()), 14.0, 1e-9, epistemic="NATIVE",
    )

    cut = BRepAlgoAPI_Cut(a, b)
    cut.Build()
    result.observe("3d/booleans/cut-done", "Cut boolean completes.", cut.IsDone(), epistemic="NATIVE")
    result.assert_close(
        "3d/booleans/cut-volume",
        "Cut volume = 8 - 2 = 6 m^3 exactly.",
        volume(cut.Shape()), 6.0, 1e-9, epistemic="NATIVE",
    )

    common = BRepAlgoAPI_Common(a, b)
    common.Build()
    result.observe("3d/booleans/common-done", "Common (intersection) boolean completes.", common.IsDone(), epistemic="NATIVE")
    result.assert_close(
        "3d/booleans/common-volume",
        "Intersection volume = 2 m^3 exactly (1x1x2 overlap).",
        volume(common.Shape()), 2.0, 1e-9, epistemic="NATIVE",
    )

    # curved boolean: sphere drilled by coaxial cylinder (napkin-ring geometry,
    # exact closed-form volume by the napkin-ring theorem)
    sphere = BRepPrimAPI_MakeSphere(gp_Pnt(0, 0, 0), 1.0).Shape()
    drill = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, -2), gp_Dir(0, 0, 1)), 0.5, 4.0).Shape()
    drilled = BRepAlgoAPI_Cut(sphere, drill)
    drilled.Build()
    import math as _math

    ring_height = 2.0 * (1.0 - 0.25) ** 0.5
    napkin_ring_volume = _math.pi * ring_height ** 3 / 6.0
    result.assert_close(
        "3d/booleans/curved-cut-volume",
        "Sphere(r=1) minus coaxial cylinder(r=0.5): volume equals the exact "
        "napkin-ring value pi*h^3/6 with h=2*sqrt(R^2-r^2).",
        volume(drilled.Shape()), napkin_ring_volume, 1e-6, epistemic="NATIVE",
        details={"napkin_ring_height": ring_height, "exact_volume": napkin_ring_volume},
    )

    # ------------------------------------------------------------------
    # 3. Transforms: rotation + translation with point verification
    # ------------------------------------------------------------------
    trsf = gp_Trsf()
    trsf.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 3.141592653589793 / 2.0)
    moved = BRepBuilderAPI_Transform(box, trsf, True).Shape()
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(moved, props, True)
    com = props.CentreOfMass()
    result.observe(
        "3d/transforms/rotation-preserves-volume",
        "90-degree rotation preserves volume exactly.",
        abs(props.Mass() - 24.0) <= 1e-9,
        details={"volume": props.Mass(), "centre_of_mass": (com.X(), com.Y(), com.Z())},
        epistemic="NATIVE",
    )
    # box centre (1, 1.5, 2) rotated 90 deg about Z -> (-1.5, 1, 2)
    result.assert_close(
        "3d/transforms/centre-of-mass",
        "Centre of mass follows the rotation exactly.",
        com.X(), -1.5, 1e-9, epistemic="NATIVE",
    )
    result.assert_close(
        "3d/transforms/centre-of-mass-y",
        "Rotated centre of mass Y coordinate.",
        com.Y(), 1.0, 1e-9, epistemic="NATIVE",
    )

    trsf2 = gp_Trsf()
    trsf2.SetTranslation(gp_Vec(10.0, 20.0, 30.0))
    moved2 = BRepBuilderAPI_Transform(box, trsf2, True).Shape()
    props2 = GProp_GProps()
    BRepGProp.VolumeProperties_s(moved2, props2, True)
    com2 = props2.CentreOfMass()
    result.observe(
        "3d/transforms/translation",
        "Translation moves centre of mass exactly.",
        abs(com2.X() - 11.0) <= 1e-9 and abs(com2.Y() - 21.5) <= 1e-9 and abs(com2.Z() - 32.0) <= 1e-9,
        details={"centre_of_mass": (com2.X(), com2.Y(), com2.Z())},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Validity checking
    # ------------------------------------------------------------------
    analyzer = BRepCheck_Analyzer(fuse.Shape())
    result.observe(
        "3d/validity/boolean-result-valid",
        "BRepCheck_Analyzer validates the fused solid.",
        analyzer.IsValid(),
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. Assembly: compound of 1000 solids with total volume
    # ------------------------------------------------------------------
    start = time.perf_counter()
    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    n = 1000
    for i in range(n):
        part = BRepPrimAPI_MakeBox(gp_Pnt(i * 0.001, 0, 0), 0.1, 0.2, 0.3).Shape()
        builder.Add(compound, part)
    elapsed = (time.perf_counter() - start) * 1000
    total_volume = volume(compound)
    result.assert_close(
        "3d/assembly/compound-volume",
        f"Compound of {n} solids: total volume exact (n x 0.006 m^3).",
        total_volume, n * 0.006, 1e-6,
        epistemic="NATIVE",
        details={"solids": n, "build_ms": round(elapsed, 3)},
    )
    result.measure("assembly_1000_solids_build_ms", round(elapsed, 3))
    result.measure("assembly_1000_solids_total_volume", total_volume)

    # validity of the compound
    start = time.perf_counter()
    valid = BRepCheck_Analyzer(compound).IsValid()
    check_ms = (time.perf_counter() - start) * 1000
    result.observe(
        "3d/assembly/compound-valid",
        f"Compound of {n} solids passes validity analysis.",
        valid,
        details={"validity_check_ms": round(check_ms, 3)},
        epistemic="NATIVE",
    )
    result.measure("assembly_1000_solids_validity_check_ms", round(check_ms, 3))

    # torus (additional curved primitive sanity)
    torus = BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 2.0, 0.5).Shape()
    result.assert_close(
        "3d/primitives/torus-volume",
        "Torus volume = 2 pi^2 R r^2 exact.",
        volume(torus), 2.0 * 3.141592653589793 ** 2 * 2.0 * 0.25, 1e-6, epistemic="NATIVE",
    )
