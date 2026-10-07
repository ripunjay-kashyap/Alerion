import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

// Exercise the contract across complete action sequences, without a running backend.
const temp = mkdtempSync(join(tmpdir(), "alerion-mock-"));
const files = [
  "errors",
  "types",
  "api",
  "mock/seed",
  "mock/fixtures",
  "mock/index",
];
try {
  for (const file of files) {
    const output = join(temp, file + ".js");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      ts.transpileModule(
        readFileSync(resolve("src/lib", file + ".ts"), "utf8"),
        {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        },
      ).outputText,
    );
  }
  const require = createRequire(join(temp, "runner.cjs"));
  const { mockApi, subscribeMock } = require("./mock/index.js");
  const events = [];
  const unsubscribe = subscribeMock((e) => events.push(e));
  let state = await mockApi.state();
  assert.equal(state.reports.length, 5);
  assert.equal(
    state.reports.find((r) => r.id === "INC-E").merged_into,
    "INC-B",
  );
  const excluded = state.assignments
    .find((a) => a.report_id === "INC-B")
    .selection.funnel.flatMap((s) => s.rejected);
  assert.ok(
    excluded.some(
      (r) => r.id === "V-02" && r.reason === "Medical certification missing",
    ),
  );
  state.reports.length = 0;
  assert.equal(
    (await mockApi.state()).reports.length,
    5,
    "snapshots must be isolated from client mutation",
  );
  const fixture = await mockApi.state();
  for (const assignment of fixture.assignments) {
    const volunteer = fixture.volunteers.find(
      (v) => v.id === assignment.volunteer_id,
    );
    assert.deepEqual(
      assignment.route_geometry.coordinates[0],
      [volunteer.longitude, volunteer.latitude],
      "route starts at its selected volunteer",
    );
  }
  function intersects(route, polygon) {
    const cross = (a, b, c) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const ring = polygon.coordinates[0];
    return route.coordinates.slice(1).some((b, i) =>
      ring.slice(1).some((d, j) => {
        const a = route.coordinates[i],
          c = ring[j];
        return (
          cross(a, b, c) * cross(a, b, d) < 0 &&
          cross(c, d, a) * cross(c, d, b) < 0
        );
      }),
    );
  }
  const secondFlood = fixture.hazards.find((h) => h.id === "HZ-02");
  const firstFlood = fixture.hazards.find((h) => h.id === "HZ-01");
  assert.ok(
    intersects(fixture.assignments[0].route_geometry, secondFlood.geometry),
    "hero hazard intersects the original rescue route",
  );
  assert.ok(
    fixture.assignments.every(
      (a) => !intersects(a.route_geometry, firstFlood.geometry),
    ),
    "initial routes avoid the active flood",
  );
  const original = (await mockApi.state()).assignments.find(
    (a) => a.id === "ASG-A",
  ).route_geometry;
  await mockApi.activateHazard("HZ-02");
  const rerouted = (await mockApi.state()).assignments.find(
    (a) => a.id === "ASG-A",
  );
  assert.equal(rerouted.previous_eta_seconds, 360);
  assert.equal(rerouted.route_eta_seconds, 540);
  assert.deepEqual(rerouted.previous_route_geometry, original);
  assert.notDeepEqual(rerouted.route_geometry, original);
  assert.ok(
    !intersects(rerouted.route_geometry, secondFlood.geometry),
    "recalculated route avoids the activated flood",
  );
  assert.equal(
    events.filter((e) => e.data.reason === "route_invalidated").length,
    1,
  );
  await mockApi.activateHazard("HZ-02");
  assert.equal(
    events.filter((e) => e.data.reason === "route_invalidated").length,
    1,
    "idempotent activation must not reroute again",
  );
  await mockApi.approve("APR-B", { note: "Medical dispatch cleared." });
  state = await mockApi.state();
  assert.equal(
    state.approvals.find((a) => a.id === "APR-B").status,
    "APPROVED",
  );
  assert.equal(
    state.assignments.find((a) => a.id === "ASG-B").status,
    "ACTIVE",
  );
  assert.equal(state.volunteers.find((v) => v.id === "V-05").available, false);
  await assert.rejects(
    () => mockApi.approve("APR-B"),
    (error) => error.status === 409,
  );
  await assert.rejects(
    () => mockApi.approve("APR-D", { corrections: { latitude: 200 } }),
    (error) => error.status === 422,
  );
  await mockApi.approve("APR-D", {
    corrections: {
      location_text: "Uzan Bazaar",
      latitude: 26.189,
      longitude: 91.753,
      need_type: "rescue",
    },
  });
  state = await mockApi.state();
  assert.equal(state.reports.find((r) => r.id === "INC-D").latitude, 26.189);
  assert.equal(
    state.approvals.find((a) => a.id === "APR-D").status,
    "APPROVED",
  );
  const beforeReset = await mockApi.audit();
  assert.equal((await mockApi.audit(beforeReset.at(-1).seq)).length, 0);
  await mockApi.resetScenario();
  state = await mockApi.state();
  assert.equal(state.reports.length, 0);
  assert.equal(state.hazards.find((h) => h.id === "HZ-02").active, false);
  assert.equal((await mockApi.audit())[0].seq, 1);
  assert.ok(events.some((e) => e.event === "system.reset"));
  await mockApi.startScenario("manual");
  for (let i = 0; i < 6; i++) await mockApi.nextScenarioEvent();
  state = await mockApi.state();
  assert.equal((await mockApi.scenarioStatus()).status, "done");
  assert.equal(state.reports.length, 5);
  assert.equal(state.reports.find((r) => r.id === "INC-B").duplicate_count, 1);
  assert.equal(state.system.stats.duplicates_merged, 1);
  assert.equal(
    state.assignments.find((a) => a.id === "ASG-A").route_eta_seconds,
    540,
  );
  const received = await mockApi.submitReport({
    text: "Need help",
    source: "anonymous",
  });
  assert.equal(received.workflow_status, "RECEIVED");
  assert.equal(received.latitude, null);
  await mockApi.reject("APR-D", {
    note: "Caller could not confirm a location.",
  });
  assert.equal(
    (await mockApi.state()).reports.find((r) => r.id === "INC-D")
      .workflow_status,
    "REJECTED",
  );
  const audit = await mockApi.audit();
  assert.ok(audit.every((e, i) => !i || e.seq > audit[i - 1].seq));
  unsubscribe();
  await mockApi.resetScenario();

  // The default API must stay live and preserve backend policy errors (including 409).
  const oldFlag = process.env.NEXT_PUBLIC_USE_MOCK;
  delete process.env.NEXT_PUBLIC_USE_MOCK;
  const { api, USE_MOCK } = require("./api.js");
  assert.equal(USE_MOCK, false);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith("/api/approvals/APR-B/approve"));
    assert.equal(init.method, "POST");
    return new Response(
      JSON.stringify({
        detail: {
          code: "route_unsafe",
          message: "Route is no longer safe.",
          policy_rule: "SAFE-01",
        },
      }),
      { status: 409 },
    );
  };
  try {
    await assert.rejects(
      () => api.approve("APR-B"),
      (error) =>
        error.status === 409 &&
        error.policyRule === "SAFE-01" &&
        error.message === "Route is no longer safe.",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldFlag !== undefined) process.env.NEXT_PUBLIC_USE_MOCK = oldFlag;
  }
  console.log(
    "Mock contract checks passed: isolated snapshots, approvals, review, reroute events, reset/cursors, full scenario, rejection and live 409 errors.",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
