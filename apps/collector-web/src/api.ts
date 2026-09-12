import type { CaptureObservation, CaptureRequest, CaptureRun, ComparisonRequest, DataField, EvaluationReport, EvaluationReview, FieldStates, LabMetadata, Page, ReferenceImport, ReferenceRecord, RepairRequest, RunEvent, RunEvaluation } from "@denicheur-breizh/collector-contracts";

export interface RepairPlan {
  runId: string; provider: "firecrawl"; strategy: "firecrawl-detail-repair-v4" | "firecrawl-native-inventory-v5" | "firecrawl-gallery-audit-v6" | "firecrawl-gallery-walk-v7";
  eligible: boolean; reason?: string; total: number; requiresCapture: number;
  items: Array<{ listingId: string; url: string; title: string; fields: DataField[]; fieldStates: FieldStates; locallyResolved: DataField[] }>;
}

export interface EvaluationReportSummary {
  id: string; referenceId: string; referenceName: string; createdAt: string;
  results: Array<Pick<RunEvaluation, "runId" | "provider" | "verdict">>;
}

export const API_BASE = "/api/v1";
export class ApiError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options, headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(error?.message ?? `HTTP ${response.status}`, response.status, error?.code ?? "request_failed");
  }
  return data as T;
}
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
export const api = {
  refreshBalances: () => post<LabMetadata>("/balances/refresh"),
  unknownUsage: () => request<{ items: Array<{ id: string; run_id: string; provider: "xai" | "firecrawl"; status: string }> }>("/usage/unknown"),
  reconcileUsage: (id: string, body: { amount: number; note: string; evidenceUrl: string }) => post<LabMetadata>(`/usage/${encodeURIComponent(id)}/reconcile`, body),
  metadata: () => request<LabMetadata>("/meta"),
  runs: (offset = 0) => request<Page<CaptureRun>>(`/runs?offset=${offset}&limit=25`),
  run: (id: string) => request<CaptureRun>(`/runs/${encodeURIComponent(id)}`),
  create: (body: CaptureRequest, key: string) => request<CaptureRun>("/runs", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } }),
  observations: (id: string, offset = 0) => request<Page<CaptureObservation>>(`/runs/${encodeURIComponent(id)}/observations?offset=${offset}&limit=24`),
  events: (id: string) => request<{ items: RunEvent[] }>(`/runs/${encodeURIComponent(id)}/events`),
  cancel: (id: string) => post<CaptureRun>(`/runs/${encodeURIComponent(id)}/cancel`),
  resume: (id: string) => post<CaptureRun>(`/runs/${encodeURIComponent(id)}/resume`),
  repairPlan: (id: string) => request<RepairPlan>(`/runs/${encodeURIComponent(id)}/repair-plan`),
  repair: (id: string, body: RepairRequest, key: string) => request<CaptureRun>(`/runs/${encodeURIComponent(id)}/repair`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } }),
  references: () => request<{ items: ReferenceRecord[] }>("/references"),
  importReference: (reference: ReferenceImport) => post<ReferenceRecord>("/references", reference),
  importExtension: (reference: Omit<ReferenceImport, "records"> & { records: unknown[] }) => post<ReferenceRecord>("/references/extension", reference),
  reports: (offset = 0) => request<Page<EvaluationReportSummary>>(`/evaluations?offset=${offset}&limit=12`),
  report: (id: string) => request<EvaluationReport>(`/evaluations/${encodeURIComponent(id)}`),
  evaluate: (comparison: ComparisonRequest) => post<EvaluationReport>("/evaluations", comparison),
  review: (review: EvaluationReview) => post<EvaluationReview>("/reviews", review),
};
export const runExportUrl = (id: string) => `${API_BASE}/runs/${encodeURIComponent(id)}/export`;
export const reportExportUrl = (id: string, format: "json" | "markdown") => `${API_BASE}/evaluations/${encodeURIComponent(id)}/export?format=${format}`;
