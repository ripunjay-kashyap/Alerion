// API contract v1: backend snapshots are authoritative.
import type * as GeoJSON from "geojson";

export type SourceType =
  "official" | "verified_operator" | "citizen" | "anonymous";

export interface Report {
  id: string; // "INC-3F9A21"
  raw_text: string;
  source_type: SourceType;
  source_identifier: string | null;
  location_text: string | null;
  latitude: number | null;
  longitude: number | null;
  location_confidence: number | null; // 0..1
  need_type: "rescue" | "medical" | "food" | null;
  people_affected: number | null;
  medical_context: string | null;
  urgency_clues: string[];
  ambiguities: string[];
  confidence: number | null; // intake confidence 0..1
  triage_evidence: TriageEvidence | null;
  trust_score: number | null; // 0..1
  trust_breakdown: TrustBreakdown | null;
  verification_status: "verified" | "unverified" | "low_trust" | null;
  priority_score: number | null; // 0..100
  priority_breakdown: PriorityBreakdown | null;
  policy_decision:
    "AUTO_DISPATCH" | "APPROVAL_REQUIRED" | "NEEDS_REVIEW" | null;
  policy_rule: string | null; // "GOV-01"
  policy_reason: string | null;
  workflow_status: ReportStatus;
  merged_into: string | null; // (new) set when this report was merged as a duplicate
  duplicate_count: number; // (new) how many duplicates merged INTO this report
  created_at: string;
  updated_at: string;
}

export type ReportStatus =
  | "RECEIVED"
  | "STRUCTURED"
  | "NEEDS_REVIEW"
  | "TRIAGED"
  | "AWAITING_APPROVAL"
  | "READY_FOR_DISPATCH"
  | "DISPATCHED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED"
  | "MERGED"; // (new) MERGED = duplicate folded into another report

export interface TriageEvidence {
  life_safety: boolean;
  vulnerabilities: string[]; // "elderly" | "child" | "pregnant" | "disabled" | "medical_dependency"
  escalation_signals: string[]; // "water rising", ...
  rationale: string;
}

export interface TrustBreakdown {
  base: number; // from source type
  modifiers: { label: string; delta: number }[]; // e.g. {label:"Corroborated by INC-…", delta:0.15}
  score: number;
}

export interface PriorityBreakdown {
  severity: number; // 0..50
  wait_time: number; // 0..20
  vulnerability: number; // 0..20
  hazard_escalation: number; // 0..10
  total: number; // 0..100
}

export interface Assignment {
  id: string; // "ASG-…"
  report_id: string;
  volunteer_id: string;
  status:
    | "PROPOSED"
    | "AWAITING_APPROVAL"
    | "ACTIVE"
    | "REROUTING"
    | "COMPLETED"
    | "CANCELLED"
    | "FAILED";
  priority_score: number | null;
  route_geometry: GeoJSON.LineString | null;
  route_eta_seconds: number | null;
  route_distance_meters: number | null;
  previous_route_geometry: GeoJSON.LineString | null; // set after a reroute
  previous_eta_seconds: number | null;
  explanation: string | null; // 1–2 line reason from the dispatch step
  selection: Selection | null;
  proposed_by: string | null; // actor id
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Selection {
  // eligibility funnel snapshot (render as a funnel)
  funnel: {
    step: "available" | "skill" | "certification" | "vehicle" | "route_safety";
    label: string; // "Medically certified"
    passed: string[]; // volunteer ids that passed this step
    rejected: { id: string; reason: string }[]; // e.g. {id:"V-02", reason:"Medical certification missing"}
  }[];
  candidates: {
    volunteer_id: string;
    eta_seconds: number | null;
    distance_meters: number | null;
    safe: boolean;
    reason: string | null; // "Route intersects HZ-01"
    hazard_id: string | null;
  }[];
  selected: string | null; // "V-04"
}

export interface Approval {
  id: string; // "APR-…"
  report_id: string;
  assignment_id: string | null;
  action_type: "dispatch" | "review" | "escalation";
  reason: string;
  policy_rule: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requested_by: string;
  approved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface Hazard {
  id: string;
  kind: "flood_zone" | "blocked_road";
  type: string;
  label: string;
  geometry: GeoJSON.Polygon | GeoJSON.LineString;
  severity: "medium" | "high" | "critical";
  active: boolean;
  source: "seed" | "operator" | "simulator";
}

export interface Volunteer {
  id: string;
  name: string;
  callsign: string;
  latitude: number;
  longitude: number;
  available: boolean;
  skills: string[];
  medical_certified: boolean;
  vehicle_type: "boat" | "4x4" | "car" | "truck";
  capacity: number;
  status: "idle" | "en_route" | "on_scene" | "offline";
}

export interface SystemInfo {
  scenario_status: "idle" | "running" | "done";
  scenario_run_id: string | null;
  stats: {
    // (new)
    reports_received: number;
    duplicates_merged: number; // = pipeline runs saved (cost guard)
  };
}

export interface OpsState {
  system: SystemInfo;
  reports: Report[];
  volunteers: Volunteer[];
  hazards: Hazard[];
  assignments: Assignment[];
  approvals: Approval[];
}

export interface AuditEntry {
  seq: number; // monotonic; use as key + cursor
  entity_type: "report" | "assignment" | "approval" | "hazard" | "system";
  entity_id: string;
  report_id: string | null; // group the timeline per incident with this
  event_type: AuditEventType;
  actor_type: "pipeline" | "human" | "system";
  actor_id: string; // see §5
  message: string; // human-readable, show as-is
  policy_rule: string | null;
  input_snapshot: Record<string, unknown> | null;
  output_snapshot: Record<string, unknown> | null;
  created_at: string;
}

export type AuditEventType =
  | "REPORT_RECEIVED"
  | "REPORT_MERGED"
  | "INTAKE_STRUCTURED"
  | "LOCATION_RESOLVED"
  | "TRUST_EVALUATED"
  | "TRIAGE_RECORDED"
  | "PRIORITY_SCORED"
  | "POLICY_EVALUATED"
  | "NEEDS_REVIEW"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_REJECTED"
  | "ASSIGNMENT_REFUSED"
  | "VOLUNTEERS_FILTERED"
  | "VOLUNTEER_REJECTED"
  | "ROUTE_CHECKED"
  | "ROUTE_REJECTED"
  | "ASSIGNMENT_PROPOSED"
  | "ASSIGNMENT_ACTIVATED"
  | "NOTIFICATION_SENT"
  | "HAZARD_ACTIVATED"
  | "HAZARD_DEACTIVATED"
  | "ROUTE_INVALIDATED"
  | "ROUTE_RECALCULATED"
  | "ASSIGNMENT_COMPLETED"
  | "ASSIGNMENT_FAILED"
  | "SCENARIO_STARTED"
  | "SCENARIO_EVENT"
  | "SCENARIO_RESET";

export interface ScenarioStatus {
  status: "idle" | "running" | "done";
  scenario_id: string | null;
  mode: "timed" | "manual";
  next_event_index: number;
  total_events: number;
  elapsed_s: number;
  events: {
    at_seconds: number;
    type: "report" | "hazard";
    label: string;
    fired: boolean;
  }[];
}

export interface ReviewCorrections {
  location_text?: string;
  latitude?: number;
  longitude?: number;
  need_type?: "rescue" | "medical" | "food";
  people_affected?: number;
}

export interface ReportInput {
  text: string;
  source: SourceType;
  source_identifier?: string;
}
export interface ApprovalInput {
  note?: string;
  corrections?: ReviewCorrections;
}
export type EventName =
  | "report.created"
  | "report.updated"
  | "assignment.updated"
  | "approval.updated"
  | "hazard.updated"
  | "volunteer.updated"
  | "audit.appended"
  | "scenario.updated"
  | "system.reset";
export interface OpsEvent {
  event: EventName;
  data: Record<string, unknown>;
}
export interface RouteInvalidation {
  key: number;
  assignment_id: string | null;
  report_id: string | null;
  hazard_id: string | null;
  previous_eta_seconds: number | null;
  new_eta_seconds: number | null;
}
