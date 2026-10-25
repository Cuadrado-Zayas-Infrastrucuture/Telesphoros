-- Drops the explanation receipts (0048). A drop cannot be undone, so it refuses to run while the table holds a row.
-- Like 0029, it runs as the NOLOGIN owner telesphoros_jobs: that role owns the objects, and its policy (USING true) shows it every row even though the table is FORCE ROW LEVEL
-- SECURITY, so the count below sees what the table holds when the migrating login (no superuser, no BYPASSRLS) runs it. Dropping needs ownership, not CREATE on the schema.
-- Note: DROP TABLE fires no row trigger, so the setting below is the only thing that protects the retention floor against the migrator.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE telesphoros_jobs;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agentic_explain_receipts)
     AND current_setting('telesphoros.allow_receipts_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop agentic_explain_receipts: it holds rows. Set telesphoros.allow_receipts_drop=yes for this session if you really mean to lose them.';
  END IF;
END $$;

DROP FUNCTION public.agentic_explain_receipt_append(jsonb);
DROP FUNCTION public.agentic_explain_receipt_read(text);
DROP FUNCTION public.agentic_explain_receipt_purge(text);
-- The row guard is dropped with the table's triggers; the delete trigger would otherwise refuse nothing here (DROP TABLE does not fire row triggers).
DROP TABLE public.agentic_explain_receipts;
DROP FUNCTION public.agentic_explain_receipt_guard();
DROP FUNCTION public.agentic_explain_identity();

RESET ROLE;
