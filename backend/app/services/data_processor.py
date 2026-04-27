"""
CSV ingestion and column profiling for the upload endpoint.

Reads a user-uploaded CSV into a pandas DataFrame, classifies each column as
numeric / categorical / text, and computes the per-column metadata
(unique count, null percentage, sample values) the frontend renders on the
baseline-configuration screen.

Hard limits enforced here protect the API from abusive uploads:
    - file size: 10 MB
    - row count: 50,000
    - column count: 50

Common upload failures (empty file, malformed CSV, encoding errors) are
translated into HTTPExceptions with 400-class status codes so the frontend
can show a useful error toast instead of a generic 500.
"""

import io
from typing import List, Tuple

import pandas as pd
from fastapi import HTTPException, UploadFile, status

from app.models.schemas import ColumnInfo

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_ROWS = 50_000
MAX_COLUMNS = 50
SAMPLE_VALUE_COUNT = 5
CATEGORICAL_UNIQUE_THRESHOLD = 20
CATEGORICAL_RATIO_THRESHOLD = 0.05


def _classify_dtype(series: pd.Series) -> str:
    """Bucket a pandas Series into 'numeric', 'categorical', or 'text'."""
    if pd.api.types.is_bool_dtype(series):
        return "categorical"
    if pd.api.types.is_numeric_dtype(series):
        return "numeric"

    non_null_count = series.notna().sum()
    if non_null_count == 0:
        return "categorical"

    unique_count = series.nunique(dropna=True)
    unique_ratio = unique_count / non_null_count
    if unique_count <= CATEGORICAL_UNIQUE_THRESHOLD or unique_ratio <= CATEGORICAL_RATIO_THRESHOLD:
        return "categorical"
    return "text"


def _profile_column(series: pd.Series) -> ColumnInfo:
    null_pct = float(series.isna().mean() * 100)
    sample_values = (
        series.dropna().head(SAMPLE_VALUE_COUNT).tolist() if not series.dropna().empty else []
    )
    return ColumnInfo(
        name=str(series.name),
        dtype=_classify_dtype(series),
        unique_count=int(series.nunique(dropna=True)),
        null_pct=round(null_pct, 2),
        sample_values=sample_values,
    )


async def process_csv(file: UploadFile) -> Tuple[pd.DataFrame, List[ColumnInfo]]:
    """
    Read and validate an uploaded CSV. Returns the DataFrame plus column profiles.

    Raises HTTPException(400) on any validation or parse failure.
    """
    contents = await file.read()

    if not contents:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB limit.",
        )

    try:
        df = pd.read_csv(io.BytesIO(contents))
    except UnicodeDecodeError:
        try:
            df = pd.read_csv(io.BytesIO(contents), encoding="latin-1")
        except Exception as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail=f"Could not decode CSV file: {exc}",
            )
    except pd.errors.EmptyDataError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="CSV file contains no data.")
    except pd.errors.ParserError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"CSV is malformed and could not be parsed: {exc}",
        )
    except Exception as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read CSV: {exc}",
        )

    if df.empty:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="CSV has headers but no rows.")
    if len(df) > MAX_ROWS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"Dataset exceeds the {MAX_ROWS:,}-row limit (got {len(df):,}).",
        )
    if len(df.columns) > MAX_COLUMNS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"Dataset exceeds the {MAX_COLUMNS}-column limit (got {len(df.columns)}).",
        )

    columns = [_profile_column(df[col]) for col in df.columns]
    return df, columns
