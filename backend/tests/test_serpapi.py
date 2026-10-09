"""SerpApi evidence layer, offline. `serpapi.search` is replaced with canned Google Maps / News / Search
responses, so everything above it (location fallback, news corroboration, trust cap, scan → accept / dismiss)
runs for real. The client tests at the bottom use an httpx mock transport, never the network."""

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.models import Report
from app.services import geo, intel, policy, serpapi

ANIL_NAGAR = {"latitude": 26.1745, "longitude": 91.7860}


def _ago(hours: float) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def fake_responses(engine: str, params: dict) -> dict:
    q = params.get("q", "")
    if engine == "google_maps":
        if q.startswith("hospital"):
            return {
                "local_results": [
                    {
                        "title": "Far Closed Clinic",
                        "gps_coordinates": {"latitude": 26.15, "longitude": 91.70},
                        "open_state": "Closed ⋅ Opens 9 AM",
                    },
                    {
                        "title": "Near Open Hospital",
                        "gps_coordinates": {"latitude": 26.175, "longitude": 91.787},
                        "open_state": "Open 24 hours",
                        "phone": "+91 361 000 0000",
                    },
                    {
                        "title": "Out Of Town Hospital",
                        "gps_coordinates": {"latitude": 25.0, "longitude": 90.0},
                        "open_state": "Open 24 hours",
                    },
                ]
            }
        if "anil nagar" in q.lower():
            return {
                "place_results": {
                    "title": "Anil Nagar",
                    "address": "Anil Nagar, Guwahati, Assam",
                    "type": "Neighborhood",
                    "place_id": "ChIJ-anil",
                    "gps_coordinates": ANIL_NAGAR,
                }
            }
        if "kamakhya" in q.lower():
            return {
                "local_results": [
                    {"title": "Some Hotel", "gps_coordinates": {"latitude": 26.16, "longitude": 91.70}},
                    {
                        "title": "Kamakhya Temple Main Gate",
                        "address": "Nilachal Hill, Guwahati",
                        "place_id": "ChIJ-kam",
                        "gps_coordinates": {"latitude": 26.1665, "longitude": 91.7055},
                    },
                ]
            }
        return {
            "local_results": [
                {"title": "Unrelated Mall", "gps_coordinates": {"latitude": 26.16, "longitude": 91.76}}
            ]
        }
    if engine == "google_news":
        if "Anil Nagar" in q:
            return {
                "news_results": [
                    {
                        "title": "Anil Nagar waterlogged again after overnight rain",
                        "link": "https://news.example/1",
                        "source": {"name": "Assam Tribune"},
                        "iso_date": _ago(2),
                    },
                    {
                        "title": "Anil Nagar flood: residents stranded",
                        "link": "https://news.example/old",
                        "source": {"name": "Old News"},
                        "iso_date": _ago(72),
                    },  # outside the 24 h window
                    {
                        "title": "Anil Nagar market reopens",
                        "link": "https://news.example/3",
                        "source": {"name": "Sentinel"},
                        "iso_date": _ago(1),
                    },  # no flood term
                ]
            }
        if q == intel.SCAN_NEWS_QUERY:
            return {
                "news_results": [
                    {
                        "title": "Heavy rain: Anil Nagar and Zoo Road waterlogged",
                        "link": "https://news.example/scan1",
                        "source": {"name": "NE Now"},
                        "iso_date": _ago(3),
                    },
                ]
            }
        return {"news_results": []}
    if engine == "google":
        return {
            "organic_results": [
                {
                    "title": "Guwahati: Anil Nagar under knee-deep water",
                    "link": "https://web.example/a",
                    "snippet": "Flooding in Anil Nagar again",
                    "source": "Pratidin Time",
                },
            ]
        }
    raise AssertionError(engine)


@pytest.fixture
def serp(monkeypatch):
    calls = []

    async def fake(engine, params, **_):
        calls.append((engine, params.get("q")))
        return fake_responses(engine, params)

    monkeypatch.setattr(serpapi, "search", fake)
    return calls


async def wait_for(client, pred, timeout=10.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        state = (await client.get("/api/state")).json()
        if pred(state):
            return state
        if asyncio.get_event_loop().time() > deadline:
            raise AssertionError("timed out waiting for state")
        await asyncio.sleep(0.05)


# ---------------------------------------------------------------- policy


def test_news_never_verifies_a_report():
    plain = policy.compute_trust("citizen", news_articles=1)
    assert plain.score == 0.65 and plain.verification_status == "unverified"
    # citizen + duplicate (0.70) + news would be 0.80 → capped at 0.79, so GOV-02 can't fire on news
    capped = policy.compute_trust("citizen", corroborations=1, news_articles=2)
    assert capped.score == 0.79 and capped.verification_status == "unverified"
    assert "capped" in capped.breakdown["modifiers"][-1]["label"]
    assert policy.evaluate_dispatch(life_safety=True, trust_score=capped.score).rule_id == "GOV-01"
    # already verified without news: unchanged
    assert (
        policy.compute_trust("citizen", corroborations=1, in_incident_zone=True, news_articles=1).score
        == 0.80
    )
    # anonymous lifts out of low_trust
    assert policy.compute_trust("anonymous", news_articles=1).verification_status == "unverified"


# ---------------------------------------------------------------- location


async def test_google_maps_resolves_landmarks_mapbox_cannot(serp):
    loc = await geo.resolve("behind Kamakhya temple gate", "")
    assert loc and loc.source == "google_maps" and loc.evidence["place_id"] == "ChIJ-kam"
    assert loc.confidence == 0.8
    # Google's top hit doesn't share a distinctive word with the report → not trusted
    assert await geo.resolve("Rongpur bylane", "") is None


async def test_serpapi_unavailable_is_neutral(monkeypatch):
    async def down(engine, params, **_):
        raise serpapi.SerpApiUnavailable("offline")

    monkeypatch.setattr(serpapi, "search", down)
    assert await geo.resolve("behind Kamakhya temple gate", "") is None
    news = await intel.news_corroboration("Anil Nagar")
    assert news["available"] is False and news["articles"] == []


# ---------------------------------------------------------------- pipeline


async def test_citizen_report_gets_news_and_maps_evidence(client, serp):
    r = await client.post(
        "/api/reports",
        json={
            "text": "Water rising fast near Anil Nagar, 4 people stuck on the roof, need rescue",
            "source": "citizen",
        },
    )
    rid = r.json()["id"]
    s = await wait_for(client, lambda s: next(x for x in s["reports"] if x["id"] == rid)["policy_rule"])
    rep = next(x for x in s["reports"] if x["id"] == rid)
    news = rep["trust_breakdown"]["_news"]
    assert [a["link"] for a in news["articles"]] == ["https://news.example/1"]  # old + off-topic filtered out
    assert any(m.get("source") == "serpapi" for m in rep["trust_breakdown"]["modifiers"])
    assert rep["trust_breakdown"]["_location"] == {
        "source": "google_maps",
        "place": {
            "title": "Anil Nagar",
            "address": "Anil Nagar, Guwahati, Assam",
            "type": "Neighborhood",
            "place_id": "ChIJ-anil",
        },
    }
    assert rep["policy_rule"] == "GOV-01"  # life-safety from a citizen still needs a human

    events = {e["event_type"]: e for e in (await client.get(f"/api/audit/{rid}")).json()}
    assert "Google Maps (SerpApi)" in events["LOCATION_RESOLVED"]["message"]
    assert events["NEWS_CORROBORATION"]["actor_id"] == "serpapi-intel"

    fac = (await client.get(f"/api/reports/{rid}/facilities")).json()
    assert fac["available"] and fac["query"] == "hospital"


async def test_facilities_open_first_and_in_area(client, serp):
    report = Report(
        raw_text="x", source_type="citizen", need_type="medical", latitude=26.1745, longitude=91.786
    )
    out = await intel.facilities(report)
    assert [p["title"] for p in out["results"]] == ["Near Open Hospital", "Far Closed Clinic"]
    assert out["results"][0]["open_now"] is True and out["results"][1]["open_now"] is False
    # food: Google Maps has no real relief camps outside a disaster, so no lookup (and no search spent)
    calls = len(serp)
    food = Report(raw_text="x", source_type="citizen", need_type="food", latitude=26.1745, longitude=91.786)
    assert (await intel.facilities(food))["available"] is False and len(serp) == calls


# ---------------------------------------------------------------- scan → accept


async def test_scan_suggests_zones_and_accept_activates_hazard(client, serp):
    body = (await client.post("/api/intel/scan")).json()
    assert {e["engine"] for e in body["searches"]} == {"google_news", "google"}
    assert body["localities"] == ["Anil Nagar", "Zoo Road"]
    anil = next(x for x in body["suggestions"] if x["locality"] == "Anil Nagar")
    assert len(anil["evidence"]) == 2 and anil["location_source"] == "google_maps"
    assert "Zoo Road" in body["unresolved"]  # Google's answer didn't match the name → no guessed polygon

    # a rescan adds nothing new
    again = (await client.post("/api/intel/scan")).json()
    assert again["created"] == [] and again["refreshed"] == []

    res = (await client.post(f"/api/intel/suggestions/{anil['id']}/accept")).json()
    hz = res["hazard"]
    assert hz["active"] and hz["source"] == "serpapi_news" and hz["geometry"]["type"] == "Polygon"
    assert (await client.post(f"/api/intel/suggestions/{anil['id']}/accept")).status_code == 409

    state = (await client.get("/api/state")).json()
    assert state["intel_suggestions"][0]["status"] == "accepted"
    audit = (await client.get(f"/api/audit/{anil['id']}")).json()
    assert {e["event_type"] for e in audit} == {"INTEL_ACCEPTED"}

    await client.post("/api/scenario/reset")
    assert (await client.get("/api/intel/suggestions")).json() == []


async def test_dismissed_zone_stays_dismissed_until_new_sources(client, serp, monkeypatch):
    body = (await client.post("/api/intel/scan")).json()
    anil = next(x for x in body["suggestions"] if x["locality"] == "Anil Nagar")
    assert (await client.post(f"/api/intel/suggestions/{anil['id']}/dismiss")).json()["status"] == "dismissed"
    assert (await client.post(f"/api/intel/suggestions/{anil['id']}/accept")).status_code == 409

    again = (await client.post("/api/intel/scan")).json()  # same articles → not proposed again
    assert again["created"] == [] and all(x["locality"] != "Anil Nagar" for x in again["suggestions"])

    def with_new_article(engine, params):
        data = fake_responses(engine, params)
        if engine == "google_news" and params.get("q") == intel.SCAN_NEWS_QUERY:
            data["news_results"].append(
                {"title": "Anil Nagar flooded again", "link": "https://news.example/new", "iso_date": _ago(1)}
            )
        return data

    async def fake(engine, params, **_):
        return with_new_article(engine, params)

    monkeypatch.setattr(serpapi, "search", fake)
    fresh = (await client.post("/api/intel/scan")).json()
    assert len(fresh["created"]) == 1 and fresh["suggestions"][0]["locality"] == "Anil Nagar"


async def test_status_reports_mode_without_key(client):
    st = (await client.get("/api/intel/status")).json()
    assert st["provider"] == "SerpApi" and st["key_configured"] is False and st["account"] is None


async def test_cache_layer_serves_disk_cache_offline(monkeypatch, tmp_path):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "seed_dir", tmp_path)
    monkeypatch.setattr(serpapi, "_memo", {})
    params = {"q": "Anil Nagar flood", "gl": "in", "hl": "en"}
    with pytest.raises(serpapi.SerpApiUnavailable):
        await serpapi.search("google_news", params)  # cache_only + miss
    serpapi._cache_path("google_news", params).write_text('{"news_results": [{"title": "t", "link": "l"}]}')
    before = serpapi.usage.cached
    assert (await serpapi.news_search("Anil Nagar flood"))[0]["link"] == "l"
    assert serpapi.usage.cached == before + 1


# ---------------------------------------------------------------- client: errors, freshness, failures


@pytest.fixture
def live_client(monkeypatch, tmp_path):
    """serpapi._fetch against an httpx mock transport, in cache_first mode with a (fake) key."""
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "seed_dir", tmp_path)
    monkeypatch.setattr(settings, "serpapi_mode", "cache_first")
    monkeypatch.setattr(settings, "serpapi_key", "SECRET-KEY-123")
    monkeypatch.setattr(serpapi, "_memo", {})
    calls: list[httpx.Request] = []
    responses: list[httpx.Response] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return responses.pop(0)

    monkeypatch.setattr(serpapi, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return calls, responses


async def test_errors_never_carry_the_api_key(live_client, caplog):
    calls, responses = live_client
    responses.append(httpx.Response(401, json={"error": "Invalid API key."}))
    with pytest.raises(serpapi.SerpApiUnavailable) as e:
        await serpapi.news_search("Anil Nagar flood")
    assert str(e.value) == "HTTP 401: Invalid API key."
    assert "SECRET-KEY-123" in str(calls[0].url)  # it was sent...
    assert "SECRET-KEY-123" not in caplog.text  # ...but never logged
    assert e.value.__cause__ is None and e.value.__suppress_context__  # nor chained into a traceback

    # the failure is remembered: the locked pipeline step doesn't hit the network again
    with pytest.raises(serpapi.SerpApiUnavailable):
        await serpapi.news_search("Anil Nagar flood")
    assert len(calls) == 1

    # facilities and news report the safe message to the API
    report = Report(
        raw_text="x", source_type="citizen", need_type="medical", latitude=26.1745, longitude=91.786
    )
    responses.append(httpx.Response(429, json={"error": "Your account has run out of searches."}))
    out = await intel.facilities(report)
    assert (
        out["available"] is False and "SECRET" not in out["reason"] and out["reason"].startswith("HTTP 429")
    )


async def test_stale_news_is_refetched_and_failures_fall_back_to_it(live_client):
    calls, responses = live_client
    params = {"q": "Anil Nagar flood", "gl": "in", "hl": "en"}
    path = serpapi._cache_path("google_news", params)
    stale = {"news_results": [{"title": "old", "link": "old"}], "_fetched_at": time.time() - 2 * 3600}
    path.write_text(json.dumps(stale))

    # the pipeline gets the stale copy at once and the refresh runs in the background...
    responses.append(httpx.Response(200, json={"news_results": [{"title": "new", "link": "new"}]}))
    assert [a["link"] for a in await serpapi.news_search("Anil Nagar flood")] == ["old"]
    await asyncio.gather(*serpapi._refreshing.values())
    assert json.loads(path.read_text())["_fetched_at"] > time.time() - 60
    assert [a["link"] for a in await serpapi.news_search("Anil Nagar flood")] == ["new"]  # memo updated

    # ...while a dispatcher's scan waits for fresh results
    path.write_text(json.dumps(stale))
    serpapi._memo.clear()
    responses.append(httpx.Response(200, json={"news_results": [{"title": "newer", "link": "newer"}]}))
    assert [a["link"] for a in await serpapi.news_search("Anil Nagar flood", fresh=True)] == ["newer"]

    # maps results don't go stale; time-bounded ones do, and a failed refresh serves the stale copy
    serpapi._memo.clear()
    path.write_text(json.dumps(stale))
    responses.append(httpx.Response(500, text="boom"))
    assert [a["link"] for a in await serpapi.news_search("Anil Nagar flood", fresh=True)] == ["old"]
    assert len(calls) == 3


def test_stale_web_results_are_not_recent():
    hour = 3600
    assert intel._recent({"engine": "google", "fetched_at": time.time() - hour})
    assert not intel._recent({"engine": "google", "fetched_at": time.time() - 30 * hour})


def test_policy_refuses_a_news_cap_that_could_verify(monkeypatch, tmp_path):
    import yaml

    from app.config import get_settings

    cfg = yaml.safe_load(get_settings().policy_path.read_text())
    cfg["trust"]["news_max_score"] = 0.8
    bad = tmp_path / "policy.yaml"
    bad.write_text(yaml.safe_dump(cfg))
    monkeypatch.setattr(get_settings(), "policy_path", bad)
    policy.config.cache_clear()
    try:
        with pytest.raises(ValueError, match="news_max_score"):
            policy.config()
    finally:
        policy.config.cache_clear()
