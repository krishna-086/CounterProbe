"""
Upload router.

Exposes POST /api/upload — accepts a CSV file as multipart form data, parses
it via data_processor.process_csv, stashes the resulting DataFrame in the
in-memory session store, and returns the session_id plus a column profile and
preview the frontend uses on the baseline-configuration screen.
"""

import math

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.models.schemas import UploadResponse
from app.services.data_processor import process_csv
from app.utils.session_store import create_session

PREVIEW_ROWS = 5

router = APIRouter(tags=["upload"])


def _build_preview(df: pd.DataFrame) -> list[dict]:
    """Convert df.head(N) to JSON-safe dicts (NaN/inf become None)."""
    head = df.head(PREVIEW_ROWS).replace({np.nan: None})
    records = head.to_dict(orient="records")
    for row in records:
        for k, v in row.items():
            if isinstance(v, float) and not math.isfinite(v):
                row[k] = None
    return records


def _looks_like_csv(file: UploadFile) -> bool:
    name = (file.filename or "").lower()
    if name.endswith(".csv"):
        return True
    ctype = (file.content_type or "").lower()
    return "csv" in ctype or ctype == "text/plain"


@router.post("/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    if not _looks_like_csv(file):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="Only CSV files are accepted.",
        )

    df, columns = await process_csv(file)
    session_id = create_session(df)

    return UploadResponse(
        session_id=session_id,
        columns=columns,
        row_count=len(df),
        preview=_build_preview(df),
    )
