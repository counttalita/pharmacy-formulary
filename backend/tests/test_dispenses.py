from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from test_rules import make_rule


def make_dispense(**changes):
    """Build an opaque, backdated dispense request with overridable test fields."""
    return {"medicine_code": "MED-001", "patient_ref": "opaque-patient", "quantity": 20,
            "dispensed_at": "2025-03-20T10:00:00Z", "authorisation_ref": None,
            "idempotency_key": "request-1", **changes}


@pytest.fixture
def active_rule(database, medicine):
    """Give service tests a rule with a 30-unit single and 60-unit rolling limit."""
    # Use the real supersede operation to build rule history.
    from app.rules import supersede_rule
    return supersede_rule(database, "MED-001", make_rule("2025-01-01"))


def test_replay_success_and_conflicting_payload(database, active_rule):
    """Identical retries return the saved success; different payloads conflict."""
    # Retry one request, then reuse its key for another quantity.
    from app.dispenses import capture_dispense
    original = capture_dispense(database, make_dispense())
    assert original[0] == 201
    assert capture_dispense(database, make_dispense()) == original
    assert capture_dispense(database, make_dispense(quantity=21))[0] == 409
    with database.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM dispense")).scalar_one() == 1
        assert connection.execute(text("SELECT count(*) FROM attempt")).scalar_one() == 1


def test_replay_equivalent_timestamp_offsets(database, active_rule):
    """Equivalent UTC and Johannesburg timestamp strings describe the same payload."""
    # Normalize time offsets before comparing a retry.
    from app.dispenses import capture_dispense
    original = capture_dispense(database, make_dispense())
    assert capture_dispense(database, make_dispense(dispensed_at="2025-03-20T12:00:00+02:00")) == original


def test_collect_all_reasons_and_persist_rejection(database, active_rule):
    """Rejected outcomes retain every independent violation but no dispense."""
    # Combine inactivity, both quantity limits and missing authorisation.
    from app.dispenses import capture_dispense
    with database.begin() as connection:
        connection.execute(text("UPDATE medicine SET is_active=false"))
        connection.execute(text("UPDATE formulary_rule SET requires_authorisation=true"))
    status, body = capture_dispense(database, make_dispense(quantity=70, authorisation_ref="  "))
    assert status == 422
    assert {error["code"] for error in body["errors"]} == {
        "inactive_medicine", "single_quantity_limit", "rolling_quantity_limit", "authorisation_required"}
    with database.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM dispense")).scalar_one() == 0
        assert connection.execute(text("SELECT count(*) FROM attempt_reason")).scalar_one() == 4
    # Changes to current state must not change a previously rejected retry.
    with database.begin() as connection:
        connection.execute(text("UPDATE medicine SET is_active=true"))
    assert capture_dispense(database, make_dispense(quantity=70, authorisation_ref="  ")) == (status, body)


def test_use_historical_rule_and_preserve_its_identity(database, active_rule):
    """Backdating chooses event-time rules rather than today's rule."""
    # Schedule a stricter rule after the occurrence timestamp.
    from app.dispenses import capture_dispense
    from app.rules import supersede_rule
    supersede_rule(database, "MED-001", make_rule("2025-04-01", 5))
    status, response = capture_dispense(database, make_dispense())
    assert status == 201
    assert response["rule_id"] == active_rule["id"]


def test_no_rule_and_inactive_report_both(database, medicine):
    """Report independently knowable errors when no historical rule exists."""
    # Disable a medicine with no rule history.
    from app.dispenses import capture_dispense
    with database.begin() as connection:
        connection.execute(text("UPDATE medicine SET is_active=false"))
    status, response = capture_dispense(database, make_dispense())
    assert status == 422
    assert {error["code"] for error in response["errors"]} == {"inactive_medicine", "no_rule"}


@pytest.mark.parametrize("quantity", [0, -1, 1.5, True, "2"])
def test_reject_invalid_quantities_and_log_them(database, active_rule, quantity):
    """Reject coercion, nonintegral units and nonpositive quantities."""
    # Invalid schemas also produce persisted rejection outcomes.
    from app.dispenses import capture_dispense
    assert capture_dispense(database, make_dispense(quantity=quantity))[0] == 422
    with database.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM attempt")).scalar_one() == 1
        assert connection.execute(text("SELECT count(*) FROM dispense")).scalar_one() == 0


def test_window_includes_exact_lower_boundary(database, active_rule):
    """A dispense exactly 30 days earlier contributes to the inclusive limit."""
    # Record two historical events first, then evaluate their inclusive endpoint.
    from app.dispenses import capture_dispense
    assert capture_dispense(database, make_dispense(quantity=30, dispensed_at="2025-02-18T10:00:00Z", idempotency_key="a"))[0] == 201
    assert capture_dispense(database, make_dispense(quantity=30, dispensed_at="2025-03-01T10:00:00Z", idempotency_key="b"))[0] == 201
    assert capture_dispense(database, make_dispense(quantity=1))[0] == 422
    assert capture_dispense(database, make_dispense(quantity=1, dispensed_at="2025-03-20T10:00:00.000001Z", idempotency_key="c"))[0] == 201


def test_backdating_counts_events_regardless_of_recording_order(database, active_rule):
    """A historical event recorded later still contributes to the event-time window."""
    # Record dates out of order, then exceed their cumulative allowance.
    from app.dispenses import capture_dispense
    assert capture_dispense(database, make_dispense(quantity=30, dispensed_at="2025-03-10T10:00:00Z", idempotency_key="a"))[0] == 201
    assert capture_dispense(database, make_dispense(quantity=30, dispensed_at="2025-03-01T10:00:00Z", idempotency_key="b"))[0] == 201
    assert capture_dispense(database, make_dispense(quantity=1))[0] == 422


def test_backdating_cannot_break_a_later_accepted_window(database, active_rule):
    """A new older event must not invalidate an already accepted later window."""
    # Fill a later window and try adding an earlier event that would raise it to 61.
    from app.dispenses import capture_dispense
    assert capture_dispense(database, make_dispense(quantity=30, idempotency_key="a"))[0] == 201
    assert capture_dispense(database, make_dispense(quantity=30, idempotency_key="b"))[0] == 201
    status, response = capture_dispense(database, make_dispense(quantity=1, dispensed_at="2025-03-01T10:00:00Z"))
    assert status == 422
    assert response["errors"][0]["code"] == "rolling_quantity_limit"


def test_keep_patient_references_opaque(database, active_rule):
    """Do not trim or interpret a nonblank patient reference."""
    # Preserve reference bytes in both persistence and the response.
    from app.dispenses import capture_dispense
    assert capture_dispense(database, make_dispense(patient_ref=" opaque "))[1]["patient_ref"] == " opaque "


def test_reject_naive_and_future_times(database, active_rule):
    """Require explicit offsets and disallow events that have not happened."""
    # Check separate keys so each invalid outcome is independently recorded.
    from app.dispenses import capture_dispense
    assert capture_dispense(database, make_dispense(dispensed_at="2025-03-20T10:00:00"))[0] == 422
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    assert capture_dispense(database, make_dispense(dispensed_at=future, idempotency_key="future"))[0] == 422
