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


LIMIT_FIELDS = ("max_quantity_per_dispense", "max_quantity_per_30_days", "requires_authorisation")


def validate_version(request, replaced):
    """Collect business violations for a new version against the period it would split."""
    errors = []
    # A rolling allowance below the single limit makes the single limit unreachable.
    if request.max_quantity_per_30_days < request.max_quantity_per_dispense:
        errors.append({"code": "rolling_below_single", "field": "max_quantity_per_30_days",
                       "message": "The 30-day limit must be at least the per-dispense limit."})
    # Splitting a period into two identical halves adds history without changing behaviour.
    if replaced is not None and all(replaced[field] == getattr(request, field) for field in LIMIT_FIELDS):
        errors.append({"code": "rule_unchanged", "field": "body",
                       "message": "The new version must change at least one limit."})
    return errors


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
        replaced = None
        for period in periods:
            if period["effective_from"] == start:
                raise ApiError(409, "rule_start_conflict", "effective_from", "A rule already starts on this date.")
            if period["effective_from"] > start:
                end = period["effective_from"]
                break
            if period["effective_to"] is None or start < period["effective_to"]:
                end = period["effective_to"]
                replaced = period
                break
        # Validate against the locked state before mutating any row.
        errors = validate_version(request, replaced)
        if errors:
            raise ApiError.many(422, errors)
        if replaced is not None:
            # Close the current period before inserting its replacement.
            execute(connection, "UPDATE formulary_rule SET effective_to=:start WHERE id=:id", {"start": start, "id": replaced["id"]})
        # Insert only the replacement interval; future versions remain intact.
        return dict(fetch_one(connection, """
            INSERT INTO formulary_rule (medicine_id,effective_from,effective_to,
                max_quantity_per_dispense,max_quantity_per_30_days,requires_authorisation)
            VALUES (:medicine,:start,:end,:single,:rolling,:authorisation) RETURNING *
        """, {"medicine": medicine["id"], "start": start, "end": end,
              "single": request.max_quantity_per_dispense, "rolling": request.max_quantity_per_30_days,
              "authorisation": request.requires_authorisation}))
