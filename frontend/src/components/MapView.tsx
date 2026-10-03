"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import mapboxgl, { type GeoJSONSource } from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { Assignment, Hazard, OpsState } from "@/lib/types";
import { api } from "@/lib/api";
import VolunteerFunnel from "./VolunteerFunnel";
import { ApiError, errorMessage } from "@/lib/errors";

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
}
const EMPTY: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const activeAssignment = (a: Assignment) =>
  ["ACTIVE", "REROUTING", "AWAITING_APPROVAL", "PROPOSED"].includes(a.status);
const reportColor = (status: string, priority: number | null) =>
  status === "NEEDS_REVIEW"
    ? "#94a3b8"
    : status === "COMPLETED"
      ? "#34d399"
      : (priority ?? 0) >= 70
        ? "#f87171"
        : (priority ?? 0) >= 40
          ? "#fbbf24"
          : "#facc15";
const eta = (seconds: number | null) =>
  seconds === null ? "—" : `${Math.ceil(seconds / 60)} min`;
function previousOpacity(a: Assignment, selected: boolean) {
  const elapsed = (Date.now() - Date.parse(a.updated_at)) / 1000;
  return elapsed < 6
    ? 0.8
    : elapsed < 8
      ? Math.max(selected ? 0.18 : 0, (0.8 * (8 - elapsed)) / 2)
      : selected
        ? 0.18
        : 0;
}
function collections(
  state: OpsState,
  selected: string | null,
  pulses: Map<string, number>,
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
  };
}
function updateMap(
  m: mapboxgl.Map,
  state: OpsState,
  selected: string | null,
  pulses: Map<string, number>,
) {
  for (const [id, data] of Object.entries(collections(state, selected, pulses)))
    (m.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}
function addLayers(m: mapboxgl.Map) {
  for (const id of [
    "hazards",
    "routes",
    "previous-routes",
    "incidents",
    "volunteers",
  ])
    m.addSource(id, { type: "geojson", data: EMPTY });
  m.addLayer({
    id: "hazard-fill",
    type: "fill",
    source: "hazards",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": "#2563eb",
      "fill-opacity": ["case", ["get", "active"], 0.3, 0],
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
    paint: { "line-color": "#60a5fa", "line-width": ["get", "pulse_width"] },
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
      "line-color": "#94a3b8",
      "line-width": 2,
      "line-dasharray": [3, 2],
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
      "line-color": "#fb923c",
      "line-width": 6,
      "line-dasharray": [2, 1],
    },
  });
  m.addLayer({
    id: "hazard-labels",
    type: "symbol",
    source: "hazards",
    layout: { "text-field": ["get", "id"], "text-size": 11 },
    paint: {
      "text-color": "#93c5fd",
      "text-halo-color": "#020617",
      "text-halo-width": 2,
    },
  });
  m.addLayer({
    id: "previous-routes",
    type: "line",
    source: "previous-routes",
    paint: {
      "line-color": "#f87171",
      "line-width": 3,
      "line-dasharray": [2, 2],
      "line-opacity": ["get", "opacity"],
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
        "#fbbf24",
        "#34d399",
      ],
      "line-width": ["case", ["get", "selected"], 7, 4],
      "line-opacity": ["case", ["get", "selected"], 1, 0.65],
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
      "line-color": "#94a3b8",
      "line-width": ["case", ["get", "selected"], 5, 3],
      "line-dasharray": [3, 2],
    },
  });
  m.addLayer({
    id: "incident-ring",
    type: "circle",
    source: "incidents",
    filter: ["any", ["get", "selected"], ["get", "review"]],
    paint: {
      "circle-radius": 16,
      "circle-color": "#020617",
      "circle-opacity": 0.35,
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": 2,
    },
  });
  m.addLayer({
    id: "incidents",
    type: "circle",
    source: "incidents",
    paint: {
      "circle-radius": ["case", ["get", "selected"], 11, 8],
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#020617",
      "circle-stroke-width": 2,
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
      "text-color": "#e2e8f0",
      "text-halo-color": "#020617",
      "text-halo-width": 2,
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
        "#38bdf8",
        "en_route",
        "#34d399",
        "on_scene",
        "#a78bfa",
        "#64748b",
      ],
      "circle-stroke-color": "#020617",
      "circle-stroke-width": 2,
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
      "text-color": "#bae6fd",
      "text-halo-color": "#020617",
      "text-halo-width": 2,
    },
  });
}

export default function MapView({
  state,
  selectedReportId,
  onSelect,
  onAction,
  onError,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const fitted = useRef(false);
  const activeHazards = useRef<Map<string, boolean>>(new Map());
  const pulses = useRef<Map<string, number>>(new Map());
  const latest = useRef({ state, selectedReportId, onSelect });
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const hasToken = !!token && token !== "pk.xxxxx";
  useEffect(() => {
    latest.current = { state, selectedReportId, onSelect };
    for (const h of state?.hazards ?? []) {
      if (h.active && activeHazards.current.get(h.id) === false)
        pulses.current.set(h.id, Date.now());
      activeHazards.current.set(h.id, h.active);
    }
  }, [state, selectedReportId, onSelect]);

  useEffect(() => {
    if (!container.current || !hasToken) return;
    let m: mapboxgl.Map;
    try {
      m = new mapboxgl.Map({
        container: container.current,
        accessToken: token,
        style: "mapbox://styles/mapbox/dark-v11",
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
      const { state, selectedReportId } = latest.current;
      if (!state || !m.getSource("incidents")) return;
      updateMap(m, state, selectedReportId, pulses.current);
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
        <span className="status-dot bg-blue-400" /> GUWAHATI · FLOOD OPERATIONS{" "}
        <span className="text-slate-500">26.165° N / 91.765° E</span>
      </div>
      {(!hasToken || mapError) && (
        <div className="map-fallback-note">
          Coordinate view ·{" "}
          {mapError
            ? "Mapbox unavailable"
            : "Set NEXT_PUBLIC_MAPBOX_TOKEN for street map"}
        </div>
      )}
      {!state && <div className="map-loading">Loading operational state…</div>}
      {state && hasToken && !mapReady && !mapError && (
        <div className="map-loading">Loading street map…</div>
      )}
      <div className="map-legend" aria-label="Map legend">
        <span>
          <i className="bg-red-400" /> Critical ≥70
        </span>
        <span>
          <i className="bg-amber-400" /> Priority ≥40
        </span>
        <span>
          <i className="bg-yellow-400" /> Priority &lt;40
        </span>
        <span>
          <i className="bg-slate-400" /> ? Review
        </span>
        <span>
          <b className="bg-emerald-400" /> Active route
        </span>
        <span>
          <b className="legend-dashed" /> Proposed route
        </span>
        <span>
          <b className="bg-amber-400" /> Rerouting
        </span>
        <span>
          <b className="bg-red-400" /> Previous route
        </span>
        <span>
          <i className="bg-blue-500" /> Flood zone
        </span>
        <span>
          <b className="bg-orange-400" /> Blocked road
        </span>
        <span>
          <i className="bg-sky-400" /> Idle volunteer
        </span>
        <span>
          <i className="bg-violet-400" /> On scene
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
              <div className="section-label">
                {hazard.active ? "ACTIVE HAZARD" : "INACTIVE HAZARD"}
              </div>
              <h3 className="font-mono text-blue-300">
                {hazard.id} · {hazard.severity.toUpperCase()}
              </h3>
              <p>{hazard.label}</p>
              <p className="muted">
                {hazard.kind.replaceAll("_", " ")} · {hazard.source}
              </p>
              <button
                className={hazard.active ? "button" : "button button-amber"}
                disabled={pending}
                onClick={() => void toggleHazard(hazard)}
              >
                {pending
                  ? "Updating…"
                  : hazard.active
                    ? "Deactivate hazard"
                    : "Activate hazard"}
              </button>
              <p className="muted">
                Activation checks active routes for flood exposure.
              </p>
            </>
          )}
          {volunteer && (
            <>
              <div className="section-label">
                VOLUNTEER · {volunteer.status.replaceAll("_", " ")}
              </div>
              <h3 className="font-mono">
                {volunteer.id} / {volunteer.callsign}
              </h3>
              <p>{volunteer.name}</p>
              <p>{volunteer.skills.join(" · ")}</p>
              <p className="muted">
                {volunteer.vehicle_type} · capacity {volunteer.capacity} ·{" "}
                {volunteer.medical_certified
                  ? "Medically certified"
                  : "No medical certification"}
              </p>
              <p className="muted">
                {volunteer.available ? "Available" : "Unavailable"}
              </p>
            </>
          )}
          {report && (
            <>
              <div className="section-label">SELECTED INCIDENT</div>
              <h3 className="font-mono">
                {report.id} ·{" "}
                {report.need_type?.toUpperCase() ?? "UNKNOWN NEED"}
              </h3>
              <p>{report.location_text ?? "Location unresolved"}</p>
              <div className="flex gap-4 font-mono">
                <span>PRI {report.priority_score ?? "—"}</span>
                <span>
                  TRUST{" "}
                  {report.trust_score === null
                    ? "—"
                    : `${Math.round(report.trust_score * 100)}%`}
                </span>
              </div>
              <p className="muted">
                {report.source_type} ·{" "}
                {report.workflow_status.replaceAll("_", " ")}
              </p>
              {assignment && (
                <>
                  <p className="font-mono text-emerald-300">
                    {assignment.volunteer_id} · ETA{" "}
                    {eta(assignment.route_eta_seconds)}
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
            stroke="#1e293b"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="1000" height="800" fill="#07111f" />
      <rect width="1000" height="800" fill="url(#map-grid)" />
      <path
        d="M0 45 C220 130 310 20 540 68 S810 145 1000 30 L1000 0 L0 0Z"
        fill="#102e4c"
      />
      <text x="400" y="50" fill="#60a5fa" fontSize="16" letterSpacing="5">
        BRAHMAPUTRA
      </text>
      <text x="330" y="420" fill="#334155" fontSize="30" letterSpacing="10">
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
              fill={h.active ? "#2563eb" : "transparent"}
              fillOpacity="0.28"
              stroke={h.active ? "#60a5fa" : "#94a3b8"}
              strokeWidth="3"
              strokeDasharray={h.active ? undefined : "8 6"}
            />
          ) : (
            <polyline
              points={points(h.geometry.coordinates)}
              fill="none"
              stroke="#fb923c"
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
            fill="#93c5fd"
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
              stroke="#f87171"
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
                  ? "#fbbf24"
                  : a.status === "ACTIVE"
                    ? "#34d399"
                    : "#94a3b8"
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
                  ? "#38bdf8"
                  : v.status === "en_route"
                    ? "#34d399"
                    : v.status === "on_scene"
                      ? "#a78bfa"
                      : "#64748b"
              }
              stroke="#020617"
              strokeWidth="2"
            />
            <text x={x + 12} y={y + 5} fill="#bae6fd" fontSize="14">
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
                  stroke="#e2e8f0"
                  fill="none"
                  strokeWidth="2"
                />
              )}
              <circle
                cx={x}
                cy={y}
                r="11"
                fill={reportColor(r.workflow_status, r.priority_score)}
                stroke="#020617"
                strokeWidth="2"
              />
              <text
                x={x}
                y={y + 28}
                textAnchor="middle"
                fill="#e2e8f0"
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
