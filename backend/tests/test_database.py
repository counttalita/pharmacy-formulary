import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError


def insert_rule(connection, medicine, start, end):
    """Insert a period directly to test database enforcement, bypassing the API."""
    # Exercise the database constraint without application validation.
    return connection.execute(text("""
        INSERT INTO formulary_rule (medicine_id,effective_from,effective_to,
            max_quantity_per_dispense,max_quantity_per_30_days,requires_authorisation)
        VALUES (:medicine,:start,:end,30,60,false) RETURNING id
    """), {"medicine": medicine, "start": start, "end": end}).scalar_one()


def test_reject_overlapping_periods(database, medicine):
    """Reject overlaps even when callers bypass application code."""
    # Commit one period, then attempt a conflicting transaction.
    with database.begin() as connection:
        insert_rule(connection, medicine, "2025-01-01T00:00:00Z", "2025-03-01T00:00:00Z")
    with pytest.raises(IntegrityError):
        with database.begin() as connection:
            insert_rule(connection, medicine, "2025-02-01T00:00:00Z", None)


def test_allow_adjacent_periods(database, medicine):
    """Permit exactly adjacent half-open rule intervals."""
    # Adjacent endpoints must not trigger the exclusion constraint.
    with database.begin() as connection:
        insert_rule(connection, medicine, "2025-01-01T00:00:00Z", "2025-03-01T00:00:00Z")
        insert_rule(connection, medicine, "2025-03-01T00:00:00Z", None)


@pytest.mark.parametrize("start,end", [("2025-03-01T00:00:00Z", "2025-01-01T00:00:00Z"), ("2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z")])
def test_reject_empty_or_reversed_period(database, medicine, start, end):
    """Prevent empty and reversed periods at the database boundary."""
    # Invalid periods must fail independent of API validation.
    with pytest.raises(IntegrityError):
        with database.begin() as connection:
            insert_rule(connection, medicine, start, end)
