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

CAD-PARITY-010 (Issue #93) adds:
  - the `intersect` boolean (BRepAlgoAPI_Common) completing the
    union/difference/intersection triad;
  - typed boolean-outcome failures: engine_empty_result (a boolean that
    annihilates all material — null or face-less result) and
    engine_non_manifold (a boolean result the OCCT shape-validity check
    rejects);
  - the `section` op: plane ∩ shape intersection curves via
    BRepAlgoAPI_Section, each edge sampled to a deterministic polyline
    (GCPnts_QuasiUniformDeflection, fixed deflection; straight intersections
    are exact 2-point segments), canonically sorted + deduplicated;
  - the `topology` op: the face/edge/vertex inventory with per-face
    triangulation (default tessellation quality), surface/curve type
    vocabulary, area/length/centroid properties, deterministic per-entity
    engine keys (sha256 over the canonical encoding — provenance only),
    canonically sorted + deduplicated, with bounded counts.

DETERMINISM (LOCK-004/005/017, host parity):
  identical recipes produce identical responses across processes and hosts:
  the meshToken is "occt:" + SHA-256 over a canonical encoding of the
  tessellated mesh (deduplicated + sorted vertices, reindexed + sorted
  triangles, fixed 9-decimal formatting, negative-zero normalized to zero).
  The bbox is the OCCT Bnd_Box (tolerance-inclusive; deterministic). The
  declared tolerance is documented in the adapter evidence. Section and
  topology outputs are canonically sorted by their fixed-precision
  encodings, so explorer enumeration order never reaches the boundary.

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
           {"op": "section", "recipe": [...], "result": "s3",
            "plane": {"origin": [0,0,0], "normal": [0,0,1]}}
           {"op": "topology", "recipe": [...], "result": "s3"}

  response {"ok": true, "engine": "occt", "engineVersion": "...",
            "meshToken": "occt:<sha256>", "bbox": [6 numbers],
            "volume": <float>, "stats": {"vertices": N, "triangles": M},
            "mesh": {"vertices": [x,y,z,...], "indices": [a,b,c,...]}}
           {"ok": true, "engine": "occt", "engineVersion": "...",
            "polylines": [{"points": [x,y,z,...]}, ...]}          (section)
           {"ok": true, "engine": "occt", "engineVersion": "...",
            "faces": [...], "edges": [...], "vertices": [...]}     (topology)
           {"ok": false, "code": "engine_malformed_input" | "engine_error" |
            "engine_unavailable" | "engine_empty_result" |
            "engine_non_manifold", "message": "..."}

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
# CAD-PARITY-010 bounds.
SECTION_DEFLECTION = 0.05          # fixed curve-sampling deflection (deterministic)
SECTION_MAX_POINTS = 8_192         # total accepted section points (typed failure beyond)
TOPOLOGY_DEFLECTION = 0.05         # fixed edge-polyline sampling deflection
MAX_TOPOLOGY_FACES = 512
MAX_TOPOLOGY_EDGES = 1_024
MAX_TOPOLOGY_VERTICES = 1_024


class MalformedInput(Exception):
    """Input failed validation or OCCT rejected it at construction time."""


class EmptyResult(Exception):
    """A boolean operation annihilated all material (typed engine_empty_result)."""


class NonManifoldResult(Exception):
    """A boolean result failed the OCCT shape-validity check (typed
    engine_non_manifold)."""


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


MAX_PROFILE_POINTS = 64
PROFILE_AREA_EPS = 1e-9
PROFILE_COINCIDENCE_EPS = 1e-9


def _require_profile(value: Any, what: str) -> List[List[float]]:
    """COMPAT-CAD-002: validate a planar extrusion profile (mirrors the
    TypeScript adapter's requireProfile — the same rules on both sides of the
    process boundary; CAD-005 §5 structural validation on every input)."""
    if not isinstance(value, list) or len(value) < 3:
        raise MalformedInput(f"{what} must be an array of at least 3 [x, y] points")
    if len(value) > MAX_PROFILE_POINTS:
        raise MalformedInput(f"{what} exceeds the {MAX_PROFILE_POINTS}-point bound")
    points: List[List[float]] = []
    for i, p in enumerate(value):
        if not isinstance(p, list) or len(p) != 2 or not all(_is_finite_number(v) for v in p):
            raise MalformedInput(f"{what}[{i}] must be [x, y] finite numbers")
        points.append([float(p[0]), float(p[1])])
    n = len(points)
    for i in range(n):
        ax, ay = points[i]
        bx, by = points[(i + 1) % n]
        if math.sqrt((ax - bx) ** 2 + (ay - by) ** 2) <= PROFILE_COINCIDENCE_EPS:
            raise MalformedInput(
                f"{what}: point {i} coincides with its successor "
                "(implicit closure - do not repeat the first point at the end)")
    shoelace = 0.0
    for i in range(n):
        ax, ay = points[i]
        bx, by = points[(i + 1) % n]
        shoelace += ax * by - bx * ay
    if abs(shoelace) / 2.0 <= PROFILE_AREA_EPS:
        raise MalformedInput(
            f"{what} must span a non-degenerate area "
            f"(shoelace magnitude > {PROFILE_AREA_EPS})")
    return points


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
            elif make == "extrude":
                _require_profile(step.get("profile"), f"recipe[{index}].profile")
                _require_positive(step.get("height"), f"recipe[{index}].height")
                _optional_vec3(step.get("base"), f"recipe[{index}].base")
            else:
                raise MalformedInput(
                    f"recipe[{index}].make must be 'box', 'cylinder' or 'extrude', got {make!r}")
        elif "bool" in step:
            if step["bool"] not in ("fuse", "cut", "intersect"):
                raise MalformedInput(f"recipe[{index}].bool must be 'fuse', 'cut' or 'intersect'")
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


def _shape_has_faces(shape: Any) -> bool:
    """True when the shape carries at least one face (the empty-boolean
    guard — an empty compound has no faces)."""
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    return explorer.More()


def _check_boolean_result(sid: str, result: Any) -> Any:
    """CAD-PARITY-010 typed boolean-outcome validation: a null or face-less
    result is engine_empty_result; a result the OCCT shape-validity check
    rejects is engine_non_manifold. Applied to EVERY boolean step (an empty
    intermediate would poison the rest of the DAG)."""
    from OCP.BRepCheck import BRepCheck_Analyzer
    if result.IsNull() or not _shape_has_faces(result):
        raise EmptyResult(
            f"recipe step '{sid}': the boolean operation annihilates all material "
            "(null or face-less result)")
    if not BRepCheck_Analyzer(result).IsValid():
        raise NonManifoldResult(
            f"recipe step '{sid}': the boolean result failed the OCCT "
            "shape-validity check (non-manifold or self-intersecting)")
    return result


def _build_shapes(recipe: List[Dict[str, Any]]):
    """Evaluate the flat recipe DAG in order. Construction errors are typed as
    engine_malformed_input (OCCT Standard_ConstructionError); anything else
    raised by the engine is engine_error (handled by the caller)."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse, BRepAlgoAPI_Cut, BRepAlgoAPI_Common
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Trsf, gp_Ax2, gp_Dir, gp_Pnt, gp_Vec
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
            elif step.get("make") == "extrude":
                # COMPAT-CAD-002: closed polygon wire -> planar face -> prism
                # along +Z by height, translated to `base` when present.
                base = _optional_vec3(step.get("base"), "base")
                polygon = BRepBuilderAPI_MakePolygon()
                for point in _require_profile(step.get("profile"), "profile"):
                    polygon.Add(gp_Pnt(point[0], point[1], 0.0))
                polygon.Close()
                face = BRepBuilderAPI_MakeFace(polygon.Wire()).Face()
                prism = BRepPrimAPI_MakePrism(face, gp_Vec(0.0, 0.0, float(step["height"]))).Shape()
                if base != [0.0, 0.0, 0.0]:
                    trsf = gp_Trsf()
                    trsf.SetTranslation(gp_Vec(base[0], base[1], base[2]))
                    prism = BRepBuilderAPI_Transform(prism, trsf, True).Shape()
                shapes[sid] = prism
            elif step.get("bool") == "fuse":
                result = BRepAlgoAPI_Fuse(shapes[step["a"]], shapes[step["b"]]).Shape()
                shapes[sid] = _check_boolean_result(sid, result)
            elif step.get("bool") == "cut":
                result = BRepAlgoAPI_Cut(shapes[step["a"]], shapes[step["b"]]).Shape()
                shapes[sid] = _check_boolean_result(sid, result)
            elif step.get("bool") == "intersect":
                result = BRepAlgoAPI_Common(shapes[step["a"]], shapes[step["b"]]).Shape()
                shapes[sid] = _check_boolean_result(sid, result)
            elif "transform" in step:
                trsf = gp_Trsf()
                trsf.SetValues(*[float(v) for v in step["matrix"][:12]])
                shapes[sid] = BRepBuilderAPI_Transform(shapes[step["transform"]], trsf, True).Shape()
        except (EmptyResult, NonManifoldResult):
            raise
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


# ---------------------------------------------------------------------------
# CAD-PARITY-010 (Issue #93): the section and topology ops.
# ---------------------------------------------------------------------------

def _fmt(v: float) -> str:
    """Fixed 9-decimal coordinate with negative-zero normalized (the meshToken
    convention — the shared canonical encoding for sorting/dedup/keys)."""
    r = round(v, 9) + 0.0
    return f"{r:.9f}"


def _encode_points(points: List[List[float]]) -> str:
    return ";".join(",".join(_fmt(c) for c in p) for p in points)


def _validate_section_plane(request: Dict[str, Any]) -> Tuple[List[float], List[float]]:
    plane = request.get("plane")
    if not isinstance(plane, dict):
        raise MalformedInput("section requires a plane {origin, normal}")
    origin = _optional_vec3(plane.get("origin"), "plane.origin")
    normal = _optional_vec3(plane.get("normal"), "plane.normal")
    length = math.sqrt(sum(n * n for n in normal))
    if length <= 1e-12:
        raise MalformedInput("plane.normal must be a non-null vector")
    if abs(length - 1.0) > 1e-9:
        raise MalformedInput(
            f"plane.normal must be unit length (got {length!r}); the caller normalizes explicitly")
    return origin, normal


def _handle_section(request: Dict[str, Any]) -> None:
    """The section op: plane ∩ result-shape intersection curves via
    BRepAlgoAPI_Section. Each result edge is sampled to a deterministic
    polyline (straight edges are exact 2-point segments); polylines are
    deduplicated + canonically sorted before the response (explorer order
    never reaches the boundary). Empty polylines = the plane misses the
    solid (a legal exact result)."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
    from OCP.gp import gp_Pln, gp_Pnt, gp_Dir
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopoDS import TopoDS
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    from OCP.GeomAbs import GeomAbs_CurveType

    _ensure_ocp()
    origin, normal = _validate_section_plane(request)
    recipe, result_id, _, _ = _validate_recipe(request)
    shapes = _build_shapes(recipe)
    shape = shapes[result_id]

    plane = gp_Pln(gp_Pnt(origin[0], origin[1], origin[2]),
                   gp_Dir(normal[0], normal[1], normal[2]))
    section = BRepAlgoAPI_Section(shape, plane, True)
    section.Build()
    if not section.IsDone():
        raise MalformedInput("the section operation did not complete")

    polylines: List[Tuple[str, List[float]]] = []
    total_points = 0
    explorer = TopExp_Explorer(section.Shape(), TopAbs_EDGE)
    while explorer.More():
        edge = TopoDS.Edge_s(explorer.Current())
        adaptor = BRepAdaptor_Curve(edge)
        curve_type = adaptor.GetType()
        points: List[List[float]] = []
        if curve_type == GeomAbs_CurveType.GeomAbs_Line:
            # Straight intersection edges: the exact 2-point segment.
            first = adaptor.Value(adaptor.FirstParameter())
            last = adaptor.Value(adaptor.LastParameter())
            points = [[first.X(), first.Y(), first.Z()], [last.X(), last.Y(), last.Z()]]
        else:
            # Curved intersection edges: deterministic polyline sampling.
            sampler = GCPnts_QuasiUniformDeflection(adaptor, SECTION_DEFLECTION)
            for i in range(1, sampler.NbPoints() + 1):
                p = sampler.Value(i)
                points.append([p.X(), p.Y(), p.Z()])
        # Drop consecutive duplicates (fixed-precision equality).
        deduped: List[List[float]] = []
        for p in points:
            if not deduped or _encode_points([deduped[-1]]) != _encode_points([p]):
                deduped.append([round(c, 9) + 0.0 for c in p])
        if len(deduped) >= 2:
            total_points += len(deduped)
            if total_points > SECTION_MAX_POINTS:
                raise MalformedInput(
                    f"section output exceeds the {SECTION_MAX_POINTS}-point bound")
            polylines.append((_encode_points(deduped),
                              [c for p in deduped for c in p]))
        explorer.Next()

    # Deduplicate identical polylines + canonical sort (encoding order).
    seen: set = set()
    unique = []
    for key, flat in polylines:
        if key not in seen:
            seen.add(key)
            unique.append((key, flat))
    unique.sort(key=lambda entry: entry[0])

    response = {
        "ok": True,
        "engine": "occt",
        "engineVersion": _engine_version(),
        "polylines": [{"points": flat} for _, flat in unique],
    }
    sys.stdout.write(json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


_SURFACE_TYPE_NAMES = {
    0: "plane", 1: "cylinder", 2: "cone", 3: "sphere", 4: "torus",
    5: "bezier", 6: "bspline", 7: "revolution", 8: "extrusion",
    9: "offset", 10: "other",
}

_CURVE_TYPE_NAMES = {
    0: "line", 1: "circle", 2: "ellipse", 3: "hyperbola", 4: "parabola",
    5: "bezier", 6: "bspline", 7: "offset", 8: "other",
}


def _handle_topology(request: Dict[str, Any]) -> None:
    """The topology op: the face/edge/vertex inventory of the result shape.

    Faces carry their OWN triangulation (world-space), surface type, area and
    centroid; edges carry curve type, a sampled polyline and the exact curve
    length; vertices carry their point. Every entity gets a deterministic
    engine key (sha256 over its canonical encoding — provenance only; the
    shared core assigns canonical identity). Faces/edges/vertices are
    deduplicated (identical geometry) and canonically sorted; counts are
    bounded."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    from OCP.BRepAdaptor import BRepAdaptor_Surface, BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection, GCPnts_AbscissaPoint
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp

    _ensure_ocp()
    recipe, result_id, _, _ = _validate_recipe(request)
    shapes = _build_shapes(recipe)
    shape = shapes[result_id]

    BRepMesh_IncrementalMesh(shape, DEFAULT_LINEAR_DEFLECTION, False,
                             DEFAULT_ANGULAR_DEFLECTION, True)

    faces: List[Tuple[str, Dict[str, Any]]] = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    location = TopLoc_Location()
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        adaptor = BRepAdaptor_Surface(face)
        surface_type = _SURFACE_TYPE_NAMES.get(int(adaptor.GetType()), "other")
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        area = round(props.Mass(), 9) + 0.0
        centre = props.CentreOfMass()
        centroid = [round(centre.X(), 9) + 0.0, round(centre.Y(), 9) + 0.0,
                    round(centre.Z(), 9) + 0.0]
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is not None:
            verts: List[float] = []
            tris: List[int] = []
            trsf = None if location.IsIdentity() else location.Transformation()
            for i in range(1, triangulation.NbNodes() + 1):
                point = triangulation.Node(i)
                if trsf is not None:
                    point = point.Transformed(trsf)
                verts.extend([round(point.X(), 9) + 0.0,
                              round(point.Y(), 9) + 0.0,
                              round(point.Z(), 9) + 0.0])
            for i in range(1, triangulation.NbTriangles() + 1):
                a, b, c = triangulation.Triangle(i).Get()
                tris.extend([a - 1, b - 1, c - 1])
            if verts and tris:
                verts_encoding = ";".join(
                    ",".join(_fmt(verts[i + k]) for k in range(3))
                    for i in range(0, len(verts), 3))
                tris_encoding = ";".join(
                    ",".join(str(t) for t in tris[i:i + 3])
                    for i in range(0, len(tris), 3))
                key_material = (f"{surface_type}|{verts_encoding}|{tris_encoding}"
                                f"|{_fmt(area)}|{','.join(_fmt(c) for c in centroid)}")
                engine_key = "occt-f:" + hashlib.sha256(
                    key_material.encode("utf-8")).hexdigest()
                faces.append((key_material, {
                    "surfaceType": surface_type,
                    "vertices": verts,
                    "indices": tris,
                    "area": area,
                    "centroid": centroid,
                    "engineKey": engine_key,
                }))
        explorer.Next()

    edges: List[Tuple[str, Dict[str, Any]]] = []
    explorer = TopExp_Explorer(shape, TopAbs_EDGE)
    while explorer.More():
        edge = TopoDS.Edge_s(explorer.Current())
        adaptor = BRepAdaptor_Curve(edge)
        curve_type = _CURVE_TYPE_NAMES.get(int(adaptor.GetType()), "other")
        sampler = GCPnts_QuasiUniformDeflection(adaptor, TOPOLOGY_DEFLECTION)
        points: List[List[float]] = []
        for i in range(1, sampler.NbPoints() + 1):
            p = sampler.Value(i)
            points.append([round(p.X(), 9) + 0.0, round(p.Y(), 9) + 0.0,
                           round(p.Z(), 9) + 0.0])
        if len(points) >= 2:
            length = round(GCPnts_AbscissaPoint.Length_s(adaptor), 9) + 0.0
            points_encoding = _encode_points(points)
            key_material = f"{curve_type}|{points_encoding}|{_fmt(length)}"
            engine_key = "occt-e:" + hashlib.sha256(key_material.encode("utf-8")).hexdigest()
            edges.append((key_material, {
                "curveType": curve_type,
                "points": [c for p in points for c in p],
                "length": length,
                "engineKey": engine_key,
            }))
        explorer.Next()

    vertices: List[Tuple[str, Dict[str, Any]]] = []
    explorer = TopExp_Explorer(shape, TopAbs_VERTEX)
    while explorer.More():
        vertex = TopoDS.Vertex_s(explorer.Current())
        point = BRep_Tool.Pnt_s(vertex)
        p = [round(point.X(), 9) + 0.0, round(point.Y(), 9) + 0.0,
             round(point.Z(), 9) + 0.0]
        key_material = ",".join(_fmt(c) for c in p)
        engine_key = "occt-v:" + hashlib.sha256(key_material.encode("utf-8")).hexdigest()
        vertices.append((key_material, {
            "point": p,
            "engineKey": engine_key,
        }))
        explorer.Next()

    # Deduplicate by canonical geometry (identical geometry from split
    # sub-shapes collapses to one entity) + canonical sort + bounds.
    def dedupe_sort(entries: List[Tuple[str, Dict[str, Any]]],
                    bound: int, what: str) -> List[Dict[str, Any]]:
        seen: set = set()
        unique: List[Tuple[str, Dict[str, Any]]] = []
        for key, value in entries:
            if key not in seen:
                seen.add(key)
                unique.append((key, value))
        if len(unique) > bound:
            raise MalformedInput(
                f"topology exceeds the {bound}-{what} bound ({len(unique)})")
        unique.sort(key=lambda entry: entry[0])
        return [value for _, value in unique]

    face_values = dedupe_sort(faces, MAX_TOPOLOGY_FACES, "face")
    edge_values = dedupe_sort(edges, MAX_TOPOLOGY_EDGES, "edge")
    vertex_values = dedupe_sort(vertices, MAX_TOPOLOGY_VERTICES, "vertex")

    response = {
        "ok": True,
        "engine": "occt",
        "engineVersion": _engine_version(),
        "faces": face_values,
        "edges": edge_values,
        "vertices": vertex_values,
    }
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
    if op != "prepare" and op != "section" and op != "topology":
        _fail("engine_malformed_input", f"unsupported op {op!r} (expected 'prepare', 'section', 'topology' or 'ping')")
        return

    try:
        _ensure_ocp()
        if op == "section":
            _handle_section(request)
            return
        if op == "topology":
            _handle_topology(request)
            return
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
    except EmptyResult as exc:
        _fail("engine_empty_result", str(exc))
    except NonManifoldResult as exc:
        _fail("engine_non_manifold", str(exc))
    except Exception as exc:  # noqa: BLE001 — any other engine failure is typed
        _fail("engine_error", f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
