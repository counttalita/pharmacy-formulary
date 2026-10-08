import os

from alembic import context
from sqlalchemy import create_engine


def run_migrations():
    """Run schema changes inside a PostgreSQL transaction."""
    # Prefer an explicit URL for isolated migration tests.
    url = context.config.get_main_option("sqlalchemy.url") or os.environ["DATABASE_URL"]
    engine = create_engine(url)
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
    # Dispose the migration-only connection pool.
    engine.dispose()


# Apply the requested Alembic revision.
run_migrations()
