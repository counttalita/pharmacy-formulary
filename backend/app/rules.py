from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from app.database import execute, fetch_all, fetch_one
from app.errors import ApiError

JOHANNESBURG = ZoneInfo("Africa/Johannesburg")


def find_rule(connection, medicine_id, occurred):
    """Select the single rule in force at an event's occurrence time."""
    # Use the same half-open range semantics as the exclusion constraint.
    return fetch_one(connection, """
        SELECT * FROM formulary_rule WHERE medicine_id=:medicine
        AND tstzrange(effective_from,effective_to,'[)') @> CAST(:occurred AS timestamptz)
    """, {"medicine": medicine_id, "occurred": occurred})


def supersede_rule(engine, code, request):
    """Split the containing period and retain separately scheduled future versions."""
    # Interpret date-only boundaries as Johannesburg midnight, then store UTC.
    start = datetime.combine(request.effective_from, time.min, JOHANNESBURG).astimezone(timezone.utc)
    with engine.begin() as connection:
        # Serialize rule edits and block concurrent dispense rule reads during the edit.
        medicine = fetch_one(connection, "SELECT id FROM medicine WHERE code=:code FOR UPDATE", {"code": code})
        if medicine is None:
            raise ApiError(404, "medicine_not_found", "medicine_code", "Medicine does not exist.")
        periods = fetch_all(connection, "SELECT * FROM formulary_rule WHERE medicine_id=:medicine ORDER BY effective_from", {"medicine": medicine["id"]})
        end = None
        for period in periods:
            if period["effective_from"] == start:
                raise ApiError(409, "rule_start_conflict", "effective_from", "A rule already starts on this date.")
            if period["effective_from"] > start:
                end = period["effective_from"]
                break
            if period["effective_to"] is None or start < period["effective_to"]:
                end = period["effective_to"]
                # Close the current period before inserting its replacement.
                execute(connection, "UPDATE formulary_rule SET effective_to=:start WHERE id=:id", {"start": start, "id": period["id"]})
                break
        # Insert only the replacement interval; future versions remain intact.
        return dict(fetch_one(connection, """
            INSERT INTO formulary_rule (medicine_id,effective_from,effective_to,
                max_quantity_per_dispense,max_quantity_per_30_days,requires_authorisation)
            VALUES (:medicine,:start,:end,:single,:rolling,:authorisation) RETURNING *
        """, {"medicine": medicine["id"], "start": start, "end": end,
              "single": request.max_quantity_per_dispense, "rolling": request.max_quantity_per_30_days,
              "authorisation": request.requires_authorisation}))
