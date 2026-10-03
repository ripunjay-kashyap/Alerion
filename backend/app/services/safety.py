"""Deterministic route safety. The LLM never overrides this."""

from dataclasses import dataclass
from typing import Any

from shapely.geometry import LineString, Point, shape
from shapely.geometry.base import BaseGeometry

from app.models import Hazard, HazardKind
from app.services.geo import meters_to_deg
from app.services.policy import config


@dataclass
class SafetyResult:
    safe: bool
    reason: str | None = None
    hazard_id: str | None = None
    exempted: list[str] | None = None  # hazards containing an endpoint (unavoidable approach)

    def as_dict(self) -> dict[str, Any]:
        return {
            "safe": self.safe,
            "reason": self.reason,
            "hazard_id": self.hazard_id,
            "exempted": self.exempted or [],
        }


def hazard_shape(h: Hazard) -> BaseGeometry:
    geom = shape(h.geometry)
    if h.kind == HazardKind.BLOCKED_ROAD:
        return geom.buffer(meters_to_deg(float(config()["routing"]["blocked_road_buffer_m"])))
    return geom


def check_route(route_geometry: dict[str, Any], hazards: list[Hazard]) -> SafetyResult:
    line = LineString(route_geometry["coordinates"])
    start, end = Point(line.coords[0]), Point(line.coords[-1])
    exempted: list[str] = []
    for h in hazards:
        if not h.active:
            continue
        geom = hazard_shape(h)
        if geom.contains(start) or geom.contains(end):
            # Incident or volunteer is inside the zone: final approach is unavoidable, flag but allow.
            exempted.append(h.id)
            continue
        if line.intersects(geom):
            what = "blocked road" if h.kind == HazardKind.BLOCKED_ROAD else "active flood zone"
            return SafetyResult(False, f"Route intersects {what} {h.id} ({h.label})", h.id, exempted)
    return SafetyResult(True, None, None, exempted)


def points_inside(route_geometry: dict[str, Any], h: Hazard, limit: int = 8) -> list[tuple[float, float]]:
    """Route vertices inside a hazard, evenly sampled — used as Mapbox exclude points."""
    geom = hazard_shape(h)
    inside = [c for c in route_geometry["coordinates"] if geom.contains(Point(c))]
    if not inside and h.kind == HazardKind.BLOCKED_ROAD:
        inside = list(shape(h.geometry).coords)
    if len(inside) <= limit:
        return [tuple(c) for c in inside]
    step = len(inside) / limit
    return [tuple(inside[int(i * step)]) for i in range(limit)]


def distance_to_active_hazards_m(lng: float, lat: float, hazards: list[Hazard]) -> float | None:
    p = Point(lng, lat)
    ds = [hazard_shape(h).distance(p) * 111_000.0 for h in hazards if h.active]
    return min(ds) if ds else None
