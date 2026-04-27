"""
Pydantic schemas for every FairLens API request and response payload.

These models are the single source of truth for the wire format between the
Next.js frontend and the FastAPI backend. The TypeScript interfaces in
frontend/src/lib/types.ts must mirror these definitions field-for-field.

Schemas cover the full pipeline:
    upload -> baseline configuration -> probe streaming -> CVE report ->
    remediation -> rescan comparison.
"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class Severity(str, Enum):
    """CVE severity tiers, ordered most-to-least urgent."""

    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class Effort(str, Enum):
    """Engineering effort required to apply a remediation strategy."""

    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class ColumnRecommendation(str, Enum):
    """Gemini's verdict on which baseline group a column belongs to."""

    LEGITIMATE = "legitimate"
    PROTECTED = "protected"
    REQUIRES_JUDGMENT = "requires_judgment"


class ProxyRisk(str, Enum):
    """How likely a column is to act as a proxy for a protected attribute."""

    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


# ---------------------------------------------------------------------------
# Upload + dataset profiling
# ---------------------------------------------------------------------------


class ColumnInfo(BaseModel):
    """Profile of a single column in the uploaded dataset."""

    name: str = Field(..., description="Column name as it appears in the CSV header.")
    dtype: str = Field(..., description="High-level type: 'numeric', 'categorical', or 'text'.")
    unique_count: int = Field(..., description="Number of distinct values in the column.")
    null_pct: float = Field(..., description="Percentage of null/NaN entries (0-100).")
    sample_values: List[Any] = Field(
        default_factory=list,
        description="A handful of example values for the user to eyeball.",
    )


class UploadResponse(BaseModel):
    """Returned by POST /api/upload after the CSV is parsed and profiled."""

    session_id: str = Field(..., description="Opaque ID used to look up this dataset in later calls.")
    columns: List[ColumnInfo] = Field(..., description="Per-column profile information.")
    row_count: int = Field(..., description="Total number of rows in the uploaded dataset.")
    preview: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="First five rows as a list of {column: value} dicts.",
    )


# ---------------------------------------------------------------------------
# Baseline configuration
# ---------------------------------------------------------------------------


class BaselineAdvisory(BaseModel):
    """Per-column advisory from Gemini about how to classify a feature."""

    column: str = Field(..., description="Column name being advised on.")
    recommendation: ColumnRecommendation = Field(
        ...,
        description="Suggested classification: legitimate factor, protected attribute, or requires_judgment.",
    )
    proxy_risk: ProxyRisk = Field(
        ...,
        description="Risk that this feature acts as a proxy for a protected attribute.",
    )
    reasoning: str = Field(..., description="Plain-English justification for the recommendation.")


class BaselineConfig(BaseModel):
    """User's final business-necessity baseline submitted to POST /api/configure-baseline."""

    session_id: str = Field(..., description="Session created by the upload endpoint.")
    legitimate_factors: List[str] = Field(
        ...,
        description="Columns that the model is allowed to use when making a decision.",
    )
    protected_attributes: List[str] = Field(
        ...,
        description="Columns that should NOT influence the decision (the bias-test target).",
    )
    target_column: str = Field(..., description="Column the model is trained to predict.")


# ---------------------------------------------------------------------------
# Probe execution
# ---------------------------------------------------------------------------


class ProbeResult(BaseModel):
    """Outcome of one counterfactual probe pair (base row vs. variant)."""

    probe_id: str = Field(..., description="Stable identifier for this probe within the session.")
    base_profile: Dict[str, Any] = Field(..., description="Original row used as the probe baseline.")
    variant_profile: Dict[str, Any] = Field(
        ...,
        description="Row with only protected attributes mutated; legitimate factors held constant.",
    )
    base_prediction: float = Field(..., description="Model output for the base profile.")
    variant_prediction: float = Field(..., description="Model output for the variant profile.")
    delta: float = Field(..., description="variant_prediction - base_prediction.")
    flipped: bool = Field(
        ...,
        description="True if the binary decision changed between base and variant.",
    )


class ProbeProgress(BaseModel):
    """Progress event streamed over SSE while probes execute."""

    probes_completed: int = Field(..., description="Number of probes finished so far.")
    total_probes: int = Field(..., description="Total probes scheduled for this run.")
    anomalies_found: int = Field(
        ...,
        description="Cumulative count of probes whose decision flipped.",
    )
    failure_rate: float = Field(
        ...,
        description="anomalies_found / probes_completed, expressed as a fraction in [0, 1].",
    )


# ---------------------------------------------------------------------------
# CVE report
# ---------------------------------------------------------------------------


class CVEEvidence(BaseModel):
    """Quantitative evidence backing a single CVE entry."""

    probe_pairs_tested: int = Field(..., description="Total counterfactual pairs evaluated for this pattern.")
    prediction_flips: int = Field(..., description="How many of those pairs flipped the model's decision.")
    flip_rate: float = Field(..., description="prediction_flips / probe_pairs_tested, in [0, 1].")
    mean_delta: float = Field(
        ...,
        description="Average signed change in model output between variant and base.",
    )
    selection_rate_ratio: float = Field(
        ...,
        description="Ratio of selection rates between disadvantaged and advantaged groups.",
    )
    four_fifths_violation: bool = Field(
        ...,
        description="True if selection_rate_ratio falls below the 4/5ths (0.8) threshold.",
    )


class CVEEntry(BaseModel):
    """One bias finding in the CVE-style vulnerability report."""

    id: str = Field(..., description="CVE-style identifier, e.g. 'COUNTERPROBE-2026-0001'.")
    title: str = Field(..., description="Short human-readable headline for the finding.")
    severity: Severity = Field(..., description="Severity tier driving prioritization.")
    attack_vector: str = Field(
        ...,
        description="Which protected attribute combination causes the bias to surface.",
    )
    evidence: CVEEvidence = Field(..., description="Numerical evidence supporting the finding.")
    legitimate_factors_controlled: List[str] = Field(
        default_factory=list,
        description="Legitimate factors held constant during probing — proves the flip is not justified.",
    )
    root_cause: str = Field(..., description="Explanation of the feature interaction driving the bias.")
    remediation_priority: int = Field(
        ...,
        description="Suggested order to address findings; lower numbers should be fixed first.",
    )


# ---------------------------------------------------------------------------
# Remediation + rescan
# ---------------------------------------------------------------------------


class RemediationStrategy(BaseModel):
    """One candidate fix Gemini proposes for a given CVE."""

    name: str = Field(..., description="Short name of the strategy, e.g. 'Drop university_tier feature'.")
    action: str = Field(..., description="Plain-English description of what the strategy does.")
    estimated_bias_reduction: float = Field(
        ...,
        description="Expected reduction in failure_rate, as a fraction in [0, 1].",
    )
    accuracy_tradeoff: float = Field(
        ...,
        description="Expected change in model accuracy; negative means accuracy drops.",
    )
    effort: Effort = Field(..., description="Engineering effort required to apply the fix.")
    code: str = Field(..., description="Runnable Python snippet that implements the fix.")


class RemediationResponse(BaseModel):
    """Returned by POST /api/remediate — strategies for one CVE."""

    cve_id: str = Field(..., description="CVE the strategies apply to.")
    strategies: List[RemediationStrategy] = Field(
        ...,
        description="Candidate fixes ranked best-to-worst by estimated impact.",
    )
    recommended_strategy: str = Field(
        ...,
        description="Name of the strategy CounterProbe recommends applying first.",
    )


class RescanComparison(BaseModel):
    """Returned by POST /api/rescan — before/after numbers proving the fix worked."""

    before_failure_rate: float = Field(..., description="Probe failure rate prior to applying the fix.")
    after_failure_rate: float = Field(..., description="Probe failure rate after applying the fix.")
    before_anomalies: int = Field(..., description="Total flipped probes prior to the fix.")
    after_anomalies: int = Field(..., description="Total flipped probes after the fix.")
    total_probes: int = Field(..., description="Number of probes executed in each run (held constant).")
    accuracy_before: float = Field(..., description="Model accuracy on the holdout set prior to the fix.")
    accuracy_after: float = Field(..., description="Model accuracy on the holdout set after the fix.")
