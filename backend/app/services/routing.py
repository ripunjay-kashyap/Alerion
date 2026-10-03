"""Safe-route search on top of Mapbox Directions (which cannot avoid arbitrary polygons natively).

Strategy (deterministic, bounded to a handful of Mapbox calls):
  1. Fastest route + alternatives → first one passing the safety check.
  2. Up to N rounds: exclude sampled route points that fall inside the violating hazards
     (Mapbox `exclude=point(...)`), re-request, re-check.
  3. Seeded detour waypoints on the violating hazards.
Every attempt is recorded so the UI/audit can show *why* a route was rejected.
"""

from dataclasses import dataclass, field
from typing import Any

from app.models import Hazard
from app.services import mapbox, safety

LngLat = tuple[float, float]
EXCLUDE_ROUNDS = 3


@dataclass
class RouteAttempt:
    strategy: str
    eta_seconds: float
    distance_meters: float
    safe: bool
    reason: str | None
    hazard_id: str | None

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class RouteSearch:
    geometry: dict[str, Any] | None = None
    eta_seconds: float | None = None
    distance_meters: float | None = None
    strategy: str | None = None
    attempts: list[RouteAttempt] = field(default_factory=list)
    error: str | None = None

    @property
    def found(self) -> bool:
        return self.geometry is not None

    @property
    def first_rejection(self) -> RouteAttempt | None:
        return next((a for a in self.attempts if not a.safe), None)

    def summary(self) -> dict[str, Any]:
        return {
            "found": self.found,
            "strategy": self.strategy,
            "eta_seconds": self.eta_seconds,
            "distance_meters": self.distance_meters,
            "attempts": [a.as_dict() for a in self.attempts],
            "error": self.error,
        }


def _evaluate(
    search: RouteSearch, options: list[mapbox.RouteOption], hazards: list[Hazard], strategy: str
) -> list[tuple[mapbox.RouteOption, safety.SafetyResult]]:
    unsafe = []
    for opt in options:
        res = safety.check_route(opt.geometry, hazards)
        search.attempts.append(
            RouteAttempt(strategy, opt.duration_s, opt.distance_m, res.safe, res.reason, res.hazard_id)
        )
        if res.safe and not search.found:
            search.geometry, search.eta_seconds, search.distance_meters = (
                opt.geometry,
                opt.duration_s,
                opt.distance_m,
            )
            search.strategy = strategy
        elif not res.safe:
            unsafe.append((opt, res))
    return unsafe


async def find_safe_route(origin: LngLat, destination: LngLat, hazards: list[Hazard]) -> RouteSearch:
    search = RouteSearch()
    active = [h for h in hazards if h.active]
    by_id = {h.id: h for h in active}
    try:
        options = await mapbox.directions(origin, destination)
        unsafe = _evaluate(search, options, active, "fastest" if len(options) <= 1 else "alternatives")
        if search.found:
            return search
        if not options:
            search.error = "No drivable route returned by Mapbox"
            return search

        exclude: list[LngLat] = []
        for round_no in range(1, EXCLUDE_ROUNDS + 1):
            new_pts = []
            for opt, res in unsafe:
                if res.hazard_id and res.hazard_id in by_id:
                    new_pts += safety.points_inside(opt.geometry, by_id[res.hazard_id])
            new_pts = [p for p in dict.fromkeys(new_pts) if p not in exclude]
            if not new_pts:
                break
            exclude = (exclude + new_pts)[:50]
            options = await mapbox.directions(origin, destination, exclude_points=exclude)
            unsafe = _evaluate(search, options, active, f"hazard_exclusion_r{round_no}")
            if search.found:
                return search

        violating = {a.hazard_id for a in search.attempts if a.hazard_id}
        for hid in violating:
            for wp in by_id[hid].detour_waypoints if hid in by_id else []:
                options = await mapbox.directions(origin, destination, via=[tuple(wp)])
                _evaluate(search, options, active, f"detour_via_{hid}")
                if search.found:
                    return search

        search.error = "No safe route avoids active hazards"
    except mapbox.MapboxUnavailable as e:
        search.error = f"Routing unavailable: {e}"
    return search
