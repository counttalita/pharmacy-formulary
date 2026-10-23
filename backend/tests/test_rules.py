from datetime import date, datetime, timezone

import pytest
from sqlalchemy import text


def make_rule(start, maximum=30):
    """Build a minimal request for a rule beginning on a business date."""
    # Validate through the same request schema used by the API.
    from app.schemas import CreateRule
    return CreateRule(effective_from=date.fromisoformat(start), max_quantity_per_dispense=maximum,
                      max_quantity_per_30_days=60, requires_authorisation=False)


def test_split_period_and_preserve_scheduled_future(database, medicine):
    """A start inside a period truncates that period without deleting future rules."""
    # Introduce January and March, then split January with February.
    from app.rules import supersede_rule
    supersede_rule(database, "MED-001", make_rule("2025-01-01", 30))
    supersede_rule(database, "MED-001", make_rule("2025-03-01", 10))
    supersede_rule(database, "MED-001", make_rule("2025-02-01", 20))
    with database.connect() as connection:
        rows = connection.execute(text("SELECT effective_from,effective_to FROM formulary_rule ORDER BY effective_from")).all()
    assert len(rows) == 3
    assert rows[0].effective_to == rows[1].effective_from
    assert rows[1].effective_to == rows[2].effective_from
    assert rows[2].effective_to is None
    assert rows[0].effective_from == datetime(2024, 12, 31, 22, tzinfo=timezone.utc)


def test_duplicate_start_is_conflict(database, medicine):
    """Reject replacing an existing rule with the same starting instant."""
    # Retain the first rule when a second request targets the same boundary.
    from app.errors import ApiError
    from app.rules import supersede_rule
    supersede_rule(database, "MED-001", make_rule("2025-01-01"))
    with pytest.raises(ApiError) as caught:
        supersede_rule(database, "MED-001", make_rule("2025-01-01", 90))
    assert caught.value.status == 409


def test_insert_before_first_rule(database, medicine):
    """A rule before existing history ends at the next scheduled start."""
    # Insert older history after a future version has already been scheduled.
    from app.rules import supersede_rule
    future = supersede_rule(database, "MED-001", make_rule("2025-03-01"))
    older = supersede_rule(database, "MED-001", make_rule("2025-01-01"))
    assert older["effective_to"] == future["effective_from"]


def test_reject_rolling_below_single_and_unchanged(database, medicine):
    """Reject incoherent or no-op versions with field-level codes and leave history untouched."""
    # An identical copy is unchanged; a lower rolling limit is incoherent.
    from app.errors import ApiError
    from app.rules import supersede_rule
    supersede_rule(database, "MED-001", make_rule("2025-01-01"))
    with pytest.raises(ApiError) as unchanged:
        supersede_rule(database, "MED-001", make_rule("2025-02-01"))
    assert unchanged.value.status == 422
    assert [e["code"] for e in unchanged.value.body["errors"]] == ["rule_unchanged"]
    with pytest.raises(ApiError) as incoherent:
        supersede_rule(database, "MED-001", make_rule("2025-02-01", 61))
    assert [(e["code"], e["field"]) for e in incoherent.value.body["errors"]] == [
        ("rolling_below_single", "max_quantity_per_30_days")]
    with database.connect() as connection:
        rows = connection.execute(text("SELECT effective_to FROM formulary_rule")).all()
    assert len(rows) == 1 and rows[0].effective_to is None


def test_identical_limits_are_allowed_in_a_gap(database, medicine):
    """An earlier version with the same limits replaces nothing, so it is not a no-op."""
    # Inserting before the first rule extends coverage rather than splitting a period.
    from app.rules import supersede_rule
    supersede_rule(database, "MED-001", make_rule("2025-03-01"))
    assert supersede_rule(database, "MED-001", make_rule("2025-01-01"))["id"]


@pytest.mark.parametrize("value", ["0001-01-01", "1999-12-31", "2101-01-01"])
def test_reject_out_of_range_dates(value):
    """Implausible business dates are input errors, not UTC overflow failures."""
    # Validate through the schema used by the HTTP route.
    from pydantic import ValidationError
    from app.schemas import CreateRule
    with pytest.raises(ValidationError):
        CreateRule(effective_from=value, max_quantity_per_dispense=1,
                   max_quantity_per_30_days=1, requires_authorisation=False)
