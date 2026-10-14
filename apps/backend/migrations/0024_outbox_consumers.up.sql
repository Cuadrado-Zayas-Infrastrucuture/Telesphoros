-- M2.3b: the transactional outbox and the first two background consumers (the scheduled upload sweep and the stored-file re-check).
-- See docs/design/plans/m2-3-jobs-outbox-worker.md.
--
--   * `outbox_events`: written by the API INSIDE the transaction that makes a change (outbox_append: the organization comes from the transaction), so a rolled-back
--     change leaves no event and a committed one cannot lose it. `outbox_relay` (the worker) turns unrelayed events into jobs in ONE transaction that also marks them
--     relayed, by a route table reviewed like any migration. A crash cannot lose or duplicate: the job's idempotency key is the event.
--   * `file_verifications`: append-only record of each re-check of a stored report file against the facts its report is pinned to.
--   * The consumers reach data only through SECURITY DEFINER functions that first prove the caller holds a RUNNING job of the right type, and then act for that job's
--     organization and nothing else: the worker login is granted no table.
--   * `uploads_sweep` is the one implementation of the sweep (the operator command calls it too).
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- What the queue's definer role needs from tables it does not own. Each grant and policy is made by the table's own owner.
DO $$
DECLARE
  t text;
  owner_role name;
BEGIN
  FOREACH t IN ARRAY ARRAY['reports', 'report_captures', 'report_upload_attempts', 'report_upload_runs'] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = ('public.' || t)::regclass;
    EXECUTE format('SET LOCAL ROLE %I', owner_role);
    IF t = 'reports' THEN
      EXECUTE 'GRANT SELECT, REFERENCES ON public.reports TO telesphoros_jobs';
      EXECUTE $p$CREATE POLICY reports_jobs ON public.reports FOR SELECT TO telesphoros_jobs USING (tenant_id = current_setting('app.current_tenant_id', true))$p$;
    ELSIF t = 'report_captures' THEN
      EXECUTE 'GRANT SELECT ON public.report_captures TO telesphoros_jobs';
      EXECUTE $p$CREATE POLICY report_captures_jobs ON public.report_captures FOR SELECT TO telesphoros_jobs USING (tenant_id = current_setting('app.current_tenant_id', true))$p$;
    ELSE
      -- Their existing policies apply to every role and are tenant-scoped.
      EXECUTE format('GRANT SELECT, UPDATE ON public.%I TO telesphoros_jobs', t);
    END IF;
    RESET ROLE;
  END LOOP;
END
$$;
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)

SET LOCAL ROLE telesphoros_jobs;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE outbox_routes (
  event_type   text PRIMARY KEY,
  job_type     text    NOT NULL,
  subject_key  text    NOT NULL,
  max_attempts integer NOT NULL DEFAULT 5,
  CONSTRAINT outbox_routes_job_type_shape CHECK (job_type ~ '^[a-z][a-z0-9.-]{1,63}$'),
  CONSTRAINT outbox_routes_subject_key_shape CHECK (subject_key ~ '^[a-z][A-Za-z0-9]{0,31}$'),
  CONSTRAINT outbox_routes_attempts_range CHECK (max_attempts BETWEEN 1 AND 20)
);
INSERT INTO outbox_routes (event_type, job_type, subject_key, max_attempts) VALUES ('report.file-committed', 'files.verify-stored', 'reportId', 5);

CREATE TABLE outbox_events (
  seq           bigint      GENERATED ALWAYS AS IDENTITY NOT NULL,
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text        NOT NULL,
  event_type    text        NOT NULL,
  subject_id    uuid        NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  relayed_at    timestamptz,
  relay_outcome text,
  CONSTRAINT outbox_events_seq_uq UNIQUE (seq),
  CONSTRAINT outbox_events_subject_uq UNIQUE (tenant_id, event_type, subject_id),
  CONSTRAINT outbox_events_type_check CHECK (event_type IN ('report.file-committed')),
  CONSTRAINT outbox_events_tenant_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT outbox_events_relay_check CHECK ((relayed_at IS NULL) = (relay_outcome IS NULL) AND (relay_outcome IS NULL OR relay_outcome IN ('relayed', 'no-route', 'no-organization')))
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (seq) WHERE relayed_at IS NULL;
-- An event is written once and decided once: only the relay's mark changes, and nothing is deleted.
CREATE FUNCTION outbox_events_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'The outbox is append-only.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.relayed_at IS NOT NULL THEN RAISE EXCEPTION 'A relayed event does not change.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'An outbox event changes only by being relayed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbox_events_no_delete BEFORE UPDATE OR DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION outbox_events_guard();
CREATE TRIGGER outbox_events_no_truncate BEFORE TRUNCATE ON outbox_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_definer ON outbox_events FOR ALL TO telesphoros_jobs USING (true) WITH CHECK (true);

-- The API's way in: inside the business transaction. The organization comes from the transaction, never from an argument.
CREATE FUNCTION outbox_append(p_type text, p_subject uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'An outbox event needs an organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.outbox_events (tenant_id, event_type, subject_id) VALUES (v_tenant, p_type, p_subject) ON CONFLICT (tenant_id, event_type, subject_id) DO NOTHING;
END
$$;

-- The relay: events become jobs, and are marked, in ONE transaction. Concurrent relays take different events (SKIP LOCKED). An event for an organization that is not
-- registered (a disposable local run) or with no route is marked as such and creates nothing. A suspended organization still gets its job: the claim holds it.
CREATE FUNCTION outbox_relay(p_batch integer DEFAULT 50) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  e record;
  v_route record;
  v_count integer := 0;
BEGIN
  IF p_batch < 1 OR p_batch > 500 THEN RAISE EXCEPTION 'Batch out of range.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  FOR e IN SELECT o.id, o.tenant_id, o.event_type, o.subject_id FROM public.outbox_events o WHERE o.relayed_at IS NULL ORDER BY o.seq LIMIT p_batch FOR UPDATE SKIP LOCKED LOOP
    SELECT r.job_type, r.subject_key, r.max_attempts INTO v_route FROM public.outbox_routes r WHERE r.event_type = e.event_type;
    IF NOT FOUND THEN
      UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'no-route' WHERE id = e.id;
    ELSIF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = e.tenant_id) THEN
      UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'no-organization' WHERE id = e.id;
    ELSE
      INSERT INTO public.jobs (tenant_id, type, payload, idempotency_key, max_attempts, requested_by)
      VALUES (e.tenant_id, v_route.job_type, jsonb_build_object(v_route.subject_key, e.subject_id::text), 'outbox-' || e.id::text, v_route.max_attempts, 'system:outbox')
      ON CONFLICT (tenant_id, type, idempotency_key) DO NOTHING;
      UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'relayed' WHERE id = e.id;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The record of stored-file re-checks
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE file_verifications (
  seq            bigint      GENERATED ALWAYS AS IDENTITY NOT NULL,
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text        NOT NULL,
  report_id      uuid        NOT NULL,
  job_id         uuid        NOT NULL REFERENCES jobs (id) ON DELETE RESTRICT,
  source         text        NOT NULL,
  outcome        text        NOT NULL,
  reason         text,
  object_version text        NOT NULL,
  verified_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_verifications_seq_uq UNIQUE (seq),
  CONSTRAINT file_verifications_report_fk FOREIGN KEY (report_id, tenant_id) REFERENCES public.reports (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT file_verifications_source_check CHECK (source IN ('upload', 'scheduled')),
  CONSTRAINT file_verifications_outcome_check CHECK (outcome IN ('ok', 'missing', 'changed', 'unreadable')),
  CONSTRAINT file_verifications_reason_check CHECK ((outcome = 'ok') = (reason IS NULL) AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9-]{1,47}$')),
  CONSTRAINT file_verifications_version_len CHECK (length(object_version) BETWEEN 1 AND 1024)
);
CREATE INDEX file_verifications_report_idx ON file_verifications (tenant_id, report_id, seq DESC);
CREATE TRIGGER file_verifications_append_only BEFORE UPDATE OR DELETE ON file_verifications FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER file_verifications_no_truncate BEFORE TRUNCATE ON file_verifications FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE file_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY file_verifications_tenant ON file_verifications FOR SELECT TO telesphoros_app USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY file_verifications_definer ON file_verifications FOR ALL TO telesphoros_jobs USING (true) WITH CHECK (true);

-- Proves the caller holds a RUNNING job of one of the given types and returns what the consumer may act on (the job's organization and payload), and binds the
-- organization for the transaction so row-level security applies to every statement that follows.
CREATE FUNCTION job_held(p_job uuid, p_worker text, p_types text[]) RETURNS TABLE (tenant_id text, job_type text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  RETURN QUERY SELECT j.tenant_id, j.type, j.payload FROM public.jobs j WHERE j.id = p_job AND j.state = 'running' AND j.locked_by = p_worker AND j.type = ANY (p_types);
  IF NOT FOUND THEN RAISE EXCEPTION 'The caller does not hold that job.' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM set_config('app.current_tenant_id', (SELECT j.tenant_id FROM public.jobs j WHERE j.id = p_job), true);
END
$$;

CREATE FUNCTION file_verification_target(p_job uuid, p_worker text)
RETURNS TABLE (report_id uuid, storage_key text, object_version text, sha256 text, size_bytes bigint, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
#variable_conflict use_column
DECLARE h record;
BEGIN
  SELECT * INTO h FROM public.job_held(p_job, p_worker, ARRAY['files.verify-stored']);
  RETURN QUERY SELECT r.id, r.storage_key, r.object_version, r.sha256, r.size_bytes, r.content_type FROM public.reports r
    WHERE r.tenant_id = h.tenant_id AND r.id = (h.payload ->> 'reportId')::uuid AND r.uploaded_at IS NOT NULL AND r.deleted_at IS NULL AND r.object_version IS NOT NULL;
END
$$;

-- Up to p_limit uploaded reports of the job's organization whose newest check is older than p_max_age_seconds (or that were never checked), the unchecked first.
CREATE FUNCTION file_verification_stale(p_job uuid, p_worker text, p_limit integer, p_max_age_seconds integer)
RETURNS TABLE (report_id uuid, storage_key text, object_version text, sha256 text, size_bytes bigint, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
#variable_conflict use_column
DECLARE h record;
BEGIN
  IF p_limit < 1 OR p_limit > 200 OR p_max_age_seconds < 60 THEN RAISE EXCEPTION 'Limits out of range.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO h FROM public.job_held(p_job, p_worker, ARRAY['files.verify-stale']);
  RETURN QUERY
    SELECT r.id, r.storage_key, r.object_version, r.sha256, r.size_bytes, r.content_type
      FROM public.reports r
      LEFT JOIN LATERAL (SELECT max(v.verified_at) AS last_at FROM public.file_verifications v WHERE v.tenant_id = r.tenant_id AND v.report_id = r.id) lv ON true
     WHERE r.tenant_id = h.tenant_id AND r.uploaded_at IS NOT NULL AND r.deleted_at IS NULL AND r.object_version IS NOT NULL
       AND (lv.last_at IS NULL OR lv.last_at < now() - make_interval(secs => p_max_age_seconds))
     ORDER BY lv.last_at NULLS FIRST, r.seq
     LIMIT p_limit;
END
$$;

CREATE FUNCTION file_verification_record(p_job uuid, p_worker text, p_report uuid, p_outcome text, p_reason text, p_version text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  h record;
  v_id uuid;
BEGIN
  SELECT * INTO h FROM public.job_held(p_job, p_worker, ARRAY['files.verify-stored', 'files.verify-stale']);
  IF h.job_type = 'files.verify-stored' AND p_report IS DISTINCT FROM (h.payload ->> 'reportId')::uuid THEN
    RAISE EXCEPTION 'That job verifies one report.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.file_verifications (tenant_id, report_id, job_id, source, outcome, reason, object_version)
  VALUES (h.tenant_id, p_report, p_job, CASE h.job_type WHEN 'files.verify-stored' THEN 'upload' ELSE 'scheduled' END, p_outcome, p_reason, p_version)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The upload sweep: ONE implementation, used by the scheduled job and by the operator command (`uploads sweep`).
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION uploads_organization_run_id(p_tenant text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS
$$
DECLARE b bytea := substring(sha256(convert_to('telesphoros-intake-scope:' || p_tenant, 'UTF8')) from 1 for 16);
BEGIN
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 80);
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);
  RETURN encode(b, 'hex')::uuid;
END
$$;

CREATE FUNCTION uploads_sweep(p_tenant text, p_grace_seconds integer, p_dry boolean) RETURNS TABLE (released integer, released_bytes bigint, objects_kept integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_run uuid := public.uploads_organization_run_id(p_tenant);
  v_ids uuid[];
  v_released integer;
  v_bytes bigint;
  v_kept integer;
BEGIN
  IF p_grace_seconds < 0 OR p_grace_seconds > 604800 THEN RAISE EXCEPTION 'graceSeconds must be between 0 and 604800.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  PERFORM set_config('app.current_tenant_id', p_tenant, true);
  WITH abandoned AS (
    SELECT a.id, a.size_bytes, a.state, a.object_version
      FROM public.report_upload_attempts a
     WHERE a.tenant_id = p_tenant AND a.run_id = v_run AND a.state NOT IN ('committed', 'cleaned')
       AND (a.state IN ('cancelled', 'cleanup') OR a.lease_until + p_grace_seconds * interval '1 second' <= now())
       AND (a.writer IS NULL OR a.lease_until + p_grace_seconds * interval '1 second' <= now())
       AND NOT EXISTS (SELECT 1 FROM public.reports r WHERE r.tenant_id = a.tenant_id AND r.storage_key = a.storage_key AND r.uploaded_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.report_captures c WHERE c.tenant_id = a.tenant_id AND c.text_storage_key = a.storage_key)
     ORDER BY a.created_at
       FOR UPDATE
  )
  SELECT array_agg(ab.id), count(*)::integer, coalesce(sum(ab.size_bytes), 0)::bigint,
         (count(*) FILTER (WHERE ab.object_version IS NOT NULL OR ab.state IN ('stored', 'unresolved')))::integer
    INTO v_ids, v_released, v_bytes, v_kept FROM abandoned ab;
  IF NOT p_dry AND v_released > 0 THEN
    UPDATE public.report_upload_attempts SET state = 'cleaned', writer = NULL, updated_at = now() WHERE tenant_id = p_tenant AND id = ANY (v_ids);
    UPDATE public.report_upload_runs SET reserved_bytes = GREATEST(reserved_bytes - v_bytes, 0), updated_at = now() WHERE tenant_id = p_tenant AND run_id = v_run;
  END IF;
  RETURN QUERY SELECT v_released, v_bytes, v_kept;
END
$$;

-- The scheduled job's door: it sweeps the organization of the job it holds, with the default grace (one day), and nothing else.
CREATE FUNCTION job_uploads_sweep(p_job uuid, p_worker text) RETURNS TABLE (released integer, released_bytes bigint, objects_kept integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE h record;
BEGIN
  SELECT * INTO h FROM public.job_held(p_job, p_worker, ARRAY['uploads.sweep']);
  RETURN QUERY SELECT * FROM public.uploads_sweep(h.tenant_id, 86400, false);
END
$$;

-- The recurring jobs (one per active organization per slot; see job_schedule_tick).
INSERT INTO job_schedules (type, interval_seconds, max_attempts) VALUES ('uploads.sweep', 3600, 5), ('files.verify-stale', 86400, 3);

-- (outbox_routes and outbox_events keep PostgreSQL's default owner-only ACL on purpose: writing an ACL that equals the default is invisible to pg_dump, so a restored
-- database would carry a different representation of the same privileges. No other role needs them: the functions above are the only way in.)
REVOKE ALL ON file_verifications FROM PUBLIC;
REVOKE ALL ON FUNCTION outbox_append(text, uuid), outbox_relay(integer), job_held(uuid, text, text[]), file_verification_target(uuid, text), file_verification_stale(uuid, text, integer, integer),
  file_verification_record(uuid, text, uuid, text, text, text), uploads_organization_run_id(text), uploads_sweep(text, integer, boolean), job_uploads_sweep(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_append(text, uuid) TO telesphoros_app;
GRANT SELECT ON file_verifications TO telesphoros_app;
GRANT EXECUTE ON FUNCTION outbox_relay(integer), file_verification_target(uuid, text), file_verification_stale(uuid, text, integer, integer),
  file_verification_record(uuid, text, uuid, text, text, text), job_uploads_sweep(uuid, text) TO telesphoros_worker;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
