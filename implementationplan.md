# Disaster Relief Router — Implementation Plan

Companion to `specs.md`. The spec says **what**; this file locks **how**.
Status: **LOCKED v1** (2026-10-03). Changes go in §14 Decision Log.

---

## 1. Locked Decisions

| Area | Decision |
|---|---|
| Team | Solo dev + Claude. Claude writes code; you handle Nuroen portal, accounts, review, demo. Two parallel tracks. |
| Demo city | **Guwahati, Assam** — Brahmaputra / Bharalu flood history, real roads, credible framing. |
| Backend | FastAPI, Python **3.12** (pinned via uv), SQLAlchemy 2 (async) + asyncpg, Pydantic v2, shapely, httpx. |
| DB | Supabase **as plain Postgres**. No supabase-py, no Supabase Realtime, no PostGIS. Geometry = GeoJSON in JSONB. |
| Realtime | SSE from FastAPI (`GET /api/events`) via in-process event bus. |
| Frontend | Next.js (App Router, TS) + Tailwind + `mapbox-gl` directly. |
| Hosting | Backend → **Render** (single instance, 1 worker, paid Starter to avoid cold starts). Frontend → **Vercel**. |
| Maps | Mapbox Directions + Geocoding, with **on-disk response cache** (cache-first in demo). |
| LLM | Only inside Nuroen. Fallback = deterministic fixtures + keyword parser (no direct LLM). |
| Canonical state | Postgres. Nuroen never owns state; it reads/writes via our tools. |
| Approvals truth | **Our `approvals` table.** Nuroen-native approval mirrored only if its API allows (see §4.6). |

---

## 2. Repository Layout

```
alerion/
├── specs.md
├── implementationplan.md
├── backend/
│   ├── pyproject.toml              # uv, py3.12
│   ├── policy.yaml                 # governance rules (deterministic)
│   ├── app/
│   │   ├── main.py                 # app factory, mounts /api and /tools
│   │   ├── config.py               # env settings
│   │   ├── db.py                   # engine/session
│   │   ├── models.py               # SQLAlchemy tables
│   │   ├── schemas.py              # Pydantic I/O models
│   │   ├── events.py               # in-process pub/sub → SSE
│   │   ├── services/
│   │   │   ├── audit.py            # append audit entries (+ publish event)
│   │   │   ├── intake_fallback.py  # fixture lookup + keyword parser
│   │   │   ├── geo.py              # geocode (fixtures → Mapbox)
│   │   │   ├── mapbox.py           # Directions/Geocoding client + disk cache
│   │   │   ├── trust.py
│   │   │   ├── priority.py
│   │   │   ├── policy.py           # evaluate(report) → decision + rule id
│   │   │   ├── eligibility.py      # filter funnel + ranking
│   │   │   ├── safety.py           # route ∩ hazards / blocked roads
│   │   │   ├── routing.py          # safe-route search (alternatives → detours)
│   │   │   ├── assignments.py      # state machine, propose/activate/complete
│   │   │   ├── approvals.py
│   │   │   └── reroute.py          # hazard change → invalidate → reroute
│   │   ├── orchestrator/
│   │   │   ├── base.py             # claim/lease + watchdog
│   │   │   ├── nuroen.py           # trigger adapter
│   │   │   └── local.py            # fallback pipeline (same services)
│   │   ├── simulator.py            # scenario replay
│   │   ├── api/                    # /api/* product routes + SSE
│   │   └── tools/                  # /tools/* (Nuroen-facing, own OpenAPI)
│   ├── seed/
│   │   ├── volunteers.json
│   │   ├── hazards.geojson
│   │   ├── locations.json          # known place → fixed coords
│   │   ├── intake_fixtures.json    # scenario text → structured intake
│   │   └── mapbox_cache/
│   └── tests/
├── frontend/
│   └── src/{app,components,lib}/
├── scenarios/flood_demo.json
└── nuroen/
    ├── agents/*.md                 # versioned prompts for each agent
    ├── define_prompt.md            # plain-language "Define" text for Nuroen builder
    └── knowledge/sop.md            # SOP pack for Nuroen knowledge
```

---

## 3. Core Principle in Code

All business logic is written **once** as service functions, and three entry points call them:

```
/tools/*   (Nuroen agents)  ─┐
/api/*     (operator UI)    ─┼─► services/*  ─► Postgres + event bus ─► SSE ─► UI
local orchestrator (fallback)┘
```

**The backend enforces governance, not the agents.** Every mutating tool re-checks policy, eligibility and route safety, and **refuses** (HTTP 409 plus a policy reason, with an audit entry) when a rule is violated. The demo line: *"Even if the LLM tries, the tool says no."*

---

## 4. Nuroen Integration Design

### 4.1 What the public docs confirm vs. what we must verify in the portal
| Confirmed in docs | Unknown → spike |
|---|---|
| Custom API connectors; "reads API docs to generate skills" | Does it import an OpenAPI URL? Auth header support? |
| Native MCP support | Remote MCP over HTTP/SSE supported? |
| Published agents get an endpoint; on-demand/event/schedule triggers | Exact trigger URL, auth, payload, sync vs async |
| Multi-agent workflows on canvas | Sub-agent nodes / agent-to-agent handoff primitive? |
| Approval gates, review queue, 24h undo | Can approvals be resolved via API/webhook? |
| Confidence gate, Budget gate, autonomy L0–L4 | Configurable thresholds per node? |
| Run history, provenance chain | Shareable run view for demo |
| Knowledge packs / Strict RAG | Strict RAG may *decline* ungrounded input — keep it OFF for Intake |

### 4.2 Integration contract: async, write-back through tools
We never parse Nuroen's response. **Agents report every result by calling our tools.** This makes the design work whether Nuroen's trigger is sync, async, webhook or chat:

```
Backend ──trigger(report_id)──► Nuroen Coordinator
                                   │ get-incident
                                   │ Intake LLM ──► submit-intake        (persist, geocode, trust)
                                   │ Triage LLM ──► submit-triage        (→ priority + policy decision)
                                   │ Dispatch   ──► get-eligible-volunteers (funnel + safe routes)
                                   │            ──► check-route-safety   (explicit, visible step)
                                   │            ──► propose-assignment   (→ ACTIVE or AWAITING_APPROVAL)
                                   ▼
                          every call → audit_entries(actor=agent) → SSE → AgentRunPanel
```

### 4.3 Ownership: lease and watchdog (stops Nuroen and the fallback from both processing a report)
- When a report is created: `orchestrator='nuroen'`, `lease_until=now+NUROEN_TIMEOUT` (default 45s).
- Each Nuroen tool call that makes progress extends the lease by 20s.
- A watchdog task scans every 2s. If a report is unfinished and its lease has expired, it sets `orchestrator='local'`, emits a `FALLBACK_ACTIVATED` audit entry, and runs the local pipeline from the report's current state.
- After takeover, any Nuroen tool call for that report gets **409 `report_owned_by_local`**. No double dispatch is possible.
- A global switch `ORCHESTRATION_MODE=nuroen|local|auto` (`auto` = Nuroen with watchdog). If the trigger call itself fails, we fall back immediately and set the system status to **degraded** (shows the banner).

### 4.4 Tool surface (mounted at `/tools`, separate OpenAPI at `/tools/openapi.json`)
Auth: `Authorization: Bearer $TOOLS_API_KEY`. Every body accepts optional `agent` and `run_id` (logged to audit), because custom headers may not be configurable in Nuroen.

| operationId | Purpose | Notes |
|---|---|---|
| `get_incident` | raw report + current state | read |
| `get_operational_state` | counts, active hazards, available volunteers | read |
| `submit_intake` | persist structured extraction | backend geocodes, computes trust, returns `{needs_review, reasons}` |
| `submit_triage` | persist urgency evidence | returns deterministic `{priority_score, breakdown, policy_decision, rule}` |
| `get_eligible_volunteers` | filter funnel + ranked candidates | each candidate has route, ETA, `safe`; rejections with reasons |
| `get_route` | Mapbox route volunteer→incident | exposed for transparency |
| `check_route_safety` | route ∩ hazards / blocked roads | `{safe, reason, hazard_id}` |
| `propose_assignment` | agent's choice + explanation | **re-validates everything**; result `ACTIVE` or `AWAITING_APPROVAL` (creates approval) or 409 |
| `request_review` | escalate to human review | low confidence / missing location |
| `log_policy_event` | agent-side note into audit | free text, tagged |
| `reroute_assignment` | manual reroute request | same logic as automatic reroute |

Descriptions and operationIds are written for LLM consumption (short, imperative, with an example), because Nuroen generates skills from API docs.
**Plan B:** if the custom-API connector doesn't fit, expose the same tools over MCP (`fastapi-mcp` or a thin MCP server), which Nuroen supports natively.

### 4.5 Agents on the Nuroen canvas
| Agent | Kind | Output |
|---|---|---|
| **Disaster Coordinator** | orchestrator; routes by tool results (`needs_review` → stop; `policy_decision` → dispatch) | final status summary |
| **Intake Agent** | LLM, structured JSON (spec §8.2 schema), "never invent location" | → `submit_intake` |
| **Triage Agent** | LLM, evidence only: `life_safety`, `vulnerabilities[]`, `escalation_signals[]`, `rationale` | → `submit_triage` (does **not** score) |
| **Dispatch Agent** | LLM + tools; must pick from returned eligible set; writes a 1–2 line explanation | → `propose_assignment` |

If the canvas has no sub-agent primitive, we use one graph with three LLM skill nodes plus tool nodes. It's still visibly multi-agent on the canvas.
Nuroen governance features we use and show: **Confidence gate** on Intake, **Budget gate**/credit ceiling per run, **autonomy L2**, the **provenance chain**, and **run history** for the "Nuroen proof" segment. The SOP knowledge pack is attached to Triage and Dispatch only.

### 4.6 Approvals (domain HITL)
- `propose_assignment` on a life-safety report from an unverified source creates an `approvals` row (PENDING). The assignment status becomes `AWAITING_APPROVAL`.
- The dispatcher clicks Approve in our UI. The backend **re-validates the route** (a hazard may have appeared since), then activates the assignment. No second LLM run is needed: the agent proposed, a human authorized, deterministic code executes.
- **Spike-dependent upgrade:** if Nuroen approvals can be resolved by API or webhook, we also put a Nuroen approval gate before `propose_assignment`, and our Approve button resolves it in Nuroen. Our table stays canonical, and Nuroen's provenance records the human sign-off.

### 4.7 Trigger options (pick after spike, in this order)
- **A.** Published agent endpoint: an HTTP POST from `orchestrator/nuroen.py` with `{report_id, raw_text, source_type}`.
- **B.** Nuroen event/webhook trigger that our backend calls.
- **C.** Nuroen schedule that polls `get_pending_reports` (latency fallback).
- **D.** Demo only: paste the report into Nuroen chat; the agent calls a `create_report` tool.

### 4.8 Nuroen spike checklist (YOU, in the portal, first 45 min)
1. Create a test agent from a plain-language Define. Note the canvas node types available.
2. Add a Custom API connector pointing at `https://<render-url>/tools/openapi.json` with a bearer key. Do skills get auto-generated?
3. Is there an MCP option (remote URL)?
4. Publish and find the **endpoint**: URL, auth, sample payload, sync or async, timeout.
5. Approval gate: who can approve, and is there an API or webhook to approve or reject?
6. Is there a sub-agent / multi-agent node, or only a single graph?
7. Run history: can we deep-link a run for the demo?
8. Credit cost per run (to budget rehearsals).

Bring back screenshots or notes. I'll adapt `orchestrator/nuroen.py` and §4.7.

---

## 5. Deterministic Logic (exact formulas)

### 5.1 Trust (0–1, clamped)
Base: official 1.00 · verified_operator 0.90 · citizen 0.55 · anonymous 0.40
- `+0.15` corroborated (another report within 500 m and 30 min, different source id)
- `+0.10` location falls inside a known incident zone / active hazard
- `−0.15` geocode confidence < 0.70
`verification_status`: ≥0.80 `verified`, ≥0.50 `unverified`, else `low_trust`.

### 5.2 Priority (0–100), every component stored in `priority_breakdown`
- **severity (0–50):** base medical 40 / rescue 35 / food 20; `+10` if `life_safety` (cap 50)
- **wait_time (0–20):** `min(20, 2 × minutes_since_received)` (recomputed on read)
- **vulnerability (0–20):** `+5` each for elderly, child, pregnant, disabled, medical_dependency; `+5` if people_affected ≥ 10 (cap 20)
- **hazard_escalation (0–10):** `10` if inside or within 300 m of an active hazard; else `5` if escalation signal (e.g. "water rising"); else 0

### 5.3 Policy evaluation (`policy.yaml` → `policy.evaluate`) — first match wins, rule id recorded
| Rule id | Condition | Outcome |
|---|---|---|
| `UNC-01` | incident confidence < 0.65 or no coordinates or location confidence < 0.70 | `NEEDS_REVIEW` |
| `GOV-01` | life_safety and trust < 0.80 | `APPROVAL_REQUIRED` ("Life-safety dispatch from unverified source") |
| `GOV-02` | official source | `AUTO_DISPATCH` |
| `GOV-03` | non-life-safety, trust ≥ 0.50 | `AUTO_DISPATCH` |
| default | — | `APPROVAL_REQUIRED` |

### 5.4 Eligibility funnel (each step recorded with rejected ids and reasons)
1. `available && status=='idle'` → else "Unavailable"
2. skill: rescue→`rescue`; medical→`medical`; food→`logistics`
3. certification: medical → `medical_certified` → else **"Medical certification missing"**
4. vehicle: rescue in a flood → `boat|4x4`; food → capacity ≥ 1 with a vehicle
5. top 3 by straight-line distance → Mapbox route → safety check → drop unsafe ("Route intersects HZ-01")
6. rank by ETA → best candidate

### 5.5 Route safety
- shapely `LineString(route)` vs active hazard `Polygon`s and blocked-road `LineString.buffer(~15 m)`.
- Returns the first violation `{safe:false, reason, hazard_id}`. Degree-based buffering is fine at city scale.

### 5.6 Safe-route search
1. Mapbox `driving`, `alternatives=true`, `geometries=geojson`, `overview=full` → first safe alternative.
2. Else retry via each detour waypoint stored on the violating hazard (`hazard.detour_waypoints`).
3. Else no safe route → candidate rejected.

### 5.7 Reroute (hero) — runs on any hazard activation / creation
For each ACTIVE assignment:
1. `check_route_safety(current route)`; if safe → skip.
2. Set status REROUTING, audit `ROUTE_INVALIDATED` (hazard id, previous ETA), SSE.
3. Run the safe-route search from the volunteer's current position. If found: store `previous_route_geometry`, the new route and ETA; audit `ROUTE_RECALCULATED` (old/new ETA); set ACTIVE.
4. If nothing is found: try the next eligible volunteer. If none: set FAILED and open a human escalation approval.

This runs in the backend, actor `safety-monitor`. It is safety-critical and latency-critical, so no LLM is involved.

### 5.8 State machines (enforced in services; illegal transitions raise)
- Report: `RECEIVED → STRUCTURING → STRUCTURED → (NEEDS_REVIEW | TRIAGED) → (AWAITING_APPROVAL | READY_FOR_DISPATCH) → DISPATCHED → IN_PROGRESS → COMPLETED`; `REJECTED` and `FAILED` are terminal.
- Assignment: `PROPOSED → (AWAITING_APPROVAL →) ACTIVE ⇄ REROUTING → COMPLETED`; `CANCELLED` and `FAILED` are terminal.
- **Idempotency:** one non-terminal assignment per report. A repeated `propose_assignment` returns the existing one.

---

## 6. Data Model (Postgres, created by SQLAlchemy `create_all` + seed script)

The spec §19 tables plus these additions:
- `reports`: `+ location_confidence`, `triage_evidence jsonb`, `priority_score`, `priority_breakdown jsonb`, `policy_decision`, `policy_rule`, `orchestrator`, `lease_until`, `scenario_run_id`
- `volunteers`: `+ callsign`, `home_lat/home_lng` (for reset)
- `hazards`: `geometry jsonb (GeoJSON)`, `+ kind (flood_zone|blocked_road)`, `detour_waypoints jsonb`
- `assignments`: `+ previous_route_geometry`, `previous_eta_seconds`, `explanation`, `proposed_by`
- `audit_entries`: `+ run_id`, `agent_name`, `seq bigserial` (stable ordering)
- `system_state` (single row): `orchestration_mode`, `nuroen_status`, `scenario_status`, `scenario_run_id`

Reset = truncate reports, assignments, approvals, audit; restore volunteers to home; deactivate scenario hazards.

---

## 7. Product API & Realtime

As in spec §18, plus:
- `GET /api/state`: one snapshot (reports, volunteers, hazards, assignments, approvals, system status) for a single fetch.
- `POST /api/system/mode`: set `nuroen|local|auto` (demo: kill Nuroen live to show the fallback).
- `GET /api/events` (SSE): events `report.updated`, `assignment.updated`, `approval.updated`, `hazard.updated`, `audit.appended`, `system.updated`. Keepalive every 15s.

**Frontend sync rule:** on any SSE event, refetch `/api/state` (debounced 200 ms). Append audit entries incrementally. The backend is the only source of truth, so the UI can't drift from it.

---

## 8. Demo World (Guwahati)

Exact coordinates get tuned in Phase 1 against real Mapbox routes. Intent:

| Place (scenario text) | Real area |
|---|---|
| Riverside Apartments | Uzan Bazaar, Brahmaputra riverfront |
| Central Market | Fancy Bazaar |
| Station Road | Paltan Bazaar, near Guwahati Railway Station |
| Volunteer base | Dispur / Ganeshguri / Chandmari |

**Hazards**
- `HZ-01` Anil Nagar–Nabin Nagar flood zone: **active at start** (first routes visibly avoid it).
- `HZ-02` Zoo Road / GS Road corridor flood zone: **inactive**. The simulator activates it at t=35s, and it is placed to **cut V-04's active route**, with a detour waypoint seeded.
- `BR-01` blocked road segment: active.

**Volunteers (6)**, seeded to reproduce the spec §13 funnel:
| ID | Skills | Med cert | Vehicle | Avail | Role in demo |
|---|---|---|---|---|---|
| V-01 | rescue | no | boat | yes | rescue alternative |
| V-02 | rescue, first_aid | **no** | 4x4 | yes | **rejected for medical: certification missing** |
| V-03 | medical | yes | car | **no** | rejected: unavailable |
| V-04 | rescue | no | 4x4 | yes | **selected for rescue**, rerouted |
| V-05 | medical | yes | car | yes | selected for medical (after approval) |
| V-06 | logistics | no | truck (cap 20) | yes | food delivery |

**Scenario `flood_demo.json`**
| t | Event | Exercises |
|---|---|---|
| 0s | Official: "Family trapped near Riverside Apartments, ground floor flooding quickly." | auto-dispatch, V-04, route avoids HZ-01 |
| 8s | Citizen: "Person unconscious near Central Market." | GOV-01 approval, V-02 rejected |
| 18s | Citizen: "Need drinking water for 15 people near Station Road." | GOV-03 auto, V-06 |
| 24s | Anonymous: "help water everywhere pls" | UNC-01 → NEEDS_REVIEW |
| 35s | Hazard HZ-02 activates | **reroute hero** |

Timings are configurable, and the scenario has a `manual` mode where the presenter clicks "Next event".

---

## 9. Frontend

Layout: left = IncidentFeed, center = MapView, right = ApprovalQueue + Governance decisions, bottom drawer = AuditTimeline. Top bar = SystemStatus (Nuroen ● ok / degraded), mode toggle, ScenarioControls, FallbackModeBanner.

| Component | Key behaviour |
|---|---|
| MapView | GeoJSON sources: incidents (color by priority), volunteers (by status), routes (active solid, previous dashed red for 5s on reroute), hazards (fill, pulse on activation), click map to toggle hazard |
| IncidentCard | raw text, source badge, need, priority with breakdown tooltip, trust, state chip, policy rule |
| ApprovalCard | reason + rule id, proposed volunteer, ETA, explanation, Approve / Reject |
| GovernanceBadge | BLOCKED / APPROVAL REQUIRED / VOLUNTEER REJECTED / ROUTE REJECTED |
| AgentRunPanel | per report: Intake → Triage → Governance → Dispatch steps lit from audit entries (actor, agent, ms) |
| AuditTimeline | filterable by entity; shows actor, policy rule, before/after |
| Report form | text + source select → `POST /api/reports` |

Visual style: dark command-center, monospace for IDs, red/amber/green status colors only. No chat UI.

---

## 10. Deployment & Config

**Backend env (Render):** `DATABASE_URL` (Supabase **pooler** URI, because the direct host is IPv6-only and fails from Render), `MAPBOX_TOKEN`, `MAPBOX_MODE=live|cache_first|cache_only`, `TOOLS_API_KEY`, `NUROEN_TRIGGER_URL`, `NUROEN_API_KEY`, `NUROEN_TIMEOUT_S=45`, `ORCHESTRATION_MODE=auto`, `CORS_ORIGINS`.
**Frontend env (Vercel):** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_MAPBOX_TOKEN` (URL-restricted public token).
Render runs **1 instance, 1 worker** (in-process event bus and watchdog). The backend is deployed in Phase 0 so Nuroen has a public URL from the start.

---

## 11. Build Schedule (solo + Claude, ~7h)

| Phase | Claude (code) | You | Exit gate ✅ |
|---|---|---|---|
| **P0 0:00–0:45** | git init, backend skeleton, models, seed, `/api/state`, deploy to Render; Next shell + map | Supabase project, Render/Vercel setup, env vars, **Nuroen spike §4.8** | Public `/tools/openapi.json` live; map renders Guwahati |
| **P1 0:45–2:00** | mapbox+cache, safety, routing, eligibility, trust, priority, policy, assignments, audit, SSE, local orchestrator, simulator; markers, routes, hazards, feed | tune coordinates/hazards with me; report spike findings | **Full scenario runs in local mode with routes on map** |
| **P2 2:00–3:00** | approvals, governance badges, audit timeline, **reroute** | test the demo flow by hand | **Entire demo works without any LLM, including the reroute** |
| **P3 3:00–4:30** | tools OpenAPI polish, `nuroen.py` trigger, lease/watchdog, agent prompts in `nuroen/` | build the 4 agents on the Nuroen canvas, bind connector, publish | **One report travels fully through Nuroen into a product action** |
| **P4 4:30–5:30** | AgentRunPanel, fallback banner, mode toggle, reset hardening, Vercel deploy, tests | full rehearsal ×3 | tag `v0.1-demo-stable` |
| **P5 5:30–7:00** | bug fixes, warm the Mapbox cache, optional Twilio on branch | record backup video, rehearse script | demo-ready |

Rule: never start the next phase with the previous exit gate red. Cut order follows spec §31.

---

## 12. Testing

- **Unit (pytest):** trust, priority, policy rules, eligibility funnel, safety intersection, state transitions, idempotency, the 409 ownership guard.
- **Scenario test:** run `flood_demo` in local mode against a test DB with `MAPBOX_MODE=cache_only`, and assert the final states (V-04 rerouted, V-02 rejected, approval pending, NEEDS_REVIEW).
- **Chaos checks (P4):** Nuroen trigger 500 / timeout, Mapbox down (cache only), backend restart mid-scenario, browser reload, double reset.

---

## 13. Risks Specific to This Plan

| Risk | Mitigation |
|---|---|
| Nuroen has no programmatic trigger | Trigger options B→C→D (§4.7); local mode keeps the product whole |
| Nuroen auto-generated skills get our schemas wrong | Flat, small request bodies; examples in OpenAPI; MCP plan B |
| Nuroen latency > 45s per report | Lease extends on progress; tune timeout after spike |
| Strict RAG declines disaster text | Keep Strict RAG off on Intake |
| Mapbox alternatives never avoid HZ-02 | Seeded detour waypoint; cache the known-good route |
| Supabase connection from Render | Use the pooler URI; verify in P0 |
| Credits burn during rehearsals | Rehearse in `local` mode; Nuroen runs only for integration tests and the final runs |

---

## 14. Decision Log
- 2026-10-03: Plan v1 locked. City Guwahati. Approvals canonical in our DB. Async write-back integration with Nuroen. Reroute is deterministic in the backend.
