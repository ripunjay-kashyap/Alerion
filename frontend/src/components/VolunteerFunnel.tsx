import type { Selection } from "@/lib/types";
import { eta } from "@/lib/format";

export default function VolunteerFunnel({
  selection,
  total,
}: {
  selection: Selection | null;
  total: number;
}) {
  if (!selection)
    return <p className="muted">Selection details not available yet.</p>;
  return (
    <details className="funnel">
      <summary>
        <span className="section-label">VOLUNTEER ELIGIBILITY</span>
        <span className="funnel-steps">
          <span className="font-mono">{total} total</span>
          {selection.funnel.map((step, i) => (
            <span
              key={`${step.step}-${i}`}
              title={step.rejected
                .map((r) => `${r.id}: ${r.reason}`)
                .join("\n")}
            >
              <span className="text-slate-600"> → </span>
              <b className="font-mono text-slate-200">
                {step.passed.length}
              </b>{" "}
              {step.label.toLowerCase()}
            </span>
          ))}
          <span className="font-mono text-emerald-300">
            {" "}
            → {selection.selected ?? "No selection"}
          </span>
        </span>
        <span className="text-link">Inspect exclusions</span>
      </summary>
      <div className="funnel-details">
        {selection.funnel.map((step, i) => (
          <div key={`${step.step}-${i}`}>
            <div className="flex justify-between">
              <span>{step.label}</span>
              <span className="font-mono muted">
                {step.passed.length} passed
              </span>
            </div>
            {step.rejected.map((r) => (
              <p key={r.id} className="funnel-rejection">
                <span className="font-mono text-red-300">{r.id}</span> ·{" "}
                {r.reason}
              </p>
            ))}
          </div>
        ))}
        {selection.candidates.map((c) => (
          <p key={c.volunteer_id} className="muted">
            <span className="font-mono">{c.volunteer_id}</span> ·{" "}
            {eta(c.eta_seconds)} ·{" "}
            {c.safe ? "Safe route" : (c.reason ?? "Unsafe route")}
          </p>
        ))}
      </div>
    </details>
  );
}
