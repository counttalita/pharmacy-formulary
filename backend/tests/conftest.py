import os

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text


@pytest.fixture(scope="session")
def database():
    """Create an isolated database so tests cannot truncate application data."""
    # Create a test-only database using the same local PostgreSQL server.
    url = os.environ.get("DATABASE_URL", "postgresql+psycopg://pharmacy:pharmacy@localhost:5433/pharmacy")
    source = create_engine(url, isolation_level="AUTOCOMMIT")
    with source.connect() as connection:
        if not connection.execute(text("SELECT 1 FROM pg_database WHERE datname='pharmacy_test'")).scalar():
            connection.execute(text("CREATE DATABASE pharmacy_test"))
    test_url = source.url.set(database="pharmacy_test").render_as_string(hide_password=False)
    os.environ["DATABASE_URL"] = test_url
    # Apply the real migrations before exercising constraints.
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", test_url)
    command.upgrade(config, "head")
    engine = create_engine(test_url)
    yield engine
    # Release the pool after all database tests finish.
    engine.dispose()
    source.dispose()


@pytest.fixture(autouse=True)
def clean_database(database):
    """Give every test empty tables without replacing PostgreSQL behaviour."""
    # Truncate only the dedicated test database.
    with database.begin() as connection:
        connection.execute(text("TRUNCATE medicine, formulary_rule, dispense, attempt RESTART IDENTITY CASCADE"))


@pytest.fixture
def medicine(database):
    """Create one catalogue item for focused business-rule tests."""
    # Insert a synthetic item with no clinical meaning.
    with database.begin() as connection:
        return connection.execute(text("""
            INSERT INTO medicine (code,name,form,strength_value,strength_unit)
            VALUES ('MED-001','Generated medicine','tablet',10,'unit') RETURNING id
        """)).scalar_one()
