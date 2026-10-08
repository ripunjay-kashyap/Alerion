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
  const who = assignment?.volunteer_id ?? "A responder";
  return (
    <div className="route-banner" role="status" aria-live="polite">
      <button
        className="popover-close"
        aria-label="Dismiss route invalidation"
        onClick={() => setVisible(false)}
      >
        ×
      </button>
      <h3>
        {newEta != null
          ? `${who} was rerouted around new flooding`
          : `${who}’s route just flooded`}
      </h3>
      <p>
        Flood zone {event.hazard_id ?? "—"} now covers the old route.{" "}
        {newEta != null
          ? "A safe way around was found automatically."
          : "Looking for a safe way around…"}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eta-change">
          <s>{eta(event.previous_eta_seconds)}</s> {eta(newEta)}
        </span>
        {reportId && (
          <button className="text-link" onClick={() => onSelect(reportId)}>
            See what happened
          </button>
        )}
      </div>
    </div>
  );
}
