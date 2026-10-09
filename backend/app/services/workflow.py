"""Workflow steps. The single implementation behind the report pipeline and the operator API.

Each step:
  - checks the state machine,
  - enforces policy deterministically (no caller can bypass it),
  - writes audit entries with the acting stage, component or human,
  - leaves the commit to the caller's unit of work.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    OPEN_ASSIGNMENT_STATUSES,
    TERMINAL_REPORT_STATUSES,
    Approval,
    ApprovalAction,
    ApprovalStatus,
    Assignment,
    AssignmentStatus,
    Hazard,
    Report,
    ReportStatus,
    SystemState,
    Volunteer,
    VolunteerStatus,
    utcnow,
)
from app.schemas import IntakeData, ReviewCorrections, TriageData
from app.services import audit, geo, intel, policy, routing
from app.services.audit import Actor
from app.services.intake import quick_need


class WorkflowError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status: int = 409,
        policy_rule: str | None = None,
        audit_entry: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code, self.message, self.status, self.policy_rule = code, message, status, policy_rule
        # Written in its own transaction after the rollback, so refusals are always on the record.
        self.audit_entry = audit_entry

    def detail(self) -> dict[str, Any]:
        d: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.policy_rule:
            d["policy_rule"] = self.policy_rule
        return d


def _now() -> datetime:
    return utcnow()


def _aware(dt: datetime | None) -> datetime | None:
    # SQLite returns naive datetimes; Postgres returns aware ones.
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


# ---------------------------------------------------------------- lookups


async def get_report(session: AsyncSession, report_id: str) -> Report:
    r = await session.get(Report, report_id)
    if r is None:
        raise WorkflowError("not_found", f"Report {report_id} not found", 404)
    return r


async def active_hazards(session: AsyncSession) -> list[Hazard]:
    return list((await session.scalars(select(Hazard).where(Hazard.active.is_(True)))).all())


async def open_assignment(session: AsyncSession, report_id: str) -> Assignment | None:
    q = select(Assignment).where(
        Assignment.report_id == report_id, Assignment.status.in_(list(OPEN_ASSIGNMENT_STATUSES))
    )
    return (await session.scalars(q)).first()


async def system_state(session: AsyncSession) -> SystemState:
    s = await session.get(SystemState, 1)
    if s is None:
        s = SystemState(id=1)
        session.add(s)
    return s


def _set_status(session: AsyncSession, report: Report, status: ReportStatus) -> None:
    report.workflow_status = status
    audit.emit(session, "report.updated", report_id=report.id)


def _report_audit(
    session: AsyncSession, report: Report, actor: Actor, event_type: str, message: str, **kw: Any
):
    audit.record(
        session,
        actor=actor,
        event_type=event_type,
        message=message,
        entity_type="report",
        entity_id=report.id,
        report_id=report.id,
        **kw,
    )


# ---------------------------------------------------------------- guards


def ensure_open(report: Report) -> None:
    """Terminal reports (completed, rejected, failed, merged) accept no further workflow steps."""
    if report.workflow_status in TERMINAL_REPORT_STATUSES:
        raise WorkflowError("invalid_transition", f"{report.id} is {report.workflow_status}")


# ---------------------------------------------------------------- ingest (+ cost guard)


async def ingest_report(
    session: AsyncSession, *, text: str, source_type: str, source_identifier: str | None, actor: Actor
) -> Report:
    """Create a report. Near-duplicates of an open incident are merged deterministically (no pipeline run)."""
    cfg = policy.config()["trust"]
    place, need = geo.match_known_place(text), quick_need(text)
    if place and need:
        since = _now() - timedelta(minutes=cfg["corroboration_window_min"])
        q = select(Report).where(
            Report.need_type == need,
            Report.latitude.is_not(None),
            Report.workflow_status.not_in([s.value for s in TERMINAL_REPORT_STATUSES]),
            Report.created_at >= since,
        )
        for parent in (await session.scalars(q)).all():
            same_source = source_identifier and parent.source_identifier == source_identifier
            near = geo.haversine_m((place["lng"], place["lat"]), (parent.longitude, parent.latitude))
            if near <= cfg["corroboration_radius_m"] and not same_source:
                return await _merge_duplicate(
                    session, parent, text, source_type, source_identifier, actor, near
                )

    report = Report(raw_text=text, source_type=source_type, source_identifier=source_identifier)
    state = await system_state(session)
    report.scenario_run_id = state.scenario_run_id
    session.add(report)
    await session.flush()
    _report_audit(
        session,
        report,
        actor,
        "REPORT_RECEIVED",
        f"Report received from {source_type} source",
        input_snapshot={"text": text, "source": source_type, "source_identifier": source_identifier},
    )
    audit.emit(session, "report.created", report_id=report.id)
    return report


async def _merge_duplicate(
    session: AsyncSession,
    parent: Report,
    text: str,
    source_type: str,
    source_identifier: str | None,
    actor: Actor,
    distance_m: float,
) -> Report:
    dup = Report(
        raw_text=text,
        source_type=source_type,
        source_identifier=source_identifier,
        workflow_status=ReportStatus.MERGED,
        merged_into=parent.id,
        need_type=parent.need_type,
        location_text=parent.location_text,
        latitude=parent.latitude,
        longitude=parent.longitude,
    )
    session.add(dup)
    await session.flush()
    parent.duplicate_count = (parent.duplicate_count or 0) + 1
    if parent.trust_score is not None:
        t = policy.compute_trust(
            parent.source_type,
            corroborations=parent.duplicate_count,
            in_incident_zone=bool((parent.trust_breakdown or {}).get("_incident_zone")),
            location_confidence=parent.location_confidence,
            news_articles=len(((parent.trust_breakdown or {}).get("_news") or {}).get("articles") or []),
        )
        old = parent.trust_score
        parent.trust_score, parent.verification_status = t.score, t.verification_status
        parent.trust_breakdown = {
            **t.breakdown,
            "_incident_zone": (parent.trust_breakdown or {}).get("_incident_zone"),
            "_news": (parent.trust_breakdown or {}).get("_news"),
            "_location": (parent.trust_breakdown or {}).get("_location"),
        }
        trust_note = f" Trust {old:.2f} → {t.score:.2f} (corroboration)."
    else:
        trust_note = ""
    msg = f"Duplicate of {parent.id} ({distance_m:.0f} m away, same need) — merged, no pipeline run spent."
    _report_audit(session, dup, actor, "REPORT_MERGED", msg, output_snapshot={"merged_into": parent.id})
    _report_audit(
        session,
        parent,
        actor,
        "REPORT_MERGED",
        f"Corroborated by {dup.id} from {source_type} source.{trust_note}",
        output_snapshot={"duplicate": dup.id, "duplicate_count": parent.duplicate_count},
    )
    audit.emit(session, "report.created", report_id=dup.id)
    audit.emit(session, "report.updated", report_id=parent.id)
    return dup


# ---------------------------------------------------------------- intake


async def submit_intake(
    session: AsyncSession, report_id: str, data: IntakeData, actor: Actor
) -> dict[str, Any]:
    report = await get_report(session, report_id)
    ensure_open(report)
    if report.workflow_status not in {ReportStatus.RECEIVED, ReportStatus.STRUCTURED}:
        raise WorkflowError("invalid_transition", f"Intake not allowed in state {report.workflow_status}")

    report.need_type = data.need_type
    report.location_text = data.location_text
    report.people_affected = data.people_affected
    report.urgency_clues = data.urgency_clues
    report.medical_context = data.medical_context
    report.confidence = data.confidence
    report.ambiguities = data.ambiguities
    _report_audit(
        session,
        report,
        actor,
        "INTAKE_STRUCTURED",
        f"Structured as {data.need_type or 'unknown need'} at '{data.location_text or 'unknown location'}'"
        f" (confidence {data.confidence:.2f})",
        input_snapshot={"raw_text": report.raw_text},
        output_snapshot=data.model_dump(),
    )

    loc = await geo.resolve(data.location_text, report.raw_text)
    if loc:
        report.latitude, report.longitude, report.location_confidence = loc.lat, loc.lng, loc.confidence
        report.location_text = data.location_text or loc.name
        _report_audit(
            session,
            report,
            actor,
            "LOCATION_RESOLVED",
            f"Location resolved to {loc.name} via "
            f"{'Google Maps (SerpApi)' if loc.source == 'google_maps' else loc.source}"
            f" (confidence {loc.confidence:.2f})",
            output_snapshot={"lng": loc.lng, "lat": loc.lat, "source": loc.source, "place": loc.evidence},
        )
    else:
        report.latitude = report.longitude = None
        report.location_confidence = None

    news = await _news_evidence(session, report, loc, data.location_text)
    t = policy.compute_trust(
        report.source_type,
        corroborations=report.duplicate_count or 0,
        in_incident_zone=bool(loc and loc.incident_zone),
        location_confidence=report.location_confidence,
        news_articles=len(news["articles"]) if news else 0,
    )
    report.trust_score, report.verification_status = t.score, t.verification_status
    report.trust_breakdown = {
        **t.breakdown,
        "_incident_zone": bool(loc and loc.incident_zone),
        "_news": news,
        "_location": {"source": loc.source, "place": loc.evidence} if loc else None,
    }
    _report_audit(
        session,
        report,
        audit.POLICY,
        "TRUST_EVALUATED",
        f"Trust {t.score:.2f} ({t.verification_status}) — base {t.breakdown['base']:.2f} for {report.source_type}",
        output_snapshot=t.breakdown,
    )

    unc = policy.check_uncertainty(data.confidence, loc is not None, report.location_confidence)
    if unc or data.need_type is None:
        decision = unc or policy.PolicyDecision(
            "NEEDS_REVIEW", "UNC-01", policy.rule("UNC-01")["reason"] + " (need type unclear)"
        )
        await _needs_review(session, report, decision)
        return {
            "report_id": report.id,
            "needs_review": True,
            "policy_rule": decision.rule_id,
            "reason": decision.reason,
        }

    _set_status(session, report, ReportStatus.STRUCTURED)
    return {
        "report_id": report.id,
        "needs_review": False,
        "location": {"name": report.location_text, "lng": report.longitude, "lat": report.latitude},
        "trust_score": t.score,
        "verification_status": t.verification_status,
    }


async def _news_evidence(
    session: AsyncSession, report: Report, loc: geo.ResolvedLocation | None, location_text: str | None
) -> dict[str, Any] | None:
    """SerpApi Google News check for reports that are not already verified by their source."""
    if not loc or not intel.needs_news(report.source_type):
        return None
    news = await intel.news_corroboration(intel.locality_for(loc, location_text))
    if not news["available"]:
        return None  # no key / offline: skip silently, absence of evidence is neutral
    n = len(news["articles"])
    audit.record(
        session,
        actor=intel.INTEL,
        event_type="NEWS_CORROBORATION",
        message=(
            f"Google News via SerpApi: {n} recent article(s) report flooding at this locality"
            if n
            else "Google News via SerpApi: no recent coverage of this locality (neutral)"
        ),
        entity_type="report",
        entity_id=report.id,
        report_id=report.id,
        input_snapshot={"query": news["query"]},
        output_snapshot={"articles": news["articles"]},
    )
    return news


async def _needs_review(session: AsyncSession, report: Report, decision: policy.PolicyDecision) -> None:
    report.policy_decision, report.policy_rule, report.policy_reason = (
        decision.outcome,
        decision.rule_id,
        decision.reason,
    )
    _set_status(session, report, ReportStatus.NEEDS_REVIEW)
    _report_audit(
        session, report, audit.POLICY, "NEEDS_REVIEW", decision.reason, policy_rule=decision.rule_id
    )
    await _request_approval(session, report, None, ApprovalAction.REVIEW, decision.reason, decision.rule_id)


async def _request_approval(
    session: AsyncSession,
    report: Report,
    assignment: Assignment | None,
    action: ApprovalAction,
    reason: str,
    rule_id: str | None,
) -> Approval:
    appr = Approval(
        report_id=report.id,
        assignment_id=assignment.id if assignment else None,
        action_type=action,
        reason=reason,
        policy_rule=rule_id,
        requested_by=audit.POLICY.id,
    )
    session.add(appr)
    await session.flush()
    audit.record(
        session,
        actor=audit.POLICY,
        event_type="APPROVAL_REQUESTED",
        message=f"{action.value.upper()} approval required: {reason}",
        entity_type="approval",
        entity_id=appr.id,
        report_id=report.id,
        policy_rule=rule_id,
    )
    audit.emit(session, "approval.updated", report_id=report.id, approval_id=appr.id)
    return appr


# ---------------------------------------------------------------- triage


async def submit_triage(
    session: AsyncSession, report_id: str, data: TriageData, actor: Actor
) -> dict[str, Any]:
    report = await get_report(session, report_id)
    ensure_open(report)
    if report.workflow_status not in {ReportStatus.STRUCTURED, ReportStatus.TRIAGED}:
        raise WorkflowError("invalid_transition", f"Triage not allowed in state {report.workflow_status}")

    report.triage_evidence = data.model_dump()
    _report_audit(
        session,
        report,
        actor,
        "TRIAGE_RECORDED",
        f"life_safety={data.life_safety}; vulnerabilities={data.vulnerabilities or 'none'}; {data.rationale}".strip(),
        output_snapshot=data.model_dump(),
    )

    from app.services.safety import distance_to_active_hazards_m

    hazards = await active_hazards(session)
    created = _aware(report.created_at) or _now()
    p = policy.compute_priority(
        report.need_type or "rescue",
        life_safety=data.life_safety,
        vulnerabilities=list(data.vulnerabilities),
        escalation_signals=data.escalation_signals,
        people_affected=report.people_affected,
        minutes_waiting=(_now() - created).total_seconds() / 60,
        hazard_distance_m=distance_to_active_hazards_m(report.longitude, report.latitude, hazards),
    )
    report.priority_score, report.priority_breakdown = p.total, p.breakdown
    _report_audit(
        session,
        report,
        audit.POLICY,
        "PRIORITY_SCORED",
        f"Priority {p.total}/100 (severity {p.breakdown['severity']}, wait {p.breakdown['wait_time']}, "
        f"vulnerability {p.breakdown['vulnerability']}, hazard {p.breakdown['hazard_escalation']})",
        output_snapshot=p.breakdown,
    )

    d = policy.evaluate_dispatch(life_safety=data.life_safety, trust_score=report.trust_score or 0.0)
    report.policy_decision, report.policy_rule, report.policy_reason = d.outcome, d.rule_id, d.reason
    _report_audit(
        session,
        report,
        audit.POLICY,
        "POLICY_EVALUATED",
        f"{d.outcome}: {d.reason}",
        policy_rule=d.rule_id,
        output_snapshot=d.as_dict(),
    )
    _set_status(session, report, ReportStatus.TRIAGED)
    return {
        "report_id": report.id,
        "priority_score": p.total,
        "priority_breakdown": p.breakdown,
        "policy_decision": d.outcome,
        "policy_rule": d.rule_id,
        "policy_reason": d.reason,
    }


# ---------------------------------------------------------------- eligibility


async def compute_selection(session: AsyncSession, report: Report) -> dict[str, Any]:
    """Deterministic funnel: availability → skill → certification → vehicle → safe route → ETA rank."""
    if report.latitude is None or report.longitude is None or not report.need_type:
        raise WorkflowError("invalid_transition", f"{report.id} has no resolved location/need")
    cfg = policy.config()["volunteers"]
    need = report.need_type
    vols = list((await session.scalars(select(Volunteer).order_by(Volunteer.id))).all())
    busy_q = select(Assignment.volunteer_id, Assignment.report_id).where(
        Assignment.status.in_(list(OPEN_ASSIGNMENT_STATUSES)), Assignment.report_id != report.id
    )
    busy = {v: r for v, r in (await session.execute(busy_q)).all()}

    funnel: list[dict[str, Any]] = []
    pool = vols

    def step(name: str, label: str, check) -> None:
        nonlocal pool
        passed, rejected = [], []
        for v in pool:
            reason = check(v)
            if reason:
                rejected.append({"id": v.id, "reason": reason})
            else:
                passed.append(v)
        funnel.append({"step": name, "label": label, "passed": [v.id for v in passed], "rejected": rejected})
        pool = passed

    step(
        "available",
        "Available",
        lambda v: (
            "Unavailable"
            if not v.available or v.status == VolunteerStatus.OFFLINE
            else f"Assigned to {busy[v.id]}"
            if v.id in busy
            else None
            if v.status == VolunteerStatus.IDLE
            else f"Busy ({v.status})"
        ),
    )
    skill = cfg["required_skill"][need]
    step("skill", f"Has '{skill}' skill", lambda v: None if skill in v.skills else f"Missing skill: {skill}")
    step(
        "certification",
        "Medically certified" if need == "medical" else "Certification (n/a)",
        lambda v: (
            "Medical certification missing"
            if need == "medical" and cfg["medical_requires_certification"] and not v.medical_certified
            else None
        ),
    )

    def vehicle_check(v: Volunteer) -> str | None:
        if need == "rescue":
            if v.vehicle_type not in cfg["rescue_vehicles"]:
                return f"Vehicle '{v.vehicle_type}' not flood-capable"
            if report.people_affected and v.capacity < report.people_affected:
                return f"Capacity {v.capacity} < {report.people_affected} people"
        if need == "food" and v.vehicle_type not in cfg["supply_vehicles"]:
            return f"Vehicle '{v.vehicle_type}' cannot carry supplies"
        return None

    step("vehicle", "Suitable vehicle", vehicle_check)

    dest = (report.longitude, report.latitude)
    pool.sort(key=lambda v: geo.haversine_m((v.longitude, v.latitude), dest))
    shortlisted, overflow = pool[: cfg["route_candidates"]], pool[cfg["route_candidates"] :]
    hazards = await active_hazards(session)
    candidates, passed, rejected = (
        [],
        [],
        [{"id": v.id, "reason": "Not shortlisted (farther away)"} for v in overflow],
    )
    searches: dict[str, routing.RouteSearch] = {}
    for v in shortlisted:
        s = await routing.find_safe_route((v.longitude, v.latitude), dest, hazards)
        searches[v.id] = s
        first_bad = s.first_rejection
        candidates.append(
            {
                "volunteer_id": v.id,
                "eta_seconds": s.eta_seconds,
                "distance_meters": s.distance_meters,
                "safe": s.found,
                "reason": None if s.found else (s.error or (first_bad.reason if first_bad else "No route")),
                "hazard_id": first_bad.hazard_id if first_bad else None,
                "strategy": s.strategy,
                "rejected_routes": [a.as_dict() for a in s.attempts if not a.safe],
            }
        )
        if s.found:
            passed.append(v.id)
        else:
            rejected.append({"id": v.id, "reason": candidates[-1]["reason"]})
    funnel.append({"step": "route_safety", "label": "Safe route", "passed": passed, "rejected": rejected})
    candidates.sort(key=lambda c: (not c["safe"], c["eta_seconds"] or 1e9))
    selected = candidates[0]["volunteer_id"] if candidates and candidates[0]["safe"] else None
    return {
        "total": len(vols),
        "funnel": funnel,
        "candidates": candidates,
        "selected": selected,
        "_searches": searches,  # internal; stripped before persisting/returning
    }


def public_selection(sel: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in sel.items() if not k.startswith("_")}


async def eligible_volunteers(session: AsyncSession, report_id: str, actor: Actor) -> dict[str, Any]:
    report = await get_report(session, report_id)
    ensure_open(report)
    if report.workflow_status != ReportStatus.TRIAGED:
        raise WorkflowError(
            "invalid_transition", f"Dispatch planning not allowed in state {report.workflow_status}"
        )
    sel = await compute_selection(session, report)
    pub = public_selection(sel)
    counts = " → ".join(f"{len(s['passed'])} {s['label'].lower()}" for s in sel["funnel"])
    _report_audit(
        session,
        report,
        actor,
        "VOLUNTEERS_FILTERED",
        f"{sel['total']} volunteers → {counts}",
        output_snapshot=pub,
    )
    for s in sel["funnel"]:
        for rej in s["rejected"]:
            if s["step"] in {"certification", "skill", "vehicle"} or (
                s["step"] == "available" and rej["reason"] != "Unavailable"
            ):
                _report_audit(
                    session,
                    report,
                    audit.POLICY,
                    "VOLUNTEER_REJECTED",
                    f"{rej['id']} rejected: {rej['reason']}",
                    output_snapshot={"volunteer_id": rej["id"], "step": s["step"], "reason": rej["reason"]},
                )
    for c in sel["candidates"]:
        for bad in c["rejected_routes"][:1]:
            _report_audit(
                session,
                report,
                audit.SAFETY,
                "ROUTE_REJECTED",
                f"{c['volunteer_id']}: {bad['reason']} — searching for a safe alternative",
                output_snapshot=bad,
            )
        if c["safe"]:
            _report_audit(
                session,
                report,
                audit.SAFETY,
                "ROUTE_CHECKED",
                f"{c['volunteer_id']}: safe route found, ETA {c['eta_seconds'] / 60:.0f} min ({c['strategy']})",
                output_snapshot={
                    k: c[k] for k in ("volunteer_id", "eta_seconds", "distance_meters", "strategy")
                },
            )
    return {"report_id": report.id, **pub}


# ---------------------------------------------------------------- assignment


async def propose_assignment(
    session: AsyncSession, report_id: str, volunteer_id: str, explanation: str | None, actor: Actor
) -> dict[str, Any]:
    report = await get_report(session, report_id)
    ensure_open(report)
    existing = await open_assignment(session, report.id)
    if existing:
        if existing.volunteer_id == volunteer_id:  # idempotent retry
            return _assignment_result(report, existing)
        raise WorkflowError("invalid_transition", f"{report.id} already has assignment {existing.id}")
    if report.workflow_status != ReportStatus.TRIAGED or not report.policy_decision:
        raise WorkflowError("invalid_transition", f"Assignment not allowed in state {report.workflow_status}")

    sel = await compute_selection(session, report)
    cand = next((c for c in sel["candidates"] if c["volunteer_id"] == volunteer_id), None)
    if cand is None or not cand["safe"]:
        reason = next(
            (r["reason"] for s in sel["funnel"] for r in s["rejected"] if r["id"] == volunteer_id),
            cand["reason"] if cand else "Not an eligible candidate",
        )
        raise WorkflowError(
            "policy_blocked",
            f"Cannot assign {volunteer_id}: {reason}",
            audit_entry={
                "actor": audit.POLICY,
                "event_type": "ASSIGNMENT_REFUSED",
                "message": f"Refused assignment of {volunteer_id} requested by {actor.id}: {reason}",
                "entity_type": "report",
                "entity_id": report.id,
                "report_id": report.id,
                "input_snapshot": {"volunteer_id": volunteer_id, "requested_by": actor.id},
            },
        )

    search: routing.RouteSearch = sel["_searches"][volunteer_id]
    vol = await session.get(Volunteer, volunteer_id)
    asg = Assignment(
        report_id=report.id,
        volunteer_id=volunteer_id,
        priority_score=report.priority_score,
        route_geometry=search.geometry,
        route_eta_seconds=search.eta_seconds,
        route_distance_meters=search.distance_meters,
        explanation=explanation or default_explanation(report, vol, cand, sel),
        selection=public_selection(sel),
        proposed_by=actor.id,
    )
    session.add(asg)
    await session.flush()
    audit.record(
        session,
        actor=actor,
        event_type="ASSIGNMENT_PROPOSED",
        message=f"Proposed {volunteer_id} ({vol.callsign}), ETA {search.eta_seconds / 60:.0f} min — {asg.explanation}",
        entity_type="assignment",
        entity_id=asg.id,
        report_id=report.id,
        output_snapshot={"volunteer_id": volunteer_id, "eta_seconds": search.eta_seconds},
    )
    if report.policy_decision == "AUTO_DISPATCH":
        await activate_assignment(session, asg, report, audit.POLICY)
    else:
        asg.status = AssignmentStatus.AWAITING_APPROVAL
        _set_status(session, report, ReportStatus.AWAITING_APPROVAL)
        await _request_approval(
            session,
            report,
            asg,
            ApprovalAction.DISPATCH,
            report.policy_reason or "Approval required",
            report.policy_rule,
        )
    audit.emit(session, "assignment.updated", report_id=report.id, assignment_id=asg.id)
    return _assignment_result(report, asg)


def _assignment_result(report: Report, asg: Assignment) -> dict[str, Any]:
    return {
        "report_id": report.id,
        "assignment_id": asg.id,
        "volunteer_id": asg.volunteer_id,
        "status": asg.status,
        "eta_seconds": asg.route_eta_seconds,
        "requires_human_approval": asg.status == AssignmentStatus.AWAITING_APPROVAL,
        "policy_rule": report.policy_rule,
    }


def default_explanation(report: Report, vol: Volunteer, cand: dict, sel: dict) -> str:
    skill = policy.config()["volunteers"]["required_skill"][report.need_type]
    bits = [f"{skill}-trained"]
    if report.need_type == "medical":
        bits.append("medically certified")
    bits += [vol.vehicle_type, f"ETA {cand['eta_seconds'] / 60:.0f} min"]
    if cand.get("rejected_routes"):
        bits.append(f"route avoids {cand['rejected_routes'][0]['hazard_id']}")
    else:
        bits.append("route outside active hazards")
    others = len(sel["candidates"]) - 1
    return (
        f"{vol.id} selected: "
        + ", ".join(bits)
        + (f"; best of {others + 1} safe-route candidates" if others else "")
    )


async def activate_assignment(session: AsyncSession, asg: Assignment, report: Report, actor: Actor) -> None:
    asg.status = AssignmentStatus.ACTIVE
    vol = await session.get(Volunteer, asg.volunteer_id)
    vol.status = VolunteerStatus.EN_ROUTE
    _set_status(session, report, ReportStatus.DISPATCHED)
    audit.record(
        session,
        actor=actor,
        event_type="ASSIGNMENT_ACTIVATED",
        message=f"{vol.id} ({vol.callsign}) dispatched to {report.id}, ETA {asg.route_eta_seconds / 60:.0f} min",
        entity_type="assignment",
        entity_id=asg.id,
        report_id=report.id,
        policy_rule=report.policy_rule,
    )
    audit.record(
        session,
        actor=audit.SYSTEM,
        event_type="NOTIFICATION_SENT",
        message=f"Dispatch notice sent to {vol.callsign}: {report.need_type} at {report.location_text}",
        entity_type="assignment",
        entity_id=asg.id,
        report_id=report.id,
    )
    audit.emit(session, "assignment.updated", report_id=report.id, assignment_id=asg.id)
    audit.emit(session, "volunteer.updated", volunteer_id=vol.id)


async def complete_assignment(session: AsyncSession, assignment_id: str, actor: Actor) -> Assignment:
    asg = await session.get(Assignment, assignment_id)
    if asg is None:
        raise WorkflowError("not_found", f"Assignment {assignment_id} not found", 404)
    if asg.status not in {AssignmentStatus.ACTIVE, AssignmentStatus.REROUTING}:
        raise WorkflowError("invalid_transition", f"Cannot complete assignment in state {asg.status}")
    report = await get_report(session, asg.report_id)
    vol = await session.get(Volunteer, asg.volunteer_id)
    asg.status, asg.completed_at = AssignmentStatus.COMPLETED, _now()
    vol.status = VolunteerStatus.IDLE
    vol.longitude, vol.latitude = report.longitude, report.latitude  # volunteer is now on scene
    _set_status(session, report, ReportStatus.COMPLETED)
    audit.record(
        session,
        actor=actor,
        event_type="ASSIGNMENT_COMPLETED",
        message=f"{vol.id} completed {report.id}",
        entity_type="assignment",
        entity_id=asg.id,
        report_id=report.id,
    )
    audit.emit(session, "assignment.updated", report_id=report.id, assignment_id=asg.id)
    audit.emit(session, "volunteer.updated", volunteer_id=vol.id)
    return asg


# ---------------------------------------------------------------- approvals (human)


async def resolve_approval(
    session: AsyncSession,
    approval_id: str,
    *,
    approve: bool,
    note: str | None,
    corrections: ReviewCorrections | None,
    actor: Actor,
) -> tuple[Approval, str | None]:
    """Returns (approval, follow_up) where follow_up is a report id needing local processing."""
    appr = await session.get(Approval, approval_id)
    if appr is None:
        raise WorkflowError("not_found", f"Approval {approval_id} not found", 404)
    if appr.status != ApprovalStatus.PENDING:
        raise WorkflowError("invalid_transition", f"Approval already {appr.status}")
    report = await get_report(session, appr.report_id)
    asg = await session.get(Assignment, appr.assignment_id) if appr.assignment_id else None
    follow_up: str | None = None

    if approve and appr.action_type == ApprovalAction.DISPATCH and asg:
        # Re-validate at approval time: a hazard may have appeared while this waited.
        from app.services import safety

        hazards = await active_hazards(session)
        check = safety.check_route(asg.route_geometry, hazards)
        if not check.safe:
            vol = await session.get(Volunteer, asg.volunteer_id)
            s = await routing.find_safe_route(
                (vol.longitude, vol.latitude), (report.longitude, report.latitude), hazards
            )
            if not s.found:
                raise WorkflowError(
                    "route_unsafe", f"Route became unsafe ({check.reason}) and no safe alternative exists"
                )
            _apply_new_route(asg, s)
            audit.record(
                session,
                actor=audit.SAFETY,
                event_type="ROUTE_RECALCULATED",
                message=f"Route re-validated at approval: {check.reason}. New ETA {s.eta_seconds / 60:.0f} min",
                entity_type="assignment",
                entity_id=asg.id,
                report_id=report.id,
            )
        await activate_assignment(session, asg, report, actor)
    elif approve and appr.action_type == ApprovalAction.REVIEW:
        if corrections:
            for k, v in corrections.model_dump(exclude_none=True).items():
                setattr(report, k, v)
            if corrections.latitude is not None and corrections.longitude is not None:
                report.location_confidence = 1.0
        if report.latitude is None and report.location_text:
            loc = await geo.resolve(report.location_text, report.raw_text)
            if loc:
                report.latitude, report.longitude, report.location_confidence = (
                    loc.lat,
                    loc.lng,
                    loc.confidence,
                )
        if report.latitude is None or not report.need_type:
            raise WorkflowError(
                "invalid_transition", "Review approval needs a location and need type (use corrections)"
            )
        report.confidence = max(report.confidence or 0, 0.9)  # human-verified
        _set_status(session, report, ReportStatus.STRUCTURED)
        follow_up = report.id
    elif approve and appr.action_type == ApprovalAction.ESCALATION:
        if asg:
            asg.status = AssignmentStatus.CANCELLED
        _set_status(session, report, ReportStatus.TRIAGED)
        follow_up = report.id  # retry dispatch with current hazards / volunteers
    else:  # reject
        if asg:
            asg.status = AssignmentStatus.CANCELLED
            audit.emit(session, "assignment.updated", report_id=report.id, assignment_id=asg.id)
        _set_status(session, report, ReportStatus.REJECTED)

    appr.status = ApprovalStatus.APPROVED if approve else ApprovalStatus.REJECTED
    appr.approved_by, appr.resolution_note, appr.resolved_at = actor.id, note, _now()
    audit.record(
        session,
        actor=actor,
        event_type="APPROVAL_GRANTED" if approve else "APPROVAL_REJECTED",
        message=f"Dispatcher {'approved' if approve else 'rejected'} {appr.action_type} for {report.id}"
        + (f": {note}" if note else ""),
        entity_type="approval",
        entity_id=appr.id,
        report_id=report.id,
        policy_rule=appr.policy_rule,
        input_snapshot={"corrections": corrections.model_dump(exclude_none=True)} if corrections else None,
    )
    audit.emit(session, "approval.updated", report_id=report.id, approval_id=appr.id)
    return appr, follow_up


def _apply_new_route(asg: Assignment, s: routing.RouteSearch) -> None:
    asg.previous_route_geometry, asg.previous_eta_seconds = asg.route_geometry, asg.route_eta_seconds
    asg.route_geometry, asg.route_eta_seconds, asg.route_distance_meters = (
        s.geometry,
        s.eta_seconds,
        s.distance_meters,
    )


# ---------------------------------------------------------------- stats


async def stats(session: AsyncSession) -> dict[str, int]:
    async def count(q) -> int:
        return int(await session.scalar(q) or 0)

    return {
        "reports_received": await count(select(func.count()).select_from(Report)),
        "duplicates_merged": await count(
            select(func.count()).select_from(Report).where(Report.workflow_status == ReportStatus.MERGED)
        ),
    }
