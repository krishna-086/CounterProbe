"""
FairLens FastAPI application entry point.

Wires up CORS middleware, loads environment variables from .env, registers
all API routers (health, upload, and later: baseline, probe, remediate), and
enforces a global 10 MB request-body cap so oversized uploads are rejected
before they hit a route handler. Exposes a root GET / endpoint as a basic
liveness signal.
"""

import os

from dotenv import load_dotenv
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import baseline, demo, health, probe, remediate, upload
from app.services.data_processor import MAX_FILE_BYTES

load_dotenv()

# Multipart encoding adds a small overhead (boundary + headers) on top of the
# raw file bytes. Allow ~1 MB of headroom so a file at exactly MAX_FILE_BYTES
# isn't falsely rejected at the middleware layer; the precise per-file check
# still happens inside data_processor.process_csv.
MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1 * 1024 * 1024

app = FastAPI(title="CounterProbe API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    # Explicit allowlist — wildcard `"*"` is incompatible with
    # `allow_credentials=True` per the CORS spec, so each origin is named.
    allow_origins=[
        "http://localhost:3000",
        "https://fairlens-494522.web.app",
        "https://fairlens-494522.firebaseapp.com",
        "https://counterprobe.web.app",
        "https://counterprobe.firebaseapp.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_REQUEST_BYTES:
        return JSONResponse(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            content={"detail": f"Request body exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB limit."},
        )
    return await call_next(request)


app.include_router(health.router, prefix="/api")
app.include_router(upload.router, prefix="/api")
app.include_router(baseline.router, prefix="/api")
app.include_router(probe.router, prefix="/api")
app.include_router(remediate.router, prefix="/api")
app.include_router(demo.router, prefix="/api")


@app.get("/")
def root():
    return {"status": "CounterProbe API running"}
