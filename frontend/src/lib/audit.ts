import type { AuditEntry, AuditEventType } from "./types";
export const stages = [
  "Intake",
  "Triage",
  "Governance",
  "Dispatch",
  "Adaptation",
  "System",
] as const;
export type Stage = (typeof stages)[number];
const eventsByStage: Record<Stage, AuditEventType[]> = {
  Intake: [
    "REPORT_RECEIVED",
    "REPORT_MERGED",
    "INTAKE_STRUCTURED",
    "LOCATION_RESOLVED",
  ],
  Triage: ["TRUST_EVALUATED", "TRIAGE_RECORDED", "PRIORITY_SCORED"],
  Governance: [
    "POLICY_EVALUATED",
    "NEEDS_REVIEW",
    "APPROVAL_REQUESTED",
    "APPROVAL_GRANTED",
    "APPROVAL_REJECTED",
    "ASSIGNMENT_REFUSED",
  ],
  Dispatch: [
    "VOLUNTEERS_FILTERED",
    "VOLUNTEER_REJECTED",
    "ROUTE_CHECKED",
    "ROUTE_REJECTED",
    "ASSIGNMENT_PROPOSED",
    "ASSIGNMENT_ACTIVATED",
    "NOTIFICATION_SENT",
  ],
  Adaptation: [
    "HAZARD_ACTIVATED",
    "HAZARD_DEACTIVATED",
    "ROUTE_INVALIDATED",
    "ROUTE_RECALCULATED",
    "ASSIGNMENT_COMPLETED",
    "ASSIGNMENT_FAILED",
  ],
  System: ["SCENARIO_STARTED", "SCENARIO_EVENT", "SCENARIO_RESET"],
};
export function stageOf(event: AuditEventType): Stage {
  return (
    stages.find((stage) => eventsByStage[stage].includes(event)) ?? "System"
  );
}
export function stageStatus(
  entry: AuditEntry | undefined,
): "pending" | "running" | "done" | "blocked" {
  if (
    !entry ||
    [
      "REPORT_RECEIVED",
      "APPROVAL_REQUESTED",
      "NEEDS_REVIEW",
      "ASSIGNMENT_PROPOSED",
    ].includes(entry.event_type)
  )
    return "pending";
  if (
    [
      "ASSIGNMENT_REFUSED",
      "VOLUNTEER_REJECTED",
      "ROUTE_REJECTED",
      "APPROVAL_REJECTED",
      "ASSIGNMENT_FAILED",
    ].includes(entry.event_type)
  )
    return "blocked";
  if (
    [
      "TRUST_EVALUATED",
      "TRIAGE_RECORDED",
      "VOLUNTEERS_FILTERED",
      "ROUTE_CHECKED",
      "ROUTE_INVALIDATED",
    ].includes(entry.event_type)
  )
    return "running";
  return "done";
}
