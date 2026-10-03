# Disaster Relief Router frontend

Next.js 16 / React 19 command center for Guwahati flood response. The fixed API contract is in `../docs/api-contract.md`; the frontend renders backend snapshots and audit records.

From `frontend/`, install dependencies with `npm ci`, configure `.env.local` using `.env.example`, then run `npm run dev`. The default API URL is `http://localhost:8000`. Set `NEXT_PUBLIC_MAPBOX_TOKEN` to a Mapbox public token for the street map. If Mapbox or WebGL is unavailable, an interactive coordinate map keeps incident and hazard controls usable.

Mock mode is opt-in:

```bash
NEXT_PUBLIC_USE_MOCK=1 npm run dev
```

The initial mock snapshot includes five reports (one merged duplicate), two approvals, three assignments, six volunteers and seed hazards. Reset clears reports and restores the seed map. Start timed runs the six demo events over 45 seconds; Start manual enables Next event. Click HZ-02 and Activate hazard to invalidate V-04's original rescue route, display the previous route and change ETA from 6 to 9 minutes. Medical approval exposes V-02's missing certification; anonymous review accepts corrected location, coordinates and need.

Submit a report from the incident feed. Mock submission returns a RECEIVED report. In Nuroen mode its Process locally action exercises human review and the safe fallback banner. Mock data lives in memory and resets on a full page reload.

Selecting an incident from its card or the map highlights its pin and route, scrolls its feed/approval cards into view and drives the agent pipeline. Open pipeline stages to inspect audit snapshots. Audit filters support all events, the selected incident and individual stages.

Live API mode remains the default when `NEXT_PUBLIC_USE_MOCK` is unset or `0`. Changing a `NEXT_PUBLIC_*` variable requires restarting development or rebuilding production. Live SSE domain events invalidate state after 200 ms; the frontend refetches snapshots and audit entries by sequence. Failed requests retain the last good snapshot and show actionable errors, including policy rule badges.

Validation:

```bash
npx tsc --noEmit
npm run lint
npm run build
npm run check:mock
```

The dev/build scripts use Next.js's supported Webpack option because Turbopack's internal port binding fails in the managed execution environment. No additional runtime dependencies were added.
