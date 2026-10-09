import { ApiError } from "./errors";
import type {
  Approval,
  ApprovalInput,
  AuditEntry,
  Facilities,
  Hazard,
  IntelScan,
  IntelStatus,
  IntelSuggestion,
  OpsState,
  Report,
  ReportInput,
  ScenarioStatus,
} from "./types";

export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
).replace(/\/$/, "");
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      body && typeof body === "object" && "detail" in body ? body.detail : null;
    if (
      detail &&
      typeof detail === "object" &&
      "message" in detail &&
      typeof detail.message === "string"
    ) {
      throw new ApiError(
        detail.message,
        response.status,
        "code" in detail && typeof detail.code === "string"
          ? detail.code
          : undefined,
        "policy_rule" in detail && typeof detail.policy_rule === "string"
          ? detail.policy_rule
          : undefined,
      );
    }
    throw new ApiError(
      response.status === 422
        ? "Some fields are invalid. Check the report or review corrections."
        : `Request failed (${response.status}). Please try again.`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const mock = () => import("./mock").then((m) => m.mockApi);
const noSerpApi = <T>() =>
  Promise.reject<T>(new ApiError("SerpApi isn’t available with sample data.", 503));
const idPath = (id: string) => encodeURIComponent(id);

export const api = {
  state: () =>
    USE_MOCK ? mock().then((m) => m.state()) : request<OpsState>("/api/state"),
  audit: (afterSeq = 0) =>
    USE_MOCK
      ? mock().then((m) => m.audit(afterSeq))
      : request<AuditEntry[]>(`/api/audit?after_seq=${afterSeq}&limit=500`),
  scenarioStatus: () =>
    USE_MOCK
      ? mock().then((m) => m.scenarioStatus())
      : request<ScenarioStatus>("/api/scenario/status"),
  resetScenario: () =>
    USE_MOCK
      ? mock().then((m) => m.resetScenario())
      : post<{ ok: boolean }>("/api/scenario/reset"),
  startScenario: (mode: "timed" | "manual") =>
    USE_MOCK
      ? mock().then((m) => m.startScenario(mode))
      : post<ScenarioStatus>("/api/scenario/start", {
          scenario_id: "flood_demo",
          mode,
        }),
  nextScenarioEvent: () =>
    USE_MOCK
      ? mock().then((m) => m.nextScenarioEvent())
      : post<ScenarioStatus>("/api/scenario/next"),
  activateHazard: (id: string) =>
    USE_MOCK
      ? mock().then((m) => m.activateHazard(id))
      : post<Hazard>(`/api/hazards/${idPath(id)}/activate`),
  deactivateHazard: (id: string) =>
    USE_MOCK
      ? mock().then((m) => m.deactivateHazard(id))
      : post<Hazard>(`/api/hazards/${idPath(id)}/deactivate`),
  approve: (id: string, body: ApprovalInput = {}) =>
    USE_MOCK
      ? mock().then((m) => m.approve(id, body))
      : post<Approval>(`/api/approvals/${idPath(id)}/approve`, body),
  reject: (id: string, body: { note?: string } = {}) =>
    USE_MOCK
      ? mock().then((m) => m.reject(id, body))
      : post<Approval>(`/api/approvals/${idPath(id)}/reject`, body),
  // SerpApi evidence layer. Mock mode has no SerpApi, so it answers "unavailable".
  intelStatus: () =>
    USE_MOCK
      ? Promise.resolve<IntelStatus | null>(null)
      : request<IntelStatus>("/api/intel/status"),
  intelScan: () =>
    USE_MOCK ? noSerpApi<IntelScan>() : post<IntelScan>("/api/intel/scan"),
  acceptSuggestion: (id: string) =>
    USE_MOCK
      ? noSerpApi<{ suggestion: IntelSuggestion; hazard: Hazard; rerouted_assignments: string[] }>()
      : post<{ suggestion: IntelSuggestion; hazard: Hazard; rerouted_assignments: string[] }>(
          `/api/intel/suggestions/${idPath(id)}/accept`,
        ),
  dismissSuggestion: (id: string) =>
    USE_MOCK
      ? noSerpApi<IntelSuggestion>()
      : post<IntelSuggestion>(`/api/intel/suggestions/${idPath(id)}/dismiss`),
  facilities: (reportId: string) =>
    USE_MOCK
      ? Promise.resolve<Facilities | null>(null)
      : request<Facilities>(`/api/reports/${idPath(reportId)}/facilities`),
  submitReport: (body: ReportInput) =>
    USE_MOCK
      ? mock().then((m) => m.submitReport(body))
      : post<Report>("/api/reports", body),
};
