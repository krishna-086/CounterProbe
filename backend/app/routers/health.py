"""
Health check router.

Exposes GET /api/health used by the frontend, load balancer, and Cloud Run
to verify the FairLens API process is alive and responding.
"""

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
def health():
    return {"ok": True}
