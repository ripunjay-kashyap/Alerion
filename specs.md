# Disaster Relief Router — Nuroen Hackathon Build Specification

## 1. Project Summary

### Working title
**Disaster Relief Router**

### One-line pitch
A governed multi-agent disaster response system that turns messy incident reports into safe, auditable volunteer assignments and live Mapbox routes.

### Core thesis
During disasters, the hard problem is not simply finding a route. The hard problem is deciding:

- what happened,
- where it happened,
- how urgent it is,
- whether the report is trustworthy,
- who is qualified to respond,
- whether the proposed action is safe,
- who approved the action,
- and how to adapt when conditions change.

The system combines:

- **Nuroen** for agent orchestration, governance, approvals, connectors, and run visibility,
- **FastAPI** for deterministic execution and safety logic,
- **Supabase/Postgres** for canonical operational state,
- **Mapbox** for geocoding, routing, hazards, and live map visualization,
- **Next.js** for the operational dashboard.

The product must remain functional even if Nuroen is temporarily unavailable.

---

# 2. Hackathon Context

## Event framing

The hackathon expects teams to build a functional AI agent with:

1. a working agent,
2. explicit governance,
3. a real automated workflow.

The organizer emphasized:

- multi-agent workflows,
- deterministic, probabilistic, and agentic flow types,
- connectors,
- human-in-the-loop governance,
- auditability,
- cost and action controls,
- "safe by default" behavior,
- complex domain workflows rather than simple chatbots.

Nuroen is positioned as an enterprise agent platform for:

- conversational agent creation,
- multi-agent orchestration,
- connectors,
- governance,
- approvals,
- audit trails,
- runtime visibility,
- deployment and monitoring.

This project should therefore use Nuroen meaningfully, not cosmetically.

---

# 3. Primary Design Principle

## Nuroen must be central to the judged workflow, but not a single point of failure

The system is split into three planes:

### 1. Orchestration / Control Plane — Nuroen
Responsible for:

- master coordination,
- specialist agent handoffs,
- governed decision flow,
- human approval gates,
- connector/tool invocation,
- auditability,
- agent execution visibility.

### 2. Execution / Safety Plane — FastAPI backend
Responsible for:

- deterministic incident normalization fallback,
- trust-score calculation,
- priority calculation,
- volunteer eligibility,
- volunteer ranking,
- hazard intersection checks,
- route safety validation,
- assignment state,
- rerouting,
- simulator,
- fallback execution.

### 3. Visualization / Operations Plane — Next.js + Mapbox
Responsible for:

- live incident map,
- volunteer positions,
- active routes,
- hazard layers,
- approval queue,
- governance decisions,
- audit timeline,
- simulator controls,
- operator actions.

### Canonical state
Operational state lives in **Supabase/Postgres**, not only inside Nuroen.

Nuroen reads and writes state through backend tools/APIs.

---

# 4. Reliability Principle

## Graceful degradation

The project must still demo successfully if Nuroen fails, times out, or becomes unreachable.

### Normal path
```text
Report
  ↓
Nuroen Master Coordinator
  ↓
Intake Agent
  ↓
Triage Agent
  ↓
Governance / Approval Gate
  ↓
Dispatch Agent
  ↓
Backend Tools
  ↓
Mapbox + Supabase
  ↓
Visible operational result
```

### Fallback path
```text
Report
  ↓
FastAPI fallback workflow
  ↓
Deterministic parsing for known demo scenarios
  ↓
Policy checks
  ↓
Priority + volunteer matching
  ↓
Route generation
  ↓
Mapbox + Supabase
  ↓
Visible operational result
```

If fallback mode is active, the UI should show:

> **Nuroen orchestration unavailable — using local safe fallback workflow**

The demo must not collapse because of an external platform dependency.

---

# 5. User Experience

## Main dashboard layout

Recommended desktop layout:

### Left panel
**Live Incident Feed**

Shows:

- raw report text,
- source type,
- extracted need,
- urgency,
- trust status,
- current workflow state.

### Center
**Mapbox Operational Map**

Layers:

- incidents,
- volunteers,
- active assignments,
- routes,
- flooded zones,
- blocked roads,
- completed tasks.

### Right panel
**Governance / Approval Queue**

Shows:

- actions requiring approval,
- blocked actions,
- policy violations,
- rejected volunteers,
- route safety failures,
- human override controls.

### Bottom drawer or expandable panel
**Decision / Audit Timeline**

Shows:

```text
Report received
↓
Location extracted
↓
Need classified
↓
Trust evaluated
↓
Policy checked
↓
Volunteers filtered
↓
Route safety checked
↓
Approval requested
↓
Dispatcher approved
↓
Assignment created
↓
Route dispatched
```

---

# 6. Supported Incident Types

For the hackathon MVP, support exactly three incident categories:

1. **Rescue**
2. **Medical**
3. **Food / Supplies**

Avoid adding more categories unless the full MVP is stable.

---

# 7. Report Sources

## Required MVP sources

### Simulator
Deterministic replay of predefined disaster reports.

### Web form
Manual incident submission from the dashboard.

## Optional post-MVP source

### Twilio SMS / WhatsApp

Twilio is not part of the required MVP.

Development strategy:

```text
main
└── stable product without Twilio

feature/twilio-ingestion
└── optional integration after core completion
```

If Twilio works reliably, merge it.

If it introduces instability or consumes too much time, discard the branch.

All ingestion methods must call the same normalized report-ingestion interface.

---

# 8. Multi-Agent Architecture

Do not create agents merely to increase agent count.

Each agent must have a distinct responsibility.

## 8.1 Master Disaster Coordinator

### Role
Orchestrates the full workflow.

### Responsibilities

- receives normalized incident event,
- decides which specialist agent runs next,
- handles handoffs,
- invokes governance checks,
- invokes tools,
- tracks workflow state,
- escalates when human approval is required,
- returns final action result.

### Inputs

- incident ID,
- report content,
- current operational state,
- available tools,
- governance constraints.

### Outputs

- next workflow action,
- tool call request,
- approval request,
- dispatch result,
- escalation result.

---

## 8.2 Intake Agent

### Role
Convert messy human reports into structured incident data.

### Example input

> "Old couple stuck near Market Road, water is rising and one person needs insulin."

### Expected output

```json
{
  "need_type": "medical",
  "location_text": "Market Road",
  "people_affected": 2,
  "urgency_clues": [
    "water rising",
    "insulin dependency"
  ],
  "medical_context": "insulin dependency",
  "source_type": "citizen",
  "confidence": 0.87,
  "ambiguities": []
}
```

### Responsibilities

- extract location,
- classify need,
- extract urgency clues,
- detect number of people,
- extract medical indicators,
- identify uncertainty,
- avoid inventing missing information.

### Governance rule

If critical fields are missing or confidence is too low, do not dispatch.

Escalate to clarification or human review.

---

## 8.3 Triage Agent

### Role
Interpret incident severity and relevant operational context.

### Responsibilities

- assess semantic urgency,
- identify vulnerability indicators,
- interpret escalation language,
- flag life-safety situations,
- pass structured evidence into deterministic priority scoring.

### Important constraint

The Triage Agent does **not** directly decide final priority.

The final priority score is deterministic.

---

## 8.4 Governance Layer

Governance should use Nuroen's built-in governance/approval capabilities wherever practical.

It must also be reflected visibly in the product.

### Responsibilities

- source trust evaluation,
- approval requirements,
- scope checks,
- human-in-the-loop gates,
- policy enforcement,
- audit provenance,
- action authorization.

### Example visible decisions

```text
BLOCKED BY POLICY
Citizen report requires confirmation.

APPROVAL REQUIRED
Life-safety dispatch requires dispatcher authorization.

VOLUNTEER REJECTED
Medical certification required.

ROUTE REJECTED
Proposed route intersects Flood Zone B.
```

---

## 8.5 Dispatch Agent

### Role
Coordinate eligible volunteer selection and dispatch.

### Responsibilities

- request eligible volunteer list,
- inspect deterministic ranking results,
- request route generation,
- request route-safety validation,
- produce concise dispatch explanation,
- initiate assignment creation only after policy approval.

### Important constraint

The Dispatch Agent does not independently decide:

- medical eligibility,
- route safety,
- hazard intersection,
- final priority score.

Those are deterministic backend functions.

---

# 9. Hybrid Intelligence Strategy

## LLM / Agent responsibilities

Use LLM reasoning where ambiguity exists:

- messy text extraction,
- semantic classification,
- urgency clue interpretation,
- ambiguity detection,
- short operator-facing explanations,
- specialist-agent routing,
- deciding when more information is required.

## Deterministic responsibilities

Use code for:

- trust-score formula,
- final urgency / priority score,
- medical-certification requirements,
- vehicle constraints,
- volunteer availability,
- volunteer ranking,
- route/hazard intersection,
- blocked-road enforcement,
- safety gates,
- assignment state,
- audit persistence.

## Why this split exists

Hard safety constraints should not depend on stochastic LLM output.

Benefits:

- reproducibility,
- easier debugging,
- safer behavior,
- judge-friendly architecture,
- deterministic replay,
- simpler fallback mode.

---

# 10. Governance Model

Governance is both:

1. a Nuroen runtime / approval capability,
2. a visible product feature.

A local policy representation can still exist for deterministic domain rules.

## Suggested policy config

```yaml
sources:
  official:
    trust_level: high
    auto_process: true

  citizen:
    trust_level: unverified
    sensitive_action_requires_approval: true

dispatch:
  life_safety_requires_human_approval: true

volunteers:
  medical_requires_certification: true
  unavailable_cannot_receive_tasks: true

routing:
  forbid_active_hazard_zones: true
  forbid_blocked_roads: true

privacy:
  expose_victim_details_only_to_assigned_responder: true

uncertainty:
  minimum_location_confidence: 0.70
  minimum_incident_confidence: 0.65
  below_threshold_action: human_review
```

---

# 11. Trust Scoring

Trust should be simple and explainable.

Do not use an opaque LLM-generated trust score.

## Suggested base trust

```text
official_feed = 1.00
verified_operator = 0.90
citizen_report = 0.55
anonymous_report = 0.40
```

Possible modifiers:

```text
+0.15 second independent confirmation
+0.10 geolocation matches known incident zone
+0.10 supporting image/evidence
-0.15 conflicting location
-0.20 contradictory report
```

Clamp result to:

```text
0.0 ≤ trust_score ≤ 1.0
```

MVP can keep this simpler if necessary.

---

# 12. Priority Scoring

Priority must be deterministic and explainable.

Suggested structure:

```text
priority_score =
    severity_score
  + wait_time_score
  + vulnerability_score
  + hazard_escalation_score
```

Example weights:

```text
severity_score:          0–50
wait_time_score:         0–20
vulnerability_score:     0–20
hazard_escalation_score: 0–10
```

Maximum:

```text
100
```

Suggested severity bases:

```text
medical = 40
rescue = 35
food   = 20
```

Then adjust using structured evidence.

The exact formula may be simplified during implementation, but it must remain deterministic and visible.

---

# 13. Volunteer Matching

## Volunteer attributes

Each volunteer should have:

- ID,
- name / callsign,
- current latitude,
- current longitude,
- availability,
- skills,
- medical certification,
- vehicle,
- capacity,
- active assignment,
- current status.

## Selection pipeline

```text
incident
  ↓
filter unavailable volunteers
  ↓
filter required skill
  ↓
filter certification
  ↓
filter incompatible vehicle
  ↓
generate safe routes
  ↓
remove unsafe routes
  ↓
rank remaining candidates by ETA
  ↓
select best candidate
```

Example:

```text
Medical incident
↓
6 volunteers total
↓
3 medically certified
↓
2 available
↓
1 has safe route
↓
Volunteer V-04 selected
```

---

# 14. Routing and Hazard Safety

## Mapbox responsibilities

Use Mapbox for:

- map rendering,
- geocoding,
- directions,
- route geometry,
- ETA.

## Backend responsibilities

Backend must validate route safety.

### Inputs

- route geometry,
- blocked road definitions,
- hazard polygons,
- current incident,
- volunteer.

### Output

```json
{
  "safe": false,
  "reason": "Route intersects active flood zone",
  "hazard_id": "HZ-02"
}
```

The LLM must never override a failed deterministic safety check.

---

# 15. Live Rerouting

This is the primary hero demo.

## Scenario

1. Volunteer is dispatched.
2. Route appears on Mapbox.
3. Operator marks a road/zone as flooded.
4. Active route becomes invalid.
5. Backend detects intersection.
6. Existing route is invalidated.
7. New route is requested.
8. Safe route is validated.
9. Map redraws route.
10. ETA updates.
11. Audit event is created.

### UI event

```text
ROUTE INVALIDATED

Reason:
New flood hazard intersects active route.

Action:
Safe route recalculated.

Previous ETA: 6 min
New ETA: 9 min
```

---

# 16. Nuroen Integration Strategy

## Goal

Use Nuroen in a way that:

- clearly demonstrates its value,
- is visible to judges,
- uses its governance/orchestration strengths,
- does not make the product fragile.

## Nuroen should own

- Master Disaster Coordinator,
- agent workflow / handoffs,
- specialist agent prompts,
- tool / connector invocation,
- approval gates,
- human-in-the-loop workflow,
- run visibility,
- governance provenance,
- audit execution context.

## Nuroen should NOT exclusively own

- canonical operational state,
- route safety truth,
- volunteer eligibility truth,
- hazard geometry,
- simulator,
- Mapbox rendering,
- deterministic assignment rules.

---

# 17. Backend Tools Exposed to Nuroen

Expose small, narrow tools.

Suggested endpoints:

```text
POST /tools/geocode
POST /tools/get-incident
POST /tools/get-volunteers
POST /tools/calculate-priority
POST /tools/get-eligible-volunteers
POST /tools/get-route
POST /tools/check-route-safety
POST /tools/create-assignment
POST /tools/reroute-assignment
POST /tools/log-policy-event
POST /tools/get-operational-state
```

## Tool design principle

Tools should do one thing well.

Avoid a giant endpoint such as:

```text
POST /do-everything
```

Nuroen should visibly orchestrate multiple meaningful steps.

---

# 18. Public / Product API

Suggested application endpoints:

## Reports

```text
POST /api/reports
GET  /api/reports
GET  /api/reports/{id}
```

## Simulation

```text
POST /api/scenario/start
POST /api/scenario/reset
GET  /api/scenario/status
```

## Volunteers

```text
GET /api/volunteers
GET /api/volunteers/{id}
```

## Hazards

```text
GET  /api/hazards
POST /api/hazards
POST /api/hazards/{id}/activate
POST /api/hazards/{id}/deactivate
```

## Assignments

```text
GET  /api/assignments
GET  /api/assignments/{id}
POST /api/assignments/{id}/complete
```

## Approvals

```text
GET  /api/approvals
POST /api/approvals/{id}/approve
POST /api/approvals/{id}/reject
```

## Audit

```text
GET /api/audit
GET /api/audit/{entity_id}
```

## Realtime

Preferred:

```text
GET /api/events
```

using SSE.

Supabase Realtime is optional.

---

# 19. Data Model

## reports

```text
id
raw_text
source_type
source_identifier
location_text
latitude
longitude
need_type
people_affected
medical_context
urgency_clues
confidence
trust_score
verification_status
workflow_status
created_at
updated_at
```

## volunteers

```text
id
name
latitude
longitude
available
skills[]
medical_certified
vehicle_type
capacity
status
created_at
updated_at
```

## hazards

```text
id
type
label
geometry
severity
active
source
created_at
updated_at
```

## assignments

```text
id
report_id
volunteer_id
status
priority_score
route_geometry
route_eta_seconds
route_distance_meters
created_at
updated_at
completed_at
```

## approvals

```text
id
report_id
assignment_id
action_type
reason
status
requested_by
approved_by
created_at
resolved_at
```

## audit_entries

```text
id
entity_type
entity_id
event_type
actor_type
actor_id
message
policy_rule
input_snapshot
output_snapshot
created_at
```

---

# 20. Workflow States

## Report states

```text
RECEIVED
STRUCTURING
STRUCTURED
NEEDS_REVIEW
TRIAGED
AWAITING_APPROVAL
READY_FOR_DISPATCH
DISPATCHED
IN_PROGRESS
COMPLETED
REJECTED
FAILED
```

## Assignment states

```text
PROPOSED
AWAITING_APPROVAL
ACTIVE
REROUTING
COMPLETED
CANCELLED
FAILED
```

---

# 21. Simulator

The simulator is mandatory.

## Purpose

- deterministic demo,
- reproducible agent workflow,
- no dependence on live disaster APIs,
- guaranteed governance cases,
- guaranteed rerouting case.

## Scenario file

Example:

```text
/scenarios/flood_demo.json
```

Suggested events:

```json
[
  {
    "at_seconds": 0,
    "type": "report",
    "payload": {
      "text": "Family trapped near Riverside Apartments, ground floor flooding quickly.",
      "source": "official"
    }
  },
  {
    "at_seconds": 8,
    "type": "report",
    "payload": {
      "text": "Person unconscious near Central Market.",
      "source": "citizen"
    }
  },
  {
    "at_seconds": 18,
    "type": "report",
    "payload": {
      "text": "Need drinking water for 15 people near Station Road.",
      "source": "citizen"
    }
  },
  {
    "at_seconds": 35,
    "type": "hazard",
    "payload": {
      "hazard_id": "HZ-02",
      "active": true
    }
  }
]
```

Use fixed coordinates for demo reliability if geocoding variability becomes a problem.

---

# 22. Knowledge Base Usage

Nuroen knowledge-base/RAG capability can be used for static context such as:

- disaster response SOP,
- volunteer operating rules,
- medical task policy,
- escalation policy,
- city emergency guidelines.

Do **not** use knowledge retrieval as the source of truth for live state.

Live state must come from:

- APIs,
- database,
- backend tools.

---

# 23. Optional Twilio Integration

Only start after the stable MVP works.

## Branch

```text
feature/twilio-ingestion
```

## Flow

```text
SMS
↓
Twilio webhook
↓
POST /api/reports
↓
same normalization pipeline
↓
Nuroen workflow
↓
map + governance + dispatch
```

No Twilio-specific logic should exist inside triage or dispatch.

Twilio is just another ingestion adapter.

---

# 24. Frontend Components

Suggested components:

```text
MapView
IncidentFeed
IncidentCard
VolunteerMarker
IncidentMarker
HazardLayer
RouteLayer
ApprovalQueue
ApprovalCard
GovernanceBadge
AuditTimeline
AgentRunPanel
ScenarioControls
SystemStatus
FallbackModeBanner
```

---

# 25. Visual Language

The interface should feel like an operational command center, not a chatbot.

Avoid:

- giant chat window,
- excessive text generation,
- decorative AI gradients everywhere,
- fake terminal spam.

Prioritize:

- map,
- statuses,
- routes,
- incident severity,
- policy outcomes,
- approvals,
- operational timeline.

---

# 26. Hero Demo Script

Target: approximately 3 minutes.

## 0:00–0:20 — Problem

Show the map.

Say:

> "During a flood, reports arrive faster than dispatchers can verify, prioritize and route responders. Our system turns those reports into governed, auditable dispatch actions."

## 0:20–0:45 — Start scenario

Press:

> **Start Disaster Scenario**

Reports arrive.

Pins appear.

Nuroen workflow begins.

Show:

```text
Intake → Triage → Governance → Dispatch
```

## 0:45–1:15 — First dispatch

A verified rescue request is processed.

Show:

- volunteers being filtered,
- selected volunteer,
- safe route,
- short explanation.

Example:

```text
Assigned V-04

✓ Rescue trained
✓ Available
✓ ETA 6 min
✓ Route outside active hazards
```

## 1:15–1:50 — Governance

Citizen medical report arrives.

Show:

```text
HUMAN APPROVAL REQUIRED
```

Also show:

```text
V-02 REJECTED
Medical certification missing
```

Approve the action.

Dispatch continues.

## 1:50–2:20 — Reroute wow moment

Activate a new flood zone.

Existing route turns invalid.

Show:

```text
ROUTE INVALIDATED
New hazard intersects active route.
```

Route disappears/redraws.

New ETA appears.

## 2:20–2:45 — Nuroen proof

Briefly show Nuroen execution graph / run history.

Explain:

> "Nuroen orchestrates our specialist agents and governance gates, while deterministic geospatial tools execute safety-critical actions."

## 2:45–3:00 — Auditability

Open audit timeline.

Show:

- who proposed,
- what policy ran,
- who approved,
- which volunteer was selected,
- what changed during reroute.

End with:

> "The system does not just recommend. It acts — but every action is constrained, explainable and accountable."

---

# 27. Functional Definition of Done

Do not prioritize polish until all required items pass.

## Ingestion

- [ ] web form submits a report
- [ ] simulator replays deterministic reports
- [ ] reports persist
- [ ] report feed updates

## AI

- [ ] Intake Agent extracts structured report
- [ ] low-confidence extraction is handled safely
- [ ] Triage Agent produces semantic urgency evidence
- [ ] Nuroen master flow runs end-to-end

## Governance

- [ ] unverified life-safety report requires approval
- [ ] medical certification rule works
- [ ] policy outcomes are visible
- [ ] approval queue works
- [ ] approve/reject works
- [ ] major policy actions are audited

## Volunteers

- [ ] volunteers appear on map
- [ ] unavailable volunteers are filtered
- [ ] skills are enforced
- [ ] medical certification is enforced
- [ ] eligible volunteers are ranked

## Routing

- [ ] route can be generated
- [ ] route appears on map
- [ ] hazard intersection works
- [ ] unsafe route is rejected
- [ ] new hazard can invalidate active route
- [ ] rerouting works
- [ ] route update is visible

## Reliability

- [ ] Nuroen failure does not kill the demo
- [ ] fallback mode works
- [ ] scenario reset works
- [ ] frontend/backed deployed integration works
- [ ] system can be demoed from a clean reload

## Optional

- [ ] Twilio SMS ingestion
- [ ] Twilio dispatch message
- [ ] additional connectors

---

# 28. Seven-Hour Build Plan

The actual hackathon window is short, so work in strict phases.

## Hour 0–1 — Skeleton + Data

Goal: get the entire product shape running.

Build:

- Next.js shell,
- Mapbox view,
- FastAPI backend,
- data models,
- seed volunteers,
- seed hazards,
- simulator JSON,
- basic report endpoint.

Do not spend time polishing UI.

---

## Hour 1–2 — Core Map Workflow

Build:

- incident markers,
- volunteer markers,
- route drawing,
- hazard drawing,
- Mapbox directions integration,
- deterministic volunteer filtering.

At the end of Hour 2:

> A fake incident should create a visible assignment and route.

---

## Hour 2–3 — Safety + Governance

Build:

- priority scoring,
- medical certification enforcement,
- approval queue,
- route hazard checks,
- audit entries,
- blocked-action UI.

At the end of Hour 3:

> The product should already demonstrate meaningful governance without any LLM.

---

## Hour 3–4 — Nuroen Integration

Build:

- Master Coordinator,
- Intake Agent,
- Triage Agent,
- Dispatch Agent,
- tool/API connections,
- approval/gate integration where supported,
- backend → Nuroen call path,
- Nuroen → backend tool path.

Keep backend deterministic fallback available.

At the end of Hour 4:

> One complete report should successfully travel through Nuroen and produce a product action.

---

## Hour 4–5 — Hero Reroute

Build and stabilize:

- hazard activation interaction,
- active route invalidation,
- reroute logic,
- map transition,
- audit event,
- policy explanation.

This is the highest-priority demo sequence.

---

## Hour 5–6 — UX + Reliability

Polish:

- command-center layout,
- governance badges,
- approval queue,
- agent workflow status,
- audit timeline,
- route animation if trivial,
- clear loading/error states.

Test:

- reset scenario,
- repeated runs,
- Nuroen timeout,
- Mapbox failure behavior,
- backend restart,
- fresh browser reload.

Create stable checkpoint:

```text
v0.1-demo-stable
```

---

## Hour 6–7 — Optional Integrations + Demo Prep

Only if stable:

1. add Twilio branch,
2. connect additional Nuroen connector if useful,
3. improve animations,
4. record backup demo.

Do not jeopardize the stable branch.

---

# 29. Branch Strategy

## Main

```text
main
```

Must always contain the stable product.

## Nuroen work

If risky:

```text
feature/nuroen-integration
```

Merge once stable.

## Twilio

```text
feature/twilio-ingestion
```

Optional.

## Stable tag

Before optional features:

```text
v0.1-demo-stable
```

---

# 30. Risk Register

## Risk 1 — Nuroen API / platform instability

### Mitigation

- backend fallback workflow,
- short timeouts,
- cached known demo extraction if needed,
- system-status indicator,
- never store critical state only in Nuroen.

---

## Risk 2 — Mapbox geocoding inconsistency

### Mitigation

For demo scenario:

- store known coordinates alongside human-readable locations.

Use geocoding for manual form submissions, not as a hard requirement for deterministic replay.

---

## Risk 3 — Route exclusion complexity

If Mapbox cannot easily avoid arbitrary polygon hazards:

1. request candidate route,
2. test geometry against hazard polygon,
3. if unsafe, request alternative waypoint/route or use predetermined safe demo alternatives.

Do not burn hackathon time building a full routing engine.

---

## Risk 4 — Multi-agent latency

### Mitigation

Do not run unnecessary agent calls.

Use:

- Intake,
- Triage,
- Coordinator,
- Dispatch,

only where each adds value.

Parallelize independent operations where possible.

---

## Risk 5 — LLM gives malformed output

### Mitigation

- strict Pydantic schema,
- structured output,
- retries,
- confidence field,
- fallback extraction for predefined demo data.

---

## Risk 6 — UI and backend state drift

### Mitigation

Backend/database is authoritative.

Frontend consumes:

- SSE,
- polling,
- or Supabase realtime.

Do not maintain independent workflow truth in frontend state.

---

## Risk 7 — Demo network failure

### Mitigation

- deterministic simulator,
- stable seeded data,
- fallback backend logic,
- recorded backup video,
- warm backend before judging.

---

# 31. Scope Cuts

If behind schedule, cut in this order:

1. Twilio
2. real official disaster feeds
3. advanced trust scoring
4. animated route transitions
5. PostGIS complexity
6. extra incident categories
7. extra agents
8. elaborate dashboards
9. advanced volunteer capacity optimization

Never cut:

- Nuroen workflow,
- visible governance,
- Mapbox route,
- approval queue,
- deterministic safety logic,
- reroute hero moment,
- audit trail,
- simulator.

---

# 32. Judging Alignment

## Agent complexity

Demonstrate:

- master coordinator,
- specialist agents,
- tool invocation,
- deterministic + probabilistic + agentic flows,
- human approval,
- environment adaptation.

## Connectors

Demonstrate meaningful external integration through:

- custom backend APIs,
- Mapbox,
- database/state connector if appropriate,
- optional Twilio.

Do not add connectors purely to increase count.

## Problem definition

Emphasize:

- incomplete information,
- urgent decisions,
- limited responders,
- changing hazards,
- safety constraints,
- accountability.

## Use case / problem size

Frame as reusable for:

- floods,
- earthquakes,
- wildfires,
- storms,
- humanitarian logistics,
- municipal emergency coordination.

Avoid claiming deployment-grade emergency reliability.

This is a hackathon prototype demonstrating the workflow.

## Implementation

Show:

- working end-to-end automation,
- visible agent decisions,
- real map actions,
- deterministic safety checks,
- human-in-the-loop governance,
- live adaptation,
- auditability,
- graceful degradation.

---

# 33. Safety / Claim Boundaries

This project is a prototype.

Do not claim:

- production emergency readiness,
- guaranteed safe routing,
- replacement of professional dispatchers,
- guaranteed report authenticity,
- medical decision-making capability.

Preferred framing:

> "A governed decision-support and dispatch automation prototype for disaster-response workflows."

Human dispatchers remain authoritative for high-risk actions.

---

# 34. Recommended README Pitch

## Disaster Relief Router

**A governed multi-agent disaster dispatch system built with Nuroen, FastAPI and Mapbox.**

During disasters, incoming reports are messy, responders have different capabilities, roads change rapidly, and autonomous actions require accountability.

Disaster Relief Router:

1. understands unstructured incident reports,
2. triages urgency,
3. applies governance policies,
4. finds qualified responders,
5. generates safe routes,
6. requires human approval for sensitive actions,
7. automatically reroutes when hazards change,
8. records every action in an audit trail.

Nuroen provides the agent orchestration and governance layer. Deterministic backend tools enforce safety-critical constraints, while Mapbox provides the live operational interface.

---

# 35. Final Architecture

```text
                         ┌─────────────────────────────┐
                         │       NEXT.JS FRONTEND      │
                         │                             │
                         │  Mapbox Operational Map     │
                         │  Incident Feed              │
                         │  Approval Queue             │
                         │  Governance Timeline        │
                         │  Audit Trail                │
                         └──────────────┬──────────────┘
                                        │
                                        │ HTTP / SSE
                                        ▼
                         ┌─────────────────────────────┐
                         │       FASTAPI BACKEND       │
                         │                             │
                         │ Canonical business logic    │
                         │ Deterministic safety        │
                         │ Simulator                   │
                         │ Fallback workflow           │
                         │ Tool endpoints              │
                         └───────┬──────────┬──────────┘
                                 │          │
                    ┌────────────┘          └─────────────┐
                    ▼                                      ▼
          ┌───────────────────────┐              ┌───────────────────┐
          │        NUROEN         │              │     SUPABASE      │
          │                       │              │                   │
          │ Master Coordinator    │              │ Reports           │
          │ Intake Agent          │              │ Volunteers        │
          │ Triage Agent          │              │ Hazards           │
          │ Dispatch Agent        │              │ Assignments       │
          │ Governance Gates      │              │ Approvals         │
          │ Human Approval        │              │ Audit entries     │
          │ Run Visibility        │              │                   │
          └───────────┬───────────┘              └───────────────────┘
                      │
                      │ custom APIs / tools
                      ▼
          ┌─────────────────────────────┐
          │       EXECUTION TOOLS       │
          │                             │
          │ Geocode                     │
          │ Priority                    │
          │ Volunteer eligibility       │
          │ Route generation            │
          │ Route safety                │
          │ Assignment creation         │
          │ Rerouting                   │
          └──────────────┬──────────────┘
                         │
                         ▼
                 ┌───────────────┐
                 │    MAPBOX     │
                 │               │
                 │ Geocoding     │
                 │ Directions    │
                 │ Map layers    │
                 └───────────────┘
```

---

# 36. Final Product Principle

> **Nuroen decides and governs the workflow.  
> The backend enforces safety and executes deterministic operations.  
> Mapbox shows the real-world consequence.  
> Supabase remembers what actually happened.**

The system should feel like a real operational agent, not a chatbot with a map attached.
