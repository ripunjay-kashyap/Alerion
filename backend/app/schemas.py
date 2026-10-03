"""Pydantic I/O models for the product API. Tool-specific models live in app/tools."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models import SourceType


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ReportOut(ORM):
    id: str
    raw_text: str
    source_type: str
    source_identifier: str | None
    location_text: str | None
    latitude: float | None
    longitude: float | None
    location_confidence: float | None
    need_type: str | None
    people_affected: int | None
    medical_context: str | None
    urgency_clues: list[str]
    ambiguities: list[str]
    confidence: float | None
    triage_evidence: dict[str, Any] | None
    trust_score: float | None
    trust_breakdown: dict[str, Any] | None
    verification_status: str | None
    priority_score: int | None
    priority_breakdown: dict[str, Any] | None
    policy_decision: str | None
    policy_rule: str | None
    policy_reason: str | None
    workflow_status: str
    orchestrator: str | None
    created_at: datetime
    updated_at: datetime


class VolunteerOut(ORM):
    id: str
    name: str
    callsign: str
    latitude: float
    longitude: float
    available: bool
    skills: list[str]
    medical_certified: bool
    vehicle_type: str
    capacity: int
    status: str


class HazardOut(ORM):
    id: str
    kind: str
    type: str
    label: str
    geometry: dict[str, Any]
    severity: str
    active: bool
    source: str


class AssignmentOut(ORM):
    id: str
    report_id: str
    volunteer_id: str
    status: str
    priority_score: int | None
    route_geometry: dict[str, Any] | None
    route_eta_seconds: float | None
    route_distance_meters: float | None
    previous_route_geometry: dict[str, Any] | None
    previous_eta_seconds: float | None
    explanation: str | None
    selection: dict[str, Any] | None
    proposed_by: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None


class ApprovalOut(ORM):
    id: str
    report_id: str
    assignment_id: str | None
    action_type: str
    reason: str
    policy_rule: str | None
    status: str
    requested_by: str
    approved_by: str | None
    resolution_note: str | None
    created_at: datetime
    resolved_at: datetime | None


class AuditOut(ORM):
    seq: int
    entity_type: str
    entity_id: str
    report_id: str | None
    event_type: str
    actor_type: str
    actor_id: str
    run_id: str | None
    message: str
    policy_rule: str | None
    input_snapshot: dict[str, Any] | None
    output_snapshot: dict[str, Any] | None
    created_at: datetime


class SystemOut(ORM):
    orchestration_mode: str
    nuroen_status: str
    scenario_status: str
    scenario_run_id: str | None
    nuroen_configured: bool = False


class StateOut(BaseModel):
    system: SystemOut
    reports: list[ReportOut]
    volunteers: list[VolunteerOut]
    hazards: list[HazardOut]
    assignments: list[AssignmentOut]
    approvals: list[ApprovalOut]


# ---------- inputs ----------


class ReportIn(BaseModel):
    text: str = Field(min_length=3, max_length=2000)
    source: SourceType = SourceType.CITIZEN
    source_identifier: str | None = None
