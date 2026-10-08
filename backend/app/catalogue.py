import base64
import binascii
import json
from datetime import datetime

from app.database import fetch_all, fetch_one
from app.errors import ApiError


def encode_cursor(scope, values):
    """Encode a small continuation token bound to its original filters."""
    # JSON keeps tokens inspectable without trusting them as SQL fragments.
    return base64.urlsafe_b64encode(json.dumps({"scope": scope, "values": values}).encode()).decode()


def decode_cursor(cursor, scope):
    """Reject malformed or cross-filter continuations before querying PostgreSQL."""
    if cursor is None:
        return None
    try:
        # Validate the envelope; each listing validates its own value types.
        decoded = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if decoded["scope"] != scope or not isinstance(decoded["values"], list):
            raise ValueError()
        return decoded["values"]
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeError):
        raise ApiError(422, "invalid_cursor", "cursor", "Invalid cursor for these filters.") from None


def list_medicines(connection, query, limit, cursor):
    """Search literal name/code substrings and continue by unique medicine code."""
    # Escape SQL pattern characters so a typed percent sign remains literal.
    pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    scope = ["medicines", query]
    values = decode_cursor(cursor, scope)
    if values is not None and (len(values) != 1 or not isinstance(values[0], str) or len(values[0]) > 80):
        raise ApiError(422, "invalid_cursor", "cursor", "Invalid medicine cursor.")
    parameters = {"pattern": pattern, "limit": limit + 1, "after": values[0] if values else ""}
    # Fetch one extra row instead of counting every match.
    rows = fetch_all(connection, """
        SELECT * FROM medicine WHERE (name ILIKE :pattern OR code ILIKE :pattern)
            AND code > :after ORDER BY code LIMIT :limit
    """, parameters)
    items = [dict(row) for row in rows[:limit]]
    return {"items": items, "next_cursor": encode_cursor(scope, [items[-1]["code"]]) if len(rows) > limit else None}


def list_dispenses(connection, patient_ref, medicine, limit, cursor):
    """Continue newest-first history using occurrence time and an ID tie-breaker."""
    scope = ["dispenses", patient_ref, medicine]
    # Bind continuation to the exact opaque reference and medicine filter.
    values = decode_cursor(cursor, scope)
    parameters = {"limit": limit + 1}
    clauses = []
    if patient_ref is not None:
        clauses.append("d.patient_ref=:patient")
        parameters["patient"] = patient_ref
    if medicine is not None:
        clauses.append("m.code=:medicine")
        parameters["medicine"] = medicine
    if values is not None:
        try:
            # Reject invalid timestamps and IDs rather than forwarding database errors.
            if len(values) != 2 or type(values[1]) is not int or not 0 < values[1] <= 9223372036854775807:
                raise ValueError()
            occurred = datetime.fromisoformat(values[0])
            if occurred.tzinfo is None:
                raise ValueError()
        except (ValueError, TypeError, OverflowError):
            raise ApiError(422, "invalid_cursor", "cursor", "Invalid dispense cursor.") from None
        clauses.append("(d.dispensed_at,d.id) < (:occurred,:id)")
        parameters.update(occurred=occurred, id=values[1])
    where = " AND ".join(clauses) or "true"
    # Interpolate only internally defined predicates; all caller values are bound.
    rows = fetch_all(connection, f"""
        SELECT d.id,m.code AS medicine_code,d.patient_ref,d.quantity,d.dispensed_at,
            d.authorisation_ref,d.rule_id
        FROM dispense d JOIN medicine m ON m.id=d.medicine_id
        WHERE {where} ORDER BY d.dispensed_at DESC,d.id DESC LIMIT :limit
    """, parameters)
    items = [dict(row) for row in rows[:limit]]
    return {"items": items, "next_cursor": encode_cursor(scope, [items[-1]["dispensed_at"].isoformat(), items[-1]["id"]]) if len(rows) > limit else None}


def require_medicine(connection, code):
    """Resolve a public medicine code or return a consistent field error."""
    # Resolve codes once before querying current rules or full history.
    medicine = fetch_one(connection, "SELECT * FROM medicine WHERE code=:code", {"code": code})
    if medicine is None:
        raise ApiError(404, "medicine_not_found", "medicine_code", "Medicine does not exist.")
    return dict(medicine)
