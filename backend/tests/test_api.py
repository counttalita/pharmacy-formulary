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
