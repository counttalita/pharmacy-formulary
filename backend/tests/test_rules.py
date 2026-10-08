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
    supersede_rule(database, "MED-001", make_rule("2025-01-01"))
    supersede_rule(database, "MED-001", make_rule("2025-03-01"))
    supersede_rule(database, "MED-001", make_rule("2025-02-01"))
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
