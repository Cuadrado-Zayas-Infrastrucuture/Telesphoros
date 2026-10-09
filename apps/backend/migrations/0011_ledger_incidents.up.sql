-- Shared ledger containment (FD-2, the peer review of 2026-10-09; plan docs/design/plans/fd2-ledger-containment.md).
--
-- Until now "the record log of this tenant is damaged" lived in the memory of the process that found it, so a second API task kept
-- appending to a damaged chain. The fact now lives in the database, and `ledger_append` (the only function the application may call to
-- write a record) refuses inside its own transaction, right after taking the tenant's head-row lock.
--
--   telesphoros_ledger_verifier  records a TENANT incident (ledger_record_incident) and reads incidents. Nothing else.
--   telesphoros_ledger_operator  sets a GLOBAL hold (ledger_set_global_hold) and clears incidents (ledger_clear_incident). Runbook only.
--   telesphoros_app              does neither, and cannot read these tables. It only meets them as a refused write.
--
-- Rolling deployment: this migration only adds tables, one column and stricter behaviour; an older application image keeps working
-- against it (its writes are refused by the database during an incident, with a 500 instead of the 503 that this release maps).

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

-- ------------------------------------------------------------------------------------------------------------------ tables
-- An incident is open until a clearance row names it. Neither table is ever updated or deleted.
CREATE TABLE ledger_incidents (
  seq         bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL,
  tenant_id   text,
  kind        text NOT NULL,
  failed_seq  bigint,
  source      text NOT NULL,
  basis       text,
  recorded_by text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ledger_incidents_scope CHECK (scope IN ('tenant', 'global')),
  CONSTRAINT ledger_incidents_scope_tenant CHECK ((scope = 'tenant') = (tenant_id IS NOT NULL)),
  CONSTRAINT ledger_incidents_tenant_len CHECK (tenant_id IS NULL OR length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT ledger_incidents_kind CHECK (kind ~ '^[a-z0-9-]{1,64}$'),
  CONSTRAINT ledger_incidents_source CHECK (source IN ('startup', 'background', 'scheduled', 'on-demand', 'manual')),
  CONSTRAINT ledger_incidents_failed_seq CHECK (failed_seq IS NULL OR failed_seq >= 1),
  -- A global hold is a human decision and says why; a tenant incident is a machine finding and carries no free text.
  CONSTRAINT ledger_incidents_basis CHECK ((scope = 'global' AND basis IS NOT NULL AND length(basis) BETWEEN 1 AND 500) OR (scope = 'tenant' AND basis IS NULL)),
  CONSTRAINT ledger_incidents_recorded_by CHECK (length(recorded_by) BETWEEN 1 AND 128)
);
CREATE INDEX ledger_incidents_tenant_idx ON ledger_incidents (tenant_id) WHERE scope = 'tenant';
CREATE INDEX ledger_incidents_global_idx ON ledger_incidents (scope) WHERE scope = 'global';

CREATE TABLE ledger_incident_clearances (
  seq                    bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id            uuid NOT NULL,
  cleared_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  cleared_by             text NOT NULL,
  basis                  text NOT NULL,
  -- The full verification that proved the chain sound again (tenant incidents). A global hold is cleared by a person's decision alone.
  verified_checkpoint_id uuid,
  CONSTRAINT ledger_clearances_incident_uq UNIQUE (incident_id),
  CONSTRAINT ledger_clearances_incident_fk FOREIGN KEY (incident_id) REFERENCES ledger_incidents (id) ON DELETE RESTRICT,
  CONSTRAINT ledger_clearances_checkpoint_fk FOREIGN KEY (verified_checkpoint_id) REFERENCES ledger_checkpoints (id) ON DELETE RESTRICT,
  CONSTRAINT ledger_clearances_basis CHECK (length(basis) BETWEEN 1 AND 500),
  CONSTRAINT ledger_clearances_cleared_by CHECK (length(cleared_by) BETWEEN 1 AND 128)
);

CREATE TRIGGER ledger_incidents_append_only BEFORE UPDATE OR DELETE ON ledger_incidents FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER ledger_incidents_no_truncate BEFORE TRUNCATE ON ledger_incidents FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER ledger_clearances_append_only BEFORE UPDATE OR DELETE ON ledger_incident_clearances FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER ledger_clearances_no_truncate BEFORE TRUNCATE ON ledger_incident_clearances FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

-- When did the walk that produced a checkpoint START (the database's clock, taken at the start of the verifier's snapshot)? A clearance
-- needs a full walk that began AFTER the incident was recorded: a walk already running at the time may have read the chain before the
-- damage, or before the other finding, and finishing later does not make it evidence about the damaged state. NULL for checkpoints
-- written by the older four-argument function (they never qualify). It is not part of the checkpoint's hashed payload (changing that is a
-- hash-version change); the table is append-only and only the function below writes it.
ALTER TABLE ledger_checkpoints ADD COLUMN walk_started_at timestamptz;

-- ------------------------------------------------------------------------------------------------------------ checkpoints
CREATE FUNCTION ledger_record_checkpoint(p_tenant text, p_up_to bigint, p_head_hash text, p_mode text, p_walk_started_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cp uuid := gen_random_uuid();
  ev uuid := gen_random_uuid();
BEGIN
  IF p_walk_started_at IS NULL OR p_walk_started_at > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'A checkpoint needs the start time of the walk that produced it, and that time cannot be in the future.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_events e WHERE e.tenant_id = p_tenant AND e.seq = p_up_to AND e.record_hash = p_head_hash) THEN
    RAISE EXCEPTION 'The checkpoint does not match the ledger.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.current_tenant_id', p_tenant, true);
  PERFORM pg_catalog.set_config('app.current_actor', 'ledger-verifier', true);
  INSERT INTO public.ledger_checkpoints (id, tenant_id, created_by, ledger_event_id, up_to_seq, head_hash, mode, walk_started_at)
       VALUES (cp, p_tenant, 'ledger-verifier', ev, p_up_to, p_head_hash, p_mode, p_walk_started_at);
  -- The same payload as the four-argument function (0005): sha256 of  id, tenant, up_to_seq, head_hash, mode  joined with chr(31).
  PERFORM public.ledger_append_internal(ev, 'checkpoint', 'ledger_checkpoints', cp,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31), cp::text, p_tenant, p_up_to::text, p_head_hash, p_mode), 'UTF8')), 'hex'),
          1::smallint);
  RETURN cp;
END $$;

-- ------------------------------------------------------------------------------------------------------------ incidents
-- The verifier records what a walk found. It takes the tenant's head-row lock first, so a write that is already in flight finishes
-- (and commits) BEFORE the incident exists and every later write sees it: no write for the tenant commits after this function returns.
-- Idempotent: while the tenant has an open incident the first finding is kept and its id is returned.
CREATE FUNCTION ledger_record_incident(p_tenant text, p_kind text, p_seq bigint, p_source text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  existing uuid;
  created  uuid;
BEGIN
  IF p_tenant IS NULL OR p_tenant = '' THEN
    RAISE EXCEPTION 'An incident needs a tenant.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_source = 'manual' THEN
    RAISE EXCEPTION 'A tenant incident is recorded by a verification, not by hand.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.set_config('lock_timeout', '3000', true);
  PERFORM 1 FROM public.ledger_heads WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That tenant has no ledger.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT i.id INTO existing FROM public.ledger_incidents i
   WHERE i.scope = 'tenant' AND i.tenant_id = p_tenant AND NOT EXISTS (SELECT 1 FROM public.ledger_incident_clearances c WHERE c.incident_id = i.id)
   ORDER BY i.seq LIMIT 1;
  IF FOUND THEN
    RETURN existing;
  END IF;
  INSERT INTO public.ledger_incidents (scope, tenant_id, kind, failed_seq, source, recorded_by)
       VALUES ('tenant', p_tenant, p_kind, p_seq, p_source, session_user) RETURNING id INTO created;
  RETURN created;
END $$;

-- A person stops writes for EVERY tenant. In-flight writes of other tenants may still commit; every write that starts after the
-- hold commits is refused. Idempotent: an open hold is returned instead of a second one.
CREATE FUNCTION ledger_set_global_hold(p_basis text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  existing uuid;
  created  uuid;
BEGIN
  IF p_basis IS NULL OR length(p_basis) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'A global hold needs a basis of 1 to 500 characters.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('telesphoros.ledger_global_hold'));
  SELECT i.id INTO existing FROM public.ledger_incidents i
   WHERE i.scope = 'global' AND NOT EXISTS (SELECT 1 FROM public.ledger_incident_clearances c WHERE c.incident_id = i.id)
   ORDER BY i.seq LIMIT 1;
  IF FOUND THEN
    RETURN existing;
  END IF;
  INSERT INTO public.ledger_incidents (scope, tenant_id, kind, failed_seq, source, basis, recorded_by)
       VALUES ('global', NULL, 'manual-hold', NULL, 'manual', p_basis, session_user) RETURNING id INTO created;
  RETURN created;
END $$;

-- A person reopens writes. A tenant incident can be cleared only by a FULL verification of that tenant that STARTED after the incident was
-- recorded and reaches at least the failed sequence number. Checkpoints are written only by a walk that found nothing wrong, so a chain
-- that is still damaged cannot be cleared by anyone, whatever their privileges. A global hold is cleared by the decision alone.
CREATE FUNCTION ledger_clear_incident(p_incident uuid, p_basis text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  i  record;
  cp uuid;
  cleared uuid;
BEGIN
  IF p_basis IS NULL OR length(p_basis) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Clearing an incident needs a basis of 1 to 500 characters.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO i FROM public.ledger_incidents WHERE id = p_incident;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such incident.' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_incident_clearances c WHERE c.incident_id = i.id) THEN
    RAISE EXCEPTION 'This incident is already cleared.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF i.scope = 'tenant' THEN
    SELECT c.id INTO cp FROM public.ledger_checkpoints c
     WHERE c.tenant_id = i.tenant_id AND c.mode = 'full' AND c.walk_started_at IS NOT NULL
       AND c.walk_started_at > i.detected_at AND c.up_to_seq >= COALESCE(i.failed_seq, 1)
     ORDER BY c.up_to_seq DESC, c.seq DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No full verification that started after the incident has passed for this tenant.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  INSERT INTO public.ledger_incident_clearances (incident_id, cleared_by, basis, verified_checkpoint_id)
       VALUES (i.id, session_user, p_basis, cp) RETURNING id INTO cleared;
  RETURN cleared;
END $$;

-- ---------------------------------------------------------------------------------------------------------------- the gate
-- Same signature, owner and grants as in 0005 (CREATE OR REPLACE keeps them). New: after the tenant's head-row lock is held, a write is
-- refused when that tenant has an open incident or any global hold is open. Checking AFTER the lock means a write cannot slip between a
-- check and its lock; the next statement's snapshot sees every incident committed before the lock was granted.
-- Checkpoints and redactions do not pass through here (they use ledger_append_internal), so a verifier can still record what it found
-- and an operator can still redact PHI during an incident. That is deliberate.
CREATE OR REPLACE FUNCTION ledger_append(p_event uuid, p_type text, p_table text, p_subject uuid, p_payload text, p_projection_version smallint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t text := pg_catalog.current_setting('app.current_tenant_id', true);
BEGIN
  IF p_type IN ('redaction', 'checkpoint') THEN
    RAISE EXCEPTION 'This event type cannot be appended by the application.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- (A missing tenant setting is refused by ledger_append_internal, exactly as before.)
  IF t IS NOT NULL AND t <> '' THEN
    PERFORM pg_catalog.set_config('lock_timeout', '3000', true);
    INSERT INTO public.ledger_heads (tenant_id, seq, record_hash) VALUES (t, 0, pg_catalog.repeat('0', 64)) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM public.ledger_heads WHERE tenant_id = t FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.ledger_incidents i
                WHERE (i.scope = 'global' OR i.tenant_id = t)
                  AND NOT EXISTS (SELECT 1 FROM public.ledger_incident_clearances c WHERE c.incident_id = i.id)) THEN
      RAISE EXCEPTION 'Writes to the record log are stopped (an open incident).' USING ERRCODE = 'LC001';
    END IF;
  END IF;
  RETURN public.ledger_append_internal(p_event, p_type, p_table, p_subject, p_payload, p_projection_version);
END $$;

-- ----------------------------------------------------------------------------------------------------------------- security
-- (still running as the owner role: only an owner may enable row-level security, create policies and grant on these objects)
ALTER TABLE ledger_incidents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_incident_clearances ENABLE ROW LEVEL SECURITY;
-- (Not FORCEd, like the other ledger tables: the owner maintains them through the functions above. The application role has no policy and no grant.)
CREATE POLICY ledger_incidents_verifier  ON ledger_incidents           FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY ledger_incidents_operator  ON ledger_incidents           FOR SELECT TO telesphoros_ledger_operator USING (true);
CREATE POLICY ledger_clearances_verifier ON ledger_incident_clearances FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY ledger_clearances_operator ON ledger_incident_clearances FOR SELECT TO telesphoros_ledger_operator USING (true);

REVOKE ALL ON ledger_incidents, ledger_incident_clearances FROM PUBLIC;
GRANT SELECT ON ledger_incidents, ledger_incident_clearances TO telesphoros_ledger_verifier, telesphoros_ledger_operator;

REVOKE ALL ON FUNCTION ledger_record_checkpoint(text, bigint, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_record_incident(text, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_set_global_hold(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_clear_incident(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_record_checkpoint(text, bigint, text, text, timestamptz) TO telesphoros_ledger_verifier;
GRANT EXECUTE ON FUNCTION ledger_record_incident(text, text, bigint, text) TO telesphoros_ledger_verifier;
GRANT EXECUTE ON FUNCTION ledger_set_global_hold(text) TO telesphoros_ledger_operator;
GRANT EXECUTE ON FUNCTION ledger_clear_incident(uuid, text) TO telesphoros_ledger_operator;

-- The application may call the gate and nothing behind it. It never held ledger_append_internal (0005 revoked it from PUBLIC and 0006
-- granted it to the redaction role only); this states it, so that a later grant by mistake has to undo a written line, and a catalog test
-- (ledger-catalog.pg-spec) pins the result.
REVOKE ALL ON FUNCTION ledger_append_internal(uuid, text, text, uuid, text, smallint) FROM PUBLIC, telesphoros_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
