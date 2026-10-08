import json

from alembic import command
from alembic.config import Config
from sqlalchemy import text


def test_round_trip_preserves_existing_reasons(database):
    """Prove the data migration and every downgrade against populated history."""
    # Run the first revision, then insert data in the legacy representation.
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", database.url.render_as_string(hide_password=False))
    command.downgrade(config, "001")
    reasons = [
        {"code": "inactive_medicine", "field": "medicine_code", "message": "Inactive."},
        {"code": "quantity_limit", "field": "quantity", "message": "Too much."},
    ]
    try:
        with database.begin() as connection:
            connection.execute(text("""
                INSERT INTO attempt (idempotency_key,payload,status_code,response,reasons)
                VALUES ('legacy','{}',422,'{}',CAST(:reasons AS jsonb))
            """), {"reasons": json.dumps(reasons)})
        # Upgrade populated data and inspect the normalized rows.
        command.upgrade(config, "head")
        with database.connect() as connection:
            rows = connection.execute(text("SELECT code,field,message FROM attempt_reason ORDER BY position")).mappings().all()
            assert [dict(row) for row in rows] == reasons
        # Downgrade again and require exact array reconstruction.
        command.downgrade(config, "001")
        with database.connect() as connection:
            assert connection.execute(text("SELECT reasons FROM attempt")).scalar_one() == reasons
        command.downgrade(config, "base")
        with database.connect() as connection:
            assert connection.execute(text("SELECT to_regclass('medicine')")).scalar_one() is None
    finally:
        # Restore head even if an assertion fails so later tests remain meaningful.
        command.upgrade(config, "head")
