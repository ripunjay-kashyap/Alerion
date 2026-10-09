// Plain-language names for backend vocabulary. One place, so every panel says the same thing.
import type { Approval, AuditEntry, Report, ReportStatus, SourceType } from "./types";
import type { Stage } from "./audit";

export const statusText: Record<ReportStatus, string> = {
  RECEIVED: "Just received",
  STRUCTURED: "Report read",
  NEEDS_REVIEW: "Needs a human check",
  TRIAGED: "Urgency assessed",
  AWAITING_APPROVAL: "Waiting for your approval",
  READY_FOR_DISPATCH: "Ready to send",
  DISPATCHED: "Responder on the way",
  IN_PROGRESS: "Responder on scene",
  COMPLETED: "Resolved",
  REJECTED: "Declined",
  FAILED: "No safe route found",
  MERGED: "Merged as a duplicate",
};

export const sourceText: Record<SourceType, string> = {
  official: "Official",
  verified_operator: "Verified operator",
  citizen: "Citizen",
  anonymous: "Anonymous",
};

export const needText = (need: Report["need_type"]) =>
  need === "rescue"
    ? "Rescue"
    : need === "medical"
      ? "Medical"
      : need === "food"
        ? "Food & water"
        : "Unclear need";

export const decisionText: Record<NonNullable<Report["policy_decision"]>, string> = {
  AUTO_DISPATCH: "Sent automatically",
  APPROVAL_REQUIRED: "Needs your approval",
  NEEDS_REVIEW: "Needs a human check",
};

export const approvalTitle: Record<Approval["action_type"], string> = {
  dispatch: "Approve this dispatch?",
  review: "Check the details",
  escalation: "No safe route — decide next step",
};

export const stageText: Record<Stage, string> = {
  Intake: "Read the report",
  Triage: "Judge urgency",
  Governance: "Check the rules",
  Dispatch: "Send a responder",
  Adaptation: "Keep the route safe",
  System: "Demo controls",
};

export const stageStatusText = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  blocked: "Stopped",
} as const;

const actorNames: Record<string, string> = {
  "intake-stage": "Intake",
  "triage-stage": "Triage",
  "dispatch-stage": "Dispatch",
  "policy-engine": "Rules",
  "safety-monitor": "Safety",
  dispatcher: "Dispatcher",
  simulator: "Demo",
  "serpapi-intel": "SerpApi",
};
export const actorText = (entry: AuditEntry) =>
  actorNames[entry.actor_id] ?? (entry.actor_type === "human" ? "Dispatcher" : "System");

// "ROUTE_RECALCULATED" → "Route recalculated"
export const eventText = (event: string) => {
  const words = event.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};
