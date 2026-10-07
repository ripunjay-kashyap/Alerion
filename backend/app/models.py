"""Canonical operational state. Postgres in prod (Supabase), SQLite in tests.

Geometry is stored as GeoJSON in JSON columns; shapely does geometry math in services.
"""

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

JsonType = JSON().with_variant(JSONB(), "postgresql")
BigIntPK = BigInteger().with_variant(Integer(), "sqlite")  # sqlite autoincrement needs INTEGER


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:6].upper()}"


# ---------- enums ----------


class SourceType(StrEnum):
    OFFICIAL = "official"
    VERIFIED_OPERATOR = "verified_operator"
    CITIZEN = "citizen"
    ANONYMOUS = "anonymous"


class NeedType(StrEnum):
    RESCUE = "rescue"
    MEDICAL = "medical"
    FOOD = "food"


class ReportStatus(StrEnum):
    RECEIVED = "RECEIVED"
    STRUCTURED = "STRUCTURED"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    TRIAGED = "TRIAGED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    READY_FOR_DISPATCH = "READY_FOR_DISPATCH"
    DISPATCHED = "DISPATCHED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    MERGED = "MERGED"  # duplicate folded into another report (cost guard: no pipeline run)


TERMINAL_REPORT_STATUSES = {
    ReportStatus.COMPLETED,
    ReportStatus.REJECTED,
    ReportStatus.FAILED,
    ReportStatus.MERGED,
}


class AssignmentStatus(StrEnum):
    PROPOSED = "PROPOSED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    ACTIVE = "ACTIVE"
    REROUTING = "REROUTING"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"


OPEN_ASSIGNMENT_STATUSES = {
    AssignmentStatus.PROPOSED,
    AssignmentStatus.AWAITING_APPROVAL,
    AssignmentStatus.ACTIVE,
    AssignmentStatus.REROUTING,
}


class ApprovalStatus(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class ApprovalAction(StrEnum):
    DISPATCH = "dispatch"  # life-safety dispatch from unverified source
    REVIEW = "review"  # low-confidence / missing location
    ESCALATION = "escalation"  # no safe route / no eligible volunteer


class HazardKind(StrEnum):
    FLOOD_ZONE = "flood_zone"
    BLOCKED_ROAD = "blocked_road"


class VolunteerStatus(StrEnum):
    IDLE = "idle"
    EN_ROUTE = "en_route"
    ON_SCENE = "on_scene"
    OFFLINE = "offline"


# ---------- tables ----------


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Report(TimestampMixin, Base):
    __tablename__ = "reports"

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default=lambda: new_id("INC"))
    raw_text: Mapped[str] = mapped_column(Text)
    source_type: Mapped[str] = mapped_column(String(32))
    source_identifier: Mapped[str | None] = mapped_column(String(128))

    # intake
    location_text: Mapped[str | None] = mapped_column(String(256))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    location_confidence: Mapped[float | None] = mapped_column(Float)
    need_type: Mapped[str | None] = mapped_column(String(16))
    people_affected: Mapped[int | None] = mapped_column(Integer)
    medical_context: Mapped[str | None] = mapped_column(Text)
    urgency_clues: Mapped[list[str]] = mapped_column(JsonType, default=list)
    ambiguities: Mapped[list[str]] = mapped_column(JsonType, default=list)
    confidence: Mapped[float | None] = mapped_column(Float)

    # triage + scoring
    triage_evidence: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    trust_score: Mapped[float | None] = mapped_column(Float)
    trust_breakdown: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    verification_status: Mapped[str | None] = mapped_column(String(16))
    priority_score: Mapped[int | None] = mapped_column(Integer)
    priority_breakdown: Mapped[dict[str, Any] | None] = mapped_column(JsonType)

    # governance
    policy_decision: Mapped[str | None] = mapped_column(String(32))
    policy_rule: Mapped[str | None] = mapped_column(String(16))
    policy_reason: Mapped[str | None] = mapped_column(Text)

    # workflow
    workflow_status: Mapped[str] = mapped_column(String(24), default=ReportStatus.RECEIVED)
    scenario_run_id: Mapped[str | None] = mapped_column(String(32))
    merged_into: Mapped[str | None] = mapped_column(String(16), index=True)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0)


class Volunteer(TimestampMixin, Base):
    __tablename__ = "volunteers"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    callsign: Mapped[str] = mapped_column(String(32))
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    home_latitude: Mapped[float] = mapped_column(Float)
    home_longitude: Mapped[float] = mapped_column(Float)
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    skills: Mapped[list[str]] = mapped_column(JsonType, default=list)
    medical_certified: Mapped[bool] = mapped_column(Boolean, default=False)
    vehicle_type: Mapped[str] = mapped_column(String(16))
    capacity: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default=VolunteerStatus.IDLE)
    home_available: Mapped[bool] = mapped_column(Boolean, default=True)


class Hazard(TimestampMixin, Base):
    __tablename__ = "hazards"

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default=lambda: new_id("HZ"))
    kind: Mapped[str] = mapped_column(String(16), default=HazardKind.FLOOD_ZONE)
    type: Mapped[str] = mapped_column(String(32), default="flood")
    label: Mapped[str] = mapped_column(String(128))
    geometry: Mapped[dict[str, Any]] = mapped_column(JsonType)  # GeoJSON geometry
    severity: Mapped[str] = mapped_column(String(16), default="high")
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    initially_active: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str] = mapped_column(String(32), default="seed")
    detour_waypoints: Mapped[list[list[float]]] = mapped_column(JsonType, default=list)  # [[lng,lat],...]


class Assignment(TimestampMixin, Base):
    __tablename__ = "assignments"

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default=lambda: new_id("ASG"))
    report_id: Mapped[str] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), index=True)
    volunteer_id: Mapped[str] = mapped_column(ForeignKey("volunteers.id"))
    status: Mapped[str] = mapped_column(String(24), default=AssignmentStatus.PROPOSED)
    priority_score: Mapped[int | None] = mapped_column(Integer)
    route_geometry: Mapped[dict[str, Any] | None] = mapped_column(JsonType)  # GeoJSON LineString
    route_eta_seconds: Mapped[float | None] = mapped_column(Float)
    route_distance_meters: Mapped[float | None] = mapped_column(Float)
    previous_route_geometry: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    previous_eta_seconds: Mapped[float | None] = mapped_column(Float)
    explanation: Mapped[str | None] = mapped_column(Text)
    selection: Mapped[dict[str, Any] | None] = mapped_column(JsonType)  # eligibility funnel snapshot
    proposed_by: Mapped[str | None] = mapped_column(String(64))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Approval(Base):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default=lambda: new_id("APR"))
    report_id: Mapped[str] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), index=True)
    assignment_id: Mapped[str | None] = mapped_column(ForeignKey("assignments.id", ondelete="CASCADE"))
    action_type: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(Text)
    policy_rule: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default=ApprovalStatus.PENDING)
    requested_by: Mapped[str] = mapped_column(String(64))
    approved_by: Mapped[str | None] = mapped_column(String(64))
    resolution_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditEntry(Base):
    __tablename__ = "audit_entries"

    seq: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(16))
    entity_id: Mapped[str] = mapped_column(String(16), index=True)
    report_id: Mapped[str | None] = mapped_column(String(16), index=True)
    event_type: Mapped[str] = mapped_column(String(48))
    actor_type: Mapped[str] = mapped_column(String(16))  # pipeline | human | system
    actor_id: Mapped[str] = mapped_column(String(64))
    message: Mapped[str] = mapped_column(Text)
    policy_rule: Mapped[str | None] = mapped_column(String(16))
    input_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    output_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SystemState(Base):
    """Single-row table (id=1)."""

    __tablename__ = "system_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    scenario_status: Mapped[str] = mapped_column(String(16), default="idle")  # idle|running|done
    scenario_run_id: Mapped[str | None] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
