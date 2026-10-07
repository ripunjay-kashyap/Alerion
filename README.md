# Disaster Relief Router

**A governed disaster dispatch system: messy flood reports in, safe, auditable volunteer assignments and live Mapbox routes out.**

Guwahati (Assam) flood scenario · FastAPI backend · Next.js frontend · Supabase · Mapbox

- **Live dashboard:** _Vercel URL_
- **API:** https://alerion-backend.onrender.com ([docs](https://alerion-backend.onrender.com/docs))

> Free-tier backend: open `/api/health` once to wake it before use.

---

## The problem

During a flood, the hard problem isn't finding a route. It's deciding **what** happened, **where**, **how urgent** it is,
whether the report is **trustworthy**, **who is qualified** to respond, whether the action is **safe**, **who approved** it,
and how to **adapt** when the water moves. Reports arrive faster than dispatchers can verify them, responders have
different capabilities, and roads close in real time.

## What it does

1. **Understands** unstructured reports (intake → structured incident).
2. **Triages** urgency, then scores priority **deterministically** (0–100, every component visible).
3. **Applies governance policy.** Source trust, confidence gates, and human approval for life-safety actions from unverified sources.
4. **Finds qualified responders** through an explainable funnel (availability → skill → medical certification → vehicle → safe route → ETA).
5. **Generates safe routes** on real roads that avoid active flood zones and blocked roads.
6. **Requires human approval** for sensitive dispatches. Approvals re-validate the route at approval time.
7. **Reroutes live** when a new hazard cuts an active route (hero demo: ETA 9.7 → 13.3 min, old route shown dashed).
8. **Audits everything.** Every extraction, score, policy decision, refusal, approval, dispatch and reroute, with the acting pipeline stage, system component or human.
9. **Merges duplicates.** Near-duplicate reports fold into the existing incident and raise its trust instead of starting a second pipeline run or dispatch.

## Architecture

The project has two parts: a FastAPI backend that owns every decision and all state, and a Next.js dashboard that renders it.

```
            Next.js + Mapbox dashboard (frontend/, Vercel)
                 │  HTTP + SSE (backend is the source of truth)
                 ▼
            FastAPI execution & safety plane (backend/, Render) ──── Supabase Postgres (canonical state)
            ├─ report pipeline: intake → triage → governance → dispatch
            ├─ policy engine (policy.yaml): trust, priority, rules UNC-01 / GOV-01..99
            ├─ eligibility funnel + safe-route search (Mapbox Directions + shapely)
            ├─ approvals, reroute engine (safety-monitor), audit trail
            └─ scenario simulator (timed or manual replay of scenarios/*.json)
```

Every new report runs through the same pipeline, whether it comes from the simulator or the dashboard's report form
(near-duplicates are merged into their incident first).
Each stage commits its result in its own transaction and publishes an SSE event, so the dashboard shows the pipeline
advancing stage by stage.

**Deterministic by design.** Intake uses exact-match fixtures for the scenario reports and a conservative keyword parser
for everything else. When the parser is unsure it lowers its confidence, and UNC-01 sends the report to a human instead
of guessing. Everything safety-critical is deterministic code: trust, priority, eligibility, certification, hazard
intersection, route safety, approvals and assignment state. **Every mutating step re-validates before it commits:** an
assignment that fails eligibility or route safety is refused and audited, and approving a dispatch whose route has since
become unsafe triggers a safe reroute, or a refusal (HTTP 409) when none exists.

## Repository layout

```
backend/              FastAPI service
  app/api/            product API (/api/*) and the SSE stream
  app/orchestrator/   report pipeline (intake → triage → dispatch)
  app/services/       workflow steps, policy, routing, safety, reroute, audit, seeding
  policy.yaml         governance rules and scoring weights
  seed/               volunteers, hazards, known places, intake fixtures, cached Mapbox responses
  tests/              offline end-to-end scenario tests
frontend/             Next.js + Mapbox operations dashboard (opt-in mock mode for UI work)
scenarios/            replayable demo scenarios
render.yaml           Render blueprint for the backend
```

## Governance rules (`backend/policy.yaml`)

| Rule | Condition | Outcome |
|---|---|---|
| UNC-01 | confidence < 0.65 or unresolved location | human review before any dispatch |
| GOV-01 | life-safety **and** trust < 0.80 | dispatcher approval required |
| GOV-02 | trust ≥ 0.80 | auto-dispatch |
| GOV-03 | not life-safety **and** trust ≥ 0.50 | auto-dispatch |
| GOV-99 | anything else | human approval (safe by default) |

Trust: official 1.00 · verified operator 0.90 · citizen 0.55 · anonymous 0.40, +0.15 corroborated, +0.10 known incident zone, −0.15 low location confidence.

## Safe routing

Mapbox can't avoid arbitrary polygons, so the backend runs a bounded, deterministic search:
fastest + alternatives → exclude sampled route points inside the violating hazard (`exclude=point(...)`, iterated) →
detour waypoints. Every rejected attempt is recorded with its reason. Responses are cached on disk so the demo
scenario works even offline.

## Demo scenario (`scenarios/flood_demo.json`)

| t | Event | Result |
|---|---|---|
| 0 s | Official: family trapped, Riverside Apartments | GOV-02 auto → V-04 (rescue, 4x4) |
| 8 s | Citizen: person unconscious, Central Market | GOV-01 approval · V-02 rejected *medical certification missing* · route avoids HZ-01 |
| 13 s | Citizen: someone collapsed, Fancy Bazaar | duplicate merged (no second pipeline run), trust 0.55 → 0.70 |
| 18 s | Citizen: drinking water for 15, Station Road | GOV-03 auto → V-06 (supply truck) |
| 24 s | Anonymous: "help water everywhere pls" | UNC-01 human review |
| 35 s | Flood zone HZ-02 activates | V-04 route invalidated → safe reroute, ETA 9.7 → 13.3 min |

## Run locally

```bash
# backend
cd backend
cp .env.example .env            # DATABASE_URL (Supabase session pooler or sqlite), MAPBOX_TOKEN
uv sync
uv run uvicorn app.main:app --reload --port 8000
uv run pytest                   # offline end-to-end scenario tests (cached Mapbox responses)

# frontend
cd frontend
cp .env.example .env.local      # NEXT_PUBLIC_API_URL, NEXT_PUBLIC_MAPBOX_TOKEN (NEXT_PUBLIC_USE_MOCK=1 for mock mode)
npm ci && npm run dev
```

## Deploy

- **Backend → Render** via `render.yaml`. Set `DATABASE_URL` (Supabase session pooler URI), `MAPBOX_TOKEN` and
  `CORS_ORIGINS` in the Render dashboard (`render.yaml` sets `MAPBOX_MODE=cache_first`). Runs as one instance with
  one worker, because the SSE event bus and the pipeline tasks are in-process.
- **Frontend → Vercel** from `frontend/`. `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_MAPBOX_TOKEN` (a URL-restricted public
  token) are read at build time from `frontend/.env.production`.

## Scope & claims

A **governed decision-support and dispatch automation prototype** for disaster-response workflows.
It doesn't claim production emergency readiness, guaranteed safe routing, report authenticity, or medical
decision-making. Human dispatchers remain authoritative for high-risk actions.

Reusable beyond floods: earthquakes, wildfires, storms, humanitarian logistics, municipal emergency coordination.
