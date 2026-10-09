"""SerpApi client (https://serpapi.com) with an on-disk response cache.

Engines used:
  google_maps   resolve landmark-style locations; find open hospitals near an incident
  google_news   corroborate a report with recent local news; scan for new flooding
  google        recent web results (tbs=qdr:d) for the same scan

SERPAPI_MODE mirrors MAPBOX_MODE:
  live         always call SerpApi (still writes cache)
  cache_first  serve from cache when present, else call SerpApi (demo default)
  cache_only   never touch the network (offline tests / venue wifi failure)

SerpApi only ever supplies evidence. Every decision stays in the deterministic policy engine.
"""

import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

SEARCH_URL = "https://serpapi.com/search.json"
ACCOUNT_URL = "https://serpapi.com/account.json"
GUWAHATI_LL = "@26.165,91.765,13z"


class SerpApiUnavailable(Exception):
    pass


@dataclass
class Usage:
    """Process-local counters, shown on /api/intel/status."""

    live: int = 0
    cached: int = 0
    failed: int = 0
    by_engine: dict[str, int] = field(default_factory=dict)


usage = Usage()
_client: httpx.AsyncClient | None = None
_memo: dict[str, tuple[float, dict]] = {}
MEMO_TTL_S = 120.0  # lets the pipeline prefetch outside the global unit-of-work lock, even in live mode


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # Google Search with a location can take ~10 s; pipeline lookups are prefetched outside the lock.
        _client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=4.0))
    return _client


def enabled() -> bool:
    s = get_settings()
    return bool(s.serpapi_key) or s.serpapi_mode != "live"


def _cache_path(engine: str, params: dict[str, Any]) -> Any:
    digest = hashlib.sha1(json.dumps({"engine": engine, **params}, sort_keys=True).encode()).hexdigest()[:20]
    d = get_settings().seed_dir / "serp_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{engine}-{digest}.json"


async def search(engine: str, params: dict[str, Any]) -> dict:
    path = _cache_path(engine, params)
    hit = _memo.get(path.name)
    if hit and time.monotonic() - hit[0] < MEMO_TTL_S:
        return hit[1]
    data = await _fetch(engine, params, path)
    _memo[path.name] = (time.monotonic(), data)
    return data


async def _fetch(engine: str, params: dict[str, Any], path: Any) -> dict:
    settings = get_settings()
    if settings.serpapi_mode != "live" and path.exists():
        usage.cached += 1
        return json.loads(path.read_text())
    if settings.serpapi_mode == "cache_only":
        raise SerpApiUnavailable(f"cache miss in cache_only mode: {engine}")
    if not settings.serpapi_key:
        raise SerpApiUnavailable("SERPAPI_KEY not configured")
    try:
        r = await _http().get(
            SEARCH_URL, params={**params, "engine": engine, "api_key": settings.serpapi_key}
        )
        r.raise_for_status()
        data = r.json()
        if data.get("error") and "hasn't returned any results" not in data["error"]:
            raise SerpApiUnavailable(data["error"])
    except (httpx.HTTPError, ValueError, SerpApiUnavailable) as e:
        usage.failed += 1
        if path.exists():  # stale cache beats no answer
            log.warning("serpapi %s failed (%s); serving cached response", engine, e)
            return json.loads(path.read_text())
        raise SerpApiUnavailable(str(e) or type(e).__name__) from e
    usage.live += 1
    usage.by_engine[engine] = usage.by_engine.get(engine, 0) + 1
    data.pop("search_metadata", None)  # holds the request URL; keep the cache free of account details
    path.write_text(json.dumps(data))
    return data


async def account() -> dict | None:
    """Plan + remaining searches (the Account API is free and does not use quota)."""
    key = get_settings().serpapi_key
    if not key:
        return None
    try:
        r = await _http().get(ACCOUNT_URL, params={"api_key": key})
        r.raise_for_status()
        a = r.json()
    except (httpx.HTTPError, ValueError) as e:
        log.warning("serpapi account lookup failed: %s", e)
        return None
    return {
        "plan": a.get("plan_name"),
        "searches_per_month": a.get("searches_per_month"),
        "searches_left": a.get("total_searches_left"),
        "this_month": a.get("this_month_usage"),
    }


# ---------------------------------------------------------------- engines


async def maps_search(query: str, ll: str = GUWAHATI_LL) -> list[dict[str, Any]]:
    """google_maps: normalised places [{title, lng, lat, address, type, place_id, open_state, phone, rating}]."""
    data = await search("google_maps", {"q": query, "ll": ll, "type": "search", "hl": "en", "gl": "in"})
    raw = data.get("local_results") or ([data["place_results"]] if data.get("place_results") else [])
    out = []
    for p in raw:
        gps = p.get("gps_coordinates") or {}
        if "latitude" not in gps or "longitude" not in gps:
            continue
        out.append(
            {
                "title": p.get("title", ""),
                "lng": gps["longitude"],
                "lat": gps["latitude"],
                "address": p.get("address"),
                "type": p.get("type"),
                "place_id": p.get("place_id"),
                "open_state": p.get("open_state") or p.get("hours"),
                "phone": p.get("phone"),
                "rating": p.get("rating"),
            }
        )
    return out


async def news_search(query: str) -> list[dict[str, Any]]:
    """google_news: [{title, source, link, iso_date}] (story clusters flattened)."""
    data = await search("google_news", {"q": query, "gl": "in", "hl": "en"})
    out = []
    for item in data.get("news_results") or []:
        for n in [item, *(item.get("stories") or [])]:
            if n.get("title") and n.get("link"):
                out.append(
                    {
                        "title": n["title"],
                        "source": (n.get("source") or {}).get("name"),
                        "link": n["link"],
                        "iso_date": n.get("iso_date"),
                        "engine": "google_news",
                    }
                )
    return out


async def web_search_recent(query: str) -> list[dict[str, Any]]:
    """google, past 24 h (tbs=qdr:d): organic results + top stories."""
    data = await search(
        "google", {"q": query, "gl": "in", "hl": "en", "location": "Guwahati, Assam, India", "tbs": "qdr:d"}
    )
    out = []
    for n in [*(data.get("top_stories") or []), *(data.get("organic_results") or [])]:
        if n.get("title") and n.get("link"):
            out.append(
                {
                    "title": n["title"],
                    "source": n.get("source"),
                    "link": n["link"],
                    "iso_date": None,  # qdr:d already bounds it to the last 24 h
                    "snippet": n.get("snippet"),
                    "engine": "google",
                }
            )
    return out
