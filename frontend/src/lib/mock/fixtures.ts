import type {
  Approval,
  Assignment,
  AuditEntry,
  OpsState,
  Report,
  Selection,
} from "../types";
import { seedHazards, seedVolunteers } from "./seed";

export const initialRoute: GeoJSON.LineString = {
  type: "LineString",
  coordinates: [
    [91.7749, 26.1835],
    [91.7705, 26.184],
    [91.767, 26.1845],
    [91.763, 26.186],
    [91.753, 26.189],
  ],
};
export const safeRoute: GeoJSON.LineString = {
  type: "LineString",
  coordinates: [
    [91.7749, 26.1835],
    [91.774, 26.18],
    [91.756, 26.18],
    [91.749, 26.184],
    [91.753, 26.189],
  ],
};

function selection(medical: boolean): Selection {
  const selected = medical ? "V-05" : "V-04";
  return {
    funnel: [
      {
        step: "available",
        label: "Available",
        passed: ["V-01", "V-02", "V-04", "V-05", "V-06"],
        rejected: [{ id: "V-03", reason: "Unavailable" }],
      },
      {
        step: "skill",
        label: medical ? "Medical support" : "Rescue skills",
        passed: medical ? ["V-02", "V-05"] : ["V-01", "V-02", "V-04"],
        rejected: medical
          ? [
              { id: "V-01", reason: "Medical skills missing" },
              { id: "V-04", reason: "Medical skills missing" },
              { id: "V-06", reason: "Medical skills missing" },
            ]
          : [
              { id: "V-05", reason: "Rescue skills missing" },
              { id: "V-06", reason: "Rescue skills missing" },
            ],
      },
      {
        step: "certification",
        label: medical ? "Medically certified" : "Certification eligible",
        passed: medical ? ["V-05"] : ["V-01", "V-02", "V-04"],
        rejected: medical
          ? [{ id: "V-02", reason: "Medical certification missing" }]
          : [],
      },
      {
        step: "vehicle",
        label: "Suitable vehicle",
        passed: medical ? ["V-05"] : ["V-02", "V-04"],
        rejected: medical
          ? []
          : [{ id: "V-01", reason: "Road access requires a 4x4" }],
      },
      {
        step: "route_safety",
        label: "Safe route",
        passed: [selected],
        rejected: medical
          ? []
          : [{ id: "V-02", reason: "Route intersects HZ-01" }],
      },
    ],
    candidates: [
      {
        volunteer_id: selected,
        eta_seconds: medical ? 420 : 360,
        distance_meters: medical ? 4100 : 5600,
        safe: true,
        reason: null,
        hazard_id: null,
      },
      ...(!medical
        ? [
            {
              volunteer_id: "V-02",
              eta_seconds: 240,
              distance_meters: 2700,
              safe: false,
              reason: "Route intersects HZ-01",
              hazard_id: "HZ-01",
            },
          ]
        : []),
    ],
    selected,
  };
}

export function receivedReport(
  id: string,
  text: string,
  source: Report["source_type"],
  timestamp: string,
): Report {
  return {
    id,
    raw_text: text,
    source_type: source,
    source_identifier: null,
    location_text: null,
    latitude: null,
    longitude: null,
    location_confidence: null,
    need_type: null,
    people_affected: null,
    medical_context: null,
    urgency_clues: [],
    ambiguities: [],
    confidence: null,
    triage_evidence: null,
    trust_score: null,
    trust_breakdown: null,
    verification_status: null,
    priority_score: null,
    priority_breakdown: null,
    policy_decision: null,
    policy_rule: null,
    policy_reason: null,
    workflow_status: "RECEIVED",
    merged_into: null,
    duplicate_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function createFixture(): { state: OpsState; audit: AuditEntry[] } {
  const start = Date.now() - 120_000;
  const timestamp = (seconds: number) =>
    new Date(start + seconds * 1000).toISOString();
  function report(
    id: string,
    text: string,
    seconds: number,
    fields: Partial<Report>,
  ): Report {
    return {
      ...receivedReport(id, text, "citizen", timestamp(seconds)),
      ...fields,
    };
  }
  const triaged = (priority: number, trust: number): Partial<Report> => ({
    location_confidence: 0.96,
    confidence: 0.94,
    trust_score: trust,
    trust_breakdown: { base: trust, modifiers: [], score: trust },
    verification_status: trust >= 0.8 ? "verified" : "unverified",
    priority_score: priority,
    priority_breakdown: {
      severity: priority >= 70 ? 45 : 25,
      wait_time: 8,
      vulnerability: priority >= 70 ? 20 : 5,
      hazard_escalation: priority - (priority >= 70 ? 73 : 38),
      total: priority,
    },
    triage_evidence: {
      life_safety: priority >= 70,
      vulnerabilities: priority >= 70 ? ["elderly", "medical_dependency"] : [],
      escalation_signals: ["water rising"],
      rationale:
        "Flood exposure and reported need assessed using deterministic policy.",
    },
  });
  const reports: Report[] = [
    report(
      "INC-A",
      "Official rescue: five residents including an elderly couple stranded at Riverside Apartments, Uzan Bazaar. Water is rising.",
      0,
      {
        ...triaged(82, 0.95),
        source_type: "official",
        source_identifier: "district-control",
        location_text: "Riverside Apartments · Uzan Bazaar",
        latitude: 26.189,
        longitude: 91.753,
        need_type: "rescue",
        people_affected: 5,
        urgency_clues: ["water rising", "stranded"],
        workflow_status: "DISPATCHED",
        policy_decision: "AUTO_DISPATCH",
        policy_rule: "GOV-02",
        policy_reason: "Trusted official life-safety rescue.",
      },
    ),
    report(
      "INC-B",
      "An elderly vendor at Central Market, Fancy Bazaar needs insulin urgently. Two people are trapped above the flooded entrance.",
      20,
      {
        ...triaged(78, 0.6),
        location_text: "Central Market · Fancy Bazaar",
        latitude: 26.1785,
        longitude: 91.7402,
        need_type: "medical",
        people_affected: 2,
        medical_context: "Insulin dependency",
        workflow_status: "AWAITING_APPROVAL",
        policy_decision: "APPROVAL_REQUIRED",
        policy_rule: "GOV-01",
        policy_reason: "Citizen medical dispatch requires human approval.",
        duplicate_count: 1,
      },
    ),
    report(
      "INC-C",
      "Twenty residents need food and drinking water on Station Road. Road access remains open.",
      40,
      {
        ...triaged(43, 0.6),
        location_text: "Station Road",
        latitude: 26.1792,
        longitude: 91.7518,
        need_type: "food",
        people_affected: 20,
        workflow_status: "DISPATCHED",
        policy_decision: "AUTO_DISPATCH",
        policy_rule: "GOV-03",
        policy_reason: "Routine food delivery on a safe route.",
      },
    ),
    report("INC-D", "help water everywhere pls", 60, {
      source_type: "anonymous",
      trust_score: 0.2,
      trust_breakdown: { base: 0.2, modifiers: [], score: 0.2 },
      verification_status: "low_trust",
      confidence: 0.18,
      ambiguities: ["Location unknown", "Need type unknown"],
      workflow_status: "NEEDS_REVIEW",
      policy_decision: "NEEDS_REVIEW",
      policy_rule: "UNC-01",
      policy_reason: "Location and need are too uncertain for dispatch.",
    }),
    report(
      "INC-E",
      "Same insulin emergency at Central Market. Elderly vendor and one other person stranded.",
      80,
      {
        location_text: "Central Market · Fancy Bazaar",
        latitude: 26.1785,
        longitude: 91.7402,
        need_type: "medical",
        workflow_status: "MERGED",
        merged_into: "INC-B",
      },
    ),
  ];
  function assignment(
    id: string,
    reportId: string,
    volunteerId: string,
    fields: Partial<Assignment>,
  ): Assignment {
    return {
      id,
      report_id: reportId,
      volunteer_id: volunteerId,
      status: "ACTIVE",
      priority_score:
        reports.find((r) => r.id === reportId)?.priority_score ?? null,
      route_geometry: null,
      route_eta_seconds: null,
      route_distance_meters: null,
      previous_route_geometry: null,
      previous_eta_seconds: null,
      explanation: null,
      selection: null,
      proposed_by: "dispatch-stage",
      created_at: timestamp(10),
      updated_at: timestamp(10),
      completed_at: null,
      ...fields,
    };
  }
  const assignments = [
    assignment("ASG-A", "INC-A", "V-04", {
      route_geometry: initialRoute,
      route_eta_seconds: 360,
      route_distance_meters: 5600,
      explanation:
        "Qualified 4x4 rescue team selected; safe route avoids HZ-01 and BR-01.",
      selection: selection(false),
    }),
    assignment("ASG-B", "INC-B", "V-05", {
      status: "AWAITING_APPROVAL",
      route_geometry: {
        type: "LineString",
        coordinates: [
          [91.7689, 26.1647],
          [91.756, 26.163],
          [91.75, 26.172],
          [91.7402, 26.1785],
        ],
      },
      route_eta_seconds: 420,
      route_distance_meters: 4100,
      explanation:
        "V-05 is the available medically certified volunteer with a safe route.",
      selection: selection(true),
    }),
    assignment("ASG-C", "INC-C", "V-06", {
      route_geometry: {
        type: "LineString",
        coordinates: [
          [91.7989, 26.1234],
          [91.776, 26.148],
          [91.753, 26.16],
          [91.747, 26.173],
          [91.7518, 26.1792],
        ],
      },
      route_eta_seconds: 660,
      route_distance_meters: 7300,
      explanation:
        "Supply truck has capacity for all 20 residents; route avoids active flood zones.",
      selection: {
        funnel: [
          {
            step: "available",
            label: "Available",
            passed: ["V-01", "V-02", "V-04", "V-05", "V-06"],
            rejected: [{ id: "V-03", reason: "Unavailable" }],
          },
          { step: "skill", label: "Logistics", passed: ["V-06"], rejected: [] },
          {
            step: "route_safety",
            label: "Safe route",
            passed: ["V-06"],
            rejected: [],
          },
        ],
        candidates: [
          {
            volunteer_id: "V-06",
            eta_seconds: 660,
            distance_meters: 7300,
            safe: true,
            reason: null,
            hazard_id: null,
          },
        ],
        selected: "V-06",
      },
    }),
  ];
  const approvals: Approval[] = [
    {
      id: "APR-B",
      report_id: "INC-B",
      assignment_id: "ASG-B",
      action_type: "dispatch",
      reason:
        "Medical dispatch from a citizen source requires dispatcher approval.",
      policy_rule: "GOV-01",
      status: "PENDING",
      requested_by: "policy-engine",
      approved_by: null,
      resolution_note: null,
      created_at: timestamp(30),
      resolved_at: null,
    },
    {
      id: "APR-D",
      report_id: "INC-D",
      assignment_id: null,
      action_type: "review",
      reason:
        "Confirm the location and need before this report can enter triage.",
      policy_rule: "UNC-01",
      status: "PENDING",
      requested_by: "intake-stage",
      approved_by: null,
      resolution_note: null,
      created_at: timestamp(65),
      resolved_at: null,
    },
  ];
  const volunteers = structuredClone(seedVolunteers);
  for (const v of volunteers)
    if (["V-04", "V-06"].includes(v.id)) {
      v.status = "en_route";
      v.available = false;
    }
  const state: OpsState = {
    system: {
      scenario_status: "idle",
      scenario_run_id: null,
      stats: {
        reports_received: 5,
        duplicates_merged: 1,
      },
    },
    reports,
    assignments,
    approvals,
    volunteers,
    hazards: structuredClone(seedHazards),
  };
  const audit: AuditEntry[] = [];
  function add(
    report: Report,
    event_type: AuditEntry["event_type"],
    actor_id: string,
    message: string,
    entity_id = report.id,
    entity_type: AuditEntry["entity_type"] = "report",
    snapshot: Record<string, unknown> | null = null,
  ) {
    audit.push({
      seq: audit.length + 1,
      entity_type,
      entity_id,
      report_id: report.id,
      event_type,
      actor_type: actor_id.endsWith("-stage") ? "pipeline" : "system",
      actor_id,
      message,
      policy_rule:
        event_type === "POLICY_EVALUATED" || event_type === "APPROVAL_REQUESTED"
          ? report.policy_rule
          : null,
      input_snapshot: null,
      output_snapshot: snapshot,
      created_at: new Date(
        new Date(report.created_at).getTime() + audit.length * 100,
      ).toISOString(),
    });
  }
  for (const r of reports) {
    add(
      r,
      "REPORT_RECEIVED",
      "system",
      "Report received from " + r.source_type + ".",
    );
    if (r.merged_into) {
      add(
        r,
        "REPORT_MERGED",
        "intake-stage",
        `Duplicate merged into ${r.merged_into}; one pipeline run saved.`,
        r.id,
        "report",
        { merged_into: r.merged_into },
      );
      continue;
    }
    add(
      r,
      "INTAKE_STRUCTURED",
      "intake-stage",
      r.location_text
        ? `Need and location resolved: ${r.location_text}.`
        : "Location and need remain unresolved.",
      r.id,
      "report",
      {
        need_type: r.need_type,
        location_text: r.location_text,
        confidence: r.confidence,
      },
    );
    if (r.priority_score !== null) {
      add(
        r,
        "TRUST_EVALUATED",
        "triage-stage",
        `Trust evaluated at ${r.trust_score}.`,
        r.id,
        "report",
        { trust: r.trust_breakdown },
      );
      add(
        r,
        "PRIORITY_SCORED",
        "triage-stage",
        `Priority scored ${r.priority_score}/100.`,
        r.id,
        "report",
        { priority: r.priority_breakdown },
      );
    }
    add(
      r,
      r.workflow_status === "NEEDS_REVIEW"
        ? "NEEDS_REVIEW"
        : "POLICY_EVALUATED",
      "policy-engine",
      r.policy_reason ?? "Policy evaluated.",
    );
    const a = assignments.find((a) => a.report_id === r.id);
    if (a) {
      add(
        r,
        "VOLUNTEERS_FILTERED",
        "dispatch-stage",
        `Eligibility funnel selected ${a.volunteer_id}.`,
        a.id,
        "assignment",
        { selection: a.selection },
      );
      for (const step of a.selection?.funnel ?? [])
        for (const rejection of step.rejected)
          add(
            r,
            "VOLUNTEER_REJECTED",
            "policy-engine",
            `${rejection.id}: ${rejection.reason}`,
            a.id,
            "assignment",
          );
      add(
        r,
        a.status === "ACTIVE" ? "ASSIGNMENT_ACTIVATED" : "ASSIGNMENT_PROPOSED",
        "dispatch-stage",
        `${a.volunteer_id} · ETA ${Math.round((a.route_eta_seconds ?? 0) / 60)} min.`,
        a.id,
        "assignment",
        { route_eta_seconds: a.route_eta_seconds, status: a.status },
      );
    }
    const approval = approvals.find((a) => a.report_id === r.id);
    if (approval)
      add(
        r,
        "APPROVAL_REQUESTED",
        "policy-engine",
        approval.reason,
        approval.id,
        "approval",
      );
  }
  return { state, audit };
}
