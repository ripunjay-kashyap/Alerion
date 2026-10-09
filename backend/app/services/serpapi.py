"""SerpApi client (https://serpapi.com) with an on-disk response cache.

Engines used:
  google_maps   resolve landmark-style locations; find open hospitals near an incident
  google_news   corroborate a report with recent local news; scan for new flooding
  google        recent web results (tbs=qdr:d) for the same scan

SERPAPI_MODE mirrors MAPBOX_MODE:
  live         always call SerpApi (still writes cache)
  cache_first  serve from cache when present, else call SerpApi (demo default). Time-bounded news and web
               queries go stale after NEWS_CACHE_TTL_S: the pipeline gets the cached copy at once while it
               refreshes in the background (so its timing never depends on SerpApi), a dispatcher's scan waits
               for fresh results.
  cache_only   never touch the network (offline tests / venue wifi failure)

SerpApi only ever supplies evidence. Every decision stays in the deterministic policy engine.
"""

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
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
# path name → (expires_at, response or failure message). Lets the pipeline prefetch outside the global
# unit-of-work lock, even in live mode; failures are remembered too, so the locked step never retries the network.
_memo: dict[str, tuple[float, dict | str]] = {}
MEMO_TTL_S = 120.0
FAILURE_TTL_S = 60.0
TIME_BOUNDED = {"google_news", "google"}  # "when:1d" / tbs=qdr:d: a cached copy goes stale
NEWS_CACHE_TTL_S = 3600.0
ACCOUNT_TTL_S = 60.0
_account: tuple[float, dict | None] | None = None
_refreshing: dict[str, asyncio.Task] = {}  # background refreshes of stale time-bounded results


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # Google Search with a location can take ~10 s; pipeline lookups are prefetched outside the lock.
        _client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=4.0))
    return _client


def _cache_path(engine: str, params: dict[str, Any]) -> Path:
    digest = hashlib.sha1(json.dumps({"engine": engine, **params}, sort_keys=True).encode()).hexdigest()[:20]
    d = get_settings().seed_dir / "serp_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{engine}-{digest}.json"


def _error_text(e: Exception) -> str:
    """Never str() an httpx error: its message contains the request URL, api_key included."""
    if isinstance(e, SerpApiUnavailable):
        return str(e)
    if isinstance(e, httpx.HTTPStatusError):
        try:
            detail = e.response.json().get("error")
        except ValueError:
            detail = None
        return f"HTTP {e.response.status_code}" + (f": {detail}" if detail else "")
    return type(e).__name__


async def search(engine: str, params: dict[str, Any], *, fresh: bool = False) -> dict:
    """`fresh`: wait for a refetch of stale time-bounded results instead of refreshing them in the background."""
    path = _cache_path(engine, params)
    now = time.monotonic()
    hit = _memo.get(path.name)
    if hit and now < hit[0] and not (fresh and isinstance(hit[1], dict) and _stale(engine, hit[1])):
        if isinstance(hit[1], str):
            raise SerpApiUnavailable(hit[1])
        return hit[1]
    for k in [k for k, (expires, _) in _memo.items() if expires <= now]:
        del _memo[k]
    try:
        data = await _fetch(engine, params, path, fresh)
    except SerpApiUnavailable as e:
        settings = get_settings()
        if settings.serpapi_key and settings.serpapi_mode != "cache_only":  # a network attempt failed
            _memo[path.name] = (now + FAILURE_TTL_S, str(e))
        raise
    _memo[path.name] = (now + MEMO_TTL_S, data)
    return data


def _stale(engine: str, data: dict) -> bool:
    return engine in TIME_BOUNDED and time.time() - data.get("_fetched_at", 0) > NEWS_CACHE_TTL_S


async def _fetch(engine: str, params: dict[str, Any], path: Path, fresh: bool = False) -> dict:
    settings = get_settings()
    cached = json.loads(path.read_text()) if settings.serpapi_mode != "live" and path.exists() else None
    if cached is not None and (
        settings.serpapi_mode == "cache_only" or not settings.serpapi_key or not _stale(engine, cached)
    ):
        usage.cached += 1
        return cached
    if settings.serpapi_mode == "cache_only":
        raise SerpApiUnavailable(f"cache miss in cache_only mode: {engine}")
    if not settings.serpapi_key:
        raise SerpApiUnavailable("SERPAPI_KEY not configured")
    if cached is not None and not fresh:  # stale-while-revalidate
        if path.name not in _refreshing:
            _refreshing[path.name] = asyncio.create_task(_refresh(engine, params, path))
        usage.cached += 1
        return cached
    return await _network(engine, params, path)


async def _refresh(engine: str, params: dict[str, Any], path: Path) -> None:
    try:
        data = await _network(engine, params, path)
        _memo[path.name] = (time.monotonic() + MEMO_TTL_S, data)
    except SerpApiUnavailable:
        pass  # already logged; the stale copy stays
    finally:
        _refreshing.pop(path.name, None)


async def _network(engine: str, params: dict[str, Any], path: Path) -> dict:
    settings = get_settings()
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
        reason = _error_text(e)
        if path.exists():  # stale cache beats no answer
            log.warning("serpapi %s failed (%s); serving cached response", engine, reason)
            usage.cached += 1
            return json.loads(path.read_text())
        raise SerpApiUnavailable(reason) from None
    usage.live += 1
    usage.by_engine[engine] = usage.by_engine.get(engine, 0) + 1
    data.pop("search_metadata", None)  # holds the request URL; keep the cache free of account details
    data["_fetched_at"] = time.time()
    path.write_text(json.dumps(data))
    return data


async def account() -> dict | None:
    """Plan + remaining searches (the Account API is free and does not use quota). Cached for a minute."""
    global _account
    key = get_settings().serpapi_key
    if not key:
        return None
    if _account and time.monotonic() < _account[0]:
        return _account[1]
    try:
        r = await _http().get(ACCOUNT_URL, params={"api_key": key})
        r.raise_for_status()
        a = r.json()
    except (httpx.HTTPError, ValueError) as e:
        log.warning("serpapi account lookup failed: %s", _error_text(e))
        _account = (time.monotonic() + ACCOUNT_TTL_S, None)
        return None
    info = {
        "plan": a.get("plan_name"),
        "searches_per_month": a.get("searches_per_month"),
        "searches_left": a.get("total_searches_left"),
        "this_month": a.get("this_month_usage"),
    }
    _account = (time.monotonic() + ACCOUNT_TTL_S, info)
    return info


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


async def news_search(query: str, *, fresh: bool = False) -> list[dict[str, Any]]:
    """google_news: [{title, source, link, iso_date}] (story clusters flattened)."""
    data = await search("google_news", {"q": query, "gl": "in", "hl": "en"}, fresh=fresh)
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


async def web_search_recent(query: str, *, fresh: bool = False) -> list[dict[str, Any]]:
    """google, past 24 h (tbs=qdr:d): organic results + top stories."""
    data = await search(
        "google",
        {"q": query, "gl": "in", "hl": "en", "location": "Guwahati, Assam, India", "tbs": "qdr:d"},
        fresh=fresh,
    )
    out = []
    for n in [*(data.get("top_stories") or []), *(data.get("organic_results") or [])]:
        if n.get("title") and n.get("link"):
            out.append(
                {
                    "title": n["title"],
                    "source": n.get("source"),
                    "link": n["link"],
                    "iso_date": None,  # qdr:d bounds it to the 24 h before the search ran
                    "fetched_at": data.get("_fetched_at"),
                    "snippet": n.get("snippet"),
                    "engine": "google",
                }
            )
    return out
