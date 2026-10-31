-- compat: breaking
-- Spec 025 slice PD-a: patient demographics with encrypted identity. Two tables and the ledger's new event type `patient-demographics`:
--   patient_field_keys    one wrapped data key per patient (envelope encryption; the key provider wraps it under the encryption context {tenant, patient}).
--                         Insert-only for the application. It is the one table here that can lose a row, and only through patient_field_key_erase() (D8):
--                         destroying the row makes every version of the patient's identity unreadable, backups included. Not a ledger record: a ledger
--                         record can never be deleted, and a key must be destroyable.
--   patient_demographics  a ledger record (event `patient-demographics`): append-only, tenant-scoped, FORCE row-level security. A correction is a new version;
--                         nothing is overwritten. Given name, family name and date of birth are stored ONLY as AES-256-GCM ciphertext (one nonce each); the
--                         coded analytic columns (sex, birth_year, ethnicity) are plaintext by design (D1). The ledger payload carries the sha-256 of each
--                         nonce-and-ciphertext, never a plaintext value and never the ciphertext itself.
--
-- WHAT THE DATABASE CANNOT CHECK. It never sees the date of birth, so "birth_year equals the year of the date of birth" (PD-4) is enforced by the service
-- that derives it and is tested there, not here. The database refuses a year outside 1900 to 2100, an unknown sex, an ethnicity outside the D3 list,
-- an empty or repeated ethnicity list, and ciphertext of a length that cannot be a name or a date.
--
-- VERSIONS. `version` is assigned by the BEFORE INSERT trigger under a per-patient advisory lock (1, 2, ...), never by the caller, so two corrections at once
-- cannot both take the same number and the numbers have no gaps. created_at is set from clock_timestamp() after the lock is held.
--
-- KEYS AND ERASURE. A version's `key_version` must name a key that exists when it is written. patient_field_keys has no foreign key from the demographics
-- (a RESTRICT key would block erasure). A patient with demographics and no key is an erased identity: the trigger on patient_field_keys refuses to create a key for
-- them, and the demographics trigger refuses a new version (SQLSTATE PD001 for both).

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. The coded vocabulary of ethnicity (D3), as a function so a CHECK can say "non-empty, only these codes, no repeats, no NULL element".
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION patient_ethnicity_valid(p_codes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_codes IS NOT NULL
     AND cardinality(p_codes) BETWEEN 1 AND 7
     AND array_ndims(p_codes) = 1
     AND NOT EXISTS (SELECT 1 FROM unnest(p_codes) AS c WHERE c IS NULL OR c NOT IN (
           'american-indian-or-alaska-native', 'asian', 'black-or-african-american', 'hispanic-or-latino',
           'middle-eastern-or-north-african', 'native-hawaiian-or-pacific-islander', 'white'))
     AND (SELECT count(DISTINCT c) FROM unnest(p_codes) AS c) = cardinality(p_codes)
$$;
REVOKE ALL ON FUNCTION patient_ethnicity_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_ethnicity_valid(text[]) TO telesphoros_app;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. patient_field_keys.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE patient_field_keys (
  tenant_id    text NOT NULL,
  patient_id   uuid NOT NULL,
  key_version  integer NOT NULL,
  wrapped_key  bytea NOT NULL,
  provider     text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_field_keys_pk PRIMARY KEY (tenant_id, patient_id),
  CONSTRAINT patient_field_keys_version_uq UNIQUE (tenant_id, patient_id, key_version),
  CONSTRAINT patient_field_keys_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_field_keys_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT patient_field_keys_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT patient_field_keys_version CHECK (key_version >= 1),
  CONSTRAINT patient_field_keys_wrapped_len CHECK (octet_length(wrapped_key) BETWEEN 16 AND 4096),
  CONSTRAINT patient_field_keys_provider CHECK (provider IN ('kms', 'local'))
);

CREATE FUNCTION patient_field_keys_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A patient field key must be created by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('patient-demographics:' || NEW.tenant_id || ':' || NEW.patient_id::text, 0));
  -- Versions without a key are an erased identity: a new key would make nothing readable again, and would hide that the erasure happened.
  -- (A patient whose key still exists is not refused here: the primary key refuses the second key, and the writer reads that as a lost race.)
  IF EXISTS (SELECT 1 FROM public.patient_demographics d WHERE d.patient_id = NEW.patient_id AND d.tenant_id = NEW.tenant_id)
     AND NOT EXISTS (SELECT 1 FROM public.patient_field_keys k WHERE k.patient_id = NEW.patient_id AND k.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'This patient already has demographics whose key was destroyed; a key cannot be created for them again.' USING ERRCODE = 'PD001';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION patient_field_keys_check() FROM PUBLIC;

-- A key leaves only through patient_field_key_erase(), which raises this setting for the length of its own transaction. The setting is a second lock behind the
-- privileges (no login holds DELETE) and the policy below; it makes a stray DELETE by the owner or a superuser fail loudly instead of destroying a key.
CREATE FUNCTION patient_field_keys_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_setting('telesphoros.field_key_erasure', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'A patient field key is destroyed only by patient_field_key_erase().' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION patient_field_keys_delete_guard() FROM PUBLIC;

CREATE TRIGGER patient_field_keys_check BEFORE INSERT ON patient_field_keys FOR EACH ROW EXECUTE FUNCTION patient_field_keys_check();
CREATE TRIGGER patient_field_keys_no_update BEFORE UPDATE ON patient_field_keys FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_field_keys_delete_guard BEFORE DELETE ON patient_field_keys FOR EACH ROW EXECUTE FUNCTION patient_field_keys_delete_guard();
CREATE TRIGGER patient_field_keys_no_truncate BEFORE TRUNCATE ON patient_field_keys FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE patient_field_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_field_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_field_keys_read ON patient_field_keys FOR SELECT TO telesphoros_app USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY patient_field_keys_insert ON patient_field_keys FOR INSERT TO telesphoros_app WITH CHECK (tenant_id = (SELECT public.app_tenant()));
-- For the owner (the role running this migration: the migrator), because FORCE row-level security would otherwise hide every row from it, and the erasure runs as
-- the owner. No login holds DELETE. A DELETE with a WHERE clause reads the rows first, so the same condition must open SELECT as well as DELETE. Both are open only
-- while patient_field_key_erase() is running (a superuser bypasses row-level security and meets the delete guard instead). No policy here is TO PUBLIC.
CREATE POLICY patient_field_keys_erase_read ON patient_field_keys FOR SELECT TO CURRENT_USER USING (current_setting('telesphoros.field_key_erasure', true) = 'on');
CREATE POLICY patient_field_keys_erase ON patient_field_keys FOR DELETE TO CURRENT_USER USING (current_setting('telesphoros.field_key_erasure', true) = 'on');
REVOKE ALL ON patient_field_keys FROM PUBLIC;
GRANT SELECT, INSERT ON patient_field_keys TO telesphoros_app;

-- The erasure (D8). SECURITY DEFINER, owned by the migrator, and executable by NO login: not the application, not the worker, not the verifier. The operator
-- runs it as the owner. It returns whether a key was destroyed. Nothing in the application, no route and no command line calls it.
CREATE FUNCTION patient_field_key_erase(p_tenant text, p_patient uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE destroyed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('patient-demographics:' || p_tenant || ':' || p_patient::text, 0));
  PERFORM set_config('telesphoros.field_key_erasure', 'on', true);
  DELETE FROM public.patient_field_keys WHERE tenant_id = p_tenant AND patient_id = p_patient;
  GET DIAGNOSTICS destroyed = ROW_COUNT;
  PERFORM set_config('telesphoros.field_key_erasure', '', true);
  RETURN destroyed = 1;
END $$;
REVOKE ALL ON FUNCTION patient_field_key_erase(text, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. patient_demographics.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE patient_demographics (
  seq                    bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                     uuid PRIMARY KEY,
  tenant_id              text NOT NULL,
  created_by             text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  ledger_event_id        uuid NOT NULL,
  patient_id             uuid NOT NULL,
  version                integer NOT NULL,
  key_version            integer NOT NULL,
  given_name_ct          bytea NOT NULL,
  given_name_nonce       bytea NOT NULL,
  family_name_ct         bytea NOT NULL,
  family_name_nonce      bytea NOT NULL,
  date_of_birth_ct       bytea NOT NULL,
  date_of_birth_nonce    bytea NOT NULL,
  sex                    text,
  birth_year             integer NOT NULL,
  ethnicity              text[],
  creation_request_id    uuid,
  creation_request_hash  text,
  CONSTRAINT patient_demographics_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT patient_demographics_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT patient_demographics_version CHECK (version >= 1),
  CONSTRAINT patient_demographics_key_version CHECK (key_version >= 1),
  -- AES-256-GCM: a 96-bit nonce, and the ciphertext carries its 16-byte tag. A date of birth is always YYYY-MM-DD: 10 bytes plus the tag.
  CONSTRAINT patient_demographics_nonces CHECK (octet_length(given_name_nonce) = 12 AND octet_length(family_name_nonce) = 12 AND octet_length(date_of_birth_nonce) = 12),
  CONSTRAINT patient_demographics_name_len CHECK (octet_length(given_name_ct) = 16 + 402 AND octet_length(family_name_ct) = 16 + 402), -- names padded to 402 bytes (identity-crypto.ts)
  CONSTRAINT patient_demographics_dob_len CHECK (octet_length(date_of_birth_ct) = 26),
  CONSTRAINT patient_demographics_sex CHECK (sex IS NULL OR sex IN ('male', 'female')),
  CONSTRAINT patient_demographics_birth_year CHECK (birth_year BETWEEN 1900 AND 2100),
  CONSTRAINT patient_demographics_ethnicity CHECK (ethnicity IS NULL OR patient_ethnicity_valid(ethnicity)),
  CONSTRAINT patient_demographics_request_pair CHECK ((creation_request_id IS NULL) = (creation_request_hash IS NULL)),
  CONSTRAINT patient_demographics_request_hash CHECK (creation_request_hash IS NULL OR creation_request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT patient_demographics_version_uq UNIQUE (tenant_id, patient_id, version),
  CONSTRAINT patient_demographics_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_demographics_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX patient_demographics_event_idx ON patient_demographics (ledger_event_id, tenant_id);
CREATE UNIQUE INDEX patient_demographics_request_uq ON patient_demographics (tenant_id, created_by, creation_request_id) WHERE creation_request_id IS NOT NULL;

CREATE FUNCTION patient_demographics_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Demographics must be recorded by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('patient-demographics:' || NEW.tenant_id || ':' || NEW.patient_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = NEW.patient_id AND p.tenant_id = NEW.tenant_id AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'The patient is not available for demographics.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The identity key must exist now. After an erasure it does not, and a version written then could never be read.
  IF NOT EXISTS (SELECT 1 FROM public.patient_field_keys k WHERE k.patient_id = NEW.patient_id AND k.tenant_id = NEW.tenant_id AND k.key_version = NEW.key_version) THEN
    RAISE EXCEPTION 'The identity key for this patient is not available.' USING ERRCODE = 'PD001';
  END IF;
  NEW.version := COALESCE((SELECT max(d.version) FROM public.patient_demographics d WHERE d.patient_id = NEW.patient_id AND d.tenant_id = NEW.tenant_id), 0) + 1;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION patient_demographics_check() FROM PUBLIC;
CREATE TRIGGER patient_demographics_check BEFORE INSERT ON patient_demographics FOR EACH ROW EXECUTE FUNCTION patient_demographics_check();

CREATE CONSTRAINT TRIGGER patient_demographics_has_event AFTER INSERT ON patient_demographics DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER patient_demographics_append_only BEFORE UPDATE OR DELETE ON patient_demographics FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_demographics_no_truncate BEFORE TRUNCATE ON patient_demographics FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE patient_demographics ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_demographics FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_demographics_tenant ON patient_demographics FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY patient_demographics_ledger ON patient_demographics FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY patient_demographics_verifier ON patient_demographics FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON patient_demographics FROM PUBLIC;
GRANT SELECT, INSERT ON patient_demographics TO telesphoros_app;
GRANT SELECT ON patient_demographics TO telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. The ledger learns the new event type and the table it is about (0063's set, plus one).
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'data-provenance', 'use-grant', 'use-grant-validation', 'use-withdrawal', 'use-restriction', 'tenant-use-terms', 'patient-demographics', 'redaction', 'checkpoint'));
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
  WHEN 'capture'                   THEN 'report_captures'
  WHEN 'capture-decision'          THEN 'capture_acceptances'
  WHEN 'evaluation'                THEN 'evaluations'
  WHEN 'correction'                THEN 'corrections'
  WHEN 'dispute'                   THEN 'cell_disputes'
  WHEN 'dispute-decision'          THEN 'cell_dispute_decisions'
  WHEN 'patient-link-decision'     THEN 'report_patient_decisions'
  WHEN 'patient-merge-proposal'    THEN 'patient_merge_proposals'
  WHEN 'patient-merge-decision'    THEN 'patient_merge_decisions'
  WHEN 'clinician-result-decision' THEN 'clinician_result_decisions'
  WHEN 'result-acknowledgement'    THEN 'result_acknowledgements'
  WHEN 'data-provenance'           THEN 'data_provenance'
  WHEN 'use-grant'                 THEN 'use_grants'
  WHEN 'use-grant-validation'      THEN 'use_grant_validations'
  WHEN 'use-withdrawal'            THEN 'use_withdrawals'
  WHEN 'use-restriction'           THEN 'use_restrictions'
  WHEN 'tenant-use-terms'          THEN 'tenant_use_terms'
  WHEN 'patient-demographics'      THEN 'patient_demographics'
  WHEN 'redaction'                 THEN 'event_notes'
  WHEN 'checkpoint'                THEN 'ledger_checkpoints'
END);

CREATE OR REPLACE FUNCTION ledger_event_row_exists() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
    WHEN 'report_patient_decisions' THEN
      SELECT true INTO ok FROM public.report_patient_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'patient_merge_proposals' THEN
      SELECT true INTO ok FROM public.patient_merge_proposals r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'patient_merge_decisions' THEN
      SELECT true INTO ok FROM public.patient_merge_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'clinician_result_decisions' THEN
      SELECT true INTO ok FROM public.clinician_result_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'result_acknowledgements' THEN
      SELECT true INTO ok FROM public.result_acknowledgements r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'data_provenance' THEN
      SELECT true INTO ok FROM public.data_provenance r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_grants' THEN
      SELECT true INTO ok FROM public.use_grants r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_grant_validations' THEN
      SELECT true INTO ok FROM public.use_grant_validations r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_withdrawals' THEN
      SELECT true INTO ok FROM public.use_withdrawals r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_restrictions' THEN
      SELECT true INTO ok FROM public.use_restrictions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'tenant_use_terms' THEN
      SELECT true INTO ok FROM public.tenant_use_terms r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'patient_demographics' THEN
      SELECT true INTO ok FROM public.patient_demographics r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
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

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
