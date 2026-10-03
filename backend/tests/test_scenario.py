"""End-to-end flood_demo in local mode, offline (Mapbox cache only)."""

import asyncio

from tests.conftest import TOOL_HEADERS


async def wait_for(client, pred, timeout=10.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        state = (await client.get("/api/state")).json()
        if pred(state):
            return state
        if asyncio.get_event_loop().time() > deadline:
            raise AssertionError("timed out waiting for state")
        await asyncio.sleep(0.05)


def by_text(state, fragment):
    return next(r for r in state["reports"] if fragment in r["raw_text"])


async def test_full_flood_demo(client):
    r = await client.post("/api/scenario/start", json={"mode": "manual"})
    assert r.status_code == 200, r.text

    # 1. official rescue → auto-dispatch V-04
    await client.post("/api/scenario/next")
    s = await wait_for(client, lambda s: by_text(s, "Riverside")["workflow_status"] == "DISPATCHED")
    rescue = by_text(s, "Riverside")
    assert rescue["workflow_status"] == "DISPATCHED"
    assert rescue["policy_rule"] == "GOV-02"
    a_rescue = next(a for a in s["assignments"] if a["report_id"] == rescue["id"])
    assert a_rescue["volunteer_id"] == "V-04"
    eta_before = a_rescue["route_eta_seconds"]

    # 2. citizen medical → approval required, V-02 rejected for certification
    await client.post("/api/scenario/next")
    s = await wait_for(client, lambda s: by_text(s, "unconscious")["workflow_status"] == "AWAITING_APPROVAL")
    med = by_text(s, "unconscious")
    assert med["workflow_status"] == "AWAITING_APPROVAL" and med["policy_rule"] == "GOV-01"
    a_med = next(a for a in s["assignments"] if a["report_id"] == med["id"])
    cert = next(f for f in a_med["selection"]["funnel"] if f["step"] == "certification")
    assert {"id": "V-02", "reason": "Medical certification missing"} in cert["rejected"]
    assert a_med["volunteer_id"] == "V-05"
    # V-05's fastest route crosses HZ-01 → safe alternative chosen
    cand = next(c for c in a_med["selection"]["candidates"] if c["volunteer_id"] == "V-05")
    assert cand["rejected_routes"] and cand["rejected_routes"][0]["hazard_id"] == "HZ-01"

    # 3. duplicate → merged, no agent run
    await client.post("/api/scenario/next")
    s = await wait_for(client, lambda s: any(r["workflow_status"] == "MERGED" for r in s["reports"]))
    dup = next(r for r in s["reports"] if r["workflow_status"] == "MERGED")
    assert dup["merged_into"] == med["id"]
    assert by_text(s, "unconscious")["duplicate_count"] == 1
    assert s["system"]["stats"]["duplicates_merged"] == 1

    # 4. food → auto (GOV-03), V-06
    await client.post("/api/scenario/next")
    s = await wait_for(client, lambda s: by_text(s, "drinking water")["workflow_status"] == "DISPATCHED")
    food = by_text(s, "drinking water")
    assert food["policy_rule"] == "GOV-03"
    assert next(a for a in s["assignments"] if a["report_id"] == food["id"])["volunteer_id"] == "V-06"

    # 5. vague anonymous → needs review
    await client.post("/api/scenario/next")
    s = await wait_for(client, lambda s: by_text(s, "help water")["workflow_status"] == "NEEDS_REVIEW")
    assert by_text(s, "help water")["policy_rule"] == "UNC-01"

    # approve the medical dispatch
    appr = next(a for a in s["approvals"] if a["report_id"] == med["id"] and a["status"] == "PENDING")
    r = await client.post(f"/api/approvals/{appr['id']}/approve", json={"note": "confirmed by phone"})
    assert r.status_code == 200, r.text
    s = (await client.get("/api/state")).json()
    assert by_text(s, "unconscious")["workflow_status"] == "DISPATCHED"

    # 6. HZ-02 activates → V-04 rerouted, ETA increases
    await client.post("/api/scenario/next")
    s = await wait_for(client, lambda s: next(h for h in s["hazards"] if h["id"] == "HZ-02")["active"])
    a_rescue = next(a for a in s["assignments"] if a["report_id"] == rescue["id"])
    assert a_rescue["status"] == "ACTIVE"
    assert a_rescue["previous_route_geometry"] is not None
    assert a_rescue["previous_eta_seconds"] == eta_before
    assert a_rescue["route_eta_seconds"] > eta_before
    assert s["system"]["scenario_status"] == "done"

    audit = (await client.get(f"/api/audit/{rescue['id']}")).json()
    kinds = [e["event_type"] for e in audit]
    for k in (
        "REPORT_RECEIVED",
        "INTAKE_STRUCTURED",
        "POLICY_EVALUATED",
        "ASSIGNMENT_ACTIVATED",
        "ROUTE_INVALIDATED",
        "ROUTE_RECALCULATED",
    ):
        assert k in kinds, k


async def test_tool_refuses_ineligible_volunteer(client):
    """Governance is enforced by the tool, not by the agent's good behaviour."""
    await client.post("/api/system/mode", json={"mode": "nuroen"})
    r = await client.post(
        "/tools/create-report",
        headers=TOOL_HEADERS,
        json={"text": "Person unconscious near Central Market.", "source": "citizen", "agent": "coordinator"},
    )
    rid = r.json()["report_id"]
    r = await client.post(
        "/tools/submit-intake",
        headers=TOOL_HEADERS,
        json={
            "report_id": rid,
            "need_type": "medical",
            "location_text": "Central Market",
            "people_affected": 1,
            "confidence": 0.85,
            "agent": "intake-agent",
        },
    )
    assert r.json()["needs_review"] is False
    r = await client.post(
        "/tools/submit-triage",
        headers=TOOL_HEADERS,
        json={"report_id": rid, "life_safety": True, "rationale": "unconscious", "agent": "triage-agent"},
    )
    assert r.json()["policy_rule"] == "GOV-01"
    r = await client.post(
        "/tools/propose-assignment",
        headers=TOOL_HEADERS,
        json={"report_id": rid, "volunteer_id": "V-02", "explanation": "closest", "agent": "dispatch-agent"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "policy_blocked"
    assert "certification" in r.json()["detail"]["message"].lower()

    audit = (await client.get(f"/api/audit/{rid}")).json()
    assert any(e["event_type"] == "TOOL_REFUSED" for e in audit)
    assert any(e["actor_id"] == "nuroen:intake-agent" for e in audit)


async def test_tools_require_key(client):
    assert (await client.post("/tools/ping")).status_code == 401
    assert (await client.post("/tools/ping", headers=TOOL_HEADERS)).status_code == 200


async def test_local_cannot_steal_nuroen_report_and_vice_versa(client):
    await client.post("/api/system/mode", json={"mode": "nuroen"})
    r = await client.post(
        "/api/reports",
        json={"text": "Need drinking water for 15 people near Station Road.", "source": "citizen"},
    )
    rid = r.json()["id"]
    assert r.json()["orchestrator"] is None  # waiting for Nuroen pickup
    await client.post(f"/api/reports/{rid}/process-locally")
    r = await client.post("/tools/claim-report", headers=TOOL_HEADERS, json={"report_id": rid})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "report_owned_by_local"
