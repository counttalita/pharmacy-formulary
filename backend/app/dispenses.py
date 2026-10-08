import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from pydantic import ValidationError

from app.database import execute, fetch_one
from app.errors import describe_validation
from app.rules import JOHANNESBURG, find_rule
from app.schemas import CreateDispense


def lock_resource(connection, resource):
    """Hold a named transaction lock until its outcome has committed."""
    # Hash namespaced resources into PostgreSQL's 64-bit advisory key space.
    execute(connection, "SELECT pg_advisory_xact_lock(hashtextextended(:resource,0))", {"resource": resource})


def describe_violation(code, field, message):
    """Build one independently renderable field or business-rule violation."""
    return {"code": code, "field": field, "message": message}


def evaluate_dispense(connection, medicine, rule, request):
    """Collect all independently evaluable failures, including affected later windows."""
    errors = []
    # Compare event time in UTC after request normalization.
    if request.dispensed_at > datetime.now(timezone.utc):
        errors.append(describe_violation("future_dispense", "dispensed_at", "A dispense cannot occur in the future."))
    if not medicine["is_active"]:
        errors.append(describe_violation("inactive_medicine", "medicine_code", "This medicine is inactive."))
    if rule is None:
        errors.append(describe_violation("no_rule", "dispensed_at", "No rule applies at this time."))
        return errors
    if request.quantity > rule["max_quantity_per_dispense"]:
        errors.append(describe_violation("single_quantity_limit", "quantity", f"Single dispense limit is {rule['max_quantity_per_dispense']}."))
    if rule["requires_authorisation"] and not (request.authorisation_ref or "").strip():
        errors.append(describe_violation("authorisation_required", "authorisation_ref", "An authorisation reference is required."))
    # Calculate inclusive event-time bounds in the named business timezone.
    local_time = request.dispensed_at.astimezone(JOHANNESBURG)
    parameters = {"patient": request.patient_ref, "medicine": medicine["id"], "occurred": request.dispensed_at,
                  "start": (local_time - timedelta(days=30)).astimezone(timezone.utc),
                  "end": (local_time + timedelta(days=30)).astimezone(timezone.utc), "quantity": request.quantity}
    total = fetch_one(connection, """
        SELECT coalesce(sum(quantity),0) AS quantity FROM dispense
        WHERE patient_ref=:patient AND medicine_id=:medicine
            AND dispensed_at BETWEEN :start AND :occurred
    """, parameters)["quantity"]
    # Protect already accepted later windows from an inserted backdated event.
    affected = fetch_one(connection, """
        SELECT EXISTS (
            SELECT 1 FROM dispense later JOIN formulary_rule r ON r.id=later.rule_id
            WHERE later.patient_ref=:patient AND later.medicine_id=:medicine
                AND later.dispensed_at BETWEEN :occurred AND :end
                AND :quantity + (
                    SELECT coalesce(sum(history.quantity),0) FROM dispense history
                    WHERE history.patient_ref=:patient AND history.medicine_id=:medicine
                        AND history.dispensed_at BETWEEN
                            (((later.dispensed_at AT TIME ZONE 'Africa/Johannesburg') - interval '30 days')
                                AT TIME ZONE 'Africa/Johannesburg')
                            AND later.dispensed_at
                ) > r.max_quantity_per_30_days
        ) AS exceeded
    """, parameters)["exceeded"]
    if total + request.quantity > rule["max_quantity_per_30_days"] or affected:
        errors.append(describe_violation("rolling_quantity_limit", "quantity",
                      "This quantity exceeds an applicable 30-day allowance, including any affected later dispense."))
    return errors


def record_outcome(connection, key, payload, status, response):
    """Commit the retry outcome and ordered rejection reasons in the same transaction."""
    # Store responses verbatim so rejected retries do not get reevaluated.
    attempt = fetch_one(connection, """
        INSERT INTO attempt (idempotency_key,payload,status_code,response)
        VALUES (:key,CAST(:payload AS jsonb),:status,CAST(:response AS jsonb)) RETURNING id
    """, {"key": key, "payload": json.dumps(payload), "status": status, "response": json.dumps(response)})
    for position, reason in enumerate(response.get("errors", []), 1):
        # Keep each reason independently queryable while preserving response order.
        execute(connection, """
            INSERT INTO attempt_reason (attempt_id,position,code,field,message)
            VALUES (:attempt,:position,:code,:field,:message)
        """, {"attempt": attempt["id"], "position": position, **reason})
    return status, response


def capture_dispense(engine, payload):
    """Validate, serialize, evaluate and persist one idempotent dispense outcome."""
    # Validate before opening the transaction, retaining invalid payloads for auditing.
    try:
        request = CreateDispense.model_validate(payload)
        canonical = request.model_dump(mode="json", exclude={"idempotency_key"})
        errors = []
    except ValidationError as error:
        request = None
        canonical = {key: value for key, value in payload.items() if key != "idempotency_key"} if isinstance(payload, dict) else payload
        errors = describe_validation(error)
    supplied_key = payload.get("idempotency_key") if isinstance(payload, dict) else None
    key = supplied_key if isinstance(supplied_key, str) and supplied_key.strip() and len(supplied_key) <= 120 else f"invalid-{uuid4()}"
    with engine.begin() as connection:
        # Global key locking precedes resource locking to keep retries atomic.
        lock_resource(connection, f"idempotency:{key}")
        previous = fetch_one(connection, "SELECT payload,status_code,response FROM attempt WHERE idempotency_key=:key", {"key": key})
        if previous:
            if previous["payload"] != canonical:
                return 409, {"errors": [describe_violation("idempotency_conflict", "idempotency_key", "This key already belongs to a different payload.")]}
            return previous["status_code"], previous["response"]
        if errors:
            return record_outcome(connection, key, canonical, 422, {"errors": errors})
        # Coordinate with rule superseding and medicine activation changes.
        medicine = fetch_one(connection, "SELECT * FROM medicine WHERE code=:code FOR SHARE", {"code": request.medicine_code})
        if medicine is None:
            return record_outcome(connection, key, canonical, 404, {"errors": [describe_violation("medicine_not_found", "medicine_code", "Medicine does not exist.")]})
        # Serialize the rolling sum and insert for precisely this patient/medicine pair.
        lock_resource(connection, f"dispense:{json.dumps([request.patient_ref, medicine['id']])}")
        rule = find_rule(connection, medicine["id"], request.dispensed_at)
        errors = evaluate_dispense(connection, medicine, rule, request)
        if errors:
            return record_outcome(connection, key, canonical, 422, {"errors": errors})
        # The deferred foreign key allows the immutable outcome to be saved after its ID is known.
        dispense = fetch_one(connection, """
            INSERT INTO dispense (medicine_id,rule_id,patient_ref,quantity,dispensed_at,authorisation_ref,idempotency_key)
            VALUES (:medicine,:rule,:patient,:quantity,:occurred,:authorisation,:key) RETURNING id
        """, {"medicine": medicine["id"], "rule": rule["id"], "patient": request.patient_ref,
              "quantity": request.quantity, "occurred": request.dispensed_at,
              "authorisation": request.authorisation_ref, "key": key})
        return record_outcome(connection, key, canonical, 201, {"id": dispense["id"], "rule_id": rule["id"], **canonical})
