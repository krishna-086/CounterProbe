"""
End-to-end smoke test for the entire FairLens pipeline.

Walks every endpoint in order against a live local server, prints PASS/FAIL
per step, and exits non-zero on the first failure:

    1. POST /api/upload                  (uploads demo_data/hiring_data.csv)
    2. POST /api/baseline-advisory       (Gemini per-column recommendations)
    3. POST /api/configure-baseline      (legit + protected + target)
    4. POST /api/run-probes              (SSE stream, num_base_profiles=10)
    5. POST /api/grade-cves              (Gemini severity grading)
    6. POST /api/remediate               (Gemini fix strategies, first CVE)
    7. POST /api/rescan                  (apply fix, replay probes)

Requires the API to be running locally and a valid GEMINI_API_KEY in
backend/.env (loaded automatically below).

Run from backend/:
    venv/Scripts/uvicorn app.main:app --reload --port 8000   # in one terminal
    venv/Scripts/python.exe test_full_flow.py                # in another
"""

import json
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "http://localhost:8000"
DATASET = Path(__file__).parent / "demo_data" / "hiring_data.csv"

_steps_passed = 0
_steps_total = 0


def step(num: int, title: str) -> None:
    global _steps_total
    _steps_total += 1
    print(f"\n{'-' * 70}")
    print(f"  STEP {num}: {title}")
    print(f"{'-' * 70}")


def passed(msg: str = "") -> None:
    global _steps_passed
    _steps_passed += 1
    print(f"  [PASS] {msg}".rstrip())


def failed(msg: str, body: str | None = None) -> None:
    print(f"  [FAIL] {msg}")
    if body:
        print(f"         {body}")
    print(f"\nResult: {_steps_passed}/{_steps_total} steps passed")
    sys.exit(1)


def main() -> None:
    print("=" * 70)
    print("  FairLens full-flow smoke test")
    print("=" * 70)
    print(f"  backend: {BASE_URL}")
    print(f"  dataset: {DATASET}")

    if not DATASET.exists():
        print()
        failed(
            f"dataset not found at {DATASET}",
            "run `python scripts/generate_dataset.py` from the project root first",
        )

    client = httpx.Client(timeout=300.0)

    # -------- 1: Upload --------
    step(1, "POST /api/upload")
    t0 = time.perf_counter()
    try:
        r = client.post(
            f"{BASE_URL}/api/upload",
            files={
                "file": ("hiring_data.csv", DATASET.read_bytes(), "text/csv"),
            },
            timeout=30.0,
        )
    except httpx.ConnectError as exc:
        failed(f"could not reach {BASE_URL}: {exc}")
    if r.status_code != 200:
        failed(f"unexpected status {r.status_code}", r.text[:300])
    body = r.json()
    session_id = body["session_id"]
    passed(
        f"session={session_id[:8]}, rows={body['row_count']:,}, "
        f"cols={len(body['columns'])} ({time.perf_counter() - t0:.1f}s)"
    )

    # -------- 2: Baseline advisory --------
    step(2, "POST /api/baseline-advisory")
    t0 = time.perf_counter()
    r = client.post(
        f"{BASE_URL}/api/baseline-advisory",
        json={
            "session_id": session_id,
            "scenario_hint": "hiring decisions for software engineering candidates",
        },
        timeout=120.0,
    )
    if r.status_code != 200:
        failed(f"unexpected status {r.status_code}", r.text[:300])
    advisories = r.json()
    if not isinstance(advisories, list) or not advisories:
        failed("advisory response was empty or not a list")
    passed(f"{len(advisories)} advisories ({time.perf_counter() - t0:.1f}s)")
    print()
    for a in advisories:
        snippet = a["reasoning"][:78] + ("..." if len(a["reasoning"]) > 78 else "")
        print(
            f"    {a['column']:18}  rec={a['recommendation']:18} "
            f"risk={a['proxy_risk']:6}  {snippet}"
        )

    # -------- 3: Configure baseline --------
    step(3, "POST /api/configure-baseline")
    r = client.post(
        f"{BASE_URL}/api/configure-baseline",
        json={
            "session_id": session_id,
            # `name` is intentionally excluded from BOTH lists: it's a per-row
            # identifier (2000 unique values for 2000 rows). One-hot encoding
            # turns it into pure memorization that drowns the demographic
            # signal.
            #
            # `university_tier` is in protected_attributes (not legitimate)
            # because it's the actual bias channel in this dataset — the
            # generator weights demographic groups into different tier
            # distributions and tier directly drives the hire decision. The
            # model still trains on it (probe.py:_ensure_model uses
            # legitimate ∪ protected), but the probes also flip it, which is
            # what surfaces the bias.
            "legitimate_factors": [
                "gpa", "years_experience", "skills_score",
                "certifications", "interview_score",
            ],
            "protected_attributes": ["gender", "age", "university_tier"],
            "target_column": "hired",
        },
        timeout=10.0,
    )
    if r.status_code != 200:
        failed(f"unexpected status {r.status_code}", r.text[:300])
    passed(r.json().get("status", ""))

    # -------- 4: Run probes (SSE) --------
    step(4, "POST /api/run-probes  (SSE, num_base_profiles=10)")
    t0 = time.perf_counter()
    final = None
    progress_count = 0
    try:
        with client.stream(
            "POST",
            f"{BASE_URL}/api/run-probes",
            json={"session_id": session_id, "num_base_profiles": 10},
            headers={"Accept": "text/event-stream"},
            timeout=600.0,
        ) as resp:
            if resp.status_code != 200:
                resp.read()
                failed(f"unexpected status {resp.status_code}", resp.text[:300])
            for line in resp.iter_lines():
                if not line.startswith("data:"):
                    continue
                payload = json.loads(line[len("data:") :].strip())
                if payload.get("status") == "error":
                    failed(f"stream error: {payload.get('detail')}")
                if payload.get("status") == "complete":
                    final = payload
                    break
                progress_count += 1
                if progress_count <= 3 or progress_count % 10 == 0:
                    print(
                        f"    [event {progress_count:>3}] "
                        f"{payload['probes_completed']}/{payload['total_probes']} done, "
                        f"{payload['anomalies_found']} flips "
                        f"({payload['failure_rate']:.1%})"
                    )
    except httpx.RemoteProtocolError as exc:
        failed(f"SSE connection broken: {exc}")

    if final is None:
        failed("stream ended without status=complete event")
    summary = final["summary"]
    passed(
        f"{progress_count} progress events + complete; "
        f"{summary['anomalies_found']}/{summary['total_probes']} flips "
        f"({summary['failure_rate']:.1%})  ({time.perf_counter() - t0:.1f}s)"
    )

    # -------- 5: Grade CVEs --------
    step(5, "POST /api/grade-cves")
    t0 = time.perf_counter()
    r = client.post(
        f"{BASE_URL}/api/grade-cves",
        json={"session_id": session_id},
        timeout=180.0,
    )
    if r.status_code != 200:
        failed(f"unexpected status {r.status_code}", r.text[:300])
    cves = r.json()
    if not cves:
        failed("grade-cves returned an empty list")
    passed(f"{len(cves)} CVEs ({time.perf_counter() - t0:.1f}s)")
    print()
    for c in cves:
        ev = c["evidence"]
        violation = " (4/5ths VIOLATION)" if ev["four_fifths_violation"] else ""
        print(f"    {c['id']}  [{c['severity']:8}]  {c['title']}")
        print(f"      attack:    {c['attack_vector']}")
        print(
            f"      evidence:  {ev['prediction_flips']}/{ev['probe_pairs_tested']} flips "
            f"({ev['flip_rate']:.1%}), mean_delta={ev['mean_delta']:+.3f}, "
            f"sel_ratio={ev['selection_rate_ratio']:.2f}{violation}"
        )

    # -------- 6: Remediate (first CVE) --------
    target = cves[0]
    step(6, f"POST /api/remediate  (cve_id={target['id']})")
    t0 = time.perf_counter()
    r = client.post(
        f"{BASE_URL}/api/remediate",
        json={"session_id": session_id, "cve_id": target["id"]},
        timeout=120.0,
    )
    if r.status_code != 200:
        failed(f"unexpected status {r.status_code}", r.text[:300])
    remediation = r.json()
    if not remediation.get("strategies"):
        failed("remediation returned no strategies")
    passed(
        f"{len(remediation['strategies'])} strategies, "
        f"recommended={remediation['recommended_strategy']!r} "
        f"({time.perf_counter() - t0:.1f}s)"
    )
    print()
    for i, s in enumerate(remediation["strategies"]):
        marker = "*" if s["name"] == remediation["recommended_strategy"] else " "
        print(
            f"    [{marker}{i}] {s['name']:38}  effort={s['effort']:6}  "
            f"bias_red={s['estimated_bias_reduction']:.2f}  "
            f"acc_trade={s['accuracy_tradeoff']:+.2f}"
        )
        action_snippet = s["action"][:110] + ("..." if len(s["action"]) > 110 else "")
        print(f"        {action_snippet}")

    # -------- 7: Rescan (strategy_index=0) --------
    step(7, f"POST /api/rescan  (cve_id={target['id']}, strategy_index=0)")
    t0 = time.perf_counter()
    r = client.post(
        f"{BASE_URL}/api/rescan",
        json={
            "session_id": session_id,
            "cve_id": target["id"],
            "strategy_index": 0,
        },
        timeout=300.0,
    )
    if r.status_code != 200:
        failed(f"unexpected status {r.status_code}", r.text[:300])
    cmp = r.json()
    if cmp["after_failure_rate"] > cmp["before_failure_rate"] + 1e-9:
        failed(
            f"fix made bias WORSE: before={cmp['before_failure_rate']:.1%}, "
            f"after={cmp['after_failure_rate']:.1%}"
        )
    passed(f"({time.perf_counter() - t0:.1f}s)")
    print()
    print(
        f"    BEFORE:  {cmp['before_anomalies']:>3}/{cmp['total_probes']} flips "
        f"({cmp['before_failure_rate']:.1%})   accuracy={cmp['accuracy_before']:.3f}"
    )
    print(
        f"    AFTER :  {cmp['after_anomalies']:>3}/{cmp['total_probes']} flips "
        f"({cmp['after_failure_rate']:.1%})   accuracy={cmp['accuracy_after']:.3f}"
    )
    df_failure = cmp["before_failure_rate"] - cmp["after_failure_rate"]
    df_accuracy = cmp["accuracy_after"] - cmp["accuracy_before"]
    print(
        f"    DELTA :  failure_rate {df_failure:+.1%}, "
        f"accuracy {df_accuracy:+.3f}"
    )

    print(f"\n{'=' * 70}")
    print(f"  RESULT: {_steps_passed}/{_steps_total} steps passed")
    print(f"{'=' * 70}")
    sys.exit(0 if _steps_passed == _steps_total else 1)


if __name__ == "__main__":
    main()
