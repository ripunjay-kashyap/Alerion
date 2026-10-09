"use client";
// News-driven flood intel: SerpApi reads Google News + Google Search for the past 24 h and proposes flood
// zones. Nothing changes on the ground until a dispatcher accepts one.
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import type { IntelScan, IntelSuggestion, OpsState } from "@/lib/types";
import { ArticleList, SerpMark } from "./SerpApiEvidence";

interface Props {
  state: OpsState | null;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onFocus: (s: IntelSuggestion) => void;
}

export default function IntelPanel({ state, refresh, onError, onFocus }: Props) {
  const scan = useAction(onError, refresh);
  const [last, setLast] = useState<IntelScan | null>(null);
  const suggestions = state?.intel_suggestions ?? [];
  const pending = suggestions.filter((s) => s.status === "pending");
  const accepted = suggestions.filter((s) => s.status === "accepted");
  return (
    <section className="intel-panel" aria-label="Flood intel from the news">
      <div className="panel-heading">
        <h2>
          Flood intel <SerpMark />
        </h2>
        <button
          className="button button-serp"
          disabled={!state || scan.pending}
          onClick={() => void scan.execute(() => api.intelScan(), setLast)}
        >
          {scan.pending ? "Scanning…" : "Scan news"}
        </button>
      </div>
      <p className="intel-sub">
        Google News and Google Search, past 24 h. Localities reported as flooded become suggested
        zones. You decide which become real hazards.
      </p>
      {last && <ScanSummary scan={last} />}
      {pending.length === 0 ? (
        <p className="empty-state">
          {last
            ? "No new flooding named in the news right now."
            : "Scan the news to look for flooding nobody has reported to you yet."}
        </p>
      ) : (
        pending.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} refresh={refresh} onError={onError} onFocus={onFocus} />
        ))
      )}
      {accepted.length > 0 && (
        <details className="history-list">
          <summary>Confirmed from the news ({accepted.length})</summary>
          {accepted.map((s) => (
            <button key={s.id} className="history-row" onClick={() => onFocus(s)}>
              <span>{s.locality}</span>
              <span className="text-emerald-300">Hazard {s.hazard_id}</span>
              <span className="muted col-span-2">{s.evidence.length} source(s)</span>
            </button>
          ))}
        </details>
      )}
    </section>
  );
}

function ScanSummary({ scan }: { scan: IntelScan }) {
  const failed = scan.searches.filter((s) => s.error);
  return (
    <p className="intel-summary" role="status">
      {scan.searches
        .filter((s) => !s.error)
        .map((s) => `${s.engine === "google_news" ? "Google News" : "Google Search"} ${s.results ?? 0}`)
        .join(" · ") || "No searches ran"}
      {" → "}
      {scan.localities.length
        ? `flooding named in ${scan.localities.join(", ")}`
        : "no flooded localities named"}
      {scan.created.length > 0 && <b> · {scan.created.length} new</b>}
      {failed.length > 0 && <span className="text-red-300"> · {failed[0].error}</span>}
    </p>
  );
}

function SuggestionCard({
  suggestion: s,
  refresh,
  onError,
  onFocus,
}: {
  suggestion: IntelSuggestion;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onFocus: (s: IntelSuggestion) => void;
}) {
  const action = useAction(onError, refresh);
  return (
    <article className="intel-card">
      <button className="text-left w-full" onClick={() => onFocus(s)}>
        <div className="flex items-center justify-between gap-2">
          <span className="badge badge-serp">Reported in the news</span>
          <span className="muted">
            {s.evidence.length} source{s.evidence.length === 1 ? "" : "s"}
          </span>
        </div>
        <h3 className="mt-2">{s.locality}</h3>
      </button>
      <ArticleList articles={s.evidence.slice(0, 3)} />
      <p className="muted intel-where">
        Located via{" "}
        {s.location_source === "google_maps"
          ? "Google Maps (SerpApi)"
          : s.location_source === "mapbox"
            ? "Mapbox"
            : "our known places"}{" "}
        · {Math.round(s.radius_m)} m zone
      </p>
      <div className="flex gap-2 mt-2">
        <button
          className="button button-go flex-1"
          disabled={action.pending}
          onClick={() => void action.execute(() => api.acceptSuggestion(s.id))}
        >
          {action.pending ? "Saving…" : "Mark as flood zone"}
        </button>
        <button
          className="button"
          disabled={action.pending}
          onClick={() => void action.execute(() => api.dismissSuggestion(s.id))}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
