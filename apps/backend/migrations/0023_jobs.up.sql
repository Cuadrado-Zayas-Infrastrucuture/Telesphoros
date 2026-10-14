-- M2.3a: a PostgreSQL job queue for a separate worker process, and the rule that a system actor is never a person.
-- See docs/design/plans/m2-3-jobs-outbox-worker.md.
--
--   * `jobs`, `job_attempts`, `job_schedules`, `job_workers`: owned by the NOLOGIN role telesphoros_jobs, which is also the owner of the functions below. Forced row-level
--     security: the application and worker logins see only their own organization's jobs (a tenant policy); only telesphoros_jobs (the definer of the functions) sees all.
--   * The queue is used ONLY through SECURITY DEFINER functions. The API enqueues (job_enqueue: the organization and the person come from the transaction, never from
--     the arguments). The worker claims, heartbeats, succeeds, fails and releases. Neither login can insert, update or delete a job row directly.
--   * A job carries ids and short codes only (the database refuses anything else), never a file name, a label, free text or a patient value; an error is a short code.
--   * job_attempts is append-only (refuse_mutation); jobs are never deleted by the system.
--   * A system actor (`system:<job type>`) is never a person: the tables that record a human decision or assertion refuse such an actor, and so does a membership.
--     Independence rules compare identities, so without this a background job would trivially be "someone else".
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_jobs') THEN
    CREATE ROLE telesphoros_jobs NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_worker') THEN
    CREATE ROLE telesphoros_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- The migrator acts as the owner role to create its objects (a one-time membership). A superuser already can.
  IF NOT pg_has_role(current_user, 'telesphoros_jobs', 'SET') THEN
    EXECUTE format('GRANT telesphoros_jobs TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO telesphoros_jobs, telesphoros_worker;
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
-- The definer reads the organization registry to skip suspended organizations.
GRANT SELECT ON tenants TO telesphoros_jobs;
GRANT REFERENCES ON tenants TO telesphoros_jobs;
-- tenants is under row-level security (the application sees only its own row): the definer reads every row, to know which organizations are active, and nothing else.
CREATE POLICY tenants_jobs ON tenants FOR SELECT TO telesphoros_jobs USING (true);

SET LOCAL ROLE telesphoros_jobs;

CREATE TABLE jobs (
  seq             bigint      GENERATED ALWAYS AS IDENTITY NOT NULL,
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  type            text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text        NOT NULL,
  state           text        NOT NULL DEFAULT 'queued',
  run_after       timestamptz NOT NULL DEFAULT now(),
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 5,
  lease_until     timestamptz,
  locked_by       text,
  started_at      timestamptz,
  requested_by    text        NOT NULL,
  last_error_code text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CONSTRAINT jobs_seq_uq UNIQUE (seq),
  CONSTRAINT jobs_idempotency_uq UNIQUE (tenant_id, type, idempotency_key),
  CONSTRAINT jobs_type_shape CHECK (type ~ '^[a-z][a-z0-9.-]{1,63}$'),
  CONSTRAINT jobs_key_shape CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,96}$'),
  CONSTRAINT jobs_state_check CHECK (state IN ('queued', 'running', 'retry', 'succeeded', 'dead', 'cancelled')),
  CONSTRAINT jobs_attempts_range CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20 AND attempts <= max_attempts),
  CONSTRAINT jobs_requested_by_len CHECK (length(requested_by) BETWEEN 1 AND 128),
  CONSTRAINT jobs_locked_by_len CHECK (locked_by IS NULL OR length(locked_by) BETWEEN 1 AND 128),
  CONSTRAINT jobs_error_code_shape CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9-]{1,47}$'),
  -- A running job has an owner and a lease; nothing else does.
  CONSTRAINT jobs_running_shape CHECK ((state = 'running') = (lease_until IS NOT NULL AND locked_by IS NOT NULL)),
  CONSTRAINT jobs_finished_shape CHECK ((state IN ('succeeded', 'dead', 'cancelled')) = (finished_at IS NOT NULL)),
  -- A payload is small and flat (strict path mode: lax mode would look inside an array and let it through): keys are short lower-camel names, values are integers, booleans or short strings of letters, digits and hyphens.
  CONSTRAINT jobs_payload_shape CHECK (
    jsonb_typeof(payload) = 'object'
    AND pg_column_size(payload) <= 1024
    AND NOT jsonb_path_exists(payload, 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9]{0,31}$"))')
    AND NOT jsonb_path_exists(payload, 'strict $.* ? (@.type() == "object" || @.type() == "array" || @.type() == "null")')
    AND NOT jsonb_path_exists(payload, 'strict $.* ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9-]{1,64}$"))')
  )
);
CREATE INDEX jobs_ready_idx ON jobs (run_after, seq) WHERE state IN ('queued', 'retry');
CREATE INDEX jobs_running_idx ON jobs (lease_until) WHERE state = 'running';
CREATE INDEX jobs_tenant_running_idx ON jobs (tenant_id) WHERE state = 'running';

CREATE TABLE job_attempts (
  seq         bigint      GENERATED ALWAYS AS IDENTITY NOT NULL,
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid        NOT NULL REFERENCES jobs (id) ON DELETE RESTRICT,
  tenant_id   text        NOT NULL,
  attempt     integer     NOT NULL,
  worker_id   text        NOT NULL,
  started_at  timestamptz,
  finished_at timestamptz NOT NULL DEFAULT now(),
  outcome     text        NOT NULL,
  error_code  text,
  CONSTRAINT job_attempts_seq_uq UNIQUE (seq),
  CONSTRAINT job_attempts_outcome_check CHECK (outcome IN ('succeeded', 'failed', 'lease-expired', 'released', 'operator-requeued', 'operator-cancelled')),
  CONSTRAINT job_attempts_worker_len CHECK (length(worker_id) BETWEEN 1 AND 128),
  CONSTRAINT job_attempts_attempt_range CHECK (attempt >= 0),
  CONSTRAINT job_attempts_error_code_shape CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9-]{1,47}$')
);
CREATE INDEX job_attempts_job_idx ON job_attempts (job_id, seq);
CREATE TRIGGER job_attempts_append_only BEFORE UPDATE OR DELETE ON job_attempts FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER job_attempts_no_truncate BEFORE TRUNCATE ON job_attempts FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

-- The recurring jobs. One job per organization per slot (the slot is part of the idempotency key), so two workers never enqueue the same slot twice and a stopped
-- worker leaves no backlog of missed slots. Rows are added by migrations of the consumers that need them (a reviewed change), not by a login.
CREATE TABLE job_schedules (
  type             text        PRIMARY KEY,
  interval_seconds integer     NOT NULL,
  max_attempts     integer     NOT NULL DEFAULT 5,
  enabled          boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_schedules_type_shape CHECK (type ~ '^[a-z][a-z0-9.-]{1,63}$'),
  CONSTRAINT job_schedules_interval_range CHECK (interval_seconds BETWEEN 60 AND 604800),
  CONSTRAINT job_schedules_attempts_range CHECK (max_attempts BETWEEN 1 AND 20)
);

CREATE TABLE job_workers (
  worker_id  text        PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_workers_id_len CHECK (length(worker_id) BETWEEN 1 AND 128)
);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant ON jobs FOR SELECT TO telesphoros_app, telesphoros_worker USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY jobs_definer ON jobs FOR ALL TO telesphoros_jobs USING (true) WITH CHECK (true);
CREATE POLICY job_attempts_tenant ON job_attempts FOR SELECT TO telesphoros_app, telesphoros_worker USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY job_attempts_definer ON job_attempts FOR ALL TO telesphoros_jobs USING (true) WITH CHECK (true);

-- The API's way in. The organization and the person come from the transaction (Database.withTenant binds both), never from the arguments, so a request cannot enqueue
-- work for another organization or in someone else's name. A repeat of the same (type, key) returns the existing job and changes nothing.
CREATE FUNCTION job_enqueue(p_type text, p_payload jsonb, p_key text, p_run_after timestamptz DEFAULT now(), p_max_attempts integer DEFAULT 5)
RETURNS TABLE (job_id uuid, created boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
  v_actor  text := nullif(current_setting('app.current_actor', true), '');
  v_id uuid;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'A job needs an organization and a person bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.jobs (tenant_id, type, payload, idempotency_key, run_after, max_attempts, requested_by)
  VALUES (v_tenant, p_type, coalesce(p_payload, '{}'::jsonb), p_key, coalesce(p_run_after, now()), p_max_attempts, v_actor)
  ON CONFLICT (tenant_id, type, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
  ELSE
    RETURN QUERY SELECT j.id, false FROM public.jobs j WHERE j.tenant_id = v_tenant AND j.type = p_type AND j.idempotency_key = p_key;
  END IF;
END
$$;

-- The worker's claim: ready jobs of the given types (and jobs whose lease ran out), oldest first, skipping organizations that are suspended and jobs another worker
-- holds, and never more than p_tenant_cap running jobs for one organization. A job whose lease ran out is recorded as such; one that has used its attempts is dead.
CREATE FUNCTION job_claim(p_worker text, p_types text[], p_batch integer, p_tenant_cap integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, tenant_id text, type text, payload jsonb, attempt integer, max_attempts integer, lease_until timestamptz, requested_by text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
#variable_conflict use_column
DECLARE
  r record;
  v_claimed integer := 0;
  v_running integer;
  v_skip text[] := ARRAY[]::text[];
BEGIN
  IF p_batch < 1 OR p_batch > 50 OR p_tenant_cap < 1 OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'Claim limits out of range.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WHILE v_claimed < p_batch LOOP
    -- One candidate at a time, so an organization that is at its cap (or being served by another claimer) is left out of the next look instead of hiding the
    -- jobs behind its backlog, and so only the rows this claimer means to run are locked.
    SELECT j.id AS jid, j.tenant_id AS jtenant, j.state AS jstate, j.attempts AS jattempts, j.max_attempts AS jmax, j.locked_by AS jlocked, j.started_at AS jstarted
      INTO r
      FROM public.jobs j
      JOIN public.tenants t ON t.id = j.tenant_id AND t.status = 'active'
     WHERE j.type = ANY (p_types)
       AND ((j.state IN ('queued', 'retry') AND j.run_after <= now()) OR (j.state = 'running' AND j.lease_until < now()))
       AND j.tenant_id <> ALL (v_skip)
       AND j.tenant_id NOT IN (SELECT x.tenant_id FROM public.jobs x WHERE x.state = 'running' AND x.lease_until >= now() GROUP BY x.tenant_id HAVING count(*) >= p_tenant_cap)
     ORDER BY j.run_after, j.seq
     LIMIT 1
       FOR UPDATE OF j SKIP LOCKED;
    EXIT WHEN NOT FOUND;
    -- One claimer at a time decides an organization's cap. A claimer that cannot take the lock leaves the organization to the other rather than waiting:
    -- two claimers waiting on each other's organizations would deadlock.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('job-cap:' || r.jtenant, 0)) THEN
      v_skip := v_skip || r.jtenant;
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_running FROM public.jobs x WHERE x.tenant_id = r.jtenant AND x.state = 'running' AND x.lease_until >= now();
    IF v_running >= p_tenant_cap THEN
      v_skip := v_skip || r.jtenant;
      CONTINUE;
    END IF;
    IF r.jstate = 'running' THEN
      INSERT INTO public.job_attempts (job_id, tenant_id, attempt, worker_id, started_at, outcome, error_code)
      VALUES (r.jid, r.jtenant, r.jattempts, coalesce(r.jlocked, 'unknown'), r.jstarted, 'lease-expired', 'lease-expired');
      IF r.jattempts >= r.jmax THEN
        UPDATE public.jobs SET state = 'dead', lease_until = NULL, locked_by = NULL, last_error_code = 'lease-expired', finished_at = now(), updated_at = now() WHERE jobs.id = r.jid;
        CONTINUE;
      END IF;
    END IF;
    RETURN QUERY
      WITH claimed AS (
        UPDATE public.jobs u
           SET state = 'running', attempts = u.attempts + 1, locked_by = p_worker, started_at = now(), lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
         WHERE u.id = r.jid
        RETURNING u.id AS cid, u.tenant_id AS ctenant, u.type AS ctype, u.payload AS cpayload, u.attempts AS cattempt, u.max_attempts AS cmax, u.lease_until AS clease, u.requested_by AS crequested
      )
      SELECT cid, ctenant, ctype, cpayload, cattempt, cmax, clease, crequested FROM claimed;
    v_claimed := v_claimed + 1;
  END LOOP;
  RETURN;
END
$$;

-- Extends the lease of a job this worker still holds. False means the lease was lost (the job is, or soon will be, someone else's): stop working on it.
CREATE FUNCTION job_heartbeat(p_id uuid, p_worker text, p_lease_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE v_n integer;
BEGIN
  IF p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Lease out of range.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  UPDATE public.jobs SET lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   WHERE id = p_id AND state = 'running' AND locked_by = p_worker AND lease_until >= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END
$$;

CREATE FUNCTION job_succeed(p_id uuid, p_worker text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE r record;
BEGIN
  UPDATE public.jobs j SET state = 'succeeded', lease_until = NULL, locked_by = NULL, last_error_code = NULL, finished_at = now(), updated_at = now()
   WHERE j.id = p_id AND j.state = 'running' AND j.locked_by = p_worker
  RETURNING j.tenant_id, j.attempts, j.started_at INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.job_attempts (job_id, tenant_id, attempt, worker_id, started_at, outcome) VALUES (p_id, r.tenant_id, r.attempts, p_worker, r.started_at, 'succeeded');
  RETURN true;
END
$$;

-- A failed run. Retryable and attempts left: retry after 1 min, 5, 25, ... (at most an hour) with +-20% jitter. Otherwise dead (kept, visible, never retried by the system).
-- Returns the new state, or NULL when this worker no longer holds the job.
CREATE FUNCTION job_fail(p_id uuid, p_worker text, p_code text, p_retryable boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  r record;
  v_state text;
  v_delay double precision;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9-]{1,47}$' THEN RAISE EXCEPTION 'An error code is a short code.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT j.tenant_id, j.attempts, j.max_attempts, j.started_at INTO r FROM public.jobs j WHERE j.id = p_id AND j.state = 'running' AND j.locked_by = p_worker FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_retryable AND r.attempts < r.max_attempts THEN
    v_state := 'retry';
    v_delay := least(3600, 60 * power(5, r.attempts - 1)) * (0.8 + 0.4 * random());
    UPDATE public.jobs SET state = 'retry', run_after = now() + make_interval(secs => v_delay), lease_until = NULL, locked_by = NULL, last_error_code = p_code, updated_at = now() WHERE id = p_id;
  ELSE
    v_state := 'dead';
    UPDATE public.jobs SET state = 'dead', lease_until = NULL, locked_by = NULL, last_error_code = p_code, finished_at = now(), updated_at = now() WHERE id = p_id;
  END IF;
  INSERT INTO public.job_attempts (job_id, tenant_id, attempt, worker_id, started_at, outcome, error_code) VALUES (p_id, r.tenant_id, r.attempts, p_worker, r.started_at, 'failed', p_code);
  RETURN v_state;
END
$$;

-- On a clean shutdown: give a job back without counting the attempt it did not get to make.
CREATE FUNCTION job_release(p_id uuid, p_worker text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE r record;
BEGIN
  UPDATE public.jobs j SET state = 'queued', attempts = greatest(j.attempts - 1, 0), lease_until = NULL, locked_by = NULL, run_after = now(), updated_at = now()
   WHERE j.id = p_id AND j.state = 'running' AND j.locked_by = p_worker
  RETURNING j.tenant_id, j.attempts, j.started_at INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.job_attempts (job_id, tenant_id, attempt, worker_id, started_at, outcome) VALUES (p_id, r.tenant_id, r.attempts + 1, p_worker, r.started_at, 'released');
  RETURN true;
END
$$;

-- One job per active organization per slot for every enabled schedule. Returns how many were new.
CREATE FUNCTION job_schedule_tick(p_now timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  s record;
  v_slot bigint;
  v_added integer := 0;
  v_n integer;
BEGIN
  FOR s IN SELECT type, interval_seconds, max_attempts FROM public.job_schedules WHERE enabled LOOP
    v_slot := floor(extract(epoch FROM p_now) / s.interval_seconds);
    INSERT INTO public.jobs (tenant_id, type, payload, idempotency_key, run_after, max_attempts, requested_by)
    SELECT t.id, s.type, '{}'::jsonb, 'slot-' || v_slot::text, p_now, s.max_attempts, 'system:scheduler'
      FROM public.tenants t WHERE t.status = 'active'
    ON CONFLICT (tenant_id, type, idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_added := v_added + v_n;
  END LOOP;
  RETURN v_added;
END
$$;

CREATE FUNCTION job_worker_seen(p_worker text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$ INSERT INTO public.job_workers (worker_id) VALUES (p_worker) ON CONFLICT (worker_id) DO UPDATE SET last_seen = now() $$;

-- Aggregates for the worker's own health line and for an alarm on a queue that is not draining: counts and ages by type and state, no row, no organization, no payload.
CREATE FUNCTION job_stats() RETURNS TABLE (type text, state text, n bigint, oldest_ready_seconds double precision)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
  SELECT j.type, j.state, count(*),
         max(CASE WHEN j.state IN ('queued', 'retry') AND j.run_after <= now() THEN extract(epoch FROM now() - j.run_after) END)::double precision
    FROM public.jobs j GROUP BY j.type, j.state
$$;

-- (job_schedules and job_workers are left with PostgreSQL's default ACL - the owner only - on purpose: writing an ACL that equals the default is invisible to pg_dump,
-- so a restored database would carry a different representation of the same privileges and the restore's privilege comparison would report a difference.)
REVOKE ALL ON jobs, job_attempts FROM PUBLIC;
REVOKE ALL ON FUNCTION job_enqueue(text, jsonb, text, timestamptz, integer), job_claim(text, text[], integer, integer, integer), job_heartbeat(uuid, text, integer),
  job_succeed(uuid, text), job_fail(uuid, text, text, boolean), job_release(uuid, text), job_schedule_tick(timestamptz), job_worker_seen(text), job_stats() FROM PUBLIC;
GRANT SELECT ON jobs, job_attempts TO telesphoros_app, telesphoros_worker;
GRANT EXECUTE ON FUNCTION job_enqueue(text, jsonb, text, timestamptz, integer) TO telesphoros_app;
GRANT EXECUTE ON FUNCTION job_claim(text, text[], integer, integer, integer), job_heartbeat(uuid, text, integer), job_succeed(uuid, text), job_fail(uuid, text, text, boolean),
  job_release(uuid, text), job_schedule_tick(timestamptz), job_worker_seen(text), job_stats() TO telesphoros_worker;
-- The definer reads and writes its own tables (the operator command acts as this role).
GRANT SELECT, INSERT, UPDATE ON jobs TO telesphoros_jobs;
GRANT SELECT, INSERT ON job_attempts TO telesphoros_jobs;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- A system actor is never a person. The tables that record a human decision or assertion refuse an actor that names a system (`system:...`), and a membership cannot
-- belong to one. Evaluations and captures stay open to a system actor (a later, planned automation); decisions, disputes, corrections, merges and identifiers do not.
-- ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_sub_human CHECK (sub !~ '^system:');
ALTER TABLE patient_identifiers ADD CONSTRAINT patient_identifiers_created_by_human CHECK (created_by !~ '^system:' AND (withdrawn_by IS NULL OR withdrawn_by !~ '^system:'));

-- Each table is altered as its own owner (the record tables are owned by the ledger role or the migrator, depending on the migration that made them).
DO $$
DECLARE
  t text;
  owner_role name;
BEGIN
  FOREACH t IN ARRAY ARRAY['capture_acceptances', 'cell_disputes', 'cell_dispute_decisions', 'corrections', 'report_patient_decisions', 'patient_merge_proposals', 'patient_merge_decisions'] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = ('public.' || t)::regclass;
    EXECUTE format('SET LOCAL ROLE %I', owner_role);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (created_by !~ %L)', t, t || '_created_by_human', '^system:');
    RESET ROLE;
  END LOOP;
END
$$;
