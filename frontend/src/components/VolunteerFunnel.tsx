import type { Selection } from "@/lib/types";
import { eta } from "@/lib/format";

// Backend step labels, said the way a dispatcher would.
const stepText: Record<Selection["funnel"][number]["step"], string> = {
  available: "free now",
  skill: "have the right skill",
  certification: "certified",
  vehicle: "right vehicle",
  route_safety: "safe route",
};

export default function VolunteerFunnel({
  selection,
  total,
}: {
  selection: Selection | null;
  total: number;
}) {
  if (!selection)
    return <p className="muted">The selection details aren’t ready yet.</p>;
  const steps = selection.funnel.filter(
    (s) => !(s.step === "certification" && s.rejected.length === 0 && s.label.includes("n/a")),
  );
  return (
    <details className="funnel">
      <summary>
        <span className="section-label">Why this responder</span>
        <span className="funnel-steps">
          <span className="funnel-step">
            <b>{total}</b> responders
          </span>
          {steps.map((step, i) => (
            <span
              key={`${step.step}-${i}`}
              className="funnel-step"
              title={step.rejected
                .map((r) => `${r.id}: ${r.reason}`)
                .join("\n")}
            >
              <b>{step.passed.length}</b> {stepText[step.step]}
            </span>
          ))}
          <span className="funnel-step picked">
            {selection.selected ? `${selection.selected} chosen` : "No one suitable"}
          </span>
        </span>
        <span className="text-link">See who was ruled out, and why</span>
      </summary>
      <div className="funnel-details">
        {steps.map((step, i) => (
          <div key={`${step.step}-${i}`}>
            <div className="flex justify-between">
              <b>{step.label}</b>
              <span className="muted">{step.passed.length} passed</span>
            </div>
            {step.rejected.map((r) => (
              <p key={r.id} className="funnel-rejection">
                <b className="text-red-300">{r.id}</b>: {r.reason}
              </p>
            ))}
          </div>
        ))}
        {selection.candidates.map((c) => (
          <p key={c.volunteer_id} className="muted">
            <b>{c.volunteer_id}</b>, {eta(c.eta_seconds)} away:{" "}
            {c.safe ? "safe route" : (c.reason ?? "no safe route")}
          </p>
        ))}
      </div>
    </details>
  );
}
