"use client";
import { useEffect, useState } from "react";
import type { OpsState, RouteInvalidation } from "@/lib/types";
import { eta } from "@/lib/format";

export default function RouteInvalidatedBanner({
  event,
  state,
  onSelect,
}: {
  event: RouteInvalidation;
  state: OpsState | null;
  onSelect: (id: string) => void;
}) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  const assignment = state?.assignments.find(
    (a) => a.id === event.assignment_id,
  );
  const reportId = event.report_id ?? assignment?.report_id;
  const newEta = event.new_eta_seconds ?? assignment?.route_eta_seconds;
  return (
    <div className="route-banner" role="status" aria-live="polite">
      <button
        className="popover-close"
        aria-label="Dismiss route invalidation"
        onClick={() => setVisible(false)}
      >
        ×
      </button>
      <div className="font-mono text-xs font-semibold tracking-wider text-amber-300">
        ⚠ ROUTE INVALIDATED · {event.assignment_id ?? "ASSIGNMENT"}{" "}
        {assignment ? `/ ${assignment.volunteer_id}` : ""}
      </div>
      <p>
        New hazard <span className="font-mono">{event.hazard_id ?? "—"}</span>{" "}
        intersects the active route.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-emerald-300">
          {newEta != null
            ? "✓ Safe route recalculated"
            : "Safety monitor recalculating route…"}
        </span>
        <span className="font-mono text-slate-100">
          ETA {eta(event.previous_eta_seconds)} → {eta(newEta)}
        </span>
      </div>
      {reportId && (
        <button className="text-link mt-2" onClick={() => onSelect(reportId)}>
          Inspect incident and audit →
        </button>
      )}
    </div>
  );
}
