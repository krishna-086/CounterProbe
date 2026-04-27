"""
Remediation router.

Two endpoints close the FairLens loop:

    POST /api/remediate
        Look up a CVE in the session, ask Gemini for 2-3 fix strategies,
        cache the response on the session, return RemediationResponse.

    POST /api/rescan
        Apply the chosen strategy's `apply_fix(df)` to the session's
        DataFrame, retrain the model, replay the SAME probe pairs from the
        original run, and return a before/after RescanComparison so the user
        can see whether the fix actually moved the failure rate.

Both endpoints expect the upload -> baseline -> run-probes -> grade-cves flow
to have already populated the session.
"""

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.models.schemas import (
    BaselineConfig,
    CVEEntry,
    RemediationResponse,
    RescanComparison,
)
from app.services.gemini_client import RemediationGenerationError
from app.services.remediator import apply_fix_and_rescan, generate_remediation
from app.utils.session_store import get_session, update_session

router = APIRouter(tags=["remediate"])


class RemediateRequest(BaseModel):
    session_id: str = Field(..., description="Session that has graded CVEs.")
    cve_id: str = Field(..., description="ID of the CVE to remediate, e.g. 'COUNTERPROBE-2026-0001'.")


class RescanRequest(BaseModel):
    session_id: str = Field(..., description="Session whose probe pairs will be replayed.")
    cve_id: str = Field(..., description="CVE whose remediation was previously generated.")
    strategy_index: int = Field(
        default=0,
        ge=0,
        description="Which strategy from the cached RemediationResponse to apply.",
    )


def _find_cve(cves: List[CVEEntry], cve_id: str) -> CVEEntry:
    for cve in cves:
        if cve.id == cve_id:
            return cve
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"CVE '{cve_id}' not found in session.",
    )


def _require_session(session_id: str) -> Dict[str, Any]:
    session = get_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or expired. Please re-upload the dataset.",
        )
    return session


@router.post("/remediate", response_model=RemediationResponse)
async def remediate(request: RemediateRequest) -> RemediationResponse:
    session = _require_session(request.session_id)

    cves: List[CVEEntry] = session.get("cves") or []
    if not cves:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No CVEs in session. POST /api/grade-cves first.",
        )
    cve = _find_cve(cves, request.cve_id)

    model = session.get("model")
    importances = session.get("model_importances") or {}
    if model is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Model not trained. POST /api/run-probes first.",
        )

    try:
        response = await generate_remediation(
            cve_entry=cve,
            df=session["df"],
            model=model,
            feature_importances=importances,
        )
    except RemediationGenerationError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        )

    cache: Dict[str, RemediationResponse] = session.get("remediations") or {}
    cache[request.cve_id] = response
    update_session(request.session_id, "remediations", cache)
    return response


@router.post("/rescan", response_model=RescanComparison)
async def rescan(request: RescanRequest) -> RescanComparison:
    session = _require_session(request.session_id)

    if not isinstance(session.get("baseline"), BaselineConfig):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Baseline not configured for this session.",
        )

    try:
        return apply_fix_and_rescan(
            session=session,
            cve_id=request.cve_id,
            strategy_index=request.strategy_index,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
