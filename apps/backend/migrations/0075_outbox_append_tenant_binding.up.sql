-- compat: breaking
-- Security audit 2026-11-13: outbox_append(text, uuid, text), the form 0042 added and the upload commit calls, took the organization from the raw
-- app.current_tenant_id setting. 0032 had moved the two-argument form to app_tenant(); the three-argument form was written after it with the old read.
-- So it skipped both checks app_tenant() makes: a setting that names another organization than the request's capability was not refused (the event
-- was appended for that organization), and a suspended organization could still append (0047 says every outbox writer stops for one).
--
-- This repoints it at app_tenant(), as the two-argument form. Nothing else changes: same signature, owner, body and grants (CREATE OR REPLACE keeps the
-- access list). The API sets the setting and the capability to the same organization, so a request from an active organization appends as before.
-- Reachable only by a caller that can run SQL as the application login; the cross-organization reach is a queue row (the consumer joins the report in
-- that organization), not clinical data. tenant-rls-catalog.pg-spec.ts now refuses any function an application role can run that reads the setting
-- itself, other than the binding primitives.
--
-- CREATE OR REPLACE of a function body is `breaking` under the migration lint: an older image's call from a suspended organization is now refused.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;

CREATE OR REPLACE FUNCTION outbox_append(p_type text, p_subject uuid, p_request text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE v_tenant text := public.app_tenant();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'An outbox event needs an organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.outbox_events (tenant_id, event_type, subject_id, request_id)
  VALUES (v_tenant, p_type, p_subject, CASE WHEN p_request ~ '^[A-Za-z0-9-]{1,64}$' THEN p_request END)
  ON CONFLICT (tenant_id, event_type, subject_id) DO NOTHING;
END
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
