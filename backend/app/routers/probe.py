"""
Probe-execution and CVE-grading router.

Exposes:

    POST /api/run-probes
        Trains the model on demand, generates counterfactual variants via
        Gemini, then streams ProbeProgress events over Server-Sent Events
        followed by a final "complete" event carrying every ProbeResult.

    POST /api/grade-cves
        Aggregates the stored probe results into per-protected-attribute
        statistics, asks Gemini for severity / title / root-cause grading,
        and returns a sorted list of CVEEntry objects.

Pre-stream errors (missing session, no baseline configured, Gemini produced
zero usable variants) return a normal 4xx JSON response. Errors that surface
mid-stream are emitted as a final SSE event with status="error".
"""

import json
import logging
from typing import Any, Dict, List

import numpy as np
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.models.schemas import BaselineConfig, CVEEntry, ProbeProgress, ProbeResult
from app.services.cve_grader import grade_vulnerabilities
from app.services.model_trainer import train_model
from app.services.probe_engine import execute_probes, generate_probes
from app.utils.session_store import get_session, update_session

logger = logging.getLogger(__name__)

router = APIRouter(tags=["probe"])


class RunProbesRequest(BaseModel):
    session_id: str = Field(..., description="Session created by the upload endpoint.")
    num_base_profiles: int = Field(
        default=50,
        ge=1,
        le=200,
        description="How many real rows to seed counterfactual probes from.",
    )


class GradeCVEsRequest(BaseModel):
    session_id: str = Field(..., description="Session that has already executed probes.")


def _json_default(obj: Any) -> Any:
    """JSON encoder fallback for numpy scalars coming out of pandas."""
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _dump(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, default=_json_default)


def _ensure_model(session: Dict[str, Any], baseline: BaselineConfig) -> Any:
    """Train + cache the model the first time, then reuse it for the session.

    The model is trained on legitimate_factors AND protected_attributes — that
    mirrors the realistic scenario where a developer didn't manually scrub
    protected fields, which is exactly the situation FairLens exists to red-
    team. If we trained on legitimate_factors alone the protected attrs
    couldn't possibly influence predictions and every probe would trivially
    return zero flips.
    """
    cached = session.get("model")
    if cached is not None:
        return cached

    feature_columns = list(dict.fromkeys(  # preserve order, dedupe
        list(baseline.legitimate_factors) + list(baseline.protected_attributes)
    ))
    df = session["df"]
    model, accuracy, importances = train_model(
        df,
        target_column=baseline.target_column,
        feature_columns=feature_columns,
    )
    session["model"] = model
    session["model_accuracy"] = accuracy
    session["model_importances"] = importances
    return model


@router.post("/run-probes")
async def run_probes(request: RunProbesRequest):
    session = get_session(request.session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or expired. Please re-upload the dataset.",
        )

    baseline = session.get("baseline")
    if not isinstance(baseline, BaselineConfig):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Baseline not configured for this session. POST /api/configure-baseline first.",
        )
    if not baseline.protected_attributes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Baseline has no protected_attributes; nothing to probe.",
        )

    model = _ensure_model(session, baseline)
    df = session["df"]

    probe_pairs = await generate_probes(
        df=df,
        protected_attributes=list(baseline.protected_attributes),
        legitimate_factors=list(baseline.legitimate_factors),
        num_base_profiles=request.num_base_profiles,
    )
    if not probe_pairs:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini failed to generate any usable counterfactual variants.",
        )

    total_probes = len(probe_pairs)

    async def event_stream():
        # Initial event so the client immediately learns the work size.
        yield _dump(
            {
                "probes_completed": 0,
                "total_probes": total_probes,
                "anomalies_found": 0,
                "failure_rate": 0.0,
            }
        )

        results: List[ProbeResult] = []
        anomalies = 0
        summary: ProbeProgress | None = None

        try:
            for event in execute_probes(probe_pairs, model):
                if isinstance(event, ProbeResult):
                    results.append(event)
                    if event.flipped:
                        anomalies += 1
                    completed = len(results)
                    yield _dump(
                        {
                            "probes_completed": completed,
                            "total_probes": total_probes,
                            "anomalies_found": anomalies,
                            "failure_rate": (anomalies / completed) if completed else 0.0,
                        }
                    )
                elif isinstance(event, ProbeProgress):
                    summary = event
        except Exception as exc:
            logger.exception("execute_probes failed mid-stream")
            yield _dump({"status": "error", "detail": f"Probe execution failed: {exc}"})
            return

        # Cache for the CVE/remediation stages. probe_pairs is stashed too so
        # rescan can replay the SAME pairs against the post-fix model.
        update_session(request.session_id, "probe_pairs", probe_pairs)
        update_session(request.session_id, "probe_results", results)
        update_session(request.session_id, "probe_summary", summary)

        yield _dump(
            {
                "status": "complete",
                "results": [r.model_dump(mode="json") for r in results],
                "summary": summary.model_dump(mode="json") if summary else None,
            }
        )

    return EventSourceResponse(event_stream())


@router.post("/grade-cves", response_model=List[CVEEntry])
async def grade_cves_endpoint(request: GradeCVEsRequest) -> List[CVEEntry]:
    session = get_session(request.session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or expired. Please re-upload the dataset.",
        )

    baseline = session.get("baseline")
    if not isinstance(baseline, BaselineConfig):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Baseline not configured for this session.",
        )

    probe_results = session.get("probe_results")
    if not probe_results:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No probe results in session. POST /api/run-probes first.",
        )

    cves = await grade_vulnerabilities(
        probe_results=probe_results,
        protected_attributes=list(baseline.protected_attributes),
        legitimate_factors=list(baseline.legitimate_factors),
        target_column=baseline.target_column,
        df=session["df"],
    )

    update_session(request.session_id, "cves", cves)
    return cves
