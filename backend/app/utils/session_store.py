"""
In-memory session store for the FairLens API.

FairLens is stateless and session-only by design (see CLAUDE.md): there is no
database. This module holds uploaded DataFrames, trained scikit-learn models,
baseline configurations, and probe results in a process-local dict keyed by a
UUID session_id.

Sessions auto-expire 30 minutes after their last access (sliding window). The
expiry check is lazy — it runs on every get/update — so no background sweeper
is needed. This is sufficient for a single-instance Cloud Run deployment used
for hackathon demos; it is NOT safe for horizontally scaled production traffic.
"""

import threading
import time
import uuid
from typing import Any, Dict, Optional

import pandas as pd

SESSION_TTL_SECONDS = 30 * 60

_sessions: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()


def _is_expired(entry: Dict[str, Any]) -> bool:
    return (time.time() - entry["last_accessed"]) > SESSION_TTL_SECONDS


def _touch(entry: Dict[str, Any]) -> None:
    entry["last_accessed"] = time.time()


def create_session(df: pd.DataFrame) -> str:
    """Register a new session seeded with the uploaded DataFrame. Returns the session_id."""
    session_id = str(uuid.uuid4())
    now = time.time()
    with _lock:
        _sessions[session_id] = {
            "df": df,
            "created_at": now,
            "last_accessed": now,
        }
    return session_id


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    """Return the session dict, or None if it doesn't exist or has expired."""
    with _lock:
        entry = _sessions.get(session_id)
        if entry is None:
            return None
        if _is_expired(entry):
            del _sessions[session_id]
            return None
        _touch(entry)
        return entry


def update_session(session_id: str, key: str, value: Any) -> bool:
    """Set session[key] = value. Returns False if the session is missing or expired."""
    with _lock:
        entry = _sessions.get(session_id)
        if entry is None:
            return False
        if _is_expired(entry):
            del _sessions[session_id]
            return False
        entry[key] = value
        _touch(entry)
        return True


def delete_session(session_id: str) -> bool:
    """Remove a session. Returns True if it existed."""
    with _lock:
        return _sessions.pop(session_id, None) is not None
