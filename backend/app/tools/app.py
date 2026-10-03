"""Nuroen-facing tool surface (mounted at /tools, own OpenAPI at /tools/openapi.json).

Design rules:
  - one narrow POST per step, flat JSON bodies, bearer-key auth;
  - every body accepts optional `agent` + `run_id` (recorded in the audit trail);
  - tools return `next_step` hints so the agent flow stays on the rails;
  - safety-critical decisions are made here, deterministically. A refusal (HTTP 409) is final.
"""

from datetime import timedelta
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.config import get_settings
from app.models import (
    Approval,
    ApprovalStatus,
    Assignment,
    Hazard,
    Orchestrator,
    Report,
    ReportStatus,
    Volunteer,
    VolunteerStatus,
)
from app.schemas import IntakeData, SourceType, TriageData
from app.services import audit, policy, reroute, routing, safety, workflow
from app.services.uow import unit_of_work
from app.services.workflow import WorkflowError


async def require_tool_key(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {get_settings().tools_api_key}":
        raise HTTPException(status_code=401, detail="invalid tool key")


tools_app = FastAPI(
    title="Disaster Relief Router — Agent Tools",
    version="1.0.0",
    description=(
        "Deterministic execution and safety tools for the Disaster Relief Router agents (Guwahati flood response). "
        "Typical flow per incident: list_pending_reports → claim_report → submit_intake → submit_triage → "
        "get_eligible_volunteers → propose_assignment. Priority, trust, eligibility, route safety and approval "
        "requirements are computed by these tools; agents must never override a tool refusal (HTTP 409)."
    ),
    dependencies=[Depends(require_tool_key)],
)


@tools_app.exception_handler(WorkflowError)
async def _workflow_error(_: Request, exc: WorkflowError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": exc.detail()})


class AgentContext(BaseModel):
    agent: str | None = Field(
        None, description="Calling agent name, e.g. 'intake-agent'", examples=["intake-agent"]
    )
    run_id: str | None = Field(None, description="Nuroen run / conversation id if available")

    def actor(self, default_agent: str) -> audit.Actor:
        return audit.nuroen(self.agent or default_agent, self.run_id)


class ReportRef(AgentContext):
    report_id: str = Field(description="Incident id, e.g. INC-3F9A21", examples=["INC-3F9A21"])


class CreateReportIn(AgentContext):
    text: str = Field(min_length=3, max_length=2000, description="Raw report text exactly as received")
    source: SourceType = Field(
        SourceType.CITIZEN, description="official | verified_operator | citizen | anonymous"
    )
    source_identifier: str | None = None


class SubmitIntakeIn(ReportRef, IntakeData):
    pass


class SubmitTriageIn(ReportRef, TriageData):
    pass


class ProposeIn(ReportRef):
    volunteer_id: str = Field(
        description="Must be a candidate with safe=true from get_eligible_volunteers", examples=["V-04"]
    )
    explanation: str = Field(
        max_length=300, description="1–2 sentence operator-facing reason for this choice"
    )


class RouteIn(ReportRef):
    volunteer_id: str = Field(examples=["V-04"])


class AssignmentRef(AgentContext):
    assignment_id: str = Field(examples=["ASG-1A2B3C"])


class ReviewIn(ReportRef):
    reason: str = Field(max_length=300, description="What is missing or unclear")


class PolicyNoteIn(ReportRef):
    message: str = Field(max_length=500)


def _report_brief(r: Report) -> dict[str, Any]:
    return {
        "report_id": r.id,
        "raw_text": r.raw_text,
        "source_type": r.source_type,
        "workflow_status": r.workflow_status,
        "orchestrator": r.orchestrator,
        "need_type": r.need_type,
        "location_text": r.location_text,
        "trust_score": r.trust_score,
        "priority_score": r.priority_score,
        "policy_decision": r.policy_decision,
        "policy_rule": r.policy_rule,
    }


# ------------------------------------------------------------------ discovery


@tools_app.post("/ping", operation_id="ping", summary="Connectivity check")
async def ping() -> dict:
    return {"ok": True, "service": "disaster-relief-router"}


@tools_app.post(
    "/list-pending-reports",
    operation_id="list_pending_reports",
    summary="List incident reports waiting to be processed",
    description="Returns reports that no one has processed yet (or that Nuroen started but has not finished). "
    "Process them highest-urgency first by calling claim_report then submit_intake.",
)
async def list_pending_reports(body: AgentContext | None = None) -> dict:
    async with unit_of_work() as s:
        q = (
            select(Report)
            .where(
                Report.workflow_status.in_(
                    [
                        ReportStatus.RECEIVED,
                        ReportStatus.STRUCTURING,
                        ReportStatus.STRUCTURED,
                        ReportStatus.TRIAGED,
                    ]
                ),
                (Report.orchestrator.is_(None)) | (Report.orchestrator == Orchestrator.NUROEN),
            )
            .order_by(Report.created_at)
        )
        reports = (await s.scalars(q)).all()
        return {
            "count": len(reports),
            "reports": [_report_brief(r) for r in reports],
            "next_step": "claim_report for each, then submit_intake" if reports else "nothing to do",
        }


@tools_app.post(
    "/get-incident", operation_id="get_incident", summary="Get one incident report with its current state"
)
async def get_incident(body: ReportRef) -> dict:
    async with unit_of_work() as s:
        r = await workflow.get_report(s, body.report_id)
        asg = await workflow.open_assignment(s, r.id)
        return {
            **_report_brief(r),
            "people_affected": r.people_affected,
            "medical_context": r.medical_context,
            "urgency_clues": r.urgency_clues,
            "triage_evidence": r.triage_evidence,
            "assignment": {"assignment_id": asg.id, "volunteer_id": asg.volunteer_id, "status": asg.status}
            if asg
            else None,
        }


@tools_app.post(
    "/get-operational-state",
    operation_id="get_operational_state",
    summary="Situation summary: open incidents, active hazards, available volunteers, pending approvals",
)
async def get_operational_state(body: AgentContext | None = None) -> dict:
    async with unit_of_work() as s:
        hazards = (await s.scalars(select(Hazard).where(Hazard.active.is_(True)))).all()
        vols = (await s.scalars(select(Volunteer))).all()
        open_reports = await s.scalar(
            select(func.count())
            .select_from(Report)
            .where(Report.workflow_status.not_in([st.value for st in workflow.TERMINAL_REPORT_STATUSES]))
        )
        pending = await s.scalar(
            select(func.count()).select_from(Approval).where(Approval.status == ApprovalStatus.PENDING)
        )
        return {
            "open_incidents": open_reports,
            "pending_human_approvals": pending,
            "active_hazards": [{"hazard_id": h.id, "label": h.label, "kind": h.kind} for h in hazards],
            "volunteers": [
                {"volunteer_id": v.id, "callsign": v.callsign, "status": v.status, "skills": v.skills}
                for v in vols
                if v.available and v.status == VolunteerStatus.IDLE
            ],
        }


# ------------------------------------------------------------------ intake


@tools_app.post(
    "/create-report",
    operation_id="create_report",
    summary="Register a new incident report pasted into chat",
    description="Use when a user gives you a raw report. Returns the new report_id (already claimed by you) "
    "— continue with submit_intake. Near-duplicates of an open incident are merged automatically "
    "(status MERGED): then stop, nothing else to do.",
)
async def create_report(body: CreateReportIn) -> dict:
    actor = body.actor("coordinator")
    async with unit_of_work() as s:
        r = await workflow.ingest_report(
            s, text=body.text, source_type=body.source, source_identifier=body.source_identifier, actor=actor
        )
        if r.workflow_status == ReportStatus.MERGED:
            return {**_report_brief(r), "merged_into": r.merged_into, "next_step": "stop — duplicate merged"}
        r.orchestrator = Orchestrator.NUROEN
        r.lease_until = workflow._now() + timedelta(seconds=get_settings().nuroen_lease_extend_s)
        return {**_report_brief(r), "next_step": "call submit_intake with your structured extraction"}


@tools_app.post(
    "/claim-report",
    operation_id="claim_report",
    summary="Claim a pending report so only you process it",
    description="Fails with 409 report_owned_by_local if the local fallback already took it — then skip it.",
)
async def claim_report(body: ReportRef) -> dict:
    async with unit_of_work() as s:
        r = await workflow.get_report(s, body.report_id)
        await workflow.ensure_can_act(s, r, body.actor("coordinator"))
        if r.workflow_status == ReportStatus.RECEIVED:
            r.workflow_status = ReportStatus.STRUCTURING
            audit.emit(s, "report.updated", report_id=r.id)
        return {**_report_brief(r), "next_step": "call submit_intake"}


@tools_app.post(
    "/submit-intake",
    operation_id="submit_intake",
    summary="Intake Agent: submit the structured extraction of a raw report",
    description="Extract need_type (rescue|medical|food), location_text, people_affected, urgency_clues, "
    "medical_context, confidence and ambiguities. NEVER invent facts — use null and list the ambiguity. "
    "The backend resolves coordinates and computes trust. If needs_review=true, STOP: a human will review.",
)
async def submit_intake(body: SubmitIntakeIn) -> dict:
    data = IntakeData(**body.model_dump(include=set(IntakeData.model_fields)))
    async with unit_of_work() as s:
        return await workflow.submit_intake(s, body.report_id, data, body.actor("intake-agent"))


# ------------------------------------------------------------------ triage


@tools_app.post(
    "/submit-triage",
    operation_id="submit_triage",
    summary="Triage Agent: submit urgency evidence; returns the deterministic priority and policy decision",
    description="Provide life_safety, vulnerabilities (elderly|child|pregnant|disabled|medical_dependency), "
    "escalation_signals and a short rationale. You do NOT set the priority — the backend scores it and "
    "evaluates governance policy (e.g. GOV-01: life-safety from an unverified source needs human approval).",
)
async def submit_triage(body: SubmitTriageIn) -> dict:
    data = TriageData(**body.model_dump(include=set(TriageData.model_fields)))
    async with unit_of_work() as s:
        return await workflow.submit_triage(s, body.report_id, data, body.actor("triage-agent"))


# ------------------------------------------------------------------ dispatch


@tools_app.post(
    "/get-eligible-volunteers",
    operation_id="get_eligible_volunteers",
    summary="Dispatch Agent: deterministic eligibility funnel + safe-route candidates ranked by ETA",
    description="Filters availability, skill, medical certification, vehicle, then checks real routes against "
    "active flood zones/blocked roads. Returns `selected` (recommended) and `candidates`. Only a candidate "
    "with safe=true can be assigned.",
)
async def get_eligible_volunteers(body: ReportRef) -> dict:
    async with unit_of_work() as s:
        return await workflow.eligible_volunteers(s, body.report_id, body.actor("dispatch-agent"))


@tools_app.post(
    "/get-route",
    operation_id="get_route",
    summary="Get the safest route for one volunteer to an incident (read-only)",
)
async def get_route(body: RouteIn) -> dict:
    async with unit_of_work() as s:
        r = await workflow.get_report(s, body.report_id)
        v = await s.get(Volunteer, body.volunteer_id)
        if v is None or r.latitude is None:
            raise WorkflowError("not_found", "Unknown volunteer or incident without location", 404)
        search = await routing.find_safe_route(
            (v.longitude, v.latitude), (r.longitude, r.latitude), await workflow.active_hazards(s)
        )
        return {"report_id": r.id, "volunteer_id": v.id, **search.summary()}


@tools_app.post(
    "/check-route-safety",
    operation_id="check_route_safety",
    summary="Re-check an existing assignment's route against current hazards",
)
async def check_route_safety(body: AssignmentRef) -> dict:
    async with unit_of_work() as s:
        asg = await s.get(Assignment, body.assignment_id)
        if asg is None or not asg.route_geometry:
            raise WorkflowError("not_found", f"Assignment {body.assignment_id} not found", 404)
        res = safety.check_route(asg.route_geometry, await workflow.active_hazards(s))
        return {"assignment_id": asg.id, **res.as_dict()}


@tools_app.post(
    "/propose-assignment",
    operation_id="propose_assignment",
    summary="Dispatch Agent: assign a volunteer (re-validated; may require human approval)",
    description="The backend re-checks eligibility and route safety. If policy requires approval the assignment "
    "waits for a human dispatcher (requires_human_approval=true) — that is success, stop there. "
    "A 409 policy_blocked is final: do not retry with the same volunteer.",
)
async def propose_assignment(body: ProposeIn) -> dict:
    async with unit_of_work() as s:
        return await workflow.propose_assignment(
            s, body.report_id, body.volunteer_id, body.explanation, body.actor("dispatch-agent")
        )


@tools_app.post(
    "/reroute-assignment",
    operation_id="reroute_assignment",
    summary="Validate an active route now and reroute it if a hazard intersects it",
)
async def reroute_assignment(body: AssignmentRef) -> dict:
    async with unit_of_work() as s:
        asg = await s.get(Assignment, body.assignment_id)
        if asg is None:
            raise WorkflowError("not_found", f"Assignment {body.assignment_id} not found", 404)
        affected = await reroute.revalidate_routes(s)
        return {
            "assignment_id": asg.id,
            "rerouted": asg.id in affected,
            "status": asg.status,
            "eta_seconds": asg.route_eta_seconds,
        }


# ------------------------------------------------------------------ governance


@tools_app.post(
    "/request-review",
    operation_id="request_review",
    summary="Escalate a report to human review (missing/unclear critical information)",
)
async def request_review(body: ReviewIn) -> dict:
    actor = body.actor("coordinator")
    async with unit_of_work() as s:
        r = await workflow.get_report(s, body.report_id)
        await workflow.ensure_can_act(s, r, actor)
        rule = policy.rule("UNC-01")
        decision = policy.PolicyDecision(rule["outcome"], rule["id"], f"Agent escalation: {body.reason}")
        await workflow._needs_review(s, r, decision)
        return {
            "report_id": r.id,
            "workflow_status": r.workflow_status,
            "next_step": "stop — human review requested",
        }


@tools_app.post(
    "/log-policy-event",
    operation_id="log_policy_event",
    summary="Add an agent note to the audit trail (e.g. why a decision was made)",
)
async def log_policy_event(body: PolicyNoteIn) -> dict:
    async with unit_of_work() as s:
        r = await workflow.get_report(s, body.report_id)
        audit.record(
            s,
            actor=body.actor("coordinator"),
            event_type="AGENT_NOTE",
            message=body.message,
            entity_type="report",
            entity_id=r.id,
            report_id=r.id,
        )
        return {"ok": True}
