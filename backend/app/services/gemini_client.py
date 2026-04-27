"""
Centralized Gemini API client.

All FairLens calls to Gemini 2.5 Flash funnel through this module so prompt
engineering, error handling, and timeouts live in one place. Currently
provides:

    get_baseline_advisory(columns, scenario_hint)
        Asks Gemini to classify each dataset column as a legitimate business
        factor, a protected attribute, or one requiring human judgment, and
        flags proxy risk.

    generate_counterfactual_variants(base_profile, protected_attrs,
                                      legitimate_factors, num_variants=8)
        Asks Gemini to produce realistic counterfactual variants of a single
        row, varying only the protected attributes while holding every other
        field identical.

    grade_cves(aggregated_stats, scenario_context, legitimate_factors)
        Sends the per-attribute aggregated probe statistics to Gemini and
        asks for the qualitative pieces of each CVE (severity, title,
        attack_vector, root_cause, remediation_priority).

    generate_remediation_strategies(cve, feature_importances, columns)
        Asks Gemini for 2-3 candidate fix strategies for one CVE, each with
        an `apply_fix(df)` Python snippet plus a recommended pick.

Per CLAUDE.md we use the google-genai SDK (NOT google-generativeai, NOT
vertexai). The client is constructed lazily so the module can be imported
even when GEMINI_API_KEY is unset (e.g., during test collection).
"""

import asyncio
import json
import math
import os
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from google import genai
from google.genai import types as genai_types

from app.models.schemas import (
    BaselineAdvisory,
    ColumnInfo,
    ColumnRecommendation,
    ProxyRisk,
)

GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_TIMEOUT_SECONDS = 60.0  # remediation-strategy prompts can take 30-50s; advisory/grading finish in <10s

_client: Optional[genai.Client] = None


def _get_client() -> genai.Client:
    """Lazily construct (and cache) the genai.Client. Raises 500 if no API key is set."""
    global _client
    if _client is not None:
        return _client
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY is not configured on the server.",
        )
    _client = genai.Client(api_key=api_key)
    return _client


def _build_advisory_prompt(columns: List[ColumnInfo], scenario_hint: str) -> str:
    """Render the columns + scenario into a single prompt with an explicit JSON schema."""
    column_block = "\n".join(
        f"- {c.name} (dtype={c.dtype}, unique_values={c.unique_count}, "
        f"null_pct={c.null_pct}, sample={c.sample_values})"
        for c in columns
    )

    schema_block = """
Return ONLY a JSON array. Each element MUST match this schema exactly:

[
  {
    "column": "<exact column name from the input>",
    "recommendation": "legitimate" | "protected" | "requires_judgment",
    "proxy_risk": "high" | "medium" | "low",
    "reasoning": "<one or two sentences explaining your call>"
  }
]

Rules:
- Return one object per input column. Do not invent columns or omit any.
- "recommendation" values:
    "legitimate"          -> safe to use as a decision factor (skills, GPA, experience)
    "protected"           -> must NOT influence the decision (gender, race, age, name, zip)
    "requires_judgment"   -> ambiguous; could be a proxy or a legitimate factor depending on use
- "proxy_risk" reflects how strongly this feature could stand in for a protected
  attribute even when not directly protected itself (e.g., university tier as a
  proxy for socioeconomic status / race).
- Output strictly valid JSON. No markdown fences, no commentary, no trailing text.
""".strip()

    return f"""You are a fairness and anti-discrimination expert auditing an ML training dataset.

Decision context: {scenario_hint or "general predictive model"}

Dataset columns:
{column_block}

{schema_block}
"""


def _coerce_advisories(
    raw: List[dict], expected_columns: List[str]
) -> List[BaselineAdvisory]:
    """Validate Gemini's array against our schema, dropping malformed entries silently."""
    by_name: dict[str, BaselineAdvisory] = {}
    valid_recs = {r.value for r in ColumnRecommendation}
    valid_risks = {r.value for r in ProxyRisk}

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("column")
        rec = entry.get("recommendation")
        risk = entry.get("proxy_risk")
        reasoning = entry.get("reasoning") or ""
        if name not in expected_columns or rec not in valid_recs or risk not in valid_risks:
            continue
        by_name[name] = BaselineAdvisory(
            column=name,
            recommendation=ColumnRecommendation(rec),
            proxy_risk=ProxyRisk(risk),
            reasoning=str(reasoning),
        )

    # Backfill any column Gemini skipped with a safe default so the frontend
    # always renders a complete row per column.
    for name in expected_columns:
        if name not in by_name:
            by_name[name] = BaselineAdvisory(
                column=name,
                recommendation=ColumnRecommendation.REQUIRES_JUDGMENT,
                proxy_risk=ProxyRisk.MEDIUM,
                reasoning="Gemini did not return an advisory for this column; please review manually.",
            )
    return [by_name[name] for name in expected_columns]


async def get_baseline_advisory(
    columns: List[ColumnInfo], scenario_hint: str
) -> List[BaselineAdvisory]:
    """
    Ask Gemini for per-column baseline classifications.

    Raises HTTPException on timeout (504), upstream API failure (502), or
    malformed JSON response (502). Always returns one advisory per input
    column on success.
    """
    if not columns:
        return []

    client = _get_client()
    prompt = _build_advisory_prompt(columns, scenario_hint)
    config = genai_types.GenerateContentConfig(
        response_mime_type="application/json",
    )

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=GEMINI_MODEL, contents=prompt, config=config
            ),
            timeout=GEMINI_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"Gemini did not respond within {int(GEMINI_TIMEOUT_SECONDS)} seconds.",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini API call failed: {exc}",
        )

    text = (getattr(response, "text", None) or "").strip()
    if not text:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini returned an empty response.",
        )

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini returned invalid JSON: {exc.msg}",
        )

    if not isinstance(parsed, list):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini response was not a JSON array.",
        )

    return _coerce_advisories(parsed, [c.name for c in columns])


# ---------------------------------------------------------------------------
# Counterfactual variant generation
# ---------------------------------------------------------------------------


class VariantGenerationError(Exception):
    """Raised when Gemini fails to produce any usable variants for a base profile."""


def _build_variant_prompt(
    base_profile: Dict[str, Any],
    protected_attrs: List[str],
    legitimate_factors: List[str],
    num_variants: int,
) -> str:
    """Render the variant-generation prompt with explicit constraints + a JSON example."""
    legit_block = (
        "\n".join(f"- {k}: {json.dumps(base_profile.get(k))}" for k in legitimate_factors)
        or "- (none — every non-protected key must be copied verbatim)"
    )
    protected_block = "\n".join(f"- {k}" for k in protected_attrs)
    base_keys = list(base_profile.keys())

    # Per-attribute hints only fire when the attribute is actually being varied.
    hints: List[str] = []
    if "name" in protected_attrs:
        hints.append('- "name": culturally realistic full names spanning multiple ethnicities and genders.')
    if "gender" in protected_attrs:
        hints.append('- "gender": realistic values such as "Male", "Female", or "Non-binary".')
    if "age" in protected_attrs:
        hints.append('- "age": realistic working-age integers between 22 and 65.')
    hints_block = "\n".join(hints) if hints else "- (no per-attribute hints)"

    return f"""You are generating counterfactual test cases to detect bias in an ML model.

BASE PROFILE:
{json.dumps(base_profile, default=str, indent=2)}

PROTECTED ATTRIBUTES — vary these across variants:
{protected_block}

LEGITIMATE FACTORS — copy EXACTLY from the base (same value, same type, no rounding):
{legit_block}

Per-attribute generation hints (apply ONLY to attributes listed under PROTECTED above):
{hints_block}

Generate exactly {num_variants} realistic variant profiles. Each variant MUST:
1. Contain ALL of these keys in this order: {base_keys}
2. Vary ONLY the protected attributes above. Every other key — including any
   identifier-style fields like names that are NOT in the protected list — must
   be copied verbatim from the base profile.
3. Preserve numeric types (e.g., 3.5 must stay 3.5, not "3.5" and not 3).

Return ONLY a JSON array of variant objects. No markdown fences, no commentary,
no trailing text.
""".strip()


def _values_equal(a: Any, b: Any) -> bool:
    """Lenient equality: numerics compared with float tolerance, others strict."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isnan(float(a)) and math.isnan(float(b)):
            return True
        return math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-9)
    return a == b


def _validate_variant(
    variant: Any,
    base_profile: Dict[str, Any],
    protected_attrs: List[str],
) -> Optional[Dict[str, Any]]:
    """Coerce a Gemini variant into a valid counterfactual, or return None.

    Drops the variant if it isn't a dict, or if the protected fields didn't
    actually change at all (no counterfactual signal). For non-protected keys
    we DON'T require Gemini to have copied them perfectly — we just overwrite
    with the base values. That makes the counterfactual property a structural
    guarantee instead of a behavioral expectation, which Gemini sometimes
    fails to honor (it likes to vary names even when told not to).
    """
    if not isinstance(variant, dict):
        return None
    if not any(
        key in variant and not _values_equal(variant[key], base_profile.get(key))
        for key in protected_attrs
    ):
        # No protected field actually changed — not a useful probe.
        return None
    return {
        key: variant[key] if key in protected_attrs and key in variant else base_profile[key]
        for key in base_profile.keys()
    }


async def generate_counterfactual_variants(
    base_profile: Dict[str, Any],
    protected_attrs: List[str],
    legitimate_factors: List[str],
    num_variants: int = 8,
) -> List[Dict[str, Any]]:
    """
    Ask Gemini for `num_variants` counterfactual variants of `base_profile`.

    Variants that don't preserve every non-protected field are silently
    dropped. Raises VariantGenerationError if Gemini returns no usable
    variants, times out, or errors — caller (probe_engine.generate_probes)
    catches this and skips the base profile.
    """
    client = _get_client()
    prompt = _build_variant_prompt(base_profile, protected_attrs, legitimate_factors, num_variants)
    config = genai_types.GenerateContentConfig(response_mime_type="application/json")

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=GEMINI_MODEL, contents=prompt, config=config
            ),
            timeout=GEMINI_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise VariantGenerationError(
            f"Gemini timed out after {int(GEMINI_TIMEOUT_SECONDS)}s while generating variants."
        ) from exc
    except Exception as exc:
        raise VariantGenerationError(f"Gemini API call failed: {exc}") from exc

    text = (getattr(response, "text", None) or "").strip()
    if not text:
        raise VariantGenerationError("Gemini returned an empty response.")

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise VariantGenerationError(f"Gemini returned invalid JSON: {exc.msg}") from exc

    if not isinstance(parsed, list):
        raise VariantGenerationError("Gemini response was not a JSON array.")

    valid: List[Dict[str, Any]] = []
    for entry in parsed:
        ok = _validate_variant(entry, base_profile, protected_attrs)
        if ok is not None:
            valid.append(ok)

    if not valid:
        raise VariantGenerationError(
            "Gemini returned variants but none preserved the legitimate factors."
        )

    return valid


# ---------------------------------------------------------------------------
# CVE severity grading
# ---------------------------------------------------------------------------


class CVEGradingError(Exception):
    """Raised when Gemini fails to grade the supplied vulnerability stats."""


def _build_grading_prompt(
    aggregated_stats: List[Dict[str, Any]],
    scenario_context: str,
    legitimate_factors: List[str],
) -> str:
    stats_block = json.dumps(aggregated_stats, default=str, indent=2)
    legit_block = ", ".join(legitimate_factors) if legitimate_factors else "(none)"
    return f"""You are an ML fairness auditor producing CVE-style entries for an
adversarial bias report.

Scenario:
{scenario_context}

Legitimate factors that were held constant during probing (any flip cannot be
explained by these): {legit_block}

Per-protected-attribute aggregated counterfactual statistics:
{stats_block}

For EACH attribute in the input, return one JSON object describing the
vulnerability. Use this exact schema:

[
  {{
    "attribute": "<exact attribute name from input>",
    "title": "<short, specific headline>",
    "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
    "attack_vector": "<which protected-attribute change triggers the bias>",
    "root_cause": "<one or two sentences on which feature interaction drives the bias>",
    "remediation_priority": <integer 1..N, 1 = fix first>
  }}
]

Severity guidance:
- CRITICAL: flip_rate >= 0.30, or four_fifths_violation with flip_rate >= 0.15.
- HIGH:     flip_rate >= 0.15, or four_fifths_violation alone.
- MEDIUM:   flip_rate >= 0.05.
- LOW:      below the above thresholds.

Return ONLY the JSON array. No markdown, no commentary, no trailing text.
""".strip()


def _coerce_grade(entry: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(entry, dict):
        return None
    attribute = entry.get("attribute")
    severity = entry.get("severity")
    if not isinstance(attribute, str) or severity not in {"CRITICAL", "HIGH", "MEDIUM", "LOW"}:
        return None
    try:
        priority = int(entry.get("remediation_priority", 0))
    except (TypeError, ValueError):
        priority = 0
    return {
        "attribute": attribute,
        "title": str(entry.get("title") or f"Bias detected when {attribute} varies"),
        "severity": severity,
        "attack_vector": str(entry.get("attack_vector") or attribute),
        "root_cause": str(entry.get("root_cause") or ""),
        "remediation_priority": priority,
    }


async def grade_cves(
    aggregated_stats: List[Dict[str, Any]],
    scenario_context: str,
    legitimate_factors: List[str],
) -> List[Dict[str, Any]]:
    """
    Ask Gemini for the qualitative half of each CVE (severity, title,
    attack_vector, root_cause, remediation_priority). The numeric evidence is
    NOT supplied by Gemini — the caller pairs each grade with the locally
    computed CVEEvidence to assemble final CVEEntry objects.

    Raises CVEGradingError on timeout, upstream failure, malformed JSON, or
    if no entry survives validation.
    """
    if not aggregated_stats:
        return []

    client = _get_client()
    prompt = _build_grading_prompt(aggregated_stats, scenario_context, legitimate_factors)
    config = genai_types.GenerateContentConfig(response_mime_type="application/json")

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=GEMINI_MODEL, contents=prompt, config=config
            ),
            timeout=GEMINI_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise CVEGradingError(
            f"Gemini timed out after {int(GEMINI_TIMEOUT_SECONDS)}s while grading CVEs."
        ) from exc
    except Exception as exc:
        raise CVEGradingError(f"Gemini API call failed: {exc}") from exc

    text = (getattr(response, "text", None) or "").strip()
    if not text:
        raise CVEGradingError("Gemini returned an empty response.")

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CVEGradingError(f"Gemini returned invalid JSON: {exc.msg}") from exc

    if not isinstance(parsed, list):
        raise CVEGradingError("Gemini response was not a JSON array.")

    valid: List[Dict[str, Any]] = []
    for entry in parsed:
        coerced = _coerce_grade(entry)
        if coerced is not None:
            valid.append(coerced)

    if not valid:
        raise CVEGradingError("Gemini returned grades but none passed validation.")

    return valid


# ---------------------------------------------------------------------------
# Remediation strategy generation
# ---------------------------------------------------------------------------


class RemediationGenerationError(Exception):
    """Raised when Gemini fails to produce usable remediation strategies."""


_VALID_EFFORTS = {"LOW", "MEDIUM", "HIGH"}


def _build_remediation_prompt(
    cve: Dict[str, Any],
    feature_importances: Dict[str, float],
    columns: List[str],
) -> str:
    cve_block = json.dumps(cve, default=str, indent=2)
    importances_block = json.dumps(feature_importances, default=str, indent=2)
    columns_block = ", ".join(columns)

    return f"""You are a fairness engineer designing concrete remediations for a detected
ML bias. Each strategy you propose will be applied to the user's training
DataFrame (a pandas DataFrame named `df`), the model will be retrained on the
result, and the same counterfactual probes will be re-run to verify the fix.

CVE under remediation:
{cve_block}

Feature importances from the current RandomForest:
{importances_block}

Columns currently in the dataset: {columns_block}

Generate 2 OR 3 candidate strategies and pick the best one. Output strict JSON:

{{
  "strategies": [
    {{
      "name": "<short title>",
      "action": "<plain-English description of what this strategy does and why>",
      "estimated_bias_reduction": <float in [0, 1]>,
      "accuracy_tradeoff": <float; negative means accuracy is expected to drop>,
      "effort": "LOW" | "MEDIUM" | "HIGH",
      "code": "def apply_fix(df):\\n    ...\\n    return df"
    }}
  ],
  "recommended_strategy": "<exact name of the best strategy from the list above>"
}}

The `code` field MUST be a Python source string that:
- Defines a single function named EXACTLY `apply_fix` taking one argument `df`.
- Uses ONLY pandas (`pd`) and numpy (`np`) — both will already be in scope.
- Returns the corrected DataFrame.
- Is self-contained (no imports, no I/O, no print statements, no external state).
- Avoids destructive operations beyond the necessary transformation.

Examples of acceptable transformations:
- Drop a leaking feature: `return df.drop(columns=['gender'])`
- Bucket a high-cardinality feature: `df['age_bucket'] = pd.cut(df['age'], bins=[0,30,45,99]); return df.drop(columns=['age'])`
- Reweight rows for class balance using sample weights stored in a new column.

Return ONLY the JSON object. No markdown fences, no commentary, no trailing text.
""".strip()


def _coerce_strategy(entry: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(entry, dict):
        return None
    name = entry.get("name")
    code = entry.get("code")
    effort = entry.get("effort")
    if not isinstance(name, str) or not isinstance(code, str) or effort not in _VALID_EFFORTS:
        return None
    if "def apply_fix" not in code:
        return None
    try:
        bias_reduction = float(entry.get("estimated_bias_reduction", 0.0))
        accuracy_tradeoff = float(entry.get("accuracy_tradeoff", 0.0))
    except (TypeError, ValueError):
        return None
    bias_reduction = max(0.0, min(1.0, bias_reduction))
    return {
        "name": name,
        "action": str(entry.get("action") or ""),
        "estimated_bias_reduction": bias_reduction,
        "accuracy_tradeoff": accuracy_tradeoff,
        "effort": effort,
        "code": code,
    }


async def generate_remediation_strategies(
    cve: Dict[str, Any],
    feature_importances: Dict[str, float],
    columns: List[str],
) -> Dict[str, Any]:
    """
    Ask Gemini for 2-3 fix strategies for one CVE.

    Returns a dict with keys "strategies" (list of strategy dicts shaped like
    RemediationStrategy) and "recommended_strategy" (str). Caller wraps these
    into a RemediationResponse.

    Raises RemediationGenerationError on timeout, upstream error, malformed
    JSON, or if no strategy survives validation.
    """
    client = _get_client()
    prompt = _build_remediation_prompt(cve, feature_importances, columns)
    config = genai_types.GenerateContentConfig(response_mime_type="application/json")

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=GEMINI_MODEL, contents=prompt, config=config
            ),
            timeout=GEMINI_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise RemediationGenerationError(
            f"Gemini timed out after {int(GEMINI_TIMEOUT_SECONDS)}s while generating remediations."
        ) from exc
    except Exception as exc:
        raise RemediationGenerationError(f"Gemini API call failed: {exc}") from exc

    text = (getattr(response, "text", None) or "").strip()
    if not text:
        raise RemediationGenerationError("Gemini returned an empty response.")

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RemediationGenerationError(f"Gemini returned invalid JSON: {exc.msg}") from exc

    if not isinstance(parsed, dict):
        raise RemediationGenerationError("Gemini response was not a JSON object.")

    raw_strategies = parsed.get("strategies")
    if not isinstance(raw_strategies, list) or not raw_strategies:
        raise RemediationGenerationError("Gemini response had no strategies array.")

    strategies = [s for s in (_coerce_strategy(e) for e in raw_strategies) if s is not None]
    if not strategies:
        raise RemediationGenerationError("Gemini returned strategies but none passed validation.")

    recommended = parsed.get("recommended_strategy")
    if not isinstance(recommended, str) or not any(s["name"] == recommended for s in strategies):
        recommended = strategies[0]["name"]

    return {"strategies": strategies, "recommended_strategy": recommended}
