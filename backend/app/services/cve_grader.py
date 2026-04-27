"""
CVE grading: turns a flat list of probe results into a ranked, severity-graded
vulnerability report.

Pipeline:
    1. Bucket each ProbeResult under every protected attribute that actually
       changed between its base and variant. A probe that varies both name
       and gender contributes to BOTH the name-bucket and the gender-bucket
       (the per-attribute signal is over-counted but still the most useful
       view; pure single-attribute counterfactuals are too sparse to grade).
    2. For each bucket, deterministically compute CVEEvidence:
         - probe_pairs_tested, prediction_flips, flip_rate
         - mean_delta (signed, variant - base)
         - selection_rate_ratio (4/5ths rule across base vs variant outcomes)
         - four_fifths_violation (ratio < 0.80)
    3. Send the per-attribute aggregates to Gemini for the qualitative
       judgments (severity, title, attack_vector, root_cause, priority).
       The numeric evidence is OURS and is never overwritten by Gemini's
       output — keeps the report auditable.
    4. If Gemini fails, fall back to a deterministic severity heuristic so
       the endpoint still returns a usable report.

Public API:
    grade_vulnerabilities(probe_results, protected_attributes,
                          legitimate_factors, target_column, df)
        -> list[CVEEntry] sorted CRITICAL -> LOW.
"""

import logging
from collections import defaultdict
from typing import Dict, List

import pandas as pd

from app.models.schemas import CVEEntry, CVEEvidence, ProbeResult, Severity
from app.services.gemini_client import CVEGradingError, grade_cves

logger = logging.getLogger(__name__)

FLIP_DECISION_THRESHOLD = 0.5
FOUR_FIFTHS = 0.80

_SEVERITY_RANK = {
    Severity.CRITICAL: 0,
    Severity.HIGH: 1,
    Severity.MEDIUM: 2,
    Severity.LOW: 3,
}


def _changed_protected(probe: ProbeResult, protected_attrs: List[str]) -> List[str]:
    base, variant = probe.base_profile, probe.variant_profile
    return [a for a in protected_attrs if base.get(a) != variant.get(a)]


def _group_probes(
    probe_results: List[ProbeResult], protected_attrs: List[str]
) -> Dict[str, List[ProbeResult]]:
    """Bucket probes by every protected attribute that differs between base and variant."""
    buckets: Dict[str, List[ProbeResult]] = defaultdict(list)
    for r in probe_results:
        for attr in _changed_protected(r, protected_attrs):
            buckets[attr].append(r)
    return dict(buckets)


def _compute_evidence(probes: List[ProbeResult]) -> CVEEvidence:
    n = len(probes)
    flips = sum(1 for p in probes if p.flipped)
    mean_delta = sum(p.variant_prediction - p.base_prediction for p in probes) / n
    base_rate = sum(1 for p in probes if p.base_prediction > FLIP_DECISION_THRESHOLD) / n
    variant_rate = sum(1 for p in probes if p.variant_prediction > FLIP_DECISION_THRESHOLD) / n
    if max(base_rate, variant_rate) > 0:
        ratio = min(base_rate, variant_rate) / max(base_rate, variant_rate)
    else:
        ratio = 1.0
    return CVEEvidence(
        probe_pairs_tested=n,
        prediction_flips=flips,
        flip_rate=flips / n,
        mean_delta=mean_delta,
        selection_rate_ratio=ratio,
        four_fifths_violation=ratio < FOUR_FIFTHS,
    )


def _heuristic_severity(evidence: CVEEvidence) -> Severity:
    if evidence.flip_rate >= 0.30 or (evidence.four_fifths_violation and evidence.flip_rate >= 0.15):
        return Severity.CRITICAL
    if evidence.flip_rate >= 0.15 or evidence.four_fifths_violation:
        return Severity.HIGH
    if evidence.flip_rate >= 0.05:
        return Severity.MEDIUM
    return Severity.LOW


def _build_scenario_context(target_column: str, df: pd.DataFrame) -> str:
    return (
        f"Binary classification model predicting `{target_column}`. "
        f"Trained on {len(df):,} rows with {len(df.columns)} columns."
    )


async def grade_vulnerabilities(
    probe_results: List[ProbeResult],
    protected_attributes: List[str],
    legitimate_factors: List[str],
    target_column: str,
    df: pd.DataFrame,
) -> List[CVEEntry]:
    if not probe_results:
        return []

    buckets = _group_probes(probe_results, protected_attributes)
    if not buckets:
        return []

    # Build per-attribute aggregates first (deterministic, source of truth).
    evidence_by_attr: Dict[str, CVEEvidence] = {
        attr: _compute_evidence(probes) for attr, probes in buckets.items()
    }

    aggregated_stats = [
        {"attribute": attr, **ev.model_dump()} for attr, ev in evidence_by_attr.items()
    ]

    # Ask Gemini for the qualitative pieces; fall back to heuristics on failure.
    grades_by_attr: Dict[str, Dict] = {}
    try:
        grades = await grade_cves(
            aggregated_stats,
            _build_scenario_context(target_column, df),
            list(legitimate_factors),
        )
        grades_by_attr = {g["attribute"]: g for g in grades}
    except CVEGradingError as exc:
        logger.warning("Gemini CVE grading failed (%s); using heuristic severities.", exc)

    # Assemble final entries; Gemini's `evidence` is replaced by ours.
    entries: List[CVEEntry] = []
    for attr, ev in evidence_by_attr.items():
        grade = grades_by_attr.get(attr, {})
        severity = (
            Severity(grade["severity"]) if grade.get("severity") in {s.value for s in Severity}
            else _heuristic_severity(ev)
        )
        entries.append(
            CVEEntry(
                id="",  # filled in after sorting
                title=grade.get("title") or f"Model output shifts when `{attr}` varies",
                severity=severity,
                attack_vector=grade.get("attack_vector") or f"counterfactual change to `{attr}`",
                evidence=ev,
                legitimate_factors_controlled=list(legitimate_factors),
                root_cause=(
                    grade.get("root_cause")
                    or f"Predictions move when only `{attr}` changes; legitimate factors are held constant."
                ),
                remediation_priority=int(grade.get("remediation_priority") or 0),
            )
        )

    entries.sort(key=lambda e: (_SEVERITY_RANK[e.severity], -e.evidence.flip_rate))

    # Final pass: stable IDs and priorities follow the sorted order.
    for idx, entry in enumerate(entries, start=1):
        entry.id = f"COUNTERPROBE-2026-{idx:04d}"
        if entry.remediation_priority <= 0:
            entry.remediation_priority = idx

    return entries
