-- compat: breaking
-- Retires the legacy `recommendations` table. GET /recommendations was removed in #19 and the repository, record type and DTOs in #39; nothing reads or
-- writes the table any more. Recommendations are read from `evaluations` and `evaluation_results`. An image that still queries the table fails once this
-- is applied, hence `breaking`; the application code that did so is already gone.
-- Two steps, in this order: the report soft-delete guard stops naming the table (it still did, since 0008), then the table is dropped. Its triggers,
-- policy, indexes, constraints and grants go with it. `set_updated_at()` and `forbid_identity_change()` stay: patients and reports use them.
-- A drop cannot be undone, so it refuses to run while the table holds a row (see the guard below).
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- 1. The guard from 0008 without the recommendations check. Only the evaluations check remains.
CREATE OR REPLACE FUNCTION block_report_soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM evaluations WHERE report_id = OLD.id) THEN
    RAISE EXCEPTION 'report has evaluations' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 2. Refuse to drop a table that holds data. The table is FORCE ROW LEVEL SECURITY, which also binds its owner (the policy names only
-- telesphoros_app), so the count below would read 0 whatever the table held. Lift the force first, as 0003 did for its backfill; the table is dropped next.
ALTER TABLE recommendations NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM recommendations)
     AND current_setting('telesphoros.allow_recommendations_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop recommendations: it holds rows. Set telesphoros.allow_recommendations_drop=yes for this session if you really mean to lose them.';
  END IF;
END $$;

DROP TABLE recommendations;
