"""
Baseline configuration router.

Two endpoints back the "business necessity baseline" step of the FairLens flow:

    POST /api/baseline-advisory
        Asks Gemini to classify each uploaded column as a legitimate factor,
        protected attribute, or one requiring human judgment, and to flag
        proxy risk. Used to pre-fill the UI before the user confirms.

    POST /api/configure-baseline
        Persists the user's final BaselineConfig (legitimate vs. protected
        split, target column) into the in-memory session so the probe stage
        can pick it up.
"""

from typing import List

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.models.schemas import BaselineAdvisory, BaselineConfig, ColumnInfo
from app.services.data_processor import _profile_column
from app.services.gemini_client import get_baseline_advisory
from app.utils.session_store import get_session, update_session

router = APIRouter(tags=["baseline"])


class AdvisoryRequest(BaseModel):
    session_id: str = Field(..., description="Session created by the upload endpoint.")
    scenario_hint: str = Field(
        default="",
        description="Free-text description of what the model decides (e.g. 'hiring decisions').",
    )


def _columns_for_session(session: dict) -> List[ColumnInfo]:
    """Recompute the column profile from the stored DataFrame.

    We don't persist ColumnInfo on upload — recomputing is cheap (<50 columns by
    spec) and avoids drift between the upload payload and the live DataFrame.
    """
    df = session["df"]
    return [_profile_column(df[col]) for col in df.columns]


@router.post("/baseline-advisory", response_model=List[BaselineAdvisory])
async def baseline_advisory(request: AdvisoryRequest) -> List[BaselineAdvisory]:
    session = get_session(request.session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or expired. Please re-upload the dataset.",
        )

    columns = _columns_for_session(session)
    return await get_baseline_advisory(columns, request.scenario_hint)


@router.post("/configure-baseline")
async def configure_baseline(config: BaselineConfig) -> dict:
    session = get_session(config.session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or expired. Please re-upload the dataset.",
        )

    df = session["df"]
    available = set(df.columns)

    if config.target_column not in available:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"target_column '{config.target_column}' is not in the dataset.",
        )

    missing_legit = [c for c in config.legitimate_factors if c not in available]
    missing_protected = [c for c in config.protected_attributes if c not in available]
    if missing_legit or missing_protected:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown columns referenced. "
                f"missing_legitimate={missing_legit}, missing_protected={missing_protected}"
            ),
        )

    overlap = set(config.legitimate_factors) & set(config.protected_attributes)
    if overlap:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Columns cannot be both legitimate and protected: {sorted(overlap)}",
        )

    if config.target_column in config.legitimate_factors or config.target_column in config.protected_attributes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target_column must not appear in legitimate_factors or protected_attributes.",
        )

    update_session(config.session_id, "baseline", config)
    return {"status": "configured"}
