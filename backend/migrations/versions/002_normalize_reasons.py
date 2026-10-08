from alembic import op

revision = "002"
down_revision = "001"


def upgrade():
    """Move existing rejection reasons into ordered, queryable records."""
    # Preserve array order and every reason while transforming existing data.
    op.execute("""
        CREATE TABLE attempt_reason (
            attempt_id bigint NOT NULL REFERENCES attempt(id) ON DELETE CASCADE,
            position integer NOT NULL,
            code text NOT NULL,
            field text NOT NULL,
            message text NOT NULL,
            PRIMARY KEY (attempt_id,position)
        );
        INSERT INTO attempt_reason (attempt_id,position,code,field,message)
        SELECT a.id, r.ordinality::integer, r.value->>'code',r.value->>'field',r.value->>'message'
        FROM attempt a CROSS JOIN LATERAL jsonb_array_elements(a.reasons)
            WITH ORDINALITY AS r(value,ordinality);
        ALTER TABLE attempt DROP COLUMN reasons;
    """)


def downgrade():
    """Reconstruct original JSON arrays without losing reason order."""
    # Aggregate normalized rows back into their original representation.
    op.execute("""
        ALTER TABLE attempt ADD COLUMN reasons jsonb NOT NULL DEFAULT '[]';
        UPDATE attempt a SET reasons = (
            SELECT jsonb_agg(jsonb_build_object('code',r.code,'field',r.field,'message',r.message)
                ORDER BY r.position) FROM attempt_reason r WHERE r.attempt_id=a.id
        ) WHERE EXISTS (SELECT 1 FROM attempt_reason r WHERE r.attempt_id=a.id);
        DROP TABLE attempt_reason;
    """)
