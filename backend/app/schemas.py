"""Pydantic I/O models for the product API."""

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import SourceType


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    @field_validator("*")
    @classmethod
    def _utc(cls, v: Any) -> Any:
        # Timestamps are stored in UTC; SQLite drops the tzinfo, so restore it for clients.
        return v.replace(tzinfo=UTC) if isinstance(v, datetime) and v.tzinfo is None else v


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
    merged_into: str | None
    duplicate_count: int
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
    message: str
    policy_rule: str | None
    input_snapshot: dict[str, Any] | None
    output_snapshot: dict[str, Any] | None
    created_at: datetime


class SystemStats(BaseModel):
    reports_received: int = 0
    duplicates_merged: int = 0


class SystemOut(ORM):
    scenario_status: str
    scenario_run_id: str | None
    stats: SystemStats = SystemStats()


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


# ---------- workflow inputs (written by the intake and triage steps) ----------

NeedLiteral = Literal["rescue", "medical", "food"]


class IntakeData(BaseModel):
    """Structured extraction of a raw report. Never invent missing facts: use null + ambiguities."""

    need_type: NeedLiteral | None = Field(None, description="rescue | medical | food; null if unclear")
    location_text: str | None = Field(
        None, description="Place exactly as mentioned, e.g. 'Riverside Apartments'"
    )
    people_affected: int | None = Field(None, ge=0, description="Number of people; null if not stated")
    urgency_clues: list[str] = Field(default_factory=list, description="Short phrases, e.g. 'water rising'")
    medical_context: str | None = Field(None, description="Medical indicators, e.g. 'insulin dependency'")
    confidence: float = Field(ge=0, le=1, description="Overall extraction confidence 0..1")
    ambiguities: list[str] = Field(default_factory=list, description="What is unclear or missing")


class TriageData(BaseModel):
    """Semantic urgency evidence. Does NOT decide priority; the backend scores deterministically."""

    life_safety: bool = Field(description="True if anyone's life may be at immediate risk")
    vulnerabilities: list[Literal["elderly", "child", "pregnant", "disabled", "medical_dependency"]] = Field(
        default_factory=list
    )
    escalation_signals: list[str] = Field(
        default_factory=list, description="e.g. 'water rising', 'getting worse'"
    )
    rationale: str = Field(default="", max_length=500, description="One or two sentences")


class ApprovalResolveIn(BaseModel):
    note: str | None = None
    corrections: "ReviewCorrections | None" = None


class ReviewCorrections(BaseModel):
    location_text: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    need_type: NeedLiteral | None = None
    people_affected: int | None = None


class ApprovalRejectIn(BaseModel):
    note: str | None = None


class HazardIn(BaseModel):
    label: str = Field(min_length=1, max_length=128)
    kind: Literal["flood_zone", "blocked_road"] = "flood_zone"
    geometry: dict[str, Any]


class ScenarioStartIn(BaseModel):
    scenario_id: str = "flood_demo"
    mode: Literal["timed", "manual"] = "timed"


class ScenarioStatusOut(BaseModel):
    status: str
    scenario_id: str | None
    mode: str
    next_event_index: int
    total_events: int
    elapsed_s: float
    events: list[dict[str, Any]]
