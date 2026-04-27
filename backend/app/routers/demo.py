"""
Demo dataset router.

Exposes GET /api/demo-data — serves the pre-generated synthetic hiring CSV
from backend/demo_data/. The frontend's "Try with sample data" link fetches
this and feeds it through the regular upload flow so the demo path uses the
same code as a real upload.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

router = APIRouter(tags=["demo"])

# backend/app/routers/demo.py -> backend/demo_data/hiring_data.csv
DEMO_CSV = Path(__file__).resolve().parents[2] / "demo_data" / "hiring_data.csv"


@router.get("/demo-data")
def get_demo_data() -> FileResponse:
    if not DEMO_CSV.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Demo dataset not found. Run `python scripts/generate_dataset.py` "
                "from the project root to materialize it."
            ),
        )
    return FileResponse(
        DEMO_CSV,
        media_type="text/csv",
        filename="hiring_data.csv",
    )
