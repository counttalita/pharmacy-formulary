import json
import math
import os
import platform
import statistics
import time

import httpx

from app.database import execute, fetch_all, get_engine


def measure_listings():
    """Measure warm end-to-end HTTP latency and expose representative query plans."""
    # Include response transfer and JSON decoding, not only database execution.
    base_url = os.environ.get("BENCHMARK_URL", "http://web/api/v1")
    endpoints = ["/medicines", "/medicines?q=Generated", "/medicines?q=SEED-004",
                 "/medicines/SEED-0000/rules", "/dispenses",
                 "/dispenses?patient_ref=patient-0000", "/dispenses?medicine=SEED-0000",
                 "/dispenses?patient_ref=patient-0000&medicine=SEED-0000"]
    results = {}
    with httpx.Client(base_url=base_url, timeout=10) as client:
        for endpoint in endpoints:
            samples = []
            for iteration in range(110):
                started = time.perf_counter()
                response = client.get(endpoint)
                response.raise_for_status()
                response.json()
                if iteration >= 10:
                    samples.append((time.perf_counter() - started) * 1000)
            # Nearest-rank p95 over 100 measured requests after ten warmups.
            results[endpoint] = {"p50_ms": round(statistics.median(samples), 2),
                                 "p95_ms": round(sorted(samples)[math.ceil(len(samples) * .95) - 1], 2)}
    report = {"platform": platform.platform(), "base_url": base_url,
              "warmup_requests": 10, "measured_requests": 100, "results": results}
    with get_engine().connect() as connection:
        report["counts"] = {table: fetch_all(connection, f"SELECT count(*) AS total FROM {table}")[0]["total"]
                            for table in ("medicine", "formulary_rule", "dispense")}
        # Record real optimizer choices rather than forcing index scans on small tables.
        plans = {
            "medicine_search": "SELECT * FROM medicine WHERE name ILIKE '%Generated%' OR code ILIKE '%Generated%' ORDER BY code LIMIT 21",
            "patient_ledger": "SELECT * FROM dispense WHERE patient_ref='patient-0000' ORDER BY dispensed_at DESC,id DESC LIMIT 21",
            "medicine_ledger": "SELECT * FROM dispense WHERE medicine_id=(SELECT id FROM medicine WHERE code='SEED-0000') ORDER BY dispensed_at DESC,id DESC LIMIT 21",
            "rolling_sum": "SELECT sum(quantity) FROM dispense WHERE patient_ref='patient-0000' AND medicine_id=1 AND dispensed_at BETWEEN now()-interval '30 days' AND now()",
            "rule_history": "SELECT * FROM formulary_rule WHERE medicine_id=1 ORDER BY effective_from,id",
        }
        report["plans"] = {name: [row[0] for row in execute(connection, "EXPLAIN (ANALYZE, BUFFERS) " + sql)]
                           for name, sql in plans.items()}
    print(json.dumps(report, indent=2))
    if any(result["p95_ms"] >= 300 for result in results.values()):
        raise SystemExit("Listing p95 exceeded 300ms")


if __name__ == "__main__":
    # Benchmark an already-seeded running stack.
    measure_listings()
