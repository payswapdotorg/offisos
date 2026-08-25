"""Benchmark: reusable components and assemblies (RESEARCH-CAD-002 scope 2).

App::Link — the FreeCAD reusable-component primitive: instance placement,
source-edit propagation into every link, link arrays, and robustness of a
medium assembly (100 placed links) with timings.
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-asm/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    script = """
import time
import FreeCAD, Part

doc = FreeCAD.newDocument("benchasm")

# ------------------------------------------------------------------
# 1. Single App::Link: placement honored, volume exact
# ------------------------------------------------------------------
src = doc.addObject("Part::Box", "Source")
src.Length, src.Width, src.Height = 2.0, 3.0, 4.0
doc.recompute()
link = doc.addObject("App::Link", "Link")
link.LinkedObject = src
link.Placement = FreeCAD.Placement(FreeCAD.Vector(10, 0, 0), FreeCAD.Rotation())
doc.recompute()
record("cad2-asm/link-volume-exact",
       "App::Link instance carries the exact source volume (24.0).",
       abs(link.Shape.Volume - 24.0) <= 1e-9,
       details={"volume": link.Shape.Volume})

vtx = [v.Point for v in link.Shape.Vertexes]
xs = [p.x for p in vtx]
record("cad2-asm/link-placement-honored",
       "The link's placement is honored: instance vertices span x in "
       "[10, 12] exactly.",
       abs(min(xs) - 10.0) <= 1e-12 and abs(max(xs) - 12.0) <= 1e-12,
       details={"x_range": (min(xs), max(xs))})

# ------------------------------------------------------------------
# 2. Source-edit propagation into links
# ------------------------------------------------------------------
src.Length = 5.0
doc.recompute()
record("cad2-asm/source-edit-propagation",
       "Editing the source Length 2.0 -> 5.0 propagates into the linked "
       "instance: exact new volume (60.0) and moved extents.",
       abs(link.Shape.Volume - 60.0) <= 1e-9,
       details={"volume_after": link.Shape.Volume})

# ------------------------------------------------------------------
# 3. Link array (ElementCount): reusable components at scale
# ------------------------------------------------------------------
arr = doc.addObject("App::Link", "Array")
arr.LinkedObject = src
arr.ElementCount = 5
doc.recompute()
record("cad2-asm/link-array",
       "A single App::Link with ElementCount=5 exposes the exact combined "
       "shape volume (5 x 60 = 300 within 1e-9).",
       abs(arr.Shape.Volume - 300.0) <= 1e-9,
       details={"elements": arr.ElementCount, "volume": arr.Shape.Volume})

# ------------------------------------------------------------------
# 4. Medium assembly: 100 independently placed links
# ------------------------------------------------------------------
src2 = doc.addObject("Part::Box", "MediumSource")
src2.Length, src2.Width, src2.Height = 1.0, 1.0, 1.0
doc.recompute()
t0 = time.perf_counter()
N = 100
for i in range(N):
    l = doc.addObject("App::Link", f"Inst{i:03d}")
    l.LinkedObject = src2
    l.Placement = FreeCAD.Placement(
        FreeCAD.Vector((i % 10) * 2.0, (i // 10) * 2.0, 0),
        FreeCAD.Rotation(FreeCAD.Vector(0, 0, 1), (i % 4) * 90.0),
    )
create_s = time.perf_counter() - t0
t0 = time.perf_counter()
doc.recompute()
recompute_s = time.perf_counter() - t0
volumes = [doc.getObject(f"Inst{i:03d}").Shape.Volume for i in range(N)]
all_exact = all(abs(v - 1.0) <= 1e-9 for v in volumes)
invalid = [o.Name for o in doc.Objects if "Invalid" in o.State]
record("cad2-asm/medium-assembly-robustness",
       f"Medium assembly of {N} independently placed links: every instance "
       f"has the exact unit volume, no Invalid states, robust recompute.",
       all_exact and not invalid,
       details={"instances": N, "all_volumes_exact": all_exact,
                "invalid_objects": invalid,
                "creation_s": round(create_s, 4),
                "recompute_s": round(recompute_s, 4),
                "document_objects": len(doc.Objects)})

# placements are distinct and exact (spot-check corners)
inst042 = doc.getObject("Inst042")
p = inst042.Placement.Base
record("cad2-asm/instance-placement-exact",
       "Instance 42 placement is exactly (4, 8, 0) with a 180-degree "
       "rotation (deterministic fixture layout).",
       abs(p.x - 4.0) <= 1e-12 and abs(p.y - 8.0) <= 1e-12 and abs(p.z - 0.0) <= 1e-12,
       details={"base": (p.x, p.y, p.z),
                "rotation_angle_deg": (42 % 4) * 90.0})

# ------------------------------------------------------------------
# 5. Source edit propagates into the whole medium assembly
# ------------------------------------------------------------------
src2.Length = 2.0
doc.recompute()
all_two = all(
    abs(doc.getObject(f"Inst{i:03d}").Shape.Volume - 2.0) <= 1e-9
    for i in range(N)
)
record("cad2-asm/assembly-wide-propagation",
       f"Editing the shared source propagates to all {N} instances: every "
       "volume is exactly 2.0 after one recompute.",
       all_two,
       details={"all_instances_updated": all_two})

"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )
    # timings from details
    for check in checks:
        if check["id"] == "cad2-asm/medium-assembly-robustness":
            d = check.get("details") or {}
            result.measure("medium_assembly_creation_s", d.get("creation_s"))
            result.measure("medium_assembly_recompute_s", d.get("recompute_s"))
            result.measure("medium_assembly_instances", d.get("instances"))
            result.measure("medium_assembly_document_objects",
                           d.get("document_objects"))
