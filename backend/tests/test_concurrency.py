import json
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from test_dispenses import active_rule, make_dispense


def wait_for_blocked_connections(database, blocker_pid, expected):
    """Require observed PostgreSQL lock contention, not lucky thread scheduling."""
    # Poll actual blocking relationships with a bounded deadline.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with database.connect() as connection:
            count = connection.execute(text("""
                SELECT count(*) FROM pg_stat_activity
                WHERE :pid = ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
            """), {"pid": blocker_pid}).scalar_one()
        if count >= expected:
            return
        time.sleep(0.02)
    pytest.fail(f"Expected {expected} connections blocked by backend {blocker_pid}; observed {count}")


def test_concurrent_dispenses_cannot_jointly_exceed_limit(database, active_rule):
    """Hold both requests at their shared lock before letting either evaluate its sum."""
    # Permit one 40-unit dispense while rejecting their combined 80 units.
    from app.dispenses import capture_dispense, lock_resource
    with database.begin() as connection:
        connection.execute(text("UPDATE formulary_rule SET max_quantity_per_dispense=60"))
    barrier = Barrier(3)

    def submit_request(key):
        """Start each request from an independent pooled connection at the same barrier."""
        # Release both callers together to create competing transactions.
        barrier.wait(timeout=5)
        from app.main import app
        with TestClient(app) as client:
            response = client.post("/api/v1/dispenses", json=make_dispense(quantity=40, idempotency_key=key))
            return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as workers:
        gate = database.connect()
        transaction = gate.begin()
        try:
            # Prevent either contender from evaluating until both have requested the lock.
            lock_resource(gate, f"dispense:{json.dumps(['opaque-patient', active_rule['medicine_id']])}")
            blocker = gate.execute(text("SELECT pg_backend_pid()")).scalar_one()
            futures = [workers.submit(submit_request, key) for key in ("left", "right")]
            barrier.wait(timeout=5)
            wait_for_blocked_connections(database, blocker, 2)
            assert all(not future.done() for future in futures)
        finally:
            # Release the gate even when the contention assertion fails.
            transaction.rollback()
            gate.close()
        results = [future.result(timeout=5) for future in futures]
    assert sorted(status for status, _ in results) == [201, 422]
    with database.connect() as connection:
        assert connection.execute(text("SELECT sum(quantity) FROM dispense")).scalar_one() == 40
        assert connection.execute(text("SELECT count(*) FROM attempt")).scalar_one() == 2


def test_concurrent_retries_create_one_outcome(database, active_rule):
    """Two callers sharing a key wait before reading or writing its outcome."""
    # Gate the idempotency resource and observe both waiters.
    from app.dispenses import capture_dispense, lock_resource
    with ThreadPoolExecutor(max_workers=2) as workers:
        gate = database.connect()
        transaction = gate.begin()
        try:
            lock_resource(gate, "idempotency:request-1")
            blocker = gate.execute(text("SELECT pg_backend_pid()")).scalar_one()
            futures = [workers.submit(capture_dispense, database, make_dispense()) for _ in range(2)]
            wait_for_blocked_connections(database, blocker, 2)
        finally:
            # Permit the first writer, then the waiting retry, to complete.
            transaction.rollback()
            gate.close()
        results = [future.result(timeout=5) for future in futures]
    assert results[0] == results[1]
    assert results[0][0] == 201
    with database.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM dispense")).scalar_one() == 1


def test_exclusion_constraint_blocks_concurrent_overlaps(database, medicine):
    """Prove overlap protection even when competing writers bypass the service."""
    # Keep the first insertion uncommitted while a second tries the same period.
    from test_database import insert_rule

    def insert_competing_rule():
        """Attempt an overlapping write on a separate database connection."""
        # Let PostgreSQL decide the conflicting concurrent insertion.
        with database.begin() as connection:
            insert_rule(connection, medicine, "2025-01-01T00:00:00Z", None)

    with ThreadPoolExecutor(max_workers=1) as workers:
        gate = database.connect()
        transaction = gate.begin()
        try:
            insert_rule(gate, medicine, "2025-01-01T00:00:00Z", None)
            blocker = gate.execute(text("SELECT pg_backend_pid()")).scalar_one()
            future = workers.submit(insert_competing_rule)
            wait_for_blocked_connections(database, blocker, 1)
            transaction.commit()
        finally:
            # Release the owning connection before awaiting the contender.
            gate.close()
        with pytest.raises(IntegrityError):
            future.result(timeout=5)
