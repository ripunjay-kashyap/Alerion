"""SerpApi evidence layer: outside evidence for the decisions the policy engine makes.

  news_corroboration   recent Google News articles that name a report's locality → trust modifier
  facilities           Google Maps hospitals near rescue/medical incidents, open ones first
  scan                 Google News + Google Search (past 24 h) → suggested flood zones for a dispatcher
  accept / dismiss     a dispatcher turns a suggestion into an active hazard (reroutes follow) or drops it

Nothing here decides anything. Corroboration feeds policy.compute_trust (capped below "verified"),
and a suggestion does nothing until a human accepts it.
"""

import json
import logging
import math
import re
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

from shapely import affinity
from shapely.geometry import Point, mapping
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Hazard, HazardKind, IntelStatus, IntelSuggestion, Report, utcnow
from app.services import audit, geo, policy, serpapi
from app.services.audit import Actor

log = logging.getLogger(__name__)

INTEL = Actor("serpapi-intel", "system")
FLOOD_TERMS = re.compile(r"flood|waterlog|water-log|inundat|submerg|deluge|knee-deep|waist-deep", re.I)
# Flood *politics* (compensation rows, protests) is news about a flood, not evidence of water on a street.
NOT_CONDITIONS = re.compile(
    r"compensation|protest|detain|satyagraha|black flag|rally|relief fund|package", re.I
)
SCAN_NEWS_QUERY = "Guwahati flood OR waterlogging OR waterlogged when:1d"
SCAN_WEB_QUERY = "Guwahati waterlogging flood today"


def _cfg() -> dict[str, Any]:
    return policy.config()["intel"]


@lru_cache
def localities() -> list[str]:
    return json.loads((get_settings().seed_dir / "localities.json").read_text())["localities"]


def _mentions(text: str, name: str) -> bool:
    return bool(re.search(rf"\b{re.escape(name.lower())}\b", text.lower()))


def _recent(article: dict[str, Any]) -> bool:
    window = timedelta(hours=_cfg()["news_window_hours"])
    if article.get("engine") == "google":
        # tbs=qdr:d bounds web results to the 24 h before the search ran; a replayed copy ages from there
        stamp = article.get("fetched_at")
        return stamp is None or utcnow() - datetime.fromtimestamp(stamp, UTC) <= window
    try:
        published = datetime.fromisoformat(article["iso_date"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return False
    return utcnow() - published <= window


def needs_news(source_type: str) -> bool:
    """Only reports whose source isn't already trusted enough to count as verified get a news check."""
    cfg = policy.config()["trust"]
    return cfg["base"].get(source_type, 0) < cfg["verified_threshold"]


def locality_for(loc: geo.ResolvedLocation, location_text: str | None) -> str:
    """The neighbourhood name a journalist would use: a known locality if one is named, else the place text."""
    hay = f"{location_text or ''} {loc.name}"
    if named := next((n for n in localities() if _mentions(hay, n)), None):
        return named
    if loc.source == "known_place" and "," in loc.name:
        return loc.name.rsplit(",", 1)[1].strip()  # "Riverside Apartments, Uzan Bazar" → "Uzan Bazar"
    return (location_text or loc.name).split(",")[0].strip()


# ---------------------------------------------------------------- report corroboration


async def prefetch(location_text: str | None, raw_text: str, source_type: str) -> None:
    """Warm the SerpApi memo before the intake step takes the global lock (same calls, same order)."""
    try:
        loc = await geo.resolve(location_text, raw_text)
        if loc and needs_news(source_type):
            await news_corroboration(locality_for(loc, location_text))
    except Exception:  # best effort only; the intake step does the real work
        log.exception("serpapi prefetch failed")


async def news_corroboration(locality: str) -> dict[str, Any]:
    """Recent articles whose headline names the locality and a flood term. Absence of news is neutral."""
    query = f'"{locality}" Guwahati flood OR waterlogging when:1d'
    try:
        articles = await serpapi.news_search(query)
    except serpapi.SerpApiUnavailable as e:
        return {"engine": "google_news", "query": query, "available": False, "reason": str(e), "articles": []}
    hits = [
        a
        for a in articles
        if _recent(a)
        and _mentions(a["title"], locality)
        and FLOOD_TERMS.search(a["title"])
        and not NOT_CONDITIONS.search(a["title"])
    ]
    return {"engine": "google_news", "query": query, "available": True, "articles": hits[:5]}


# ---------------------------------------------------------------- facilities


def _open_now(state: str | None) -> bool | None:
    """Google Maps open_state: "Open ⋅ Closes 10 PM" | "Open 24 hours" | "Closed ⋅ Opens 9 AM"."""
    s = (state or "").lower()
    if re.match(r"open\b", s):
        return True
    if s.startswith(("closed", "temporarily closed", "permanently closed")):
        return False
    return None


async def facilities(report: Report) -> dict[str, Any]:
    if report.latitude is None or report.longitude is None:
        return {"query": None, "available": False, "reason": "report has no location", "results": []}
    query = _cfg()["facility_queries"].get(report.need_type or "")
    if not query:
        return {
            "query": None,
            "available": False,
            "reason": "no nearby-help search for this need",
            "results": [],
        }
    try:
        places = await serpapi.maps_search(query, ll=f"@{report.latitude:.4f},{report.longitude:.4f},15z")
    except serpapi.SerpApiUnavailable as e:
        return {"query": query, "available": False, "reason": str(e), "results": []}
    origin = (report.longitude, report.latitude)
    results = []
    for p in places:
        if not geo.in_bbox(p["lng"], p["lat"]):
            continue
        distance = round(geo.haversine_m(origin, (p["lng"], p["lat"])))
        results.append({**p, "open_now": _open_now(p.get("open_state")), "distance_m": distance})
    # open first (unknown next, closed last), then nearest
    results.sort(key=lambda r: ({True: 0, None: 1, False: 2}[r["open_now"]], r["distance_m"]))
    return {"engine": "google_maps", "query": query, "available": True, "results": results[:5]}


# ---------------------------------------------------------------- scan → suggestions


async def _gather_articles() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    articles, searches = [], []
    for engine, fn, q in (
        ("google_news", serpapi.news_search, SCAN_NEWS_QUERY),
        ("google", serpapi.web_search_recent, SCAN_WEB_QUERY),
    ):
        try:
            found = await fn(q, fresh=True)  # a dispatcher asked: wait for today's results
            searches.append({"engine": engine, "query": q, "results": len(found)})
            articles += found
        except serpapi.SerpApiUnavailable as e:
            searches.append({"engine": engine, "query": q, "error": str(e)})
    return [a for a in articles if _recent(a)], searches


def _group_by_locality(articles: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    seen: set[str] = set()
    for a in articles:
        text = f"{a['title']} {a.get('snippet') or ''}"
        if a["link"] in seen or not FLOOD_TERMS.search(text) or NOT_CONDITIONS.search(text):
            continue
        seen.add(a["link"])
        for name in localities():
            if _mentions(text, name):
                groups.setdefault(name, []).append(
                    {k: a.get(k) for k in ("title", "source", "link", "iso_date", "engine")}
                )
    return groups


async def gather() -> dict[str, Any]:
    """Network half of a scan (SerpApi + geocoding). Runs outside the unit-of-work lock."""
    articles, searches = await _gather_articles()
    groups = _group_by_locality(articles)
    places, unresolved = {}, []
    for name in groups:
        if loc := await geo.resolve(name):
            places[name] = loc
        else:
            unresolved.append(name)
    return {
        "articles": articles,
        "searches": searches,
        "groups": groups,
        "places": places,
        "unresolved": unresolved,
    }


async def scan(session: AsyncSession, found: dict[str, Any]) -> dict[str, Any]:
    """DB half of a scan: new suggestions per locality, new articles appended to open ones.
    A dismissed locality is only proposed again when articles the dispatcher hasn't seen name it."""
    articles, searches, groups = found["articles"], found["searches"], found["groups"]
    rows = (await session.scalars(select(IntelSuggestion).order_by(IntelSuggestion.created_at))).all()
    existing = {s.locality: s for s in rows if s.status != IntelStatus.DISMISSED}
    seen = {s.locality: {e["link"] for e in s.evidence} for s in rows if s.status == IntelStatus.DISMISSED}
    created, refreshed = [], []
    for name, evidence in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        if prev := existing.get(name):
            links = {e["link"] for e in prev.evidence}
            new = [e for e in evidence if e["link"] not in links]
            if new:
                prev.evidence = [*prev.evidence, *new]
                refreshed.append(prev.id)
            continue
        if not (loc := found["places"].get(name)):
            continue
        if name in seen and all(e["link"] in seen[name] for e in evidence):
            continue
        sug = IntelSuggestion(
            locality=name,
            label=f"{name}: flooding reported in the news",
            longitude=loc.lng,
            latitude=loc.lat,
            radius_m=_cfg()["suggestion_radius_m"],
            location_source=loc.source,
            evidence=evidence,
        )
        session.add(sug)
        await session.flush()
        created.append(sug.id)

    summary = {
        "searches": searches,
        "articles": len(articles),
        "localities": sorted(groups),
        "created": created,
        "refreshed": refreshed,
        "unresolved": found["unresolved"],
    }
    audit.record(
        session,
        actor=INTEL,
        event_type="INTEL_SCAN",
        message=(
            f"SerpApi scan (Google News + Google Search, past 24 h): {len(articles)} recent results, "
            f"{len(groups)} flood-hit localities named, {len(created)} new suggestion(s)"
        ),
        entity_type="intel",
        entity_id="scan",
        output_snapshot=summary,
    )
    audit.emit(session, "intel.updated")
    return summary


def _circle(lng: float, lat: float, radius_m: float) -> dict[str, Any]:
    c = Point(lng, lat).buffer(geo.meters_to_deg(radius_m), 24)
    return mapping(affinity.scale(c, xfact=1 / math.cos(math.radians(lat)), yfact=1.0))


async def _pending(session: AsyncSession, suggestion_id: str) -> IntelSuggestion:
    from app.services.workflow import WorkflowError

    sug = await session.get(IntelSuggestion, suggestion_id)
    if not sug:
        raise WorkflowError("not_found", f"Suggestion {suggestion_id} not found", 404)
    if sug.status != IntelStatus.PENDING:
        raise WorkflowError("invalid_transition", f"Suggestion {suggestion_id} is already {sug.status}")
    return sug


async def accept(
    session: AsyncSession, suggestion_id: str, actor: Actor
) -> tuple[IntelSuggestion, list[str]]:
    """Dispatcher confirms: create + activate a flood zone. Live routes crossing it are rerouted."""
    from app.services import reroute  # reroute → workflow → intel

    sug = await _pending(session, suggestion_id)
    h = Hazard(
        kind=HazardKind.FLOOD_ZONE,
        type="flood",
        label=f"{sug.locality} (news-reported)"[:128],
        geometry=_circle(sug.longitude, sug.latitude, sug.radius_m),
        severity="high",
        active=False,
        source="serpapi_news",
    )
    session.add(h)
    await session.flush()
    sug.status, sug.hazard_id = IntelStatus.ACCEPTED, h.id
    audit.record(
        session,
        actor=actor,
        event_type="INTEL_ACCEPTED",
        message=(
            f"{actor.id} confirmed news-reported flooding at {sug.locality} "
            f"({len(sug.evidence)} SerpApi source(s)) → hazard {h.id}"
        ),
        entity_type="intel",
        entity_id=sug.id,
        input_snapshot={"evidence": sug.evidence},
        output_snapshot={"hazard_id": h.id, "radius_m": sug.radius_m},
    )
    affected = await reroute.set_hazard_active(session, h, True, actor)
    audit.emit(session, "intel.updated")
    return sug, affected


async def dismiss(session: AsyncSession, suggestion_id: str, actor: Actor) -> IntelSuggestion:
    sug = await _pending(session, suggestion_id)
    sug.status = IntelStatus.DISMISSED
    audit.record(
        session,
        actor=actor,
        event_type="INTEL_DISMISSED",
        message=f"{actor.id} dismissed the news-reported flooding at {sug.locality}",
        entity_type="intel",
        entity_id=sug.id,
    )
    audit.emit(session, "intel.updated")
    return sug


async def clear(session: AsyncSession) -> None:
    await session.execute(delete(IntelSuggestion))
