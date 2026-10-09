"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import mapboxgl, { type GeoJSONSource } from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { Assignment, Facility, Hazard, OpsState } from "@/lib/types";
import { api } from "@/lib/api";
import VolunteerFunnel from "./VolunteerFunnel";
import { ApiError, errorMessage } from "@/lib/errors";
import { MAP_THEME_LUT } from "@/lib/mapTheme";
import { needText, statusText } from "@/lib/copy";

type Popup = {
  kind: "hazard" | "volunteer";
  id: string;
  reportAtOpen: string | null;
};
interface Props {
  state: OpsState | null;
  selectedReportId: string | null;
  onSelect: (id: string | null) => void;
  onAction: () => Promise<void>;
  onError: (error: unknown) => void;
  facilities?: Facility[]; // Google Maps (SerpApi) help points near the selected incident
  focus?: { lng: number; lat: number; key: number } | null; // fly here (e.g. a news suggestion)
}
const EMPTY: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const activeAssignment = (a: Assignment) =>
  ["ACTIVE", "REROUTING", "AWAITING_APPROVAL", "PROPOSED"].includes(a.status);
// Overlay colors, chosen to stay legible on the dark neon basemap (shared with the legend).
const C = {
  critical: "#ff3b5c",
  urgent: "#ffb020",
  routine: "#ffe45c",
  review: "#b9c0d9",
  done: "#3dff9a",
  route: "#3dff9a",
  rerouting: "#ffb020",
  proposed: "#d7dbf0",
  previous: "#ff3b5c",
  flood: "#2f8cff",
  floodLine: "#6cc4ff",
  inactive: "#8f97bd",
  blocked: "#ff8a1f",
  idle: "#7dd3fc",
  enRoute: "#3dff9a",
  onScene: "#c58cff",
  offline: "#6b7290",
  label: "#eef1ff",
  halo: "#0a0e27",
  stroke: "#f5f7ff",
  news: "#ff5ce1", // SerpApi news suggestion (not a confirmed hazard yet)
  facility: "#5cffd6", // SerpApi Google Maps hospital / relief camp
} as const;

// Circle polygon in lng/lat for a suggestion radius (good enough at city scale).
function circle(lng: number, lat: number, radiusM: number): GeoJSON.Polygon {
  const dLat = radiusM / 111_000;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const ring = Array.from({ length: 41 }, (_, i) => {
    const a = (i / 40) * 2 * Math.PI;
    return [lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)];
  });
  return { type: "Polygon", coordinates: [ring] };
}
// Standard's night light preset dims custom layers unless they are emissive.
const GLOW = 1;
const reportColor = (status: string, priority: number | null) =>
  status === "NEEDS_REVIEW"
    ? C.review
    : status === "COMPLETED"
      ? C.done
      : (priority ?? 0) >= 70
        ? C.critical
        : (priority ?? 0) >= 40
          ? C.urgent
          : C.routine;
const eta = (seconds: number | null) =>
  seconds === null ? "—" : `${Math.ceil(seconds / 60)} min`;
function previousOpacity(a: Assignment, selected: boolean) {
  const elapsed = (Date.now() - Date.parse(a.updated_at)) / 1000;
  return elapsed < 6
    ? 0.9
    : elapsed < 8
      ? Math.max(selected ? 0.6 : 0, (0.9 * (8 - elapsed)) / 2)
      : selected
        ? 0.6 // stays visible on the dark basemap while the incident is selected
        : 0;
}
function collections(
  state: OpsState,
  selected: string | null,
  pulses: Map<string, number>,
  facilities: Facility[],
) {
  const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features,
  });
  const assignments = state.assignments.filter(activeAssignment);
  return {
    hazards: fc(
      state.hazards.map((h) => ({
        type: "Feature",
        geometry: h.geometry,
        properties: {
          id: h.id,
          label: h.label,
          active: h.active,
          pulse_width:
            Date.now() - (pulses.get(h.id) ?? 0) < 5000
              ? 3.5 +
                1.5 * Math.sin((Date.now() - (pulses.get(h.id) ?? 0)) / 150)
              : 2,
        },
      })),
    ),
    routes: fc(
      assignments.flatMap((a) =>
        a.route_geometry
          ? [
              {
                type: "Feature" as const,
                geometry: a.route_geometry,
                properties: {
                  id: a.id,
                  status: a.status,
                  selected: a.report_id === selected,
                },
              },
            ]
          : [],
      ),
    ),
    "previous-routes": fc(
      assignments.flatMap((a) =>
        a.previous_route_geometry
          ? [
              {
                type: "Feature" as const,
                geometry: a.previous_route_geometry,
                properties: {
                  id: a.id,
                  opacity: previousOpacity(a, a.report_id === selected),
                },
              },
            ]
          : [],
      ),
    ),
    incidents: fc(
      state.reports.flatMap((r) =>
        r.latitude !== null &&
        r.longitude !== null &&
        r.workflow_status !== "MERGED"
          ? [
              {
                type: "Feature" as const,
                geometry: {
                  type: "Point" as const,
                  coordinates: [r.longitude, r.latitude],
                },
                properties: {
                  id: r.id,
                  color: reportColor(r.workflow_status, r.priority_score),
                  selected: r.id === selected,
                  review: r.workflow_status === "NEEDS_REVIEW",
                },
              },
            ]
          : [],
      ),
    ),
    volunteers: fc(
      state.volunteers.map((v) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [v.longitude, v.latitude] },
        properties: { id: v.id, status: v.status },
      })),
    ),
    intel: fc(
      (state.intel_suggestions ?? [])
        .filter((s) => s.status === "pending")
        .map((s) => ({
          type: "Feature",
          geometry: circle(s.longitude, s.latitude, s.radius_m),
          properties: {
            id: s.id,
            label: `News: ${s.locality} (${s.evidence.length})`,
          },
        })),
    ),
    facilities: fc(
      facilities.map((f, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [f.lng, f.lat] },
        properties: {
          id: `facility-${i}`,
          label: f.title,
          open: f.open_now !== false,
        },
      })),
    ),
  };
}
function updateMap(
  m: mapboxgl.Map,
  state: OpsState,
  selected: string | null,
  pulses: Map<string, number>,
  facilities: Facility[],
) {
  for (const [id, data] of Object.entries(
    collections(state, selected, pulses, facilities),
  ))
    (m.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}
function addLayers(m: mapboxgl.Map) {
  for (const id of [
    "hazards",
    "routes",
    "previous-routes",
    "incidents",
    "volunteers",
    "intel",
    "facilities",
  ])
    m.addSource(id, { type: "geojson", data: EMPTY });
  // SerpApi layers sit under routes and pins: evidence, not decisions.
  m.addLayer({
    id: "intel-fill",
    type: "fill",
    source: "intel",
    paint: {
      "fill-color": C.news,
      "fill-opacity": 0.12,
      "fill-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "intel-line",
    type: "line",
    source: "intel",
    paint: {
      "line-color": C.news,
      "line-width": 2,
      "line-dasharray": [2, 1.5],
      "line-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "intel-labels",
    type: "symbol",
    source: "intel",
    layout: { "text-field": ["get", "label"], "text-size": 11 },
    paint: {
      "text-color": C.news,
      "text-halo-color": C.halo,
      "text-halo-width": 2,
      "text-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "hazard-fill",
    type: "fill",
    source: "hazards",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": C.flood,
      "fill-opacity": ["case", ["get", "active"], 0.28, 0],
      "fill-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "hazard-active",
    type: "line",
    source: "hazards",
    filter: [
      "all",
      ["==", ["geometry-type"], "Polygon"],
      ["==", ["get", "active"], true],
    ],
    paint: {
      "line-color": C.floodLine,
      "line-width": ["get", "pulse_width"],
      "line-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "hazard-inactive",
    type: "line",
    source: "hazards",
    filter: [
      "all",
      ["==", ["geometry-type"], "Polygon"],
      ["==", ["get", "active"], false],
    ],
    paint: {
      "line-color": C.inactive,
      "line-width": 2,
      "line-dasharray": [3, 2],
      "line-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "blocked-roads",
    type: "line",
    source: "hazards",
    filter: [
      "all",
      ["==", ["geometry-type"], "LineString"],
      ["==", ["get", "active"], true],
    ],
    paint: {
      "line-color": C.blocked,
      "line-width": 6,
      "line-dasharray": [2, 1],
      "line-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "hazard-labels",
    type: "symbol",
    source: "hazards",
    layout: { "text-field": ["get", "id"], "text-size": 11 },
    paint: {
      "text-color": C.floodLine,
      "text-halo-color": C.halo,
      "text-halo-width": 2,
      "text-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "previous-routes",
    type: "line",
    source: "previous-routes",
    paint: {
      "line-color": C.previous,
      "line-width": 4,
      "line-dasharray": [2, 2],
      "line-opacity": ["get", "opacity"],
      "line-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "routes-active",
    type: "line",
    source: "routes",
    filter: ["in", ["get", "status"], ["literal", ["ACTIVE", "REROUTING"]]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": [
        "case",
        ["==", ["get", "status"], "REROUTING"],
        C.rerouting,
        C.route,
      ],
      "line-width": ["case", ["get", "selected"], 7, 4],
      "line-opacity": ["case", ["get", "selected"], 1, 0.75],
      "line-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "routes-proposed",
    type: "line",
    source: "routes",
    filter: [
      "in",
      ["get", "status"],
      ["literal", ["AWAITING_APPROVAL", "PROPOSED"]],
    ],
    paint: {
      "line-color": C.proposed,
      "line-width": ["case", ["get", "selected"], 5, 3],
      "line-dasharray": [3, 2],
      "line-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "incident-ring",
    type: "circle",
    source: "incidents",
    filter: ["any", ["get", "selected"], ["get", "review"]],
    paint: {
      "circle-radius": 16,
      "circle-color": C.stroke,
      "circle-opacity": 0.12,
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": 2,
      "circle-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "incidents",
    type: "circle",
    source: "incidents",
    paint: {
      "circle-radius": ["case", ["get", "selected"], 11, 8],
      "circle-color": ["get", "color"],
      "circle-stroke-color": C.stroke,
      "circle-stroke-width": 2,
      "circle-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "incident-labels",
    type: "symbol",
    source: "incidents",
    layout: {
      "text-field": ["case", ["get", "review"], "?", ["get", "id"]],
      "text-size": 11,
      "text-offset": [0, 1.7],
    },
    paint: {
      "text-color": C.label,
      "text-halo-color": C.halo,
      "text-halo-width": 2,
      "text-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "volunteers",
    type: "circle",
    source: "volunteers",
    paint: {
      "circle-radius": 6,
      "circle-color": [
        "match",
        ["get", "status"],
        "idle",
        C.idle,
        "en_route",
        C.enRoute,
        "on_scene",
        C.onScene,
        C.offline,
      ],
      "circle-stroke-color": C.halo,
      "circle-stroke-width": 2,
      "circle-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "volunteer-labels",
    type: "symbol",
    source: "volunteers",
    layout: {
      "text-field": ["get", "id"],
      "text-size": 11,
      "text-offset": [0, 1.5],
    },
    paint: {
      "text-color": C.idle,
      "text-halo-color": C.halo,
      "text-halo-width": 2,
      "text-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "facilities",
    type: "circle",
    source: "facilities",
    paint: {
      "circle-radius": 6,
      "circle-color": C.facility,
      "circle-opacity": ["case", ["get", "open"], 1, 0.4],
      "circle-stroke-color": C.halo,
      "circle-stroke-width": 2,
      "circle-emissive-strength": GLOW,
    },
  });
  m.addLayer({
    id: "facility-labels",
    type: "symbol",
    source: "facilities",
    layout: {
      "text-field": ["get", "label"],
      "text-size": 10,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
    },
    paint: {
      "text-color": C.facility,
      "text-halo-color": C.halo,
      "text-halo-width": 2,
      "text-emissive-strength": GLOW,
    },
  });
}

export default function MapView({
  state,
  selectedReportId,
  onSelect,
  onAction,
  onError,
  facilities = [],
  focus = null,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const fitted = useRef(false);
  const activeHazards = useRef<Map<string, boolean>>(new Map());
  const pulses = useRef<Map<string, number>>(new Map());
  const latest = useRef({ state, selectedReportId, onSelect, facilities });
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const hasToken = !!token && token !== "pk.xxxxx";
  useEffect(() => {
    if (focus && map.current)
      map.current.flyTo({ center: [focus.lng, focus.lat], zoom: 14.2, duration: 1200 });
  }, [focus]);
  useEffect(() => {
    latest.current = { state, selectedReportId, onSelect, facilities };
    for (const h of state?.hazards ?? []) {
      if (h.active && activeHazards.current.get(h.id) === false)
        pulses.current.set(h.id, Date.now());
      activeHazards.current.set(h.id, h.active);
    }
  }, [state, selectedReportId, onSelect, facilities]);

  useEffect(() => {
    if (!container.current || !hasToken) return;
    let m: mapboxgl.Map;
    try {
      m = new mapboxgl.Map({
        container: container.current,
        accessToken: token,
        style: "mapbox://styles/mapbox/standard",
        config: {
          basemap: {
            theme: "custom",
            "theme-data": MAP_THEME_LUT,
            lightPreset: "night",
          },
        },
        center: [91.765, 26.165],
        zoom: 12.6,
        attributionControl: false,
      });
    } catch (cause) {
      const failure = setTimeout(() => setMapError(errorMessage(cause)), 0);
      return () => clearTimeout(failure);
    }
    map.current = m;
    const loadTimeout = setTimeout(() => {
      if (!m.getSource("incidents"))
        setMapError(
          "Mapbox did not finish loading; coordinate view is available.",
        );
    }, 12000);
    const observer = new ResizeObserver(() => m.resize());
    observer.observe(container.current);
    m.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    m.addControl(
      new mapboxgl.AttributionControl({ compact: true }),
      "bottom-right",
    );
    m.on("error", (event) => {
      if (!m.isStyleLoaded()) setMapError(event.error.message);
    });
    const render = () => {
      const { state, selectedReportId, facilities } = latest.current;
      if (!state || !m.getSource("incidents")) return;
      updateMap(m, state, selectedReportId, pulses.current, facilities);
      if (!fitted.current) {
        const bounds = new mapboxgl.LngLatBounds();
        for (const v of state.volunteers)
          bounds.extend([v.longitude, v.latitude]);
        for (const r of state.reports)
          if (r.longitude !== null && r.latitude !== null)
            bounds.extend([r.longitude, r.latitude]);
        if (!bounds.isEmpty()) {
          m.fitBounds(bounds, { padding: 70, maxZoom: 13, duration: 0 });
          fitted.current = true;
        }
      }
    };
    m.on("load", () => {
      clearTimeout(loadTimeout);
      setMapError(null);
      setMapReady(true);
      addLayers(m);
      render();
      m.on("click", (event) => {
        const feature = m.queryRenderedFeatures(event.point, {
          layers: [
            "incidents",
            "volunteers",
            "hazard-fill",
            "hazard-inactive",
            "blocked-roads",
          ],
        })[0];
        const id: unknown = feature?.properties?.id;
        if (typeof id !== "string") return;
        setActionError(null);
        if (feature.source === "incidents") {
          latest.current.onSelect(id);
          setPopup(null);
        } else
          setPopup({
            kind: feature.source === "volunteers" ? "volunteer" : "hazard",
            id,
            reportAtOpen: latest.current.selectedReportId,
          });
      });
      m.on("mousemove", (event) => {
        m.getCanvas().style.cursor = m.queryRenderedFeatures(event.point, {
          layers: [
            "incidents",
            "volunteers",
            "hazard-fill",
            "hazard-inactive",
            "blocked-roads",
          ],
        }).length
          ? "pointer"
          : "";
      });
    });
    const interval = setInterval(render, 250);
    return () => {
      clearTimeout(loadTimeout);
      clearInterval(interval);
      observer.disconnect();
      m.remove();
      map.current = null;
      fitted.current = false;
    };
  }, [hasToken, token]);

  const opened = popup?.reportAtOpen === selectedReportId ? popup : null;
  const hazard =
    opened?.kind === "hazard"
      ? state?.hazards.find((h) => h.id === opened.id)
      : null;
  const volunteer =
    opened?.kind === "volunteer"
      ? state?.volunteers.find((v) => v.id === opened.id)
      : null;
  const report = !opened
    ? state?.reports.find((r) => r.id === selectedReportId)
    : null;
  const assignment = report
    ? state?.assignments.find(
        (a) => a.report_id === report.id && activeAssignment(a),
      )
    : null;
  async function toggleHazard(h: Hazard) {
    setPending(true);
    setActionError(null);
    try {
      await (h.active ? api.deactivateHazard(h.id) : api.activateHazard(h.id));
      await onAction();
    } catch (cause) {
      setActionError(
        errorMessage(cause) +
          (cause instanceof ApiError && cause.policyRule
            ? ` · ${cause.policyRule}`
            : ""),
      );
      onError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="map-shell">
      <div ref={container} className="map-container" />
      {(!hasToken || mapError) && (
        <CoordinateMap
          state={state}
          selected={selectedReportId}
          onSelect={(id) => {
            onSelect(id);
            setPopup(null);
          }}
          onPopup={(kind, id) => {
            setPopup({ kind, id, reportAtOpen: selectedReportId });
            setActionError(null);
          }}
        />
      )}
      <div className="map-title">
        Guwahati tonight <span>Click a pin or a flood zone for details</span>
      </div>
      {(!hasToken || mapError) && (
        <div className="map-fallback-note">
          Simplified map:{" "}
          {mapError
            ? "the street map couldn’t load"
            : "add NEXT_PUBLIC_MAPBOX_TOKEN for the street map"}
        </div>
      )}
      {!state && <div className="map-loading">Loading incidents…</div>}
      {state && hasToken && !mapReady && !mapError && (
        <div className="map-loading">Loading the street map…</div>
      )}
      <div className="map-legend" aria-label="Map legend">
        <span>
          <i style={{ background: C.critical }} /> Critical (70+)
        </span>
        <span>
          <i style={{ background: C.urgent }} /> Urgent (40+)
        </span>
        <span>
          <i style={{ background: C.routine }} /> Routine
        </span>
        <span>
          <i style={{ background: C.review }} /> Needs a human check
        </span>
        <span>
          <b style={{ background: C.route }} /> Responder route
        </span>
        <span>
          <b className="legend-dashed" /> Waiting for approval
        </span>
        <span>
          <b style={{ background: C.rerouting }} /> Rerouting
        </span>
        <span>
          <b style={{ background: C.previous }} /> Old route
        </span>
        <span>
          <i style={{ background: C.flood }} /> Flood zone
        </span>
        <span>
          <b style={{ background: C.blocked }} /> Blocked road
        </span>
        <span>
          <i style={{ background: C.idle }} /> Available responder
        </span>
        <span>
          <i style={{ background: C.onScene }} /> On scene
        </span>
        <span>
          <b className="legend-dashed" style={{ borderColor: C.news }} /> News
          report (SerpApi)
        </span>
        <span>
          <i style={{ background: C.facility }} /> Hospital / camp (SerpApi)
        </span>
      </div>
      {(hazard || volunteer || report) && (
        <section className="map-popover" aria-label="Map details">
          <button
            className="popover-close"
            aria-label="Close map details"
            onClick={() => {
              setPopup(null);
              if (report) onSelect(null);
            }}
          >
            ×
          </button>
          {hazard && (
            <>
              <span className={`badge ${hazard.active ? "badge-blue" : "badge-slate"}`}>
                {hazard.kind === "blocked_road" ? "Blocked road" : "Flood zone"}
                {hazard.active ? ", active" : ", not active"}
              </span>
              <h3>{hazard.label}</h3>
              <p className="muted">
                {hazard.id}, {hazard.severity} severity
              </p>
              <button
                className={hazard.active ? "button" : "button button-amber"}
                disabled={pending}
                onClick={() => void toggleHazard(hazard)}
              >
                {pending
                  ? "Updating…"
                  : hazard.active
                    ? "Mark as cleared"
                    : "Activate this flood zone"}
              </button>
              <p className="muted">
                Activating it reroutes any responder whose route crosses it.
              </p>
            </>
          )}
          {volunteer && (
            <>
              <span
                className={`badge ${volunteer.status === "idle" ? "badge-green" : volunteer.status === "offline" ? "badge-slate" : "badge-blue"}`}
              >
                {volunteer.status === "idle"
                  ? "Available"
                  : volunteer.status === "en_route"
                    ? "On the way to an incident"
                    : volunteer.status === "on_scene"
                      ? "On scene"
                      : "Off duty"}
              </span>
              <h3>{volunteer.name}</h3>
              <p className="muted">
                {volunteer.id}, call sign {volunteer.callsign}
              </p>
              <p>Skills: {volunteer.skills.join(", ").replaceAll("_", " ")}</p>
              <p className="muted">
                Drives a {volunteer.vehicle_type}, carries up to{" "}
                {volunteer.capacity}.{" "}
                {volunteer.medical_certified
                  ? "Medically certified."
                  : "Not medically certified."}
              </p>
            </>
          )}
          {report && (
            <>
              <span className="badge badge-slate">
                {needText(report.need_type)}, {report.id}
              </span>
              <h3>{report.location_text ?? "Location not clear yet"}</h3>
              <div className="popover-stats">
                <span>
                  Urgency<b>{report.priority_score ?? "—"}</b>
                </span>
                <span>
                  Trust
                  <b>
                    {report.trust_score === null
                      ? "—"
                      : `${Math.round(report.trust_score * 100)}%`}
                  </b>
                </span>
              </div>
              <p className="muted">{statusText[report.workflow_status]}</p>
              {assignment && (
                <>
                  <p className="text-emerald-300">
                    <b>{assignment.volunteer_id}</b>{" "}
                    {assignment.status === "AWAITING_APPROVAL"
                      ? "suggested"
                      : "on the way"}
                    , {eta(assignment.route_eta_seconds)} away
                  </p>
                  <p className="muted">{assignment.explanation}</p>
                  <VolunteerFunnel
                    selection={assignment.selection}
                    total={state?.volunteers.length ?? 0}
                  />
                </>
              )}
            </>
          )}
          {actionError && (
            <p role="alert" className="text-red-300">
              {actionError}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

// A geographic fallback keeps mock interactions usable without a Mapbox token or WebGL.
function CoordinateMap({
  state,
  selected,
  onSelect,
  onPopup,
}: {
  state: OpsState | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onPopup: (kind: "hazard" | "volunteer", id: string) => void;
}) {
  const [, tick] = useState(0);
  const svg = useRef<SVGSVGElement>(null);
  const seen = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const h of state?.hazards ?? []) {
      if (h.active && seen.current.get(h.id) === false)
        svg.current
          ?.querySelector(`[data-hazard-id="${CSS.escape(h.id)}"]`)
          ?.classList.add("hazard-pulse");
      seen.current.set(h.id, h.active);
    }
    if (
      !state?.assignments.some(
        (a) =>
          a.previous_route_geometry &&
          Date.now() - Date.parse(a.updated_at) < 8000,
      )
    )
      return;
    const interval = setInterval(() => {
      tick((v) => v + 1);
      if (
        !state.assignments.some(
          (a) =>
            a.previous_route_geometry &&
            Date.now() - Date.parse(a.updated_at) < 8000,
        )
      )
        clearInterval(interval);
    }, 250);
    return () => clearInterval(interval);
  }, [state]);
  const xy = ([lng, lat]: number[]) => [
    ((lng - 91.725) / 0.085) * 1000,
    ((26.2 - lat) / 0.085) * 800,
  ];
  const points = (coordinates: number[][]) =>
    coordinates.map((c) => xy(c).join(",")).join(" ");
  return (
    <svg
      ref={svg}
      className="coordinate-map"
      viewBox="0 0 1000 800"
      role="img"
      aria-label="Guwahati incident and hazard coordinate map"
    >
      <defs>
        <pattern
          id="map-grid"
          width="50"
          height="50"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 50 0 L 0 0 0 50"
            fill="none"
            stroke="#dce0d5"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="1000" height="800" fill="#edf0e7" />
      <rect width="1000" height="800" fill="url(#map-grid)" />
      <path
        d="M0 45 C220 130 310 20 540 68 S810 145 1000 30 L1000 0 L0 0Z"
        fill="#dbe6e8"
      />
      <text x="400" y="50" fill="#557385" fontSize="16" letterSpacing="5">
        BRAHMAPUTRA
      </text>
      <text x="330" y="420" fill="#bbc1b4" fontSize="30" letterSpacing="10">
        GUWAHATI
      </text>
      {state?.hazards.map((h) => (
        <g
          key={`${h.id}-${h.active}`}
          data-hazard-id={h.id}
          className="map-feature"
          tabIndex={0}
          role="button"
          aria-label={`${h.id} ${h.active ? "active" : "inactive"} hazard`}
          onClick={() => onPopup("hazard", h.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onPopup("hazard", h.id);
            }
          }}
        >
          {h.geometry.type === "Polygon" ? (
            <polygon
              points={points(h.geometry.coordinates[0])}
              fill={h.active ? "#72909f" : "transparent"}
              fillOpacity="0.28"
              stroke={h.active ? "#557385" : "#878e80"}
              strokeWidth="3"
              strokeDasharray={h.active ? undefined : "8 6"}
            />
          ) : (
            <polyline
              points={points(h.geometry.coordinates)}
              fill="none"
              stroke="#ad7c4d"
              opacity={h.active ? 1 : 0.3}
              strokeWidth="7"
              strokeDasharray="8 5"
            />
          )}
          <text
            x={
              xy(
                h.geometry.type === "Polygon"
                  ? h.geometry.coordinates[0][0]
                  : h.geometry.coordinates[0],
              )[0]
            }
            y={
              xy(
                h.geometry.type === "Polygon"
                  ? h.geometry.coordinates[0][0]
                  : h.geometry.coordinates[0],
              )[1] - 12
            }
            fill="#496879"
            fontSize="15"
          >
            {h.id}
          </text>
        </g>
      ))}
      {state?.assignments.filter(activeAssignment).map((a) => (
        <g key={`${a.id}-${a.updated_at}`}>
          {a.previous_route_geometry && (
            <polyline
              points={points(a.previous_route_geometry.coordinates)}
              stroke="#aa5649"
              fill="none"
              strokeWidth="4"
              strokeDasharray="8 6"
              className="previous-route"
              style={{
                opacity: previousOpacity(a, a.report_id === selected),
                animation: "none",
              }}
            />
          )}
          {a.route_geometry && (
            <polyline
              points={points(a.route_geometry.coordinates)}
              fill="none"
              stroke={
                a.status === "REROUTING"
                  ? "#a17c35"
                  : a.status === "ACTIVE"
                    ? "#4f7056"
                    : "#878e80"
              }
              strokeWidth={a.report_id === selected ? 7 : 4}
              opacity={a.report_id === selected ? 1 : 0.65}
              strokeDasharray={
                ["PROPOSED", "AWAITING_APPROVAL"].includes(a.status)
                  ? "10 7"
                  : undefined
              }
            />
          )}
        </g>
      ))}
      {state?.volunteers.map((v) => {
        const [x, y] = xy([v.longitude, v.latitude]);
        return (
          <g
            key={v.id}
            className="map-feature"
            role="button"
            tabIndex={0}
            aria-label={`Volunteer ${v.id}`}
            onClick={() => onPopup("volunteer", v.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPopup("volunteer", v.id);
              }
            }}
          >
            <circle
              cx={x}
              cy={y}
              r="8"
              fill={
                v.status === "idle"
                  ? "#648497"
                  : v.status === "en_route"
                    ? "#4f7056"
                    : v.status === "on_scene"
                      ? "#88718c"
                      : "#91988b"
              }
              stroke="#faf9f5"
              strokeWidth="2"
            />
            <text x={x + 12} y={y + 5} fill="#526a76" fontSize="14">
              {v.id}
            </text>
          </g>
        );
      })}
      {state?.reports
        .filter(
          (r) =>
            r.latitude !== null &&
            r.longitude !== null &&
            r.workflow_status !== "MERGED",
        )
        .map((r) => {
          const [x, y] = xy([r.longitude!, r.latitude!]);
          return (
            <g
              key={r.id}
              role="button"
              tabIndex={0}
              className="map-feature"
              aria-label={`Select incident ${r.id}`}
              onClick={() => onSelect(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(r.id);
                }
              }}
            >
              {r.id === selected && (
                <circle
                  cx={x}
                  cy={y}
                  r="19"
                  stroke="#394136"
                  fill="none"
                  strokeWidth="2"
                />
              )}
              <circle
                cx={x}
                cy={y}
                r="11"
                fill={reportColor(r.workflow_status, r.priority_score)}
                stroke="#faf9f5"
                strokeWidth="2"
              />
              <text
                x={x}
                y={y + 28}
                textAnchor="middle"
                fill="#394136"
                fontSize="14"
              >
                {r.workflow_status === "NEEDS_REVIEW" ? "? " : ""}
                {r.id}
              </text>
            </g>
          );
        })}
    </svg>
  );
}
