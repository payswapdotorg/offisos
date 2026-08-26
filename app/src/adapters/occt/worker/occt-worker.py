#!/usr/bin/env python3
"""OCCT geometry worker — the engine side of the Offisos CAD adapter boundary.

CAD-IMPLEMENT-002 / Issue #26. Architecture v1.1 FROZEN (LOCK-003/018).

This process is the isolated engine worker mandated by the RESEARCH-CAD-005
operational findings:

  * disposable subprocess per prepare call (process-per-call isolation —
    CAD-005 §7 measured it affordable at every tier);
  * one JSON request on stdin -> one JSON response on stdout -> exit;
  * the parent (Node) enforces the wall-clock timeout at the PROCESS boundary
    with SIGTERM -> SIGKILL (in-process cancellation of native OCCT calls is
    impossible — CAD-005 §6);
  * typed failures: engine_malformed_input (input validation / construction
    errors), engine_error (engine failures), engine_unavailable (OCP not
    importable — surfaced by the ping op);
  * every response is structurally validated again by the parent before it
    can reach the App API (CAD-005 §5: never trust reader success blindly).

Geometry set (Issue #26 minimum canonical set):
  box, cylinder, transform (row-major 4x4 affine matrix), boolean fuse/cut.
Plus: selection/query metadata (volume, vertex/triangle stats) and
deterministic serialization of the result.

DETERMINISM (LOCK-004/005/017, host parity):
  identical recipes produce identical responses across processes and hosts:
  the meshToken is "occt:" + SHA-256 over a canonical encoding of the
  tessellated mesh (deduplicated + sorted vertices, reindexed + sorted
  triangles, fixed 9-decimal formatting, negative-zero normalized to zero).
  The bbox is the OCCT Bnd_Box (tolerance-inclusive; deterministic). The
  declared tolerance is documented in the adapter evidence.

Protocol (single JSON object each way):

  request  {"op": "ping"}
           {"op": "prepare",
            "recipe": [
              {"id": "s0", "make": "box", "width": 1, "depth": 2, "height": 3},
              {"id": "s1", "make": "cylinder", "radius": 0.5, "height": 2,
               "origin": [0,0,0], "direction": [0,0,1]},
              {"id": "s2", "bool": "fuse", "a": "s0", "b": "s1"},
              {"id": "s3", "transform": "s2", "matrix": [16 numbers row-major]}
            ],
            "result": "s3",
            "tessellation": {"linearDeflection": 0.1, "angularDeflection": 0.5}}

  response {"ok": true, "engine": "occt", "engineVersion": "...",
            "meshToken": "occt:<sha256>", "bbox": [6 numbers],
            "volume": <float>, "stats": {"vertices": N, "triangles": M},
            "mesh": {"vertices": [x,y,z,...], "indices": [a,b,c,...]}}
           {"ok": false, "code": "engine_malformed_input" | "engine_error" |
            "engine_unavailable", "message": "..."}

The recipe is a FLAT, ordered list of steps; every step may reference only
EARLIER step ids (DAG evaluated in order). The recursive geometry descriptor
that the App API accepts is compiled to this flat form by the TypeScript
adapter (app/src/adapters/occt/occt-geometry-adapter.ts) — this worker never
sees nested input, which bounds its complexity.

Only the OCP Python bindings (cadquery-ocp / OCCT) and the standard library
are used. No FreeCAD application runtime is required for the minimum
geometry set; the OCCT kernel is the same one FreeCAD builds on.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import sys
from typing import Any, Dict, List, Tuple

MAX_RECIPE_STEPS = 256
MAX_MESH_VERTICES = 2_000_000
MAX_MESH_TRIANGLES = 4_000_000
DEFAULT_LINEAR_DEFLECTION = 0.1
DEFAULT_ANGULAR_DEFLECTION = 0.5
MIN_LINEAR_DEFLECTION = 1e-6
MAX_LINEAR_DEFLECTION = 10.0
MIN_ANGULAR_DEFLECTION = 1e-3
MAX_ANGULAR_DEFLECTION = math.pi


class MalformedInput(Exception):
    """Input failed validation or OCCT rejected it at construction time."""


def _fail(code: str, message: str) -> None:
    """Emit the single typed-failure response and exit cleanly (exit 0 — the
    parent parses the JSON; a non-zero exit would only occur on a hard crash
    like SIGSEGV, which the parent maps to engine_error)."""
    sys.stdout.write(
        json.dumps({"ok": False, "code": code, "message": message},
                   separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()
    sys.exit(0)


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _require_positive(value: Any, what: str) -> float:
    if not _is_finite_number(value):
        raise MalformedInput(f"{what} must be a finite number, got {value!r}")
    if value <= 0:
        raise MalformedInput(f"{what} must be > 0, got {value}")
    return float(value)


def _optional_vec3(value: Any, what: str, default: List[float] | None = None) -> List[float]:
    if value is None:
        return list(default) if default is not None else [0.0, 0.0, 0.0]
    if not isinstance(value, list) or len(value) != 3 or not all(_is_finite_number(v) for v in value):
        raise MalformedInput(f"{what} must be an array of 3 finite numbers")
    return [float(v) for v in value]


def _validate_recipe(request: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str, float, float]:
    """Full structural validation of the prepare request (CAD-005 §5:
    structural validation on every input — never trust blindly)."""
    recipe = request.get("recipe")
    if not isinstance(recipe, list) or len(recipe) == 0:
        raise MalformedInput("recipe must be a non-empty array of steps")
    if len(recipe) > MAX_RECIPE_STEPS:
        raise MalformedInput(f"recipe exceeds the {MAX_RECIPE_STEPS}-step bound")

    seen: set = set()
    for index, step in enumerate(recipe):
        if not isinstance(step, dict):
            raise MalformedInput(f"recipe[{index}] must be an object")
        sid = step.get("id")
        if not isinstance(sid, str) or not sid:
            raise MalformedInput(f"recipe[{index}].id must be a non-empty string")
        if sid in seen:
            raise MalformedInput(f"recipe step id '{sid}' is duplicated")
        seen.add(sid)

        if "make" in step:
            make = step["make"]
            if make == "box":
                _require_positive(step.get("width"), f"recipe[{index}].width")
                _require_positive(step.get("depth"), f"recipe[{index}].depth")
                _require_positive(step.get("height"), f"recipe[{index}].height")
            elif make == "cylinder":
                _require_positive(step.get("radius"), f"recipe[{index}].radius")
                _require_positive(step.get("height"), f"recipe[{index}].height")
                _optional_vec3(step.get("origin"), f"recipe[{index}].origin")
                direction = _optional_vec3(step.get("direction"), f"recipe[{index}].direction",
                                           default=[0.0, 0.0, 1.0])
                if math.sqrt(sum(d * d for d in direction)) <= 1e-12:
                    raise MalformedInput(f"recipe[{index}].direction must be a non-null vector")
            else:
                raise MalformedInput(f"recipe[{index}].make must be 'box' or 'cylinder', got {make!r}")
        elif "bool" in step:
            if step["bool"] not in ("fuse", "cut"):
                raise MalformedInput(f"recipe[{index}].bool must be 'fuse' or 'cut'")
            for ref in ("a", "b"):
                target = step.get(ref)
                if not isinstance(target, str) or target not in seen or target == sid:
                    raise MalformedInput(f"recipe[{index}].{ref} must reference an earlier step id")
        elif "transform" in step:
            target = step.get("transform")
            if not isinstance(target, str) or target not in seen or target == sid:
                raise MalformedInput(f"recipe[{index}].transform must reference an earlier step id")
            matrix = step.get("matrix")
            if not isinstance(matrix, list) or len(matrix) != 16 or not all(_is_finite_number(v) for v in matrix):
                raise MalformedInput(f"recipe[{index}].matrix must be an array of 16 finite numbers")
            bottom = [float(matrix[i]) for i in (12, 13, 14, 15)]
            if any(abs(v) > 1e-9 for v in bottom[:3]) or abs(bottom[3] - 1.0) > 1e-9:
                raise MalformedInput(f"recipe[{index}].matrix must be affine (bottom row [0,0,0,1])")
        else:
            raise MalformedInput(
                f"recipe[{index}] must contain exactly one of 'make', 'bool' or 'transform'")

    result = request.get("result")
    if not isinstance(result, str) or result not in seen:
        raise MalformedInput("result must reference a recipe step id")

    tess = request.get("tessellation") or {}
    if not isinstance(tess, dict):
        raise MalformedInput("tessellation must be an object")

    def _bounded(key: str, default: float, lo: float, hi: float) -> float:
        value = tess.get(key, default)
        if not _is_finite_number(value) or not (lo <= value <= hi):
            raise MalformedInput(f"tessellation.{key} must be a number in [{lo}, {hi}]")
        return float(value)

    linear = _bounded("linearDeflection", DEFAULT_LINEAR_DEFLECTION,
                      MIN_LINEAR_DEFLECTION, MAX_LINEAR_DEFLECTION)
    angular = _bounded("angularDeflection", DEFAULT_ANGULAR_DEFLECTION,
                       MIN_ANGULAR_DEFLECTION, MAX_ANGULAR_DEFLECTION)
    return recipe, result, linear, angular


def _build_shapes(recipe: List[Dict[str, Any]]):
    """Evaluate the flat recipe DAG in order. Construction errors are typed as
    engine_malformed_input (OCCT Standard_ConstructionError); anything else
    raised by the engine is engine_error (handled by the caller)."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse, BRepAlgoAPI_Cut
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Trsf, gp_Ax2, gp_Dir, gp_Pnt
    from OCP.Standard import Standard_ConstructionError

    shapes: Dict[str, Any] = {}
    for step in recipe:
        sid = step["id"]
        try:
            if step.get("make") == "box":
                shapes[sid] = BRepPrimAPI_MakeBox(
                    float(step["width"]), float(step["depth"]), float(step["height"])
                ).Shape()
            elif step.get("make") == "cylinder":
                origin = _optional_vec3(step.get("origin"), "origin")
                direction = _optional_vec3(step.get("direction"), "direction",
                                           default=[0.0, 0.0, 1.0])
                axis = gp_Ax2(gp_Pnt(origin[0], origin[1], origin[2]),
                              gp_Dir(direction[0], direction[1], direction[2]))
                shapes[sid] = BRepPrimAPI_MakeCylinder(
                    axis, float(step["radius"]), float(step["height"])
                ).Shape()
            elif step.get("bool") == "fuse":
                shapes[sid] = BRepAlgoAPI_Fuse(shapes[step["a"]], shapes[step["b"]]).Shape()
            elif step.get("bool") == "cut":
                shapes[sid] = BRepAlgoAPI_Cut(shapes[step["a"]], shapes[step["b"]]).Shape()
            elif "transform" in step:
                trsf = gp_Trsf()
                trsf.SetValues(*[float(v) for v in step["matrix"][:12]])
                shapes[sid] = BRepBuilderAPI_Transform(shapes[step["transform"]], trsf, True).Shape()
        except Standard_ConstructionError as exc:
            raise MalformedInput(
                f"recipe step '{sid}' rejected at construction: {exc}") from exc
    return shapes


def _tessellate(shape: Any, linear: float, angular: float) -> Tuple[List[Tuple[float, float, float]], List[Tuple[int, int, int]]]:
    """Global vertex/triangle lists with per-face local-index offsetting.
    Coordinates rounded to 9 decimals; negative zero normalized to +0.0."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    BRepMesh_IncrementalMesh(shape, linear, False, angular, True)
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    location = TopLoc_Location()
    verts: List[Tuple[float, float, float]] = []
    tris: List[Tuple[int, int, int]] = []
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is not None:
            base = len(verts)
            trsf = None if location.IsIdentity() else location.Transformation()
            for i in range(1, triangulation.NbNodes() + 1):
                point = triangulation.Node(i)
                if trsf is not None:
                    point = point.Transformed(trsf)
                x = round(point.X(), 9) + 0.0
                y = round(point.Y(), 9) + 0.0
                z = round(point.Z(), 9) + 0.0
                if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
                    raise MalformedInput("tessellation produced non-finite coordinates")
                verts.append((x, y, z))
            for i in range(1, triangulation.NbTriangles() + 1):
                a, b, c = triangulation.Triangle(i).Get()
                tris.append((base + a - 1, base + b - 1, base + c - 1))
        explorer.Next()
    if not verts or not tris:
        raise MalformedInput("tessellation produced an empty mesh")
    if len(verts) > MAX_MESH_VERTICES or len(tris) > MAX_MESH_TRIANGLES:
        raise MalformedInput(
            f"tessellation exceeds bounds ({len(verts)} vertices / {len(tris)} triangles)")
    return verts, tris


def _mesh_token(verts: List[Tuple[float, float, float]],
                tris: List[Tuple[int, int, int]]) -> Tuple[str, List[Tuple[float, float, float]], List[Tuple[int, int, int]]]:
    """Deterministic meshToken: deduplicate + sort vertices, reindex + sort
    triangles, canonical fixed-precision encoding, SHA-256. The deduplicated
    mesh is returned so the emitted mesh data uses the same indexing as the
    token (what the token certifies is exactly what is returned)."""
    unique = sorted(set(verts))
    position = {v: i for i, v in enumerate(unique)}
    original_to_unique = [position[v] for v in verts]
    reindexed = sorted(
        (original_to_unique[a], original_to_unique[b], original_to_unique[c])
        for a, b, c in tris
    )
    vertex_encoding = ";".join(",".join(f"{c:.9f}" for c in v) for v in unique)
    triangle_encoding = ";".join(",".join(map(str, t)) for t in reindexed)
    encoding = vertex_encoding + "|" + triangle_encoding
    token = "occt:" + hashlib.sha256(encoding.encode("utf-8")).hexdigest()
    return token, unique, reindexed


def _bbox_of(shape: Any) -> List[float]:
    """OCCT Bnd_Box (tolerance-inclusive, deterministic). Declared tolerance:
    primitives ~1e-7; fused/cut shapes up to ~5e-3 (boolean tolerances)."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    return [round(v, 9) + 0.0 for v in box.Get()]


def _volume_of(shape: Any) -> float:
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return round(props.Mass(), 9) + 0.0


def _engine_version() -> str:
    try:
        return importlib.metadata.version("cadquery-ocp")
    except Exception:  # noqa: BLE001 — best-effort provenance only
        return "unknown"


def _ensure_ocp() -> None:
    """Fail with the typed engine_unavailable code (not engine_error) when the
    OCP bindings are not importable in this environment."""
    try:
        import OCP  # noqa: F401 — availability probe
    except Exception as exc:  # noqa: BLE001 — ImportError expected when absent
        _fail("engine_unavailable", f"OCP not importable: {exc}")


def _handle_ping() -> None:
    _ensure_ocp()
    response = {"ok": True, "engine": "occt", "engineVersion": _engine_version()}
    sys.stdout.write(json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


def main() -> None:
    try:
        request = json.loads(sys.stdin.read())
    except Exception as exc:  # noqa: BLE001 — malformed JSON is typed input failure
        _fail("engine_malformed_input", f"request is not valid JSON: {exc}")
        return

    if not isinstance(request, dict):
        _fail("engine_malformed_input", "request must be a JSON object")
        return

    op = request.get("op")
    if op == "ping":
        _handle_ping()
        return
    if op != "prepare":
        _fail("engine_malformed_input", f"unsupported op {op!r} (expected 'prepare' or 'ping')")
        return

    try:
        _ensure_ocp()
        recipe, result_id, linear, angular = _validate_recipe(request)
        shapes = _build_shapes(recipe)
        shape = shapes[result_id]
        verts, tris = _tessellate(shape, linear, angular)
        token, unique, reindexed = _mesh_token(verts, tris)
        response = {
            "ok": True,
            "engine": "occt",
            "engineVersion": _engine_version(),
            "meshToken": token,
            "bbox": _bbox_of(shape),
            "volume": _volume_of(shape),
            "stats": {"vertices": len(unique), "triangles": len(reindexed)},
            "mesh": {
                "vertices": [coordinate for vertex in unique for coordinate in vertex],
                "indices": [index for triangle in reindexed for index in triangle],
            },
        }
        sys.stdout.write(json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n")
        sys.stdout.flush()
    except MalformedInput as exc:
        _fail("engine_malformed_input", str(exc))
    except Exception as exc:  # noqa: BLE001 — any other engine failure is typed
        _fail("engine_error", f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
