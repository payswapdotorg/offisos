"""Deterministic fixtures for RESEARCH-CAD-001.

All fixtures are fully deterministic (fixed dimensions, no randomness) so
that any engineer can regenerate byte-comparable models and reproduce every
measurement. The fixtures deliberately cover the five fixture classes named
in GitHub issue #1:

- FIX-2D-PLAN: 2D plan with layers/dimensions/constraints data
- FIX-BIM-SMALL: small architectural BIM model (walls/slabs/doors/windows/spaces)
- FIX-OPENINGS: model containing openings and analytic quantities
- FIX-ROUNDTRIP: IFC round-trip fixture with semantic assertions
- FIX-MEDIUM: medium model for performance measurement

Analytic expectations (volumes, areas, counts) are stated alongside the
fixture definitions so benchmarks can assert against them numerically.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Canonical dimensions (meters, IFC coordinate convention: X east, Y north, Z up)
# ---------------------------------------------------------------------------

WALL_HEIGHT = 3.0
WALL_THICKNESS = 0.3
SLAB_THICKNESS = 0.25

# FIX-OPENINGS: a single wall with one door and one window opening.
OPENINGS_WALL_LENGTH = 6.0
DOOR_WIDTH, DOOR_HEIGHT = 1.0, 2.1
WINDOW_WIDTH, WINDOW_HEIGHT = 1.2, 1.5
WINDOW_SILL = 0.9

@dataclass
class OpeningSpec:
    kind: str  # "door" | "window"
    x: float  # center position along the wall
    width: float
    height: float
    sill: float  # bottom height (doors: 0)

    @property
    def area(self) -> float:
        return self.width * self.height


@dataclass
class WallSpec:
    id: str
    x0: float
    y0: float
    x1: float
    y1: float
    height: float = WALL_HEIGHT
    thickness: float = WALL_THICKNESS
    openings: list[OpeningSpec] = field(default_factory=list)

    @property
    def length(self) -> float:
        return ((self.x1 - self.x0) ** 2 + (self.y1 - self.y0) ** 2) ** 0.5

    @property
    def gross_volume(self) -> float:
        return self.length * self.thickness * self.height

    @property
    def gross_side_area(self) -> float:
        return self.length * self.height

    @property
    def openings_volume(self) -> float:
        # Opening void volume = width x opening height x wall thickness
        # (openings are rectangular and fully within the wall height).
        return sum(o.width * o.height * self.thickness for o in self.openings)

    @property
    def net_volume(self) -> float:
        return self.gross_volume - self.openings_volume


# ---------------------------------------------------------------------------
# FIX-BIM-SMALL: 8.0 x 5.0 m single-room building, 4 walls, 1 slab,
# 1 door, 2 windows, 1 space. Grid-aligned, deterministic.
# ---------------------------------------------------------------------------

SMALL_BUILDING = {
    "width": 8.0,
    "length": 5.0,
    "story_height": WALL_HEIGHT,
    "slab": {"thickness": SLAB_THICKNESS},
}

SMALL_WALLS: list[WallSpec] = [
    WallSpec(
        id="wall-north",
        x0=0.0, y0=5.0, x1=8.0, y1=5.0,
        openings=[
            OpeningSpec("window", x=4.0, width=WINDOW_WIDTH,
                        height=WINDOW_HEIGHT, sill=WINDOW_SILL),
        ],
    ),
    WallSpec(
        id="wall-south",
        x0=0.0, y0=0.0, x1=8.0, y1=0.0,
        openings=[
            OpeningSpec("door", x=1.5, width=DOOR_WIDTH,
                        height=DOOR_HEIGHT, sill=0.0),
            OpeningSpec("window", x=5.5, width=WINDOW_WIDTH,
                        height=WINDOW_HEIGHT, sill=WINDOW_SILL),
        ],
    ),
    WallSpec(id="wall-east", x0=8.0, y0=0.0, x1=8.0, y1=5.0),
    WallSpec(id="wall-west", x0=0.0, y0=0.0, x1=0.0, y1=5.0),
]

SMALL_SPACE = {
    "id": "space-room-101",
    "name": "Room 101",
    "area": SMALL_BUILDING["width"] * SMALL_BUILDING["length"]
    - 2 * (WALL_THICKNESS * (SMALL_BUILDING["length"] - 2 * WALL_THICKNESS))
    - 2 * (WALL_THICKNESS * (SMALL_BUILDING["width"] - 2 * WALL_THICKNESS)),
    "long_name": "Office",
}

# Analytic expectations for FIX-BIM-SMALL (CALCULATED, exact):
SMALL_EXPECTED = {
    "wall_count": 4,
    "slab_count": 1,
    "door_count": 1,
    "window_count": 2,
    "space_count": 1,
    "opening_count": 3,
    "wall_gross_volume_sum": sum(w.gross_volume for w in SMALL_WALLS),
    "wall_net_volume_sum": sum(w.net_volume for w in SMALL_WALLS),
    "slab_volume": SMALL_BUILDING["width"] * SMALL_BUILDING["length"] * SLAB_THICKNESS,
    "door_area": DOOR_WIDTH * DOOR_HEIGHT,
    "window_area_sum": 2 * (WINDOW_WIDTH * WINDOW_HEIGHT),
}

# ---------------------------------------------------------------------------
# FIX-OPENINGS: dedicated single-wall fixture with exact analytic quantities.
# ---------------------------------------------------------------------------

OPENINGS_WALL = WallSpec(
    id="wall-openings",
    x0=0.0, y0=0.0, x1=OPENINGS_WALL_LENGTH, y1=0.0,
    openings=[
        OpeningSpec("door", x=1.5, width=DOOR_WIDTH, height=DOOR_HEIGHT, sill=0.0),
        OpeningSpec("window", x=4.0, width=WINDOW_WIDTH, height=WINDOW_HEIGHT, sill=WINDOW_SILL),
    ],
)

OPENINGS_EXPECTED = {
    "gross_volume": OPENINGS_WALL.gross_volume,          # 6.0*0.3*3.0  = 5.4
    "door_volume": DOOR_WIDTH * DOOR_HEIGHT * WALL_THICKNESS,   # 1.0*2.1*0.3 = 0.63
    "window_volume": WINDOW_WIDTH * WINDOW_HEIGHT * WALL_THICKNESS,  # 1.2*1.5*0.3 = 0.54
    "net_volume": OPENINGS_WALL.net_volume,              # 5.4 - 0.63 - 0.54 = 4.23
    "gross_side_area": OPENINGS_WALL.gross_side_area,    # 18.0
    "net_side_area": OPENINGS_WALL.gross_side_area
    - DOOR_WIDTH * DOOR_HEIGHT - WINDOW_WIDTH * WINDOW_HEIGHT,  # 18 - 2.1 - 1.8 = 14.1
    "opening_count": 2,
}

# ---------------------------------------------------------------------------
# FIX-2D-PLAN: 2D plan definition (geometry + layers + dimension +
# constraint data). The *rendering* is engine-independent; the plan carries
# explicit layer assignments and dimension anchor points so 2D drafting
# capability can be tested for precision, layering and dimension geometry.
# ---------------------------------------------------------------------------

PLAN_LAYERS = [
    {"id": "layer-walls", "name": "WALL", "color": "#000000"},
    {"id": "layer-doors", "name": "DOOR", "color": "#FF0000"},
    {"id": "layer-windows", "name": "WINDOW", "color": "#0000FF"},
    {"id": "layer-dims", "name": "DIMENSIONS", "color": "#00AA00"},
    {"id": "layer-text", "name": "ANNOTATION", "color": "#888888"},
]

PLAN_SEGMENTS = [
    # (layer, x0, y0, x1, y1) — the same room footprint as FIX-BIM-SMALL
    ("layer-walls", 0.0, 0.0, 8.0, 0.0),
    ("layer-walls", 8.0, 0.0, 8.0, 5.0),
    ("layer-walls", 8.0, 5.0, 0.0, 5.0),
    ("layer-walls", 0.0, 5.0, 0.0, 0.0),
]

PLAN_DIMENSIONS = [
    # (id, measured points, expected length, text)
    ("dim-1", (0.0, 0.0), (8.0, 0.0), 8.0, "8.00 m"),
    ("dim-2", (8.0, 0.0), (8.0, 5.0), 5.0, "5.00 m"),
]

PLAN_GRID = {"spacing": 0.5}  # snapping grid for adapter-level snapping tests

# ---------------------------------------------------------------------------
# FIX-ROUNDTRIP: semantic payload asserted across IFC write/read cycles.
# Typed property values chosen to cover the common IFC property types.
# ---------------------------------------------------------------------------

ROUNDTRIP_PROPERTIES = [
    {"name": "FireRating", "value": "REI60", "type": "IfcLabel"},
    {"name": "IsExternal", "value": True, "type": "IfcBoolean"},
    {"name": "LoadBearing", "value": False, "type": "IfcBoolean"},
    {"name": "ThermalTransmittance", "value": 0.35, "type": "IfcReal"},
    {"name": "Reference", "value": "W-STD-300", "type": "IfcIdentifier"},
    {"name": "RenovationStatus", "value": "NEW", "type": "IfcLabel"},
]

ROUNDTRIP_QUANTITIES = [
    {"name": "NetVolume", "value": OPENINGS_EXPECTED["net_volume"], "unit": "CUBIC_METRE"},
    {"name": "GrossVolume", "value": OPENINGS_EXPECTED["gross_volume"], "unit": "CUBIC_METRE"},
    {"name": "NetSideArea", "value": OPENINGS_EXPECTED["net_side_area"], "unit": "SQUARE_METRE"},
    {"name": "Height", "value": WALL_HEIGHT, "unit": "METRE"},
]

# ---------------------------------------------------------------------------
# FIX-MEDIUM: parameterized multi-story model for performance measurement.
# Deterministic: stories x walls-per-story with alternating openings.
# ---------------------------------------------------------------------------

MEDIUM_STORIES = 5
MEDIUM_WALLS_PER_STORY = 20
MEDIUM_SPACES_PER_STORY = 4


def medium_walls() -> list[WallSpec]:
    """Deterministic medium-model wall layout: a rectangular ring of
    MEDIUM_WALLS_PER_STORY walls per story (positions computed, not random)."""
    walls: list[WallSpec] = []
    n = MEDIUM_WALLS_PER_STORY
    for story in range(MEDIUM_STORIES):
        for i in range(n):
            if i < n // 4:
                # north row
                x0, y0, x1, y1 = i * 2.0, 10.0, (i + 1) * 2.0, 10.0
            elif i < n // 2:
                # south row
                j = i - n // 4
                x0, y0, x1, y1 = j * 2.0, 0.0, (j + 1) * 2.0, 0.0
            elif i < 3 * n // 4:
                # east column
                j = i - n // 2
                x0, y0, x1, y1 = 10.0, j * 2.5, 10.0, (j + 1) * 2.5
            else:
                # west column
                j = i - 3 * n // 4
                x0, y0, x1, y1 = 0.0, j * 2.5, 0.0, (j + 1) * 2.5
            openings: list[OpeningSpec] = []
            if i % 4 == 1:
                openings.append(OpeningSpec("door", x=1.0, width=DOOR_WIDTH,
                                            height=DOOR_HEIGHT, sill=0.0))
            if i % 4 == 2:
                openings.append(OpeningSpec("window", x=1.0, width=WINDOW_WIDTH,
                                            height=WINDOW_HEIGHT, sill=WINDOW_SILL))
            walls.append(
                WallSpec(
                    id=f"wall-s{story}-w{i:02d}",
                    x0=x0, y0=y0, x1=x1, y1=y1,
                    openings=openings,
                )
            )
    return walls


MEDIUM_EXPECTED = {
    "story_count": MEDIUM_STORIES,
    "wall_count": MEDIUM_STORIES * MEDIUM_WALLS_PER_STORY,
    "space_count": MEDIUM_STORIES * MEDIUM_SPACES_PER_STORY,
}
