-- Restores the 0042 body of outbox_append(text, uuid, text) verbatim: the organization from the raw setting. Same signature, owner and grants.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;

CREATE OR REPLACE FUNCTION outbox_append(p_type text, p_subject uuid, p_request text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'An outbox event needs an organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.outbox_events (tenant_id, event_type, subject_id, request_id)
  VALUES (v_tenant, p_type, p_subject, CASE WHEN p_request ~ '^[A-Za-z0-9-]{1,64}$' THEN p_request END)
  ON CONFLICT (tenant_id, event_type, subject_id) DO NOTHING;
END
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
