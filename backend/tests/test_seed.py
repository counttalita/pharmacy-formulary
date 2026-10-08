from sqlalchemy import text


def test_seed_is_repeatable_and_covers_required_volume(database):
    """Seed twice without duplication and verify relational and temporal coverage."""
    # Import after the test database URL has been set.
    from app.seed import seed_database
    seed_database(database)
    seed_database(database)
    with database.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM medicine")).scalar_one() == 500
        assert connection.execute(text("SELECT count(*) FROM formulary_rule")).scalar_one() == 2000
        assert connection.execute(text("SELECT count(*) FROM dispense")).scalar_one() == 2000
        assert connection.execute(text("SELECT count(DISTINCT patient_ref) FROM dispense")).scalar_one() == 2000
        assert connection.execute(text("SELECT extract(day FROM max(dispensed_at)-min(dispensed_at)) FROM dispense")).scalar_one() >= 729
        assert connection.execute(text("""
            SELECT count(*) FROM dispense d JOIN formulary_rule r ON r.id=d.rule_id
            WHERE d.dispensed_at < r.effective_from
                OR (r.effective_to IS NOT NULL AND d.dispensed_at >= r.effective_to)
        """)).scalar_one() == 0
