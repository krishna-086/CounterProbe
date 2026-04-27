"""
Counterfactual probe generation and execution.

This is the heart of FairLens. We sample real rows from the user's dataset
("base profiles"), ask Gemini for realistic counterfactual variants that
change ONLY the protected attributes, then fire each base/variant pair
through the trained model. A flipped binary decision between base and
variant — with all legitimate factors held constant — is direct evidence
of bias and counts as an anomaly.

Public API:

    generate_probes(df, protected_attributes, legitimate_factors,
                    num_base_profiles=50, random_state=42) -> list[ProbePair]
        Async. Samples base profiles from `df`, calls Gemini in parallel
        (semaphore-limited) to generate variants per base, and bundles every
        validated base/variant pair into a ProbePair. Bases whose Gemini call
        fails are skipped with a logged warning, never crash the whole run.

    execute_probes(probe_pairs, model, preprocessing_info=None)
            -> Generator yielding ProbeResult per pair, then a final
               ProbeProgress summary.
        Sync generator suitable for SSE streaming. predict_single is fast,
        so synchronous iteration is fine — the SSE wrapper can flush each
        yield as a separate event.

The threshold for `flipped` is delta > FLIP_THRESHOLD (0.5) — i.e., one side
predicts the positive class and the other doesn't.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Dict, Generator, List, Optional, Union

import pandas as pd

from app.models.schemas import ProbeProgress, ProbeResult
from app.services.gemini_client import (
    VariantGenerationError,
    generate_counterfactual_variants,
)
from app.services.model_trainer import predict_single

logger = logging.getLogger(__name__)

FLIP_THRESHOLD = 0.5
DEFAULT_VARIANTS_PER_BASE = 8
MAX_CONCURRENT_GEMINI_CALLS = 5


@dataclass
class ProbePair:
    """A single base profile paired with one of its counterfactual variants."""

    base_profile: Dict[str, Any]
    variant_profile: Dict[str, Any]
    variant_label: str
    base_id: str


def _label_variant(variant: Dict[str, Any], protected_attrs: List[str]) -> str:
    """Build a short human-readable summary of what changed in this variant."""
    parts = [f"{k}={variant.get(k)!r}" for k in protected_attrs]
    return ", ".join(parts)


async def _variants_for_base(
    base_idx: int,
    base_profile: Dict[str, Any],
    protected_attrs: List[str],
    legitimate_factors: List[str],
    num_variants: int,
    semaphore: asyncio.Semaphore,
) -> List[ProbePair]:
    base_id = f"base_{base_idx}"
    async with semaphore:
        try:
            variants = await generate_counterfactual_variants(
                base_profile, protected_attrs, legitimate_factors, num_variants
            )
        except VariantGenerationError as exc:
            logger.warning("Skipping %s: %s", base_id, exc)
            return []

    return [
        ProbePair(
            base_profile=base_profile,
            variant_profile=variant,
            variant_label=_label_variant(variant, protected_attrs),
            base_id=base_id,
        )
        for variant in variants
    ]


async def generate_probes(
    df: pd.DataFrame,
    protected_attributes: List[str],
    legitimate_factors: List[str],
    num_base_profiles: int = 50,
    variants_per_base: int = DEFAULT_VARIANTS_PER_BASE,
    random_state: int = 42,
) -> List[ProbePair]:
    if not protected_attributes:
        raise ValueError("protected_attributes must contain at least one column.")
    if df.empty:
        return []

    sample_size = min(num_base_profiles, len(df))
    sampled = df.sample(n=sample_size, random_state=random_state).reset_index(drop=True)

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_GEMINI_CALLS)
    tasks = [
        _variants_for_base(
            base_idx=i,
            base_profile=sampled.iloc[i].to_dict(),
            protected_attrs=protected_attributes,
            legitimate_factors=legitimate_factors,
            num_variants=variants_per_base,
            semaphore=semaphore,
        )
        for i in range(sample_size)
    ]
    grouped: List[List[ProbePair]] = await asyncio.gather(*tasks)

    pairs: List[ProbePair] = []
    for group in grouped:
        pairs.extend(group)
    return pairs


def execute_probes(
    probe_pairs: List[ProbePair],
    model: Any,
    preprocessing_info: Optional[Dict[str, Any]] = None,
) -> Generator[Union[ProbeResult, ProbeProgress], None, None]:
    """
    Yield a ProbeResult per probe pair, then a final ProbeProgress summary.

    Designed to be consumed by the SSE endpoint: the route iterates this
    generator and emits each yield as its own server-sent event.
    """
    total = len(probe_pairs)
    anomalies = 0

    for idx, pair in enumerate(probe_pairs):
        base_pred = float(predict_single(model, preprocessing_info, pair.base_profile))
        variant_pred = float(predict_single(model, preprocessing_info, pair.variant_profile))
        delta = abs(base_pred - variant_pred)
        flipped = delta > FLIP_THRESHOLD
        if flipped:
            anomalies += 1

        yield ProbeResult(
            probe_id=f"{pair.base_id}_v{idx}",
            base_profile=pair.base_profile,
            variant_profile=pair.variant_profile,
            base_prediction=base_pred,
            variant_prediction=variant_pred,
            delta=delta,
            flipped=flipped,
        )

    completed = total
    failure_rate = (anomalies / completed) if completed else 0.0
    yield ProbeProgress(
        probes_completed=completed,
        total_probes=total,
        anomalies_found=anomalies,
        failure_rate=failure_rate,
    )
