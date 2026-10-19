-- Refuse rollback if any synthetic fixture/configuration/data remains. Never cascade into shared objects.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;
DO $$ DECLARE table_name text; occupied boolean; BEGIN
  FOREACH table_name IN ARRAY ARRAY['agentic_synthetic_capacity','agentic_synthetic_grants',
    'agentic_synthetic_sources','agentic_synthetic_grant_sources','agentic_synthetic_runs',
    'agentic_synthetic_reservations','agentic_synthetic_buckets','agentic_synthetic_invocations',
    'agentic_synthetic_outcomes','agentic_synthetic_audit'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', table_name) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION 'Synthetic schema contains data; rollback refused.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
END $$;
DROP FUNCTION public.agentic_synthetic_admit(jsonb, jsonb);
DROP TABLE public.agentic_synthetic_audit;
DROP TABLE public.agentic_synthetic_outcomes;
DROP TABLE public.agentic_synthetic_invocations;
DROP TABLE public.agentic_synthetic_reservations;
DROP TABLE public.agentic_synthetic_runs;
DROP TABLE public.agentic_synthetic_grant_sources;
DROP TABLE public.agentic_synthetic_sources;
DROP TABLE public.agentic_synthetic_grants;
DROP TABLE public.agentic_synthetic_buckets;
DROP TABLE public.agentic_synthetic_capacity;
DROP FUNCTION public.agentic_synthetic_refuse_mutation();
DROP FUNCTION public.agentic_synthetic_source_guard();
DROP FUNCTION public.agentic_synthetic_invocation_guard();
RESET ROLE;
DROP FUNCTION public.agentic_synthetic_tenant_active(text);
REVOKE EXECUTE ON FUNCTION public.membership_assert_current(text, bigint) FROM telesphoros_jobs;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
