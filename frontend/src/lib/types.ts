/**
 * TypeScript interfaces mirroring backend/app/models/schemas.py.
 *
 * Keep these in lockstep with the Pydantic models — they are the wire format
 * for every FairLens API call. Field names, types, and nullability must match.
 */

// ---------- Enums (str-backed in the Pydantic source) ----------

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type Effort = "LOW" | "MEDIUM" | "HIGH";
export type ColumnRecommendation = "legitimate" | "protected" | "requires_judgment";
export type ProxyRisk = "high" | "medium" | "low";

// ---------- Upload + dataset profiling ----------

export interface ColumnInfo {
  name: string;
  /** "numeric" | "categorical" | "text" — see backend data_processor classification */
  dtype: string;
  unique_count: number;
  /** Percentage of null/NaN entries (0-100). */
  null_pct: number;
  sample_values: unknown[];
}

export interface UploadResponse {
  session_id: string;
  columns: ColumnInfo[];
  row_count: number;
  preview: Record<string, unknown>[];
}

// ---------- Baseline configuration ----------

export interface BaselineAdvisory {
  column: string;
  recommendation: ColumnRecommendation;
  proxy_risk: ProxyRisk;
  reasoning: string;
}

export interface BaselineConfig {
  session_id: string;
  legitimate_factors: string[];
  protected_attributes: string[];
  target_column: string;
}

// ---------- Probe execution ----------

export interface ProbeResult {
  probe_id: string;
  base_profile: Record<string, unknown>;
  variant_profile: Record<string, unknown>;
  base_prediction: number;
  variant_prediction: number;
  /** abs(variant_prediction - base_prediction). */
  delta: number;
  flipped: boolean;
}

export interface ProbeProgress {
  probes_completed: number;
  total_probes: number;
  anomalies_found: number;
  /** anomalies_found / probes_completed, in [0, 1]. */
  failure_rate: number;
}

// SSE stream events from POST /api/run-probes.
export type RunProbesEvent =
  | (ProbeProgress & { status?: undefined })
  | { status: "complete"; results: ProbeResult[]; summary: ProbeProgress }
  | { status: "error"; detail: string };

// ---------- CVE report ----------

export interface CVEEvidence {
  probe_pairs_tested: number;
  prediction_flips: number;
  flip_rate: number;
  mean_delta: number;
  selection_rate_ratio: number;
  four_fifths_violation: boolean;
}

export interface CVEEntry {
  id: string;
  title: string;
  severity: Severity;
  attack_vector: string;
  evidence: CVEEvidence;
  legitimate_factors_controlled: string[];
  root_cause: string;
  remediation_priority: number;
}

// ---------- Remediation + rescan ----------

export interface RemediationStrategy {
  name: string;
  action: string;
  estimated_bias_reduction: number;
  accuracy_tradeoff: number;
  effort: Effort;
  /** Python source defining `apply_fix(df)`. */
  code: string;
}

export interface RemediationResponse {
  cve_id: string;
  strategies: RemediationStrategy[];
  recommended_strategy: string;
}

export interface RescanComparison {
  before_failure_rate: number;
  after_failure_rate: number;
  before_anomalies: number;
  after_anomalies: number;
  total_probes: number;
  accuracy_before: number;
  accuracy_after: number;
}
