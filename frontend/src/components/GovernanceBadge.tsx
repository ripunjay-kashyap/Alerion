import type { AuditEntry, Report } from "@/lib/types";

export default function GovernanceBadge({
  decision,
  rule,
  event,
}: {
  decision?: Report["policy_decision"];
  rule?: string | null;
  event?: AuditEntry["event_type"];
}) {
  const auditLabels: Partial<Record<AuditEntry["event_type"], string>> = {
    ASSIGNMENT_REFUSED: "BLOCKED BY POLICY",
    ROUTE_REJECTED: "ROUTE REJECTED",
    VOLUNTEER_REJECTED: "VOLUNTEER REJECTED",
  };
  const auditLabel = event ? auditLabels[event] : null;
  if (auditLabel)
    return (
      <span className="badge badge-red">
        {auditLabel}
        {rule ? <span className="font-mono"> · {rule}</span> : null}
      </span>
    );
  if (!decision) return null;
  const text =
    decision === "AUTO_DISPATCH"
      ? "AUTO-DISPATCH"
      : decision === "NEEDS_REVIEW"
        ? "HUMAN REVIEW"
        : "APPROVAL REQUIRED";
  return (
    <span
      className={`badge ${decision === "AUTO_DISPATCH" ? "badge-green" : decision === "NEEDS_REVIEW" ? "badge-slate" : "badge-amber"}`}
    >
      {text}
      {rule && <span className="font-mono"> · {rule}</span>}
    </span>
  );
}
