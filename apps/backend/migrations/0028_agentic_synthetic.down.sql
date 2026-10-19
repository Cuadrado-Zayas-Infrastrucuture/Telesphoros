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
DROP FUNCTION public.agentic_synthetic_ts(timestamptz);
DROP FUNCTION public.agentic_synthetic_refusal(text);
DROP FUNCTION public.agentic_synthetic_sha(text);
DROP FUNCTION public.agentic_synthetic_keys(jsonb,text[],text[]);
DROP FUNCTION public.agentic_synthetic_stamp_ok(jsonb);
DROP FUNCTION public.agentic_synthetic_expected_ok(jsonb);
DROP FUNCTION public.agentic_synthetic_caller_ok(jsonb);
DROP FUNCTION public.agentic_synthetic_member_current(text,text,bigint);
DROP FUNCTION public.agentic_synthetic_authority(text,uuid);
DROP FUNCTION public.agentic_synthetic_claim_guard(jsonb);
DROP FUNCTION public.agentic_synthetic_fresh(jsonb);
DROP FUNCTION public.agentic_synthetic_expected_matches(text,uuid,jsonb);
DROP FUNCTION public.agentic_synthetic_view(text,uuid);
DROP FUNCTION public.agentic_synthetic_candidate_ok(text,uuid,jsonb);
DROP FUNCTION public.agentic_synthetic_verdict_ok(jsonb,jsonb,text);
DROP FUNCTION public.agentic_synthetic_input_digest(text,uuid,text,integer);
DROP FUNCTION public.agentic_synthetic_draft_ok(text,uuid,integer);
DROP FUNCTION public.agentic_synthetic_director_is(text,uuid,integer,text);
DROP FUNCTION public.agentic_synthetic_repair_ok(text,uuid);
DROP FUNCTION public.agentic_synthetic_audit_event(text,uuid,text,text,text);
DROP FUNCTION public.agentic_synthetic_settle(text,uuid);
DROP FUNCTION public.agentic_synthetic_lock_accounts(text,uuid);
DROP FUNCTION public.agentic_synthetic_outcome(text,uuid,text,text,jsonb);
DROP FUNCTION public.agentic_synthetic_commit_terminal(text,uuid,text,text,jsonb,boolean);
DROP FUNCTION public.agentic_synthetic_claim(text,integer);
DROP FUNCTION public.agentic_synthetic_load(jsonb,jsonb);
DROP FUNCTION public.agentic_synthetic_sources(jsonb,jsonb);
DROP FUNCTION public.agentic_synthetic_advance(jsonb,jsonb,text);
DROP FUNCTION public.agentic_synthetic_begin(jsonb,jsonb,jsonb);
DROP FUNCTION public.agentic_synthetic_observe(jsonb,jsonb,jsonb);
DROP FUNCTION public.agentic_synthetic_finish(jsonb,jsonb,jsonb);
DROP FUNCTION public.agentic_synthetic_read(uuid,jsonb);
DROP FUNCTION public.agentic_synthetic_cancel(uuid,jsonb);
DROP FUNCTION public.agentic_synthetic_queue_control(jsonb,text,text);
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
