import { ApiError } from "../errors";
import type {
  ApprovalInput,
  AuditEntry,
  OpsEvent,
  OpsState,
  ReportInput,
  ScenarioStatus,
} from "../types";
import { createFixture, receivedReport, safeRoute } from "./fixtures";
import { seedHazards, seedVolunteers } from "./seed";

const copy = <T>(value: T): T => structuredClone(value);
const listeners = new Set<(event: OpsEvent) => void>();
let store: ReturnType<typeof createFixture> | null = null;
let scenario: ScenarioStatus = emptyScenario();
let startedAt = 0;
let timed: ReturnType<typeof setInterval> | null = null;
let reportCounter = 0;

function emptyScenario(): ScenarioStatus {
  return {
    status: "idle",
    scenario_id: null,
    mode: "timed",
    next_event_index: 0,
    total_events: 6,
    elapsed_s: 0,
    events: [
      {
        at_seconds: 0,
        type: "report",
        label: "Official rescue · Riverside Apartments",
        fired: false,
      },
      {
        at_seconds: 8,
        type: "report",
        label: "Citizen medical · Central Market",
        fired: false,
      },
      {
        at_seconds: 16,
        type: "report",
        label: "Food delivery · Station Road",
        fired: false,
      },
      {
        at_seconds: 24,
        type: "report",
        label: "Anonymous report · human review",
        fired: false,
      },
      {
        at_seconds: 32,
        type: "report",
        label: "Duplicate medical report merged",
        fired: false,
      },
      {
        at_seconds: 45,
        type: "hazard",
        label: "HZ-02 activates · live reroute",
        fired: false,
      },
    ],
  };
}
function data() {
  return (store ??= createFixture());
}
function emit(event: OpsEvent["event"], payload: OpsEvent["data"] = {}) {
  for (const fn of listeners) fn({ event, data: payload });
}
function append(
  fields: Pick<
    AuditEntry,
    "event_type" | "entity_type" | "entity_id" | "message"
  > &
    Partial<AuditEntry>,
) {
  const audit = data().audit;
  audit.push({
    seq: (audit.at(-1)?.seq ?? 0) + 1,
    report_id: null,
    actor_type: "system",
    actor_id: "system",
    policy_rule: null,
    input_snapshot: null,
    output_snapshot: null,
    created_at: new Date().toISOString(),
    ...fields,
  });
  emit("audit.appended");
}
function stopTimer() {
  if (timed) clearInterval(timed);
  timed = null;
}
function reset() {
  stopTimer();
  const clean: OpsState = {
    system: {
      scenario_status: "idle",
      scenario_run_id: null,
      stats: {
        reports_received: 0,
        duplicates_merged: 0,
      },
    },
    reports: [],
    assignments: [],
    approvals: [],
    hazards: copy(seedHazards),
    volunteers: copy(seedVolunteers),
  };
  store = { state: clean, audit: [] };
  scenario = emptyScenario();
  startedAt = 0;
  emit("system.reset");
  append({
    event_type: "SCENARIO_RESET",
    entity_type: "system",
    entity_id: "scenario",
    message: "Scenario reset; ready for a new run.",
  });
  return { ok: true as const };
}
function activateHazard(id: string, active: boolean) {
  const { state } = data();
  const hazard = state.hazards.find((h) => h.id === id);
  if (!hazard) throw new ApiError("Hazard not found.", 404, "not_found");
  if (hazard.active === active) return copy(hazard);
  hazard.active = active;
  append({
    event_type: active ? "HAZARD_ACTIVATED" : "HAZARD_DEACTIVATED",
    entity_type: "hazard",
    entity_id: id,
    actor_type: "human",
    actor_id: "dispatcher",
    message: `${id} ${active ? "activated" : "deactivated"}: ${hazard.label}.`,
  });
  emit("hazard.updated", { hazard_id: id });
  if (id === "HZ-02" && active) {
    const a = state.assignments.find(
      (a) => a.report_id === "INC-A" && a.status === "ACTIVE",
    );
    if (a && !a.previous_route_geometry) {
      a.previous_route_geometry = copy(a.route_geometry);
      a.previous_eta_seconds = a.route_eta_seconds;
      a.route_geometry = copy(safeRoute);
      a.route_eta_seconds = 540;
      a.route_distance_meters = 7200;
      a.updated_at = new Date().toISOString();
      a.explanation =
        "HZ-02 invalidated the original route. Safe detour recalculated around both flood zones.";
      const payload = {
        assignment_id: a.id,
        report_id: a.report_id,
        hazard_id: id,
        previous_eta_seconds: a.previous_eta_seconds,
        new_eta_seconds: 540,
      };
      append({
        event_type: "ROUTE_INVALIDATED",
        entity_type: "assignment",
        entity_id: a.id,
        report_id: a.report_id,
        actor_id: "safety-monitor",
        message: `${id} intersects the active route for ${a.volunteer_id}.`,
        input_snapshot: {
          route_geometry: a.previous_route_geometry,
          eta_seconds: a.previous_eta_seconds,
        },
        output_snapshot: payload,
      });
      append({
        event_type: "ROUTE_RECALCULATED",
        entity_type: "assignment",
        entity_id: a.id,
        report_id: a.report_id,
        actor_id: "safety-monitor",
        message: "Safe route recalculated · ETA 6 min → 9 min.",
        output_snapshot: { route_geometry: a.route_geometry, eta_seconds: 540 },
      });
      emit("assignment.updated", { ...payload, reason: "route_invalidated" });
    }
  }
  return copy(hazard);
}
function nextEvent() {
  if (scenario.status !== "running")
    throw new ApiError(
      "Start a scenario before firing an event.",
      409,
      "invalid_transition",
    );
  const index = scenario.next_event_index;
  const fixture = createFixture();
  const { state } = data();
  if (index < 5) {
    const report = copy(fixture.state.reports[index]);
    report.created_at = report.updated_at = new Date().toISOString();
    state.reports.push(report);
    state.system.stats.reports_received++;
    if (report.merged_into) {
      state.system.stats.duplicates_merged++;
      const parent = state.reports.find((r) => r.id === report.merged_into);
      if (parent) parent.duplicate_count++;
    } else {
      report.duplicate_count = 0;
    }
    for (const assignment of fixture.state.assignments.filter(
      (a) => a.report_id === report.id,
    )) {
      state.assignments.push(copy(assignment));
      const volunteer = state.volunteers.find(
        (v) => v.id === assignment.volunteer_id,
      );
      if (volunteer && assignment.status === "ACTIVE") {
        volunteer.status = "en_route";
        volunteer.available = false;
      }
    }
    state.approvals.push(
      ...copy(fixture.state.approvals.filter((a) => a.report_id === report.id)),
    );
    for (const entry of fixture.audit.filter(
      (a) => a.report_id === report.id,
    )) {
      append({
        ...entry,
        seq: (data().audit.at(-1)?.seq ?? 0) + 1,
        created_at: new Date().toISOString(),
      });
    }
    emit("report.created", { report_id: report.id });
  } else activateHazard("HZ-02", true);
  scenario.events[index].fired = true;
  scenario.next_event_index++;
  scenario.elapsed_s =
    scenario.mode === "manual"
      ? scenario.events[index].at_seconds
      : Math.floor((Date.now() - startedAt) / 1000);
  if (scenario.next_event_index === scenario.total_events) {
    scenario.status = "done";
    state.system.scenario_status = "done";
    stopTimer();
  }
  append({
    event_type: "SCENARIO_EVENT",
    entity_type: "system",
    entity_id: "scenario",
    actor_id: "simulator",
    message: scenario.events[index].label,
  });
  emit("scenario.updated");
  return copy(scenario);
}
function resolveApproval(id: string, approved: boolean, body: ApprovalInput) {
  const { state } = data();
  const approval = state.approvals.find((a) => a.id === id);
  if (!approval) throw new ApiError("Approval not found.", 404, "not_found");
  if (approval.status !== "PENDING")
    throw new ApiError(
      "This approval has already been resolved.",
      409,
      "invalid_transition",
    );
  const report = state.reports.find((r) => r.id === approval.report_id)!;
  const assignment = state.assignments.find(
    (a) => a.id === approval.assignment_id,
  );
  if (approved && approval.action_type === "review") {
    const c = body.corrections;
    if (
      !c?.location_text?.trim() ||
      c.latitude == null ||
      c.longitude == null ||
      !c.need_type ||
      !Number.isFinite(c.latitude) ||
      !Number.isFinite(c.longitude) ||
      Math.abs(c.latitude) > 90 ||
      Math.abs(c.longitude) > 180
    )
      throw new ApiError(
        "Provide a valid location, coordinates and need type for this mock review.",
        422,
      );
    Object.assign(report, c, {
      workflow_status: "READY_FOR_DISPATCH",
      policy_decision: null,
      policy_rule: null,
      policy_reason: null,
      location_confidence: 1,
      confidence: 1,
    });
    append({
      event_type: "INTAKE_STRUCTURED",
      entity_type: "report",
      entity_id: report.id,
      report_id: report.id,
      actor_type: "human",
      actor_id: "dispatcher",
      message:
        "Dispatcher corrected location and need; report ready for workflow processing.",
      output_snapshot: { corrections: c },
    });
  } else if (approved && assignment) {
    assignment.status = "ACTIVE";
    assignment.updated_at = new Date().toISOString();
    report.workflow_status = "DISPATCHED";
    const volunteer = state.volunteers.find(
      (v) => v.id === assignment.volunteer_id,
    );
    if (volunteer) {
      volunteer.available = false;
      volunteer.status = "en_route";
    }
    append({
      event_type: "ASSIGNMENT_ACTIVATED",
      entity_type: "assignment",
      entity_id: assignment.id,
      report_id: report.id,
      actor_type: "human",
      actor_id: "dispatcher",
      message: `${assignment.volunteer_id} dispatched after approval.`,
      output_snapshot: { status: assignment.status },
    });
    emit("assignment.updated", { assignment_id: assignment.id });
  } else if (!approved) {
    report.workflow_status = "REJECTED";
    if (assignment) {
      assignment.status = "CANCELLED";
      assignment.updated_at = new Date().toISOString();
    }
  }
  approval.status = approved ? "APPROVED" : "REJECTED";
  approval.approved_by = "dispatcher";
  approval.resolution_note = body.note?.trim() || null;
  approval.resolved_at = report.updated_at = new Date().toISOString();
  append({
    event_type: approved ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
    entity_type: "approval",
    entity_id: id,
    report_id: report.id,
    actor_type: "human",
    actor_id: "dispatcher",
    message: `${approval.action_type} ${approved ? "approved" : "rejected"}${body.note ? ": " + body.note : "."}`,
    policy_rule: approval.policy_rule,
    input_snapshot: { ...body },
  });
  emit("approval.updated", { approval_id: id, report_id: report.id });
  return copy(approval);
}

export function subscribeMock(listener: (event: OpsEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const mockApi = {
  state: async () => copy(data().state),
  audit: async (afterSeq = 0) =>
    copy(
      data()
        .audit.filter((a) => a.seq > afterSeq)
        .slice(0, 500),
    ),
  scenarioStatus: async () => {
    if (scenario.status === "running" && scenario.mode === "timed")
      scenario.elapsed_s = Math.floor((Date.now() - startedAt) / 1000);
    return copy(scenario);
  },
  resetScenario: async () => reset(),
  startScenario: async (mode: "timed" | "manual") => {
    reset();
    scenario.status = "running";
    scenario.scenario_id = "flood_demo";
    scenario.mode = mode;
    startedAt = Date.now();
    data().state.system.scenario_status = "running";
    data().state.system.scenario_run_id = `mock-${startedAt}`;
    append({
      event_type: "SCENARIO_STARTED",
      entity_type: "system",
      entity_id: "scenario",
      actor_id: "simulator",
      message: `Flood demo started in ${mode} mode.`,
    });
    emit("scenario.updated");
    if (mode === "timed") {
      nextEvent();
      timed = setInterval(() => {
        const next = scenario.events[scenario.next_event_index];
        if (
          scenario.status === "running" &&
          next &&
          (Date.now() - startedAt) / 1000 >= next.at_seconds
        )
          nextEvent();
      }, 500);
    }
    return copy(scenario);
  },
  nextScenarioEvent: async () => {
    if (scenario.mode !== "manual")
      throw new ApiError(
        "Next event is available in manual mode.",
        409,
        "invalid_transition",
      );
    return nextEvent();
  },
  activateHazard: async (id: string) => activateHazard(id, true),
  deactivateHazard: async (id: string) => activateHazard(id, false),
  approve: async (id: string, body: ApprovalInput = {}) =>
    resolveApproval(id, true, body),
  reject: async (id: string, body: { note?: string } = {}) =>
    resolveApproval(id, false, body),
  submitReport: async (body: ReportInput) => {
    if (!body.text.trim()) throw new ApiError("Enter an incident report.", 422);
    const report = receivedReport(
      `INC-M${++reportCounter}`,
      body.text.trim(),
      body.source,
      new Date().toISOString(),
    );
    report.source_identifier = body.source_identifier ?? null;
    data().state.reports.push(report);
    data().state.system.stats.reports_received++;
    append({
      event_type: "REPORT_RECEIVED",
      entity_type: "report",
      entity_id: report.id,
      report_id: report.id,
      message: `Report received from ${body.source}.`,
    });
    emit("report.created", { report_id: report.id });
    return copy(report);
  },
};
