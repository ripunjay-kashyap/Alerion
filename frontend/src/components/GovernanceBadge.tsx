import type { AuditEntry, Report } from "@/lib/types";
import { decisionText } from "@/lib/copy";

const auditLabels: Partial<Record<AuditEntry["event_type"], string>> = {
  ASSIGNMENT_REFUSED: "Assignment blocked",
  ROUTE_REJECTED: "Unsafe route avoided",
  VOLUNTEER_REJECTED: "Responder ruled out",
};

export default function GovernanceBadge({
  decision,
  rule,
  event,
}: {
  decision?: Report["policy_decision"];
  rule?: string | null;
  event?: AuditEntry["event_type"];
}) {
  const ruleTag = rule ? <span className="rule">rule {rule}</span> : null;
  const auditLabel = event ? auditLabels[event] : null;
  if (auditLabel)
    return (
      <span className="badge badge-red">
        {auditLabel}
        {ruleTag}
      </span>
    );
  if (!decision) return null;
  return (
    <span
      className={`badge ${decision === "AUTO_DISPATCH" ? "badge-green" : decision === "NEEDS_REVIEW" ? "badge-slate" : "badge-amber"}`}
    >
      {decisionText[decision]}
      {ruleTag}
    </span>
  );
}
