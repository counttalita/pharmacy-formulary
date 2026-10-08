import os
from functools import lru_cache

from sqlalchemy import create_engine, text


@lru_cache
def get_engine():
    """Share a bounded PostgreSQL connection pool across API requests."""
    # Use READ COMMITTED so reads after a waited lock see the winning commit.
    return create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True,
                         connect_args={"options": "-c timezone=UTC"})


def fetch_one(connection, sql, parameters=None):
    """Return one mapping from a parameterized statement."""
    # Bind values separately from SQL identifiers and operators.
    return connection.execute(text(sql), parameters or {}).mappings().first()


def fetch_all(connection, sql, parameters=None):
    """Return mappings from a parameterized statement."""
    # Keep SQL visible to make query plans and transaction costs easy to inspect.
    return connection.execute(text(sql), parameters or {}).mappings().all()


def execute(connection, sql, parameters=None):
    """Execute a parameterized write or locking statement."""
    # SQLAlchemy owns the connection and transaction lifecycle.
    return connection.execute(text(sql), parameters or {})
