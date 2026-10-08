-- The audit ledger (docs/design/records-and-corrections.md, section 6) and the least-privilege roles around it.
--
-- WHO IS WHO (each role was proven in a permissions spike before this migration was written):
--   telesphoros_ledger           NOLOGIN. Owns the ledger tables and the ledger functions. Reads the record tables only
--                                through explicit, tenant-scoped SELECT policies (forced row-level security blinds even an
--                                owner, so without those policies every commit would fail, and that is deliberate: it fails closed).
--   telesphoros_ledger_verifier  NOLOGIN group. Reads everything, writes nothing, is NOT a member of the application role.
--                                Its login is provisioned outside the repository (docs/ops/ledger-roles.md).
--   telesphoros_app              (migration 0002) calls ledger_append and reads the ledger. It cannot write a ledger row.
-- Roles are created here when the migrator may create roles; otherwise they are provisioned beforehand (same as telesphoros_app).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_ledger') THEN
    CREATE ROLE telesphoros_ledger NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_ledger_verifier') THEN
    CREATE ROLE telesphoros_ledger_verifier NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- The migrator must be able to act as the owner role to create its objects (a one-time membership). A superuser already can.
  IF NOT pg_has_role(current_user, 'telesphoros_ledger', 'SET') THEN
    EXECUTE format('GRANT telesphoros_ledger TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END
$$;

-- No role may create objects in public unless granted (a PostgreSQL 16 default, now asserted). The database owner keeps CREATE.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO telesphoros_ledger, telesphoros_ledger_verifier;
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)

-- Shared by every append-only table: nobody, owner included, updates or deletes a row or truncates the table.
CREATE FUNCTION refuse_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$ BEGIN RAISE EXCEPTION 'This table is append-only.' USING ERRCODE = 'integrity_constraint_violation'; END $$;

SET LOCAL ROLE telesphoros_ledger;

CREATE TABLE ledger_heads (
  tenant_id   text PRIMARY KEY,
  seq         bigint NOT NULL,
  record_hash text NOT NULL,
  CONSTRAINT ledger_heads_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT ledger_heads_hash_format CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ledger_heads_seq_nonneg CHECK (seq >= 0)
);

CREATE TABLE ledger_events (
  id                 uuid PRIMARY KEY,
  tenant_id          text NOT NULL,
  seq                bigint NOT NULL,
  event_type         text NOT NULL,
  subject_table      text NOT NULL,
  subject_id         uuid NOT NULL,
  actor_sub          text NOT NULL,
  payload_sha256     text NOT NULL,
  projection_version smallint NOT NULL,
  hash_version       smallint NOT NULL,
  prev_hash          text NOT NULL,
  record_hash        text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_events_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT ledger_events_actor_len CHECK (length(actor_sub) BETWEEN 1 AND 128),
  -- Every hashed text value is joined with chr(31): none may contain it, and concat_ws would skip a NULL (all are NOT NULL).
  CONSTRAINT ledger_events_no_separator CHECK (position(chr(31) in tenant_id) = 0 AND position(chr(31) in actor_sub) = 0),
  CONSTRAINT ledger_events_seq_positive CHECK (seq >= 1),
  CONSTRAINT ledger_events_versions CHECK (projection_version >= 1 AND hash_version = 1),
  CONSTRAINT ledger_events_hash_formats CHECK (payload_sha256 ~ '^[0-9a-f]{64}$' AND prev_hash ~ '^[0-9a-f]{64}$' AND record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ledger_events_type_valid CHECK (event_type IN
    ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'redaction', 'checkpoint')),
  -- Each event type is about exactly one kind of subject. (type_valid above matters: a CASE with no match is NULL, and NULL passes a CHECK.)
  CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
    WHEN 'capture'          THEN 'report_captures'
    WHEN 'capture-decision' THEN 'capture_acceptances'
    WHEN 'evaluation'       THEN 'evaluations'
    WHEN 'correction'       THEN 'corrections'
    WHEN 'dispute'          THEN 'cell_disputes'
    WHEN 'dispute-decision' THEN 'cell_dispute_decisions'
    WHEN 'redaction'        THEN 'event_notes'
    WHEN 'checkpoint'       THEN 'ledger_checkpoints'
  END),
  CONSTRAINT ledger_events_tenant_seq_uq UNIQUE (tenant_id, seq),
  -- A node has at most one child: a fork is impossible.
  CONSTRAINT ledger_events_tenant_prev_uq UNIQUE (tenant_id, prev_hash),
  -- One event per row.
  CONSTRAINT ledger_events_subject_uq UNIQUE (subject_table, subject_id),
  CONSTRAINT ledger_events_id_tenant_uq UNIQUE (id, tenant_id)
);

-- A checkpoint is a record like any other (it has its own ledger event); it is written only by ledger_record_checkpoint.
CREATE TABLE ledger_checkpoints (
  seq             bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  up_to_seq       bigint NOT NULL,
  head_hash       text NOT NULL,
  mode            text NOT NULL,
  CONSTRAINT ledger_checkpoints_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT ledger_checkpoints_mode CHECK (mode IN ('full', 'tail')),
  CONSTRAINT ledger_checkpoints_head_format CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ledger_checkpoints_up_to CHECK (up_to_seq >= 1),
  CONSTRAINT ledger_checkpoints_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ledger_checkpoints_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX ledger_checkpoints_tenant_seq_idx ON ledger_checkpoints (tenant_id, up_to_seq DESC);

-- Later migrations create record tables as the migrator, with a foreign key to ledger_events: give it the right to reference.
DO $$ BEGIN EXECUTE format('GRANT REFERENCES (id, tenant_id) ON ledger_events TO %I', session_user); END $$;

-- ---------------------------------------------------------------------------------------------------------- guards
CREATE TRIGGER ledger_events_append_only BEFORE UPDATE OR DELETE ON ledger_events FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER ledger_events_no_truncate BEFORE TRUNCATE ON ledger_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER ledger_checkpoints_append_only BEFORE UPDATE OR DELETE ON ledger_checkpoints FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER ledger_checkpoints_no_truncate BEFORE TRUNCATE ON ledger_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER ledger_heads_no_truncate BEFORE TRUNCATE ON ledger_heads FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

-- ledger_heads is the one controlled-update table: it starts at genesis and advances by exactly one, and only together with the
-- event that was appended by the SAME transaction (xmin of that row equals this transaction's id). Nobody, owner included, can jump or delete it.
CREATE FUNCTION ledger_heads_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.seq <> 0 OR NEW.record_hash <> pg_catalog.repeat('0', 64) THEN
      RAISE EXCEPTION 'A ledger head starts at genesis.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.seq <> OLD.seq + 1 OR NOT EXISTS (
         SELECT 1 FROM public.ledger_events e
          WHERE e.tenant_id = NEW.tenant_id AND e.seq = NEW.seq AND e.record_hash = NEW.record_hash
            AND e.prev_hash = OLD.record_hash AND e.xmin = pg_catalog.pg_current_xact_id()::xid)
    THEN
      RAISE EXCEPTION 'A ledger head advances by one, together with the event appended in this transaction.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A ledger head cannot be deleted.' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER ledger_heads_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_heads FOR EACH ROW EXECUTE FUNCTION ledger_heads_guard();

-- --------------------------------------------------------------------------------------------------------- append
-- The worker. The record hash is computed HERE, by the database, from a fixed list of columns, so application code cannot forge it.
-- Tenant and actor come from the transaction's settings (identity claims supplied by authenticated application code, never parameters);
-- if either is missing it fails closed. The head row lock is taken by the last statement of the caller's transaction and held to commit;
-- lock_timeout bounds the wait.
CREATE FUNCTION ledger_append_internal(p_event uuid, p_type text, p_table text, p_subject uuid, p_payload text, p_projection_version smallint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t  text := pg_catalog.current_setting('app.current_tenant_id', true);
  a  text := pg_catalog.current_setting('app.current_actor', true);
  h  record;
  s  bigint;
  rh text;
  ts timestamptz := pg_catalog.now();
BEGIN
  IF t IS NULL OR t = '' OR a IS NULL OR a = '' THEN
    RAISE EXCEPTION 'The ledger needs the tenant and actor settings.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.set_config('lock_timeout', '3000', true);
  INSERT INTO public.ledger_heads (tenant_id, seq, record_hash) VALUES (t, 0, pg_catalog.repeat('0', 64)) ON CONFLICT DO NOTHING;
  SELECT * INTO h FROM public.ledger_heads WHERE tenant_id = t FOR UPDATE;
  s := h.seq + 1;
  rh := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31),
          t, s::text, p_type, p_table, p_subject::text, a, p_payload, p_projection_version::text, '1', h.record_hash,
          pg_catalog.to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex');
  INSERT INTO public.ledger_events (id, tenant_id, seq, event_type, subject_table, subject_id, actor_sub, payload_sha256,
                                    projection_version, hash_version, prev_hash, record_hash, created_at)
       VALUES (p_event, t, s, p_type, p_table, p_subject, a, p_payload, p_projection_version, 1, h.record_hash, rh, ts);
  UPDATE public.ledger_heads SET seq = s, record_hash = rh WHERE tenant_id = t;
  RETURN s;
END $$;

-- What the application may call: everything except the event types that only privileged procedures may write.
CREATE FUNCTION ledger_append(p_event uuid, p_type text, p_table text, p_subject uuid, p_payload text, p_projection_version smallint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_type IN ('redaction', 'checkpoint') THEN
    RAISE EXCEPTION 'This event type cannot be appended by the application.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.ledger_append_internal(p_event, p_type, p_table, p_subject, p_payload, p_projection_version);
END $$;

-- At COMMIT: an event must describe a row that exists, in the same tenant, that points back at this event, and was authored by the
-- event's actor. (The reverse, a row without its event, is the deferred foreign key on each record table.)
-- Tables created by later migrations are named here and looked up when the function runs.
CREATE FUNCTION ledger_event_row_exists() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ok boolean;
BEGIN
  CASE NEW.subject_table
    WHEN 'report_captures' THEN
      SELECT true INTO ok FROM public.report_captures r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'capture_acceptances' THEN
      SELECT true INTO ok FROM public.capture_acceptances r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'evaluations' THEN
      SELECT true INTO ok FROM public.evaluations r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'corrections' THEN
      SELECT true INTO ok FROM public.corrections r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'cell_disputes' THEN
      SELECT true INTO ok FROM public.cell_disputes r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'cell_dispute_decisions' THEN
      SELECT true INTO ok FROM public.cell_dispute_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'ledger_checkpoints' THEN
      SELECT true INTO ok FROM public.ledger_checkpoints r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'event_notes' THEN
      -- A redaction event: the note exists in this tenant and is redacted by this very transaction.
      SELECT true INTO ok FROM public.event_notes r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.redacted_at IS NOT NULL;
    ELSE
      ok := false;
  END CASE;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'A ledger event must describe an existing row of the same tenant, authored by the event actor.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_events_row_exists AFTER INSERT ON ledger_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_event_row_exists();

-- The same contract from the record's side. A record must be described by an event of its OWN: its event exists, names this very row
-- (table and id), the same tenant and the same author. (The deferred foreign key on each record table only proves that SOME event with
-- that id exists; without this check a second row could point at the first row's event and commit.) Every record table, including
-- ledger_checkpoints below, gets one deferred constraint trigger that calls this function.
CREATE FUNCTION ledger_row_has_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_events e
                  WHERE e.id = NEW.ledger_event_id AND e.tenant_id = NEW.tenant_id AND e.subject_table = TG_TABLE_NAME
                    AND e.subject_id = NEW.id AND e.actor_sub = NEW.created_by) THEN
    RAISE EXCEPTION 'A record must be described by its own ledger event.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_row_has_event() FROM PUBLIC;
-- Later migrations create the triggers as the migrator, who needs the right to name this function.
DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION ledger_row_has_event() TO %I', session_user); END $$;
CREATE CONSTRAINT TRIGGER ledger_checkpoints_has_event AFTER INSERT ON ledger_checkpoints DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();

REVOKE ALL ON FUNCTION ledger_heads_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_event_row_exists() FROM PUBLIC;

-- Records a verification result. Only the verifier may call it; it refuses anything that does not match the chain.
CREATE FUNCTION ledger_record_checkpoint(p_tenant text, p_up_to bigint, p_head_hash text, p_mode text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cp uuid := gen_random_uuid();
  ev uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_events e WHERE e.tenant_id = p_tenant AND e.seq = p_up_to AND e.record_hash = p_head_hash) THEN
    RAISE EXCEPTION 'The checkpoint does not match the ledger.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.current_tenant_id', p_tenant, true);
  PERFORM pg_catalog.set_config('app.current_actor', 'ledger-verifier', true);
  INSERT INTO public.ledger_checkpoints (id, tenant_id, created_by, ledger_event_id, up_to_seq, head_hash, mode)
       VALUES (cp, p_tenant, 'ledger-verifier', ev, p_up_to, p_head_hash, p_mode);
  -- Payload: sha256 of  id, tenant, up_to_seq, head_hash, mode  joined with chr(31) (the specification gives this encoding).
  PERFORM public.ledger_append_internal(ev, 'checkpoint', 'ledger_checkpoints', cp,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31), cp::text, p_tenant, p_up_to::text, p_head_hash, p_mode), 'UTF8')), 'hex'),
          1::smallint);
  RETURN cp;
END $$;

-- ------------------------------------------------------------------------------------------------ security of the ledger
-- (still running as the owner role: only an owner may enable row-level security, create policies and grant on these objects)
ALTER TABLE ledger_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_heads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_checkpoints ENABLE ROW LEVEL SECURITY;
-- (Not FORCEd: the owner role maintains these tables through the functions above. The application role is fully bound.)
CREATE POLICY ledger_events_tenant      ON ledger_events      FOR SELECT TO telesphoros_app USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY ledger_heads_tenant       ON ledger_heads       FOR SELECT TO telesphoros_app USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY ledger_checkpoints_tenant ON ledger_checkpoints FOR SELECT TO telesphoros_app USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY ledger_events_verifier      ON ledger_events      FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY ledger_heads_verifier       ON ledger_heads       FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY ledger_checkpoints_verifier ON ledger_checkpoints FOR SELECT TO telesphoros_ledger_verifier USING (true);

REVOKE ALL ON ledger_events, ledger_heads, ledger_checkpoints FROM PUBLIC;
GRANT SELECT ON ledger_events, ledger_heads, ledger_checkpoints TO telesphoros_app, telesphoros_ledger_verifier;

REVOKE ALL ON FUNCTION ledger_append(uuid, text, text, uuid, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_append_internal(uuid, text, text, uuid, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_record_checkpoint(text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_append(uuid, text, text, uuid, text, smallint) TO telesphoros_app;
GRANT EXECUTE ON FUNCTION ledger_record_checkpoint(text, bigint, text, text) TO telesphoros_ledger_verifier;
-- ledger_append_internal is executed only by other functions of the same owner (and, in 0006, by the redaction function).

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
