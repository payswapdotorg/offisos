"""OCCT engine-side operations for RESEARCH-CAD-005.

The ENGINE side of the measurement boundary for the pure-geometry
workloads: primitive construction, boolean operations (sequential cut
chains and the plate-with-holes stress shape), tessellation (the
headless proxy for view/geometry preparation), STEP read/write, and
BRep volume properties (the geometry side of quantity extraction).

Everything here calls OCCT 7.8.1 directly through the cadquery-ocp
bindings — no Offisos translation, no domain objects. Time spent in
this module is what the benchmark records as engine_ms.
"""
from __future__ import annotations

import contextlib
import os
import sys
from typing import Any

from OCP.BRep import BRep_Tool
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_Transform,
)
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCylinder,
)
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from OCP.TopAbs import TopAbs_ShapeEnum
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS_Compound, TopoDS_Builder, TopoDS
from OCP.STEPControl import STEPControl_Reader, STEPControl_Writer, STEPControl_StepModelType


@contextlib.contextmanager
def silenced_occt_output():
    """Silence OCCT's C++-level stdout chatter (STEP transfer statistics).

    OCCT prints directly to the process stdout via C++ streams; Python
    level redirection does not capture it, so this redirects the file
    descriptor itself for the duration of the context.
    """
    if sys.platform != "linux":
        yield
        return
    devnull = os.open(os.devnull, os.O_WRONLY)
    saved = os.dup(1)
    try:
        os.dup2(devnull, 1)
        yield
    finally:
        os.dup2(saved, 1)
        os.close(saved)
        os.close(devnull)


def make_box(x: float, y: float, z: float, dx: float, dy: float, dz: float):
    box = BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()
    return box


def make_cylinder(x: float, y: float, z: float, r: float, h: float, axis="Z"):
    if axis == "Z":
        ax = gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1))
    else:
        ax = gp_Ax2(gp_Pnt(x, y, z), gp_Dir(1, 0, 0))
    return BRepPrimAPI_MakeCylinder(ax, r, h).Shape()


def translated(shape, dx: float, dy: float, dz: float):
    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(dx, dy, dz))
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


def volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props, True)
    return props.Mass()


def face_count(shape) -> int:
    explorer = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_FACE)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def solid_count(shape) -> int:
    explorer = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_SOLID)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def build_tier_primitives(count: int) -> list:
    """Deterministic primitive corpus: alternating boxes and cylinders."""
    shapes = []
    for i in range(count):
        x = (i % 20) * 2.5
        y = ((i // 20) % 20) * 2.5
        z = (i // 400) * 2.5
        if i % 2 == 0:
            shapes.append(make_box(x, y, z, 2.0, 1.0, 1.5))
        else:
            shapes.append(make_cylinder(x + 1.0, y + 0.5, z, 0.5, 1.5))
    return shapes


def cut_chain(shapes: list) -> list:
    """Sequential boolean cuts: cut a small box out of each primitive."""
    results = []
    for i, shape in enumerate(shapes):
        x = (i % 20) * 2.5
        y = ((i // 20) % 20) * 2.5
        z = (i // 400) * 2.5
        tool = make_box(x + 0.5, y + 0.25, z + 0.25, 0.5, 0.25, 0.5)
        cut = BRepAlgoAPI_Cut(shape, tool)
        cut.Build()
        if not cut.IsDone():
            raise RuntimeError(f"boolean cut {i} failed")
        results.append(cut.Shape())
    return results


def plate_with_holes(holes: int, plate_dx: float = 8.0, plate_dy: float = 4.0,
                     plate_dz: float = 0.1, hole_r: float = 0.08) -> Any:
    """The complex stress shape: a plate with a grid of holes cut in one
    multi-tool boolean (BRepAlgoAPI_Cut with argument lists — the
    efficient batch form; sequential per-hole cutting is measured
    separately via cut_chain)."""
    plate = make_box(0.0, 0.0, 0.0, plate_dx, plate_dy, plate_dz)
    side = int(holes ** 0.5)
    if side * side != holes:
        side += 1  # round up to a grid; caller documents actual count
    builder = TopoDS_Builder()
    tools = TopoDS_Compound()
    builder.MakeCompound(tools)
    n = 0
    margin = 0.4
    gx = max(1, side)
    gy = max(1, (holes + side - 1) // side)
    for ix in range(gx):
        for iy in range(gy):
            if n >= holes:
                break
            x = margin + (plate_dx - 2 * margin) * (ix + 0.5) / gx
            y = margin + (plate_dy - 2 * margin) * (iy + 0.5) / gy
            builder.Add(
                tools,
                make_cylinder(x, y, -0.02, hole_r, plate_dz + 0.04),
            )
            n += 1
    cut = BRepAlgoAPI_Cut(plate, tools)
    cut.Build()
    if not cut.IsDone():
        raise RuntimeError("plate-with-holes boolean failed")
    return cut.Shape(), n


def tessellate(shape, linear_deflection: float = 0.1, angular_deflection: float = 0.5):
    """Mesh the shape (headless view-pipeline proxy); return triangle count."""
    mesher = BRepMesh_IncrementalMesh(
        shape, linear_deflection, False, angular_deflection, True
    )
    mesher.Perform()
    triangles = 0
    explorer = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_FACE)
    loc = TopLoc_Location()
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        triangulation = BRep_Tool.Triangulation_s(face, loc)
        if triangulation is not None:
            triangles += triangulation.NbTriangles()
        explorer.Next()
    return triangles


def write_step(shapes: list, path: str) -> None:
    with silenced_occt_output():
        writer = STEPControl_Writer()
        for shape in shapes:
            writer.Transfer(shape, STEPControl_StepModelType.STEPControl_AsIs)
        writer.Write(path)


def read_step(path: str):
    with silenced_occt_output():
        reader = STEPControl_Reader()
        status = reader.ReadFile(path)
        if status != 1:  # IFSelect_RetDone
            raise RuntimeError(f"STEP read failed with status {status}")
        reader.TransferRoots()
        return reader.OneShape()


def compound(shapes: list):
    comp = TopoDS_Compound()
    builder = TopoDS_Builder()
    builder.MakeCompound(comp)
    for s in shapes:
        builder.Add(comp, s)
    return comp


def fuse_pair(a, b):
    op = BRepAlgoAPI_Fuse(a, b)
    op.Build()
    if not op.IsDone():
        raise RuntimeError("fuse failed")
    return op.Shape()


def degenerate_self_intersecting_solid():
    """A deliberately invalid shape for the failure/recovery scenario:
    a zero-height box (degenerate) — OCCT tolerates creation but boolean
    volume properties on it are degenerate; combined with a bad cut we
    get a genuine engine failure to type and recover from."""
    return make_box(0.0, 0.0, 0.0, 1.0, 1.0, 0.0)
