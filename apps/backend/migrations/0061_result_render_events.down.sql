-- Spec 019 D02b down. Render events are append-only evidence under governed retention (plan P3): dropping a populated table would destroy them. So there
-- is no override: a populated database is refused here with a clear message, and repaired forward with a new migration. An empty one reverts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- result_render_events has FORCE ROW LEVEL SECURITY and its one policy is for another role, so the migrator (its owner, but not a superuser and without
-- BYPASSRLS) sees no rows, and the check below would always read "empty". The owner may lift FORCE inside this transaction; it is put back straight
-- after the check (and a refusal rolls it back with everything else).
ALTER TABLE result_render_events NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM result_render_events) THEN
    RAISE EXCEPTION 'Refusing to drop populated result render events: they are retained evidence. Repair forward with a new migration.';
  END IF;
END $$;
ALTER TABLE result_render_events FORCE ROW LEVEL SECURITY;

DROP TABLE result_render_events;
DROP FUNCTION result_render_events_check();
