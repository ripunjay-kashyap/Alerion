"""Per-incident "run sheet" for mirroring a product run into the Nuroen master workflow by hand.

Node ids/names match docs/nuroen/workflow_blueprint.txt (local, git-ignored) (N1…N11), so each payload can be pasted into the
corresponding Nuroen node. Built only from canonical state + audit trail (no recomputation).
"""

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Approval, Assignment, AuditEntry, Volunteer
from app.services import workflow


def _first(entries: list[AuditEntry], event_type: str) -> AuditEntry | None:
    return next((e for e in entries if e.event_type == event_type), None)


async def run_sheet(session: AsyncSession, report_id: str) -> dict[str, Any]:
    r = await workflow.get_report(session, report_id)
    entries = list(
        (
            await session.scalars(
                select(AuditEntry).where(AuditEntry.report_id == r.id).order_by(AuditEntry.seq)
            )
        ).all()
    )
    asg = (
        await session.scalars(
            select(Assignment).where(Assignment.report_id == r.id).order_by(Assignment.created_at)
        )
    ).first()
    approvals = list((await session.scalars(select(Approval).where(Approval.report_id == r.id))).all())
    vol = await session.get(Volunteer, asg.volunteer_id) if asg else None
    nodes: list[dict[str, Any]] = []

    def node(nid: str, name: str, payload: dict[str, Any] | None, note: str = "") -> None:
        nodes.append(
            {"node": nid, "name": name, "reached": payload is not None, "payload": payload, "note": note}
        )

    node("N1", "Trigger: Incident Report", {"report_text": r.raw_text, "source_type": r.source_type})
    if r.merged_into:
        node(
            "N2",
            "Master Disaster Coordinator",
            None,
            f"Duplicate merged into {r.merged_into}: no workflow run.",
        )
        return _finish(r.id, nodes)

    intake = _first(entries, "INTAKE_STRUCTURED")
    node("N3", "Intake Agent", intake.output_snapshot if intake else None)

    review = next((a for a in approvals if a.action_type == "review"), None)
    if intake:
        passed = review is None
        node(
            "N4",
            "Confidence Gate (UNC-01)",
            {"pass": passed, "confidence": r.confidence, "location_resolved": r.latitude is not None}
            | ({} if passed else {"rule": "UNC-01", "reason": r.policy_reason}),
        )
        if not passed:
            node("N4b", "Human Review", {"status": review.status, "reviewed_by": review.approved_by})
            if review.status != "APPROVED":
                return _finish(r.id, nodes)

    triage = _first(entries, "TRIAGE_RECORDED")
    node("N5", "Triage Agent", triage.output_snapshot if triage else None)

    if r.policy_decision and r.policy_decision != "NEEDS_REVIEW":
        node(
            "N6",
            "Governance Agent (trust + policy)",
            {
                "trust_score": r.trust_score,
                "trust_base": (r.trust_breakdown or {}).get("base"),
                "trust_modifiers": (r.trust_breakdown or {}).get("modifiers", []),
                "policy_decision": r.policy_decision,
                "policy_rule": r.policy_rule,
                "reason": r.policy_reason,
                "priority_score": r.priority_score,
                "priority_breakdown": r.priority_breakdown,
            },
        )
        node("N7", "Policy Branch", {"branch": r.policy_decision})
        dispatch_appr = next((a for a in approvals if a.action_type == "dispatch"), None)
        if r.policy_decision == "APPROVAL_REQUIRED":
            node(
                "N8",
                "Approval Gate: Dispatcher",
                {
                    "status": dispatch_appr.status if dispatch_appr else "PENDING",
                    "rule": r.policy_rule,
                    "approved_by": dispatch_appr.approved_by if dispatch_appr else None,
                    "note": dispatch_appr.resolution_note if dispatch_appr else None,
                }
                if dispatch_appr
                else None,
            )
    else:
        node("N6", "Governance Agent (trust + policy)", None)

    if asg and vol:
        rejected = [rej for step in (asg.selection or {}).get("funnel", []) for rej in step["rejected"]]
        node(
            "N9",
            "Dispatch Agent",
            {
                "volunteer_id": vol.id,
                "callsign": vol.callsign,
                "rejected": rejected,
                "explanation": asg.explanation,
                "eta_minutes": round((asg.route_eta_seconds or 0) / 60, 1),
            },
        )
        notified = _first(entries, "NOTIFICATION_SENT")
        node(
            "N10",
            "Slack: #dispatch notice",
            {
                "message": f"🚨 DISPATCH {vol.id} → {r.need_type} at {r.location_text} | {r.policy_rule} | "
                f"{asg.explanation}"
            }
            if notified
            else None,
            "" if notified else "Not sent yet (awaiting approval).",
        )
        reroutes = [e for e in entries if e.event_type == "ROUTE_RECALCULATED"]
        node(
            "N11",
            "Output: Dispatch Decision",
            {
                "need_type": r.need_type,
                "location_text": r.location_text,
                "policy_rule": r.policy_rule,
                "approval": next(
                    (a.status for a in approvals if a.action_type == "dispatch"), "not required"
                ),
                "volunteer_id": vol.id,
                "assignment_status": asg.status,
                "explanation": asg.explanation,
                "reroutes": [e.message for e in reroutes],
            },
        )
    return _finish(r.id, nodes)


def _finish(report_id: str, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    lines = [f"NUROEN RUN SHEET — {report_id}", "=" * 40]
    for n in nodes:
        lines.append(f"\n[{n['node']}] {n['name']}" + ("" if n["reached"] else "  (not reached)"))
        if n["payload"] is not None:
            lines.append(json.dumps(n["payload"], indent=2, ensure_ascii=False))
        if n["note"]:
            lines.append(f"note: {n['note']}")
    return {"report_id": report_id, "nodes": nodes, "text": "\n".join(lines)}
