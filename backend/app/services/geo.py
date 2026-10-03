"""Location resolution + small geo helpers.

Resolution order: known places (fixed coords, deterministic) → Mapbox geocoding constrained to the ops bbox.
"""

import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache

from app.config import get_settings
from app.services import mapbox

OPS_CENTER = (91.765, 26.165)


@dataclass
class ResolvedLocation:
    name: str
    lng: float
    lat: float
    confidence: float
    incident_zone: bool
    source: str  # "known_place" | "mapbox" | "unresolved"


@lru_cache
def _places() -> dict:
    return json.loads((get_settings().seed_dir / "locations.json").read_text())


def bbox() -> list[float]:
    return _places()["bbox"]


def match_known_place(text: str) -> dict | None:
    """Longest alias contained in text (word-boundary), so 'riverside apartments' beats 'riverside'."""
    t = text.lower()
    best: tuple[int, dict] | None = None
    for p in _places()["places"]:
        for alias in p["aliases"]:
            if re.search(rf"\b{re.escape(alias)}\b", t) and (best is None or len(alias) > best[0]):
                best = (len(alias), p)
    return best[1] if best else None


def in_bbox(lng: float, lat: float) -> bool:
    w, s, e, n = bbox()
    return w <= lng <= e and s <= lat <= n


async def resolve(location_text: str | None, raw_text: str = "") -> ResolvedLocation | None:
    for candidate in (location_text or "", raw_text):
        if candidate and (p := match_known_place(candidate)):
            return ResolvedLocation(p["name"], p["lng"], p["lat"], 0.95, p["incident_zone"], "known_place")
    if not location_text:
        return None
    try:
        hit = await mapbox.geocode(f"{location_text}, Guwahati", bbox(), OPS_CENTER)
    except mapbox.MapboxUnavailable:
        return None
    if not hit or not in_bbox(hit["lng"], hit["lat"]):
        return None
    # street/address hits are precise; locality/place hits are coarse
    precise = hit.get("feature_type") in {"address", "street", "poi"}
    return ResolvedLocation(hit["name"], hit["lng"], hit["lat"], 0.8 if precise else 0.72, False, "mapbox")


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """a, b = (lng, lat)."""
    r = 6371000.0
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def meters_to_deg(m: float) -> float:
    # good enough at city scale near 26°N for buffers/proximity
    return m / 111_000.0
