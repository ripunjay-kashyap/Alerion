"""End-to-end flood_demo, offline (Mapbox cache only)."""

import asyncio

import pytest

from app.services import audit, workflow
from app.services.intake import extract
from app.services.uow import unit_of_work
from app.services.workflow import WorkflowError


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

    # 3. duplicate → merged, no pipeline run
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

    trail = (await client.get(f"/api/audit/{rescue['id']}")).json()
    kinds = [e["event_type"] for e in trail]
    for k in (
        "REPORT_RECEIVED",
        "INTAKE_STRUCTURED",
        "POLICY_EVALUATED",
        "ASSIGNMENT_ACTIVATED",
        "ROUTE_INVALIDATED",
        "ROUTE_RECALCULATED",
    ):
        assert k in kinds, k


async def test_assignment_refuses_ineligible_volunteer(client):
    """Governance is enforced inside the workflow step, whoever proposes the volunteer."""
    text = "Person unconscious near Central Market."
    async with unit_of_work() as s:
        report = await workflow.ingest_report(
            s, text=text, source_type="citizen", source_identifier=None, actor=audit.DISPATCHER
        )
    intake, triage = extract(text)
    async with unit_of_work() as s:
        res = await workflow.submit_intake(s, report.id, intake, audit.stage("intake"))
    assert res["needs_review"] is False
    async with unit_of_work() as s:
        res = await workflow.submit_triage(s, report.id, triage, audit.stage("triage"))
    assert res["policy_rule"] == "GOV-01"

    with pytest.raises(WorkflowError) as refused:
        async with unit_of_work() as s:
            await workflow.propose_assignment(s, report.id, "V-02", "closest", audit.stage("dispatch"))
    assert refused.value.code == "policy_blocked"
    assert "certification" in refused.value.message.lower()

    trail = (await client.get(f"/api/audit/{report.id}")).json()
    assert any(e["event_type"] == "ASSIGNMENT_REFUSED" for e in trail)
    assert any(e["actor_id"] == "intake-stage" for e in trail)
