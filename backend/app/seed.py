import json
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.database import execute, fetch_one, get_engine

JOHANNESBURG = ZoneInfo("Africa/Johannesburg")


def seed_database(engine):
    """Load deterministic synthetic records atomically without duplicating reruns."""
    # Anchor the generated two-year window to local business dates.
    today = datetime.now(JOHANNESBURG).date()
    start = datetime.combine(today - timedelta(days=730), time(12), JOHANNESBURG)
    with engine.begin() as connection:
        # Serialize seed commands and leave existing demo data unchanged.
        execute(connection, "SELECT pg_advisory_xact_lock(17001)")
        existing = fetch_one(connection, "SELECT count(*) AS total FROM medicine WHERE code LIKE 'SEED-%'")
        if existing["total"]:
            if existing["total"] != 500:
                raise ValueError("The SEED- namespace is already in use; seed into a clean database.")
            return
        medicine_ids = []
        rule_ids = []
        for index in range(500):
            # Insert generated catalogue data and four adjacent versions.
            medicine = fetch_one(connection, """
                INSERT INTO medicine (code,name,form,strength_value,strength_unit)
                VALUES (:code,:name,'tablet',:strength,'unit') RETURNING id
            """, {"code": f"SEED-{index:04}", "name": f"Generated medicine {index:04}", "strength": index % 50 + 1})
            medicine_ids.append(medicine["id"])
            versions = []
            for period in range(4):
                boundary = start.replace(hour=0) + timedelta(days=183 * period)
                end = boundary + timedelta(days=183) if period < 3 else None
                rule = fetch_one(connection, """
                    INSERT INTO formulary_rule (medicine_id,effective_from,effective_to,
                        max_quantity_per_dispense,max_quantity_per_30_days,requires_authorisation)
                    VALUES (:medicine,:start,:end,:maximum,120,false) RETURNING id
                """, {"medicine": medicine["id"], "start": boundary, "end": end, "maximum": 30 + period * 10})
                versions.append(rule["id"])
            rule_ids.append(versions)
        for index in range(2000):
            # Preserve exactly the payload and outcome that an API retry would use.
            day = index % 730
            item = index % 500
            occurred = (start + timedelta(days=day)).astimezone(timezone.utc)
            key = f"seed-dispense-{index:04}"
            payload = {"medicine_code": f"SEED-{item:04}", "patient_ref": f"patient-{index:04}",
                       "quantity": index % 5 + 1, "dispensed_at": occurred.isoformat(), "authorisation_ref": None}
            row = fetch_one(connection, """
                INSERT INTO dispense (medicine_id,rule_id,patient_ref,quantity,dispensed_at,idempotency_key)
                VALUES (:medicine,:rule,:patient,:quantity,:occurred,:key) RETURNING id
            """, {"medicine": medicine_ids[item], "rule": rule_ids[item][min(day // 183, 3)],
                  "patient": payload["patient_ref"], "quantity": payload["quantity"], "occurred": occurred, "key": key})
            response = {**payload, "id": row["id"], "rule_id": rule_ids[item][min(day // 183, 3)]}
            execute(connection, """
                INSERT INTO attempt (idempotency_key,payload,status_code,response)
                VALUES (:key,CAST(:payload AS jsonb),201,CAST(:response AS jsonb))
            """, {"key": key, "payload": json.dumps(payload), "response": json.dumps(response)})
        # Refresh statistics so the performance measurement uses representative plans.
        execute(connection, "ANALYZE medicine, formulary_rule, dispense, attempt")


if __name__ == "__main__":
    # Run against the configured application database.
    seed_database(get_engine())
    print("Seed ready: 500 medicines, 2,000 rules, 2,000 dispenses and patient references.")
