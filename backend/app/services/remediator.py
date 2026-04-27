"""
Remediation: Gemini-suggested fix strategies, plus the apply-fix-and-rescan
machinery that turns a strategy into empirical proof it works.

The proof loop:
    original df + model + probe_pairs   ->  produced "before" failure_rate
    apply_fix(df) -> df_fixed           ->  retrain model on df_fixed
    re-run THE SAME probe_pairs         ->  produces "after" failure_rate
    return RescanComparison

Reusing the identical probe pairs is what makes the result rigorous: same
counterfactual stimuli, different model, observable change in behavior.

SECURITY NOTE: `apply_fix_and_rescan` exec()s Gemini-generated Python code in
a restricted globals scope (only `pd`/`np`/the input df + a small builtin
allowlist). This raises the bar against trivial accidents but Python's exec
is not a sandbox. FairLens treats Gemini output as semi-trusted, in-process
content; never wire this code path to untrusted user-supplied source.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from app.models.schemas import (
    BaselineConfig,
    CVEEntry,
    Effort,
    ProbeProgress,
    ProbeResult,
    RemediationResponse,
    RemediationStrategy,
    RescanComparison,
)
from app.services.gemini_client import (
    RemediationGenerationError,
    generate_remediation_strategies,
)
from app.services.model_trainer import train_model
from app.services.probe_engine import ProbePair, execute_probes

logger = logging.getLogger(__name__)

_SAFE_BUILTINS: Dict[str, Any] = {
    "abs": abs, "min": min, "max": max, "sum": sum, "len": len,
    "list": list, "dict": dict, "set": set, "tuple": tuple,
    "str": str, "int": int, "float": float, "bool": bool,
    "range": range, "enumerate": enumerate, "zip": zip, "map": map, "filter": filter,
    "isinstance": isinstance, "True": True, "False": False, "None": None,
    "round": round, "sorted": sorted, "reversed": reversed,
    "any": any, "all": all, "print": print,
}


async def generate_remediation(
    cve_entry: CVEEntry,
    df: pd.DataFrame,
    model: Any,
    feature_importances: Dict[str, float],
) -> RemediationResponse:
    """Ask Gemini for fix strategies and assemble the API response."""
    cve_payload = cve_entry.model_dump(mode="json")
    try:
        result = await generate_remediation_strategies(
            cve=cve_payload,
            feature_importances=feature_importances,
            columns=list(df.columns),
        )
    except RemediationGenerationError as exc:
        logger.warning("Gemini remediation failed: %s", exc)
        raise

    strategies = [
        RemediationStrategy(
            name=s["name"],
            action=s["action"],
            estimated_bias_reduction=s["estimated_bias_reduction"],
            accuracy_tradeoff=s["accuracy_tradeoff"],
            effort=Effort(s["effort"]),
            code=s["code"],
        )
        for s in result["strategies"]
    ]
    return RemediationResponse(
        cve_id=cve_entry.id,
        strategies=strategies,
        recommended_strategy=result["recommended_strategy"],
    )


def _exec_apply_fix(code: str, df: pd.DataFrame) -> pd.DataFrame:
    """Execute Gemini's code in a restricted scope and return df after `apply_fix`."""
    safe_globals: Dict[str, Any] = {
        "__builtins__": _SAFE_BUILTINS,
        "pd": pd,
        "np": np,
    }
    local_scope: Dict[str, Any] = {}
    try:
        exec(code, safe_globals, local_scope)  # noqa: S102 — see security note in module docstring
    except Exception as exc:
        raise ValueError(f"Fix code raised during definition: {exc}") from exc

    apply_fix = local_scope.get("apply_fix") or safe_globals.get("apply_fix")
    if not callable(apply_fix):
        raise ValueError("Fix code did not define a callable `apply_fix(df)`.")

    try:
        result = apply_fix(df.copy())
    except Exception as exc:
        raise ValueError(f"apply_fix(df) raised: {exc}") from exc

    if not isinstance(result, pd.DataFrame):
        raise ValueError("apply_fix(df) must return a pandas DataFrame.")
    if result.empty:
        raise ValueError("apply_fix(df) returned an empty DataFrame.")
    return result


def _replay_probes(
    probe_pairs: List[ProbePair], model: Any
) -> Tuple[List[ProbeResult], Optional[ProbeProgress]]:
    results: List[ProbeResult] = []
    summary: Optional[ProbeProgress] = None
    for event in execute_probes(probe_pairs, model):
        if isinstance(event, ProbeResult):
            results.append(event)
        elif isinstance(event, ProbeProgress):
            summary = event
    return results, summary


def apply_fix_and_rescan(
    session: Dict[str, Any],
    cve_id: str,
    strategy_index: int,
) -> RescanComparison:
    """Apply the chosen strategy to the session's df, retrain, replay probes."""
    baseline = session.get("baseline")
    if not isinstance(baseline, BaselineConfig):
        raise ValueError("Baseline not configured for this session.")

    probe_pairs = session.get("probe_pairs")
    if not probe_pairs:
        raise ValueError("No probe pairs in session — run /api/run-probes first.")

    remediations: Dict[str, RemediationResponse] = session.get("remediations") or {}
    remediation = remediations.get(cve_id)
    if remediation is None:
        raise ValueError(f"No remediation cached for CVE '{cve_id}'. Call /api/remediate first.")

    if strategy_index < 0 or strategy_index >= len(remediation.strategies):
        raise ValueError(
            f"strategy_index {strategy_index} is out of range (0..{len(remediation.strategies)-1})."
        )
    strategy = remediation.strategies[strategy_index]

    original_df: pd.DataFrame = session["df"]
    fixed_df = _exec_apply_fix(strategy.code, original_df)

    if baseline.target_column not in fixed_df.columns:
        raise ValueError(
            f"apply_fix removed the target column '{baseline.target_column}'."
        )

    surviving_features = [
        c
        for c in list(baseline.legitimate_factors) + list(baseline.protected_attributes)
        if c in fixed_df.columns and c != baseline.target_column
    ]
    if not surviving_features:
        raise ValueError("apply_fix removed every feature column — nothing left to train on.")

    new_model, accuracy_after, _ = train_model(
        df=fixed_df,
        target_column=baseline.target_column,
        feature_columns=surviving_features,
    )

    new_results, new_summary = _replay_probes(probe_pairs, new_model)

    before_results: List[ProbeResult] = session.get("probe_results") or []
    before_total = len(before_results)
    before_anomalies = sum(1 for r in before_results if r.flipped)
    before_failure_rate = (before_anomalies / before_total) if before_total else 0.0
    accuracy_before = float(session.get("model_accuracy") or 0.0)

    after_total = len(new_results)
    after_anomalies = new_summary.anomalies_found if new_summary else sum(
        1 for r in new_results if r.flipped
    )
    after_failure_rate = new_summary.failure_rate if new_summary else (
        (after_anomalies / after_total) if after_total else 0.0
    )

    # Persist the post-fix state so subsequent rescans of other strategies
    # still compare against the original "before" baseline.
    session["last_rescan"] = {
        "cve_id": cve_id,
        "strategy_index": strategy_index,
        "fixed_df": fixed_df,
        "fixed_model": new_model,
        "after_results": new_results,
        "after_summary": new_summary,
    }

    return RescanComparison(
        before_failure_rate=before_failure_rate,
        after_failure_rate=after_failure_rate,
        before_anomalies=before_anomalies,
        after_anomalies=after_anomalies,
        total_probes=before_total or after_total,
        accuracy_before=accuracy_before,
        accuracy_after=accuracy_after,
    )
