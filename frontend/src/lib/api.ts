/**
 * Typed HTTP client for the FairLens backend.
 *
 * One function per API endpoint. All take/return interfaces from ./types.
 * Errors from the backend (4xx/5xx) are normalized into ApiError so the UI
 * can show a single consistent message regardless of which call failed.
 *
 * Backend URL is read from NEXT_PUBLIC_API_URL — set in .env.local for dev,
 * baked at build time for the static export deployed to Firebase Hosting.
 */

import type {
  BaselineAdvisory,
  BaselineConfig,
  CVEEntry,
  ProbeProgress,
  ProbeResult,
  RemediationResponse,
  RescanComparison,
  RunProbesEvent,
  UploadResponse,
} from "@/lib/types";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(res);
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (body?.detail) detail = JSON.stringify(body.detail);
    } catch {
      // ignore — keep statusText
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

// ---------- Health ----------

/** Hits GET /api/health. Returns true if the backend is reachable. */
export async function pingHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/health`, {
      method: "GET",
      cache: "no-store",
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- Demo dataset ----------

/** Pull the bundled hiring_data.csv from /api/demo-data and wrap it as a File. */
export async function downloadDemoCSV(): Promise<File> {
  const res = await fetch(`${API_URL}/api/demo-data`);
  if (!res.ok) {
    throw new ApiError(res.status, "Could not load the demo dataset.");
  }
  const blob = await res.blob();
  return new File([blob], "hiring_data.csv", { type: "text/csv" });
}

// ---------- Upload ----------

export async function uploadCSV(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/api/upload`, {
    method: "POST",
    body: form,
  });
  return parseResponse<UploadResponse>(res);
}

// ---------- Baseline ----------

export function getBaselineAdvisory(
  sessionId: string,
  scenarioHint: string = "",
): Promise<BaselineAdvisory[]> {
  return postJson("/api/baseline-advisory", {
    session_id: sessionId,
    scenario_hint: scenarioHint,
  });
}

export function configureBaseline(
  config: BaselineConfig,
): Promise<{ status: string }> {
  return postJson("/api/configure-baseline", config);
}

// ---------- Probe execution (SSE) ----------

export interface RunProbesCallbacks {
  onProgress?: (progress: ProbeProgress) => void;
  onComplete?: (result: { results: ProbeResult[]; summary: ProbeProgress }) => void;
  onError?: (detail: string) => void;
  /** Allows the caller to abort an in-flight probe stream. */
  signal?: AbortSignal;
}

/**
 * Stream POST /api/run-probes. Resolves once the stream closes (after either
 * the "complete" event or an error). Each progress event is forwarded via
 * onProgress; the final results land via onComplete.
 */
export async function runProbes(
  request: { session_id: string; num_base_profiles?: number },
  callbacks: RunProbesCallbacks = {},
): Promise<void> {
  const res = await fetch(`${API_URL}/api/run-probes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(request),
    signal: callbacks.signal,
  });
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events end with a blank line; lines we care about start with "data:".
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (!payload) continue;

      let parsed: RunProbesEvent;
      try {
        parsed = JSON.parse(payload) as RunProbesEvent;
      } catch {
        continue;
      }

      if ("status" in parsed && parsed.status === "complete") {
        callbacks.onComplete?.({
          results: parsed.results,
          summary: parsed.summary,
        });
        return;
      }
      if ("status" in parsed && parsed.status === "error") {
        callbacks.onError?.(parsed.detail);
        throw new ApiError(500, parsed.detail);
      }
      callbacks.onProgress?.(parsed as ProbeProgress);
    }
  }
}

// ---------- CVE grading ----------

export function gradeCVEs(sessionId: string): Promise<CVEEntry[]> {
  return postJson("/api/grade-cves", { session_id: sessionId });
}

// ---------- Remediation + rescan ----------

export function getRemediation(
  sessionId: string,
  cveId: string,
): Promise<RemediationResponse> {
  return postJson("/api/remediate", {
    session_id: sessionId,
    cve_id: cveId,
  });
}

export function runRescan(
  sessionId: string,
  cveId: string,
  strategyIndex: number = 0,
): Promise<RescanComparison> {
  return postJson("/api/rescan", {
    session_id: sessionId,
    cve_id: cveId,
    strategy_index: strategyIndex,
  });
}
