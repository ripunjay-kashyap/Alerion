"""Mapbox Directions + Geocoding client with an on-disk response cache.

MAPBOX_MODE:
  live         always call Mapbox (still writes cache)
  cache_first  serve from cache when present, else call Mapbox (demo default)
  cache_only   never touch the network (offline tests / venue wifi failure)
"""

import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

DIRECTIONS_URL = "https://api.mapbox.com/directions/v5/mapbox/driving/{coords}"
GEOCODE_URL = "https://api.mapbox.com/search/geocode/v6/forward"

LngLat = tuple[float, float]


class MapboxUnavailable(Exception):
    pass


@dataclass
class RouteOption:
    geometry: dict[str, Any]  # GeoJSON LineString
    duration_s: float
    distance_m: float


_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=4.0))
    return _client


def _cache_path(kind: str, key_obj: dict) -> Path:
    digest = hashlib.sha1(json.dumps(key_obj, sort_keys=True).encode()).hexdigest()[:20]
    d = get_settings().seed_dir / "mapbox_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{kind}-{digest}.json"


async def _get_json(kind: str, url: str, params: dict[str, Any]) -> dict:
    settings = get_settings()
    path = _cache_path(kind, {"url": url, "params": params})
    if settings.mapbox_mode != "live" and path.exists():
        return json.loads(path.read_text())
    if settings.mapbox_mode == "cache_only":
        raise MapboxUnavailable(f"cache miss in cache_only mode: {kind}")
    if not settings.mapbox_token:
        raise MapboxUnavailable("MAPBOX_TOKEN not configured")
    try:
        r = await _http().get(url, params={**params, "access_token": settings.mapbox_token})
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        # never str() an httpx error: its message contains the request URL, access_token included
        reason = (
            f"HTTP {e.response.status_code}" if isinstance(e, httpx.HTTPStatusError) else type(e).__name__
        )
        if path.exists():  # stale cache beats no answer
            log.warning("mapbox %s failed (%s); serving cached response", kind, reason)
            return json.loads(path.read_text())
        raise MapboxUnavailable(reason) from None
    path.write_text(json.dumps(data))
    return data


def _round(p: LngLat) -> LngLat:
    # stable cache keys + Mapbox precision is ~1m at 5 decimals
    return (round(p[0], 5), round(p[1], 5))


async def directions(
    origin: LngLat,
    destination: LngLat,
    *,
    via: list[LngLat] | None = None,
    exclude_points: list[LngLat] | None = None,
    alternatives: bool = True,
) -> list[RouteOption]:
    pts = [_round(origin), *[_round(v) for v in via or []], _round(destination)]
    coords = ";".join(f"{x},{y}" for x, y in pts)
    params: dict[str, Any] = {
        "geometries": "geojson",
        "overview": "full",
        "alternatives": "true" if alternatives and not via else "false",
    }
    if exclude_points:
        params["exclude"] = ",".join(f"point({x} {y})" for x, y in map(_round, exclude_points[:50]))
    data = await _get_json("dir", DIRECTIONS_URL.format(coords=coords), params)
    if data.get("code") != "Ok":
        # NoRoute / InvalidInput with excludes → no options, caller decides
        log.info("mapbox directions code=%s message=%s", data.get("code"), data.get("message"))
        return []
    return [
        RouteOption(geometry=r["geometry"], duration_s=r["duration"], distance_m=r["distance"])
        for r in data.get("routes", [])
    ]


async def geocode(query: str, bbox: list[float], proximity: LngLat) -> dict | None:
    """Returns {name, lng, lat, feature_type} or None. Constrained to the ops bbox."""
    params = {
        "q": query,
        "limit": 1,
        "country": "in",
        "bbox": ",".join(str(b) for b in bbox),
        "proximity": f"{proximity[0]},{proximity[1]}",
    }
    data = await _get_json("geo", GEOCODE_URL, params)
    feats = data.get("features") or []
    if not feats:
        return None
    f = feats[0]
    lng, lat = f["geometry"]["coordinates"]
    return {
        "name": f["properties"].get("full_address") or f["properties"].get("name") or query,
        "lng": lng,
        "lat": lat,
        "feature_type": f["properties"].get("feature_type"),
    }
