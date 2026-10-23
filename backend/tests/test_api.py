from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from test_dispenses import active_rule, make_dispense


@pytest.fixture
def client(database):
    """Send real ASGI requests through routes and exception handlers."""
    # Import only after the test fixture configures its database URL.
    from app.main import app
    with TestClient(app) as client:
        yield client


def test_search_paginate_and_escape_literal_wildcards(client, database, medicine):
    """Search by case-insensitive substring with deterministic bounded pages."""
    # Add a second item to prove continuation and literal wildcard handling.
    with database.begin() as connection:
        connection.execute(text("INSERT INTO medicine(code,name,form,strength_value,strength_unit) VALUES ('ZZ-002','Literal % name','tablet',1,'unit')"))
    first = client.get("/api/v1/medicines", params={"limit": 1}).json()
    assert first["items"][0]["code"] == "MED-001"
    second = client.get("/api/v1/medicines", params={"limit": 1, "cursor": first["next_cursor"]}).json()
    assert second["items"][0]["code"] == "ZZ-002"
    assert second["next_cursor"] is None
    assert len(client.get("/api/v1/medicines", params={"q": "%"}).json()["items"]) == 1
    assert len(client.get("/api/v1/medicines", params={"q": "med-"}).json()["items"]) == 1


def test_detail_and_ordered_history(client, active_rule):
    """Expose the current rule and all versions through their required routes."""
    # Read the medicine and its full ordered history.
    detail = client.get("/api/v1/medicines/MED-001").json()
    assert detail["current_rule"]["id"] == active_rule["id"]
    history = client.get("/api/v1/medicines/MED-001/rules").json()
    assert history["items"][0]["id"] == active_rule["id"]
    assert history["items"][0]["is_current"] is True


def test_post_rule_and_conflict_contract(client, medicine):
    """Return a created rule and a field-specific duplicate-start conflict."""
    # Submit the same rule start twice through HTTP.
    payload = {"effective_from": "2025-01-01", "max_quantity_per_dispense": 30,
               "max_quantity_per_30_days": 60, "requires_authorisation": False}
    assert client.post("/api/v1/medicines/MED-001/rules", json=payload).status_code == 201
    conflict = client.post("/api/v1/medicines/MED-001/rules", json=payload)
    assert conflict.status_code == 409
    assert conflict.json()["errors"][0]["field"] == "effective_from"


def test_update_per_dispense_limit_from_60_to_30(client, medicine):
    """Updating the rule in force closes it at the new date and enforces the new limit."""
    # Start from: 10 Apr 2026 → open ended, in force now, 60 per dispense, 120 per 30 days, no authorisation.
    original = {"effective_from": "2026-04-10", "max_quantity_per_dispense": 60,
                "max_quantity_per_30_days": 120, "requires_authorisation": False}
    assert client.post("/api/v1/medicines/MED-001/rules", json=original).status_code == 201
    before = client.get("/api/v1/medicines/MED-001").json()["current_rule"]
    assert (before["max_quantity_per_dispense"], before["effective_to"]) == (60, None)
    # Update only the per-dispense limit, effective today in Johannesburg.
    today = datetime.now(ZoneInfo("Africa/Johannesburg")).date()
    update = {**original, "effective_from": today.isoformat(), "max_quantity_per_dispense": 30}
    created = client.post("/api/v1/medicines/MED-001/rules", json=update)
    assert created.status_code == 201
    history = client.get("/api/v1/medicines/MED-001/rules").json()["items"]
    assert len(history) == 2
    old, new = history
    midnight = datetime.combine(today, time.min, ZoneInfo("Africa/Johannesburg"))
    assert datetime.fromisoformat(old["effective_to"]) == midnight
    assert old["max_quantity_per_dispense"] == 60 and old["is_current"] is False
    assert datetime.fromisoformat(new["effective_from"]) == midnight
    assert new["effective_to"] is None and new["is_current"] is True
    assert (new["max_quantity_per_dispense"], new["max_quantity_per_30_days"], new["requires_authorisation"]) == (30, 120, False)
    assert client.get("/api/v1/medicines/MED-001").json()["current_rule"]["id"] == new["id"]
    # The new limit applies to dispenses from now on: 31 is rejected, 30 is accepted.
    now = datetime.now(timezone.utc).isoformat()
    rejected = client.post("/api/v1/dispenses", json=make_dispense(quantity=31, dispensed_at=now, idempotency_key="over"))
    assert rejected.status_code == 422
    assert [e["code"] for e in rejected.json()["errors"]] == ["single_quantity_limit"]
    accepted = client.post("/api/v1/dispenses", json=make_dispense(quantity=30, dispensed_at=now, idempotency_key="within"))
    assert accepted.status_code == 201
    assert accepted.json()["rule_id"] == new["id"]


@pytest.mark.parametrize(("changes", "expected"), [
    ({"max_quantity_per_30_days": 59}, [("rolling_below_single", "max_quantity_per_30_days")]),
    ({}, [("rule_unchanged", "body")]),
    ({"effective_from": "0001-01-01"}, [("invalid_input", "effective_from")]),
    ({"max_quantity_per_dispense": 0}, [("invalid_input", "max_quantity_per_dispense")]),
    ({"requires_authorisation": "no"}, [("invalid_input", "requires_authorisation")]),
])
def test_rule_update_validation_contract(client, medicine, changes, expected):
    """Invalid updates return 422 with field-addressable codes and never 500."""
    # Each update targets a date inside an existing 60/120 period.
    base = {"effective_from": "2025-01-01", "max_quantity_per_dispense": 60,
            "max_quantity_per_30_days": 120, "requires_authorisation": False}
    assert client.post("/api/v1/medicines/MED-001/rules", json=base).status_code == 201
    response = client.post("/api/v1/medicines/MED-001/rules", json={**base, "effective_from": "2025-02-01", **changes})
    assert response.status_code == 422
    assert [(e["code"], e["field"]) for e in response.json()["errors"]] == expected


def test_capture_and_paginate_patient_ledger(client, active_rule):
    """Return stable newest-first pages and exact patient and medicine filters."""
    # Equal timestamps must be ordered by ID without skipping or repeating rows.
    for index in range(3):
        assert client.post("/api/v1/dispenses", json=make_dispense(quantity=1, idempotency_key=f"key-{index}")).status_code == 201
    first = client.get("/api/v1/dispenses", params={"patient_ref": "opaque-patient", "medicine": "MED-001", "limit": 2}).json()
    second = client.get("/api/v1/dispenses", params={"patient_ref": "opaque-patient", "medicine": "MED-001", "limit": 2, "cursor": first["next_cursor"]}).json()
    assert [item["id"] for item in first["items"] + second["items"]] == [3, 2, 1]
    assert second["next_cursor"] is None
    assert client.get("/api/v1/dispenses", params={"patient_ref": "someone-else"}).json()["items"] == []
    assert client.get("/api/v1/dispenses", params={"medicine": "missing"}).json()["items"] == []


@pytest.mark.parametrize("path", ["/api/v1/medicines?limit=0", "/api/v1/dispenses?limit=101", "/api/v1/dispenses?cursor=bad", "/api/v1/medicines/missing", "/does-not-exist"])
def test_consistent_error_contract(client, path):
    """Use the same error envelope for pagination, missing routes and missing entities."""
    # Validate errors through the actual HTTP exception handlers.
    response = client.get(path)
    assert response.status_code in (404, 422)
    assert set(response.json()["errors"][0]) == {"code", "field", "message"}


def test_audit_malformed_json(client, database):
    """Malformed dispense requests produce a logged field-level rejection."""
    # Exercise parsing failure before schema validation can run.
    response = client.post("/api/v1/dispenses", content='{', headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json()["errors"]
    with database.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM attempt")).scalar_one() == 1
