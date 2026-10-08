from alembic import op

revision = "001"
down_revision = None


def upgrade():
    """Create temporal rules, immutable outcomes and indexed dispense history."""
    # Install the PostgreSQL operators used by exclusion and substring indexes.
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("""
        CREATE TABLE medicine (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code varchar(80) NOT NULL UNIQUE CHECK (btrim(code) <> ''),
            name varchar(200) NOT NULL CHECK (btrim(name) <> ''),
            form varchar(80) NOT NULL CHECK (btrim(form) <> ''),
            strength_value numeric(12,3) NOT NULL CHECK (strength_value > 0),
            strength_unit varchar(40) NOT NULL CHECK (btrim(strength_unit) <> ''),
            is_active boolean NOT NULL DEFAULT true
        );
        CREATE TABLE formulary_rule (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            medicine_id bigint NOT NULL REFERENCES medicine(id),
            effective_from timestamptz NOT NULL,
            effective_to timestamptz,
            max_quantity_per_dispense integer NOT NULL CHECK (max_quantity_per_dispense > 0),
            max_quantity_per_30_days integer NOT NULL CHECK (max_quantity_per_30_days > 0),
            requires_authorisation boolean NOT NULL,
            UNIQUE (id, medicine_id),
            CHECK (effective_to IS NULL OR effective_to > effective_from),
            EXCLUDE USING gist (medicine_id WITH =,
                tstzrange(effective_from,effective_to,'[)') WITH &&)
        );
        CREATE TABLE attempt (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            idempotency_key varchar(120) NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
            payload jsonb NOT NULL,
            status_code integer NOT NULL CHECK (status_code IN (201,404,422)),
            response jsonb NOT NULL,
            reasons jsonb NOT NULL DEFAULT '[]',
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE dispense (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            medicine_id bigint NOT NULL REFERENCES medicine(id),
            rule_id bigint NOT NULL,
            patient_ref varchar(120) NOT NULL CHECK (btrim(patient_ref) <> ''),
            quantity integer NOT NULL CHECK (quantity > 0),
            dispensed_at timestamptz NOT NULL,
            authorisation_ref varchar(120),
            idempotency_key varchar(120) NOT NULL UNIQUE REFERENCES attempt(idempotency_key)
                DEFERRABLE INITIALLY DEFERRED,
            created_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (rule_id,medicine_id) REFERENCES formulary_rule(id,medicine_id)
        );
        CREATE INDEX ix_medicine_name_search ON medicine USING gin (name gin_trgm_ops);
        CREATE INDEX ix_medicine_code_search ON medicine USING gin (code gin_trgm_ops);
        CREATE INDEX ix_rule_history ON formulary_rule (medicine_id,effective_from,id);
        CREATE INDEX ix_dispense_window ON dispense (patient_ref,medicine_id,dispensed_at) INCLUDE (quantity);
        CREATE INDEX ix_dispense_patient ON dispense (patient_ref,dispensed_at DESC,id DESC);
        CREATE INDEX ix_dispense_medicine ON dispense (medicine_id,dispensed_at DESC,id DESC);
        CREATE INDEX ix_dispense_recent ON dispense (dispensed_at DESC,id DESC);
    """)


def downgrade():
    """Remove owned tables while retaining potentially shared extensions."""
    # Drop dependent tables before the catalogue.
    op.execute("DROP TABLE dispense, attempt, formulary_rule, medicine")
