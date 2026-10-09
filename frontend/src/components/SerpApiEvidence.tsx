"use client";
// Everything the SerpApi evidence layer adds to an incident: how it was located, what the news says,
// and where the nearest open help is. Evidence only: the rules still make the decision.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Facilities, IntelStatus, NewsArticle, OpsState, Report } from "@/lib/types";

export const timeAgo = (iso: string | null) => {
  if (!iso) return "past 24 h";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

export function SerpMark() {
  return <span className="serp-mark">SerpApi</span>;
}

export function ArticleList({ articles }: { articles: NewsArticle[] }) {
  return (
    <ul className="serp-articles">
      {articles.map((a) => (
        <li key={a.link}>
          <a href={a.link} target="_blank" rel="noreferrer">
            {a.title}
          </a>
          <span>
            {a.source ?? (a.engine === "google" ? "Google Search" : "Google News")} ·{" "}
            {timeAgo(a.iso_date)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Location + news evidence for one report. `compact` = one line of chips for the incident list. */
export function SerpEvidence({ report, compact = false }: { report: Report; compact?: boolean }) {
  const loc = report.trust_breakdown?._location;
  const news = report.trust_breakdown?._news;
  const viaMaps = loc?.source === "google_maps";
  if (!viaMaps && !news) return null;
  const count = news?.articles.length ?? 0;
  if (compact)
    return (
      <div className="serp-chips" aria-label="SerpApi evidence">
        {viaMaps && (
          <span className="badge badge-serp" title={loc?.place?.address ?? undefined}>
            Located via Google Maps
          </span>
        )}
        {news && (
          <span className={`badge ${count ? "badge-serp" : "badge-slate"}`}>
            {count ? `${count} news report${count === 1 ? "" : "s"}` : "No news coverage"}
          </span>
        )}
      </div>
    );
  return (
    <section className="serp-evidence" aria-label="Outside evidence from SerpApi">
      <div className="serp-evidence-head">
        <span className="section-label">Outside evidence</span>
        <SerpMark />
      </div>
      {viaMaps && loc?.place && (
        <p className="serp-line">
          <b>Google Maps</b> found “{loc.place.title}”
          {loc.place.address ? `, ${loc.place.address}` : ""}
          {loc.place.type ? ` (${loc.place.type})` : ""}.
        </p>
      )}
      {news &&
        (count ? (
          <>
            <p className="serp-line">
              <b>Google News</b>: {count} recent report{count === 1 ? "" : "s"} of flooding here.
              Raises trust, but never enough on its own to skip your approval.
            </p>
            <ArticleList articles={news.articles} />
          </>
        ) : (
          <p className="serp-line muted">
            <b>Google News</b>: no coverage of this spot in the last 24 h. That doesn’t count against
            the report.
          </p>
        ))}
    </section>
  );
}

/** Google Maps (SerpApi) hospitals or relief camps near the selected incident. */
export function useFacilities(report: Report | undefined) {
  const [result, setResult] = useState<{ id: string; data: Facilities | null } | null>(null);
  const id = report?.id;
  const located = report?.latitude != null && report?.longitude != null;
  const need = report?.need_type;
  useEffect(() => {
    if (!id || !located || !need) return;
    let live = true;
    api
      .facilities(id)
      .then((data) => live && setResult({ id, data }))
      .catch(() => live && setResult({ id, data: null }));
    return () => {
      live = false;
    };
  }, [id, located, need]);
  return result && result.id === id ? result.data : null;
}

export function NearbyHelp({ facilities }: { facilities: Facilities | null }) {
  if (!facilities?.available || facilities.results.length === 0) return null;
  const what = facilities.query === "hospital" ? "Nearest hospitals" : "Nearest relief camps";
  return (
    <section className="serp-evidence" aria-label={what}>
      <div className="serp-evidence-head">
        <span className="section-label">{what}</span>
        <SerpMark />
      </div>
      <ul className="serp-facilities">
        {facilities.results.slice(0, 3).map((f) => (
          <li key={`${f.title}-${f.lat}`}>
            <span className="serp-facility-name">{f.title}</span>
            <span className="muted">
              {(f.distance_m / 1000).toFixed(1)} km
              {f.open_now === true ? " · open now" : f.open_now === false ? " · closed" : ""}
              {f.phone ? ` · ${f.phone}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Powered by SerpApi" chip for the app bar, with live usage in the tooltip. */
export function SerpApiChip({ state }: { state: OpsState | null }) {
  const [status, setStatus] = useState<IntelStatus | null>(null);
  // refetch usage whenever the pipeline moves (a new lookup may have happened)
  const tick = state?.reports.reduce((t, r) => (r.updated_at > t ? r.updated_at : t), "") ?? "";
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .intelStatus()
        .then((s) => live && setStatus(s))
        .catch(() => live && setStatus(null));
    const t = setTimeout(load, 400);
    const poll = setInterval(load, 15000); // facility lookups don't change ops state
    return () => {
      live = false;
      clearTimeout(t);
      clearInterval(poll);
    };
  }, [tick, state?.intel_suggestions?.length]);
  if (!status) return null;
  const used = status.session_usage.live_searches + status.session_usage.cache_hits;
  const ready = status.key_configured || status.mode !== "live";
  const mode =
    status.mode === "live" ? "live" : status.mode === "cache_first" ? "live + cache" : "cached replay";
  const title = [
    `Engines: ${status.engines.join(", ")}`,
    `This session: ${status.session_usage.live_searches} live searches, ${status.session_usage.cache_hits} from cache`,
    status.account?.plan
      ? `Plan: ${status.account.plan}, ${status.account.searches_left ?? "?"} searches left this month`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`serp-chip ${ready ? "" : "off"}`} title={title}>
      <span className="serp-chip-dot" aria-hidden="true" />
      Powered by <b>SerpApi</b>
      <small>
        {status.key_configured ? `${mode} · ${used} lookups` : "no key: evidence off"}
      </small>
    </span>
  );
}
