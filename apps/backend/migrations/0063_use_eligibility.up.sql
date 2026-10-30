-- compat: breaking
-- Spec 020 slice E1b: the use-eligibility records and the policy `use-eligibility-v1` (plan.md; tasks.md, slice plan B1 to B5). Five ledger records, each
-- append-only, tenant-scoped, FORCE row-level security and with one event of its own:
--   use_grants (event `use-grant`)                       a patient's permission for one purpose and scope: who signed, in what capacity, on which form,
--                                                         under which legal authority and jurisdiction, effective from when, expiring how (E3, E5, B1, B4, B5)
--   use_grant_validations (event `use-grant-validation`) who validated a grant, and when (B2): a grant row cannot be updated to "validated"
--   use_withdrawals (event `use-withdrawal`)             the end of one grant, never effective before the moment it was recorded (E6)
--   use_restrictions (event `use-restriction`)           a patient's restriction on one purpose or on all of them, over an interval
--   tenant_use_terms (event `tenant-use-terms`)          what the organization's agreement lets the platform do: purposes, data classifications, de-identification
-- and two functions: use_eligibility_lock() (the per-patient lock, E6) and use_eligibility() (the policy).
--
-- Nothing in the application writes these tables: the writers (E2 operator command, E3 API) are later slices. They are written by tests and seed scripts only.
--
-- TIME. A record is bound to the moment the database took it: `created_at` is set by the BEFORE INSERT trigger from clock_timestamp() AFTER the per-patient
-- lock is held (for the four patient-scoped records), never from the caller. The policy answers "as of `at`, knowing only what was recorded by `at`":
-- a record counts only when `created_at <= at` AND its own interval covers `at` (E2, FR-02). A grant recorded later with a back-dated `effective_from`
-- therefore cannot change an answer already given for an earlier instant. A caller that must see every record committed before its ask takes the lock with
-- use_eligibility_lock(), which returns clock_timestamp() read after the lock was granted, and passes THAT as `at` in a fresh statement (FR-04, E6).
--
-- No PHI: every text column is a reference or a code bound to a pattern (a signer, a witness, an authority-evidence reference and a signed-document
-- reference are identifiers kept elsewhere; a name containing a space is refused). The signed document is an immutable reference plus its sha-256.
--
-- Breaking by the lint's rule: a widened ledger event-type set (0062's set, restated with five more types, run as the ledger owner as 0062 did), and the
-- TRUNCATE refusal names TRUNCATE. Nothing an older image reads or writes changes. The composite keys the foreign keys use already exist (patients 0003).
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. The per-patient lock (E6). The four patient-scoped records take it in their BEFORE INSERT trigger, and a use takes it before asking.
--    It returns the instant after the lock was granted: a record committed before that instant is visible to the next statement, and a record
--    inserted after it carries a later created_at, so passing the returned instant as `at` never misses a withdrawal that committed first.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION use_eligibility_lock(p_tenant text, p_patient uuid) RETURNS timestamptz
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM public.app_tenant() THEN
    RAISE EXCEPTION 'The use-eligibility lock is for the organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_patient IS NULL THEN
    RAISE EXCEPTION 'The use-eligibility lock needs a patient.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('use-eligibility:' || p_tenant || ':' || p_patient::text, 0));
  RETURN clock_timestamp();
END $$;
REVOKE ALL ON FUNCTION use_eligibility_lock(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION use_eligibility_lock(text, uuid) TO telesphoros_app;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. use_grants.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE use_grants (
  seq                     bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                      uuid PRIMARY KEY,
  tenant_id               text NOT NULL,
  created_by              text NOT NULL,            -- the actor of the transaction: the person who recorded the grant (equal to recorded_by)
  created_at              timestamptz NOT NULL DEFAULT now(), -- set by the trigger after the patient lock; the grant counts only from here (E2)
  ledger_event_id         uuid NOT NULL,
  patient_id              uuid NOT NULL,
  purpose                 text NOT NULL,            -- E1: a closed vocabulary; no model-* purposes
  scope                   text NOT NULL,            -- for example a program id
  jurisdiction            text NOT NULL,            -- B1: recorded on the grant, ISO-like; v1 allows only the synthetic `ZZ` (use_eligibility)
  legal_authority         text NOT NULL,            -- B4: `authorization`, `waiver` or `tpo`
  form_version            text NOT NULL,
  terms_version           text NOT NULL,
  language                text NOT NULL,
  effective_from          timestamptz NOT NULL,
  expiry_kind             text NOT NULL,            -- B5: `date`, or the research-only `no-expiration`; `event` and a missing kind are refused
  expires_at              timestamptz,
  signer                  text NOT NULL,            -- E5: a reference to who signed, never a name
  signer_capacity         text NOT NULL,            -- `patient` or `legally-authorized-representative`
  authority_evidence_ref  text,                     -- required for a representative, absent for the patient
  recorded_by             text NOT NULL,            -- E5: recording is not signing; the transaction actor
  witness_or_attester     text,
  signed_document_ref     text NOT NULL,            -- an immutable reference to the signed document
  signed_document_sha256  text NOT NULL,
  signed_at               timestamptz NOT NULL,
  CONSTRAINT use_grants_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT use_grants_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT use_grants_recorded_by_actor CHECK (recorded_by = created_by),
  CONSTRAINT use_grants_purpose CHECK (purpose IN ('clinical-care', 'tenant-quality-improvement', 'research', 'commercial-aggregate', 'payer-program')),
  CONSTRAINT use_grants_jurisdiction CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  CONSTRAINT use_grants_legal_authority CHECK (legal_authority IN ('authorization', 'waiver', 'tpo')),
  CONSTRAINT use_grants_language CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(language) <= 35),
  -- Reference-like text: no space or punctuation beyond . _ : / - (a name with a space is refused). PostgreSQL's regex repetition limit is 255, so length is a separate test.
  CONSTRAINT use_grants_refs CHECK (
    scope ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(scope) <= 128
    AND form_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(form_version) <= 128
    AND terms_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(terms_version) <= 128
    AND signer ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(signer) <= 128
    AND signed_document_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(signed_document_ref) <= 512
    AND (authority_evidence_ref IS NULL OR (authority_evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(authority_evidence_ref) <= 512))
    AND (witness_or_attester IS NULL OR (witness_or_attester ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(witness_or_attester) <= 128))),
  CONSTRAINT use_grants_recorded_by_len CHECK (length(recorded_by) BETWEEN 1 AND 128),
  CONSTRAINT use_grants_expiry_kind CHECK (expiry_kind IN ('date', 'no-expiration')),
  CONSTRAINT use_grants_expiry_shape CHECK ((expiry_kind = 'date') = (expires_at IS NOT NULL)),
  CONSTRAINT use_grants_expiry_after_start CHECK (expires_at IS NULL OR expires_at > effective_from),
  CONSTRAINT use_grants_no_expiration_research CHECK (expiry_kind <> 'no-expiration' OR purpose = 'research'),
  CONSTRAINT use_grants_signer_capacity CHECK (signer_capacity IN ('patient', 'legally-authorized-representative')),
  CONSTRAINT use_grants_representative_evidence CHECK ((signer_capacity = 'legally-authorized-representative') = (authority_evidence_ref IS NOT NULL)),
  CONSTRAINT use_grants_document_hash CHECK (signed_document_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT use_grants_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT use_grants_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT use_grants_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX use_grants_patient_idx ON use_grants (tenant_id, patient_id, purpose, scope, seq);
CREATE INDEX use_grants_event_idx ON use_grants (ledger_event_id, tenant_id);

CREATE FUNCTION use_grants_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() OR NEW.recorded_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A use grant must be recorded by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := public.use_eligibility_lock(NEW.tenant_id, NEW.patient_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION use_grants_check() FROM PUBLIC;
CREATE TRIGGER use_grants_check BEFORE INSERT ON use_grants FOR EACH ROW EXECUTE FUNCTION use_grants_check();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. use_grant_validations (B2): at most one per grant; the validator is not the person who recorded the grant.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE use_grant_validations (
  seq              bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL,
  created_by       text NOT NULL,              -- the validator, and so the actor; created_at is the moment of validation
  created_at       timestamptz NOT NULL DEFAULT now(),
  ledger_event_id  uuid NOT NULL,
  grant_id         uuid NOT NULL,
  validated_by     text NOT NULL,
  CONSTRAINT use_grant_validations_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT use_grant_validations_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT use_grant_validations_validated_by_actor CHECK (validated_by = created_by),
  CONSTRAINT use_grant_validations_once_uq UNIQUE (grant_id, tenant_id),
  CONSTRAINT use_grant_validations_grant_fk FOREIGN KEY (grant_id, tenant_id) REFERENCES use_grants (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT use_grant_validations_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX use_grant_validations_event_idx ON use_grant_validations (ledger_event_id, tenant_id);

CREATE FUNCTION use_grant_validations_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g record;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() OR NEW.validated_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A grant validation must be by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.patient_id, x.recorded_by INTO g FROM public.use_grants x WHERE x.id = NEW.grant_id AND x.tenant_id = NEW.tenant_id;
  IF FOUND THEN -- a missing grant is refused by the foreign key, with its name
    IF g.recorded_by = NEW.validated_by THEN
      RAISE EXCEPTION 'A grant is validated by someone other than the person who recorded it.'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'use_grant_validations_not_self', TABLE = 'use_grant_validations';
    END IF;
    NEW.created_at := public.use_eligibility_lock(NEW.tenant_id, g.patient_id);
  ELSE
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION use_grant_validations_check() FROM PUBLIC;
CREATE TRIGGER use_grant_validations_check BEFORE INSERT ON use_grant_validations FOR EACH ROW EXECUTE FUNCTION use_grant_validations_check();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. use_withdrawals: at most one per grant; never effective before the moment it was recorded. A null effective_at means "effective when recorded".
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE use_withdrawals (
  seq              bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ledger_event_id  uuid NOT NULL,
  grant_id         uuid NOT NULL,
  effective_at     timestamptz NOT NULL,
  recorded_by      text NOT NULL,
  CONSTRAINT use_withdrawals_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT use_withdrawals_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT use_withdrawals_recorded_by_actor CHECK (recorded_by = created_by),
  CONSTRAINT use_withdrawals_not_backdated CHECK (effective_at >= created_at),
  CONSTRAINT use_withdrawals_once_uq UNIQUE (grant_id, tenant_id),
  CONSTRAINT use_withdrawals_grant_fk FOREIGN KEY (grant_id, tenant_id) REFERENCES use_grants (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT use_withdrawals_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX use_withdrawals_event_idx ON use_withdrawals (ledger_event_id, tenant_id);

CREATE FUNCTION use_withdrawals_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g record;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() OR NEW.recorded_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A withdrawal must be recorded by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.patient_id INTO g FROM public.use_grants x WHERE x.id = NEW.grant_id AND x.tenant_id = NEW.tenant_id;
  IF FOUND THEN -- a missing grant is refused by the foreign key, with its name
    NEW.created_at := public.use_eligibility_lock(NEW.tenant_id, g.patient_id);
  ELSE
    NEW.created_at := clock_timestamp();
  END IF;
  NEW.effective_at := COALESCE(NEW.effective_at, NEW.created_at);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION use_withdrawals_check() FROM PUBLIC;
CREATE TRIGGER use_withdrawals_check BEFORE INSERT ON use_withdrawals FOR EACH ROW EXECUTE FUNCTION use_withdrawals_check();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. use_restrictions: one purpose, or all of them, over an interval.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE use_restrictions (
  seq              bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ledger_event_id  uuid NOT NULL,
  patient_id       uuid NOT NULL,
  purpose          text NOT NULL,               -- a purpose of the vocabulary, or `all`
  effective_from   timestamptz NOT NULL,
  effective_until  timestamptz,                 -- null: no end recorded yet
  reason_code      text NOT NULL,
  CONSTRAINT use_restrictions_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT use_restrictions_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT use_restrictions_purpose CHECK (purpose IN ('all', 'clinical-care', 'tenant-quality-improvement', 'research', 'commercial-aggregate', 'payer-program')),
  CONSTRAINT use_restrictions_interval CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT use_restrictions_reason_code CHECK (reason_code IN ('patient-requested', 'jurisdiction-rule')),
  CONSTRAINT use_restrictions_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT use_restrictions_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX use_restrictions_patient_idx ON use_restrictions (tenant_id, patient_id, seq);
CREATE INDEX use_restrictions_event_idx ON use_restrictions (ledger_event_id, tenant_id);

CREATE FUNCTION use_restrictions_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A use restriction must be recorded by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := public.use_eligibility_lock(NEW.tenant_id, NEW.patient_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION use_restrictions_check() FROM PUBLIC;
CREATE TRIGGER use_restrictions_check BEFORE INSERT ON use_restrictions FOR EACH ROW EXECUTE FUNCTION use_restrictions_check();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. tenant_use_terms: tenant-level, no patient. No lock: terms have a fixed interval and nothing ends them early (a later record supersedes).
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE tenant_use_terms (
  seq                            bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                             uuid PRIMARY KEY,
  tenant_id                      text NOT NULL,
  created_by                     text NOT NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  ledger_event_id                uuid NOT NULL,
  agreement_ref                  text NOT NULL,
  agreement_version              text NOT NULL,
  effective_from                 timestamptz NOT NULL,
  effective_until                timestamptz,
  authorized_purposes            text[] NOT NULL,
  authorized_classifications     text[] NOT NULL,   -- B4
  de_identification_authorized   boolean NOT NULL,
  CONSTRAINT tenant_use_terms_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT tenant_use_terms_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT tenant_use_terms_refs CHECK (
    agreement_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(agreement_ref) <= 256
    AND agreement_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(agreement_version) <= 128),
  CONSTRAINT tenant_use_terms_interval CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT tenant_use_terms_purposes CHECK (
    cardinality(authorized_purposes) BETWEEN 1 AND 5
    AND authorized_purposes <@ ARRAY['clinical-care', 'tenant-quality-improvement', 'research', 'commercial-aggregate', 'payer-program']::text[]),
  CONSTRAINT tenant_use_terms_classifications CHECK (
    cardinality(authorized_classifications) BETWEEN 1 AND 4
    AND authorized_classifications <@ ARRAY['identifiable', 'coded', 'limited-data-set', 'de-identified']::text[]),
  CONSTRAINT tenant_use_terms_once_uq UNIQUE (tenant_id, agreement_ref, agreement_version),
  CONSTRAINT tenant_use_terms_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX tenant_use_terms_event_idx ON tenant_use_terms (ledger_event_id, tenant_id);

CREATE FUNCTION tenant_use_terms_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Tenant use terms must be recorded by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tenant_use_terms_check() FROM PUBLIC;
CREATE TRIGGER tenant_use_terms_check BEFORE INSERT ON tenant_use_terms FOR EACH ROW EXECUTE FUNCTION tenant_use_terms_check();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. Ledger and append-only protection, RLS and grants: the same for all five, as 0062 does for data_provenance.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE CONSTRAINT TRIGGER use_grants_has_event AFTER INSERT ON use_grants DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER use_grants_append_only BEFORE UPDATE OR DELETE ON use_grants FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER use_grants_no_truncate BEFORE TRUNCATE ON use_grants FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE use_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE use_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY use_grants_tenant ON use_grants FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_grants_ledger ON use_grants FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_grants_verifier ON use_grants FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON use_grants FROM PUBLIC;
GRANT SELECT, INSERT ON use_grants TO telesphoros_app;
GRANT SELECT ON use_grants TO telesphoros_ledger, telesphoros_ledger_verifier;

CREATE CONSTRAINT TRIGGER use_grant_validations_has_event AFTER INSERT ON use_grant_validations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER use_grant_validations_append_only BEFORE UPDATE OR DELETE ON use_grant_validations FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER use_grant_validations_no_truncate BEFORE TRUNCATE ON use_grant_validations FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE use_grant_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE use_grant_validations FORCE ROW LEVEL SECURITY;
CREATE POLICY use_grant_validations_tenant ON use_grant_validations FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_grant_validations_ledger ON use_grant_validations FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_grant_validations_verifier ON use_grant_validations FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON use_grant_validations FROM PUBLIC;
GRANT SELECT, INSERT ON use_grant_validations TO telesphoros_app;
GRANT SELECT ON use_grant_validations TO telesphoros_ledger, telesphoros_ledger_verifier;

CREATE CONSTRAINT TRIGGER use_withdrawals_has_event AFTER INSERT ON use_withdrawals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER use_withdrawals_append_only BEFORE UPDATE OR DELETE ON use_withdrawals FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER use_withdrawals_no_truncate BEFORE TRUNCATE ON use_withdrawals FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE use_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE use_withdrawals FORCE ROW LEVEL SECURITY;
CREATE POLICY use_withdrawals_tenant ON use_withdrawals FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_withdrawals_ledger ON use_withdrawals FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_withdrawals_verifier ON use_withdrawals FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON use_withdrawals FROM PUBLIC;
GRANT SELECT, INSERT ON use_withdrawals TO telesphoros_app;
GRANT SELECT ON use_withdrawals TO telesphoros_ledger, telesphoros_ledger_verifier;

CREATE CONSTRAINT TRIGGER use_restrictions_has_event AFTER INSERT ON use_restrictions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER use_restrictions_append_only BEFORE UPDATE OR DELETE ON use_restrictions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER use_restrictions_no_truncate BEFORE TRUNCATE ON use_restrictions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE use_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE use_restrictions FORCE ROW LEVEL SECURITY;
CREATE POLICY use_restrictions_tenant ON use_restrictions FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_restrictions_ledger ON use_restrictions FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY use_restrictions_verifier ON use_restrictions FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON use_restrictions FROM PUBLIC;
GRANT SELECT, INSERT ON use_restrictions TO telesphoros_app;
GRANT SELECT ON use_restrictions TO telesphoros_ledger, telesphoros_ledger_verifier;

CREATE CONSTRAINT TRIGGER tenant_use_terms_has_event AFTER INSERT ON tenant_use_terms DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER tenant_use_terms_append_only BEFORE UPDATE OR DELETE ON tenant_use_terms FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER tenant_use_terms_no_truncate BEFORE TRUNCATE ON tenant_use_terms FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE tenant_use_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_use_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_use_terms_tenant ON tenant_use_terms FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY tenant_use_terms_ledger ON tenant_use_terms FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY tenant_use_terms_verifier ON tenant_use_terms FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON tenant_use_terms FROM PUBLIC;
GRANT SELECT, INSERT ON tenant_use_terms TO telesphoros_app;
GRANT SELECT ON tenant_use_terms TO telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. The policy `use-eligibility-v1`. SECURITY INVOKER: it reads under the caller's row-level security, so it can only see the organization's own rows.
--    It fails closed: every reason that applies is returned, sorted, and `eligible` is true only with none. A record counts only if it was recorded by
--    `p_at` AND its interval covers `p_at`. Reason codes:
--      unknown-purpose, unknown-classification, no-terms-in-force, terms-purpose-not-authorized, terms-classification-not-authorized, no-grant,
--      grant-not-yet-effective, grant-expired, grant-withdrawn, grant-unvalidated, jurisdiction-not-allowed, restriction-in-force, origin-unknown,
--      origin-not-allowed.
--    Which record is relied on when there are several: the terms in force recorded last; among the patient's grants for the purpose and scope, the
--    newest USABLE one (effective, unexpired, not withdrawn, validated, jurisdiction allowed), else the newest grant recorded, whose failures are the reasons.
--    A fact (a capture or an evaluation) is this patient's through its report or its own patient; a fact with no provenance row recorded by `p_at`, or
--    another patient's fact, or an unknown kind, is `origin-unknown`. Real data is allowed only for clinical care (FR-07).
--    The v1 jurisdiction allowlist is the one synthetic code `ZZ` for every purpose (B1). A real pair needs counsel, a new migration and a new version.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION use_eligibility(
  p_tenant text, p_patient uuid, p_purpose text, p_scope text, p_classification text, p_fact_kind text, p_fact_id uuid, p_at timestamptz)
RETURNS TABLE (eligible boolean, reason_codes text[], evidence_ids uuid[], legal_authority text, data_classification text, policy_version text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  purposes constant text[] := ARRAY['clinical-care', 'tenant-quality-improvement', 'research', 'commercial-aggregate', 'payer-program'];
  classifications constant text[] := ARRAY['identifiable', 'coded', 'limited-data-set', 'de-identified'];
  allowed_jurisdictions constant text[] := ARRAY['ZZ'];
  reasons text[] := ARRAY[]::text[];
  evidence uuid[] := ARRAY[]::uuid[];
  purpose_ok boolean := COALESCE(p_purpose = ANY (purposes), false);
  class_ok boolean := COALESCE(p_classification = ANY (classifications), false);
  authority text := NULL;
  terms record;
  grant_row record;
  restrictions uuid[];
  prov_id uuid := NULL;
  prov_origin text := NULL;
BEGIN
  IF p_tenant IS DISTINCT FROM public.app_tenant() THEN
    RAISE EXCEPTION 'Eligibility is answered for the organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'Eligibility is answered as of an instant.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT purpose_ok THEN reasons := array_append(reasons, 'unknown-purpose'); END IF;
  IF NOT class_ok THEN reasons := array_append(reasons, 'unknown-classification'); END IF;

  -- The terms in force: recorded by p_at, interval covers p_at; the last one recorded wins.
  SELECT x.id, x.authorized_purposes, x.authorized_classifications INTO terms
    FROM public.tenant_use_terms x
   WHERE x.tenant_id = p_tenant AND x.created_at <= p_at AND x.effective_from <= p_at AND (x.effective_until IS NULL OR p_at < x.effective_until)
   ORDER BY x.created_at DESC, x.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    reasons := array_append(reasons, 'no-terms-in-force');
  ELSE
    evidence := evidence || terms.id;
    IF purpose_ok AND NOT (p_purpose = ANY (terms.authorized_purposes)) THEN reasons := array_append(reasons, 'terms-purpose-not-authorized'); END IF;
    IF class_ok AND NOT (p_classification = ANY (terms.authorized_classifications)) THEN reasons := array_append(reasons, 'terms-classification-not-authorized'); END IF;
  END IF;

  IF purpose_ok THEN
    -- The grant: the newest usable one, else the newest recorded (whose failures are reported).
    SELECT s.* INTO grant_row FROM (
      SELECT g.id, g.legal_authority AS authority, v.id AS validation_id, w.id AS withdrawal_id,
             (g.effective_from <= p_at) AS started,
             (g.expires_at IS NULL OR p_at < g.expires_at) AS unexpired,
             (g.jurisdiction = ANY (allowed_jurisdictions)) AS jurisdiction_ok,
             g.created_at, g.seq
        FROM public.use_grants g
        LEFT JOIN public.use_withdrawals w ON w.grant_id = g.id AND w.tenant_id = g.tenant_id AND w.created_at <= p_at AND w.effective_at <= p_at
        LEFT JOIN public.use_grant_validations v ON v.grant_id = g.id AND v.tenant_id = g.tenant_id AND v.created_at <= p_at
       WHERE g.tenant_id = p_tenant AND g.patient_id = p_patient AND g.purpose = p_purpose AND g.scope = p_scope AND g.created_at <= p_at
    ) s
    ORDER BY (s.started AND s.unexpired AND s.withdrawal_id IS NULL AND s.validation_id IS NOT NULL AND s.jurisdiction_ok) DESC, s.created_at DESC, s.seq DESC
    LIMIT 1;
    IF NOT FOUND THEN
      reasons := array_append(reasons, 'no-grant');
    ELSE
      evidence := evidence || grant_row.id;
      authority := grant_row.authority;
      IF grant_row.validation_id IS NOT NULL THEN evidence := evidence || grant_row.validation_id; END IF;
      IF grant_row.withdrawal_id IS NOT NULL THEN evidence := evidence || grant_row.withdrawal_id; reasons := array_append(reasons, 'grant-withdrawn'); END IF;
      IF NOT grant_row.started THEN reasons := array_append(reasons, 'grant-not-yet-effective'); END IF;
      IF NOT grant_row.unexpired THEN reasons := array_append(reasons, 'grant-expired'); END IF;
      IF grant_row.validation_id IS NULL THEN reasons := array_append(reasons, 'grant-unvalidated'); END IF;
      IF NOT grant_row.jurisdiction_ok THEN reasons := array_append(reasons, 'jurisdiction-not-allowed'); END IF;
    END IF;

    SELECT array_agg(r.id ORDER BY r.id) INTO restrictions
      FROM public.use_restrictions r
     WHERE r.tenant_id = p_tenant AND r.patient_id = p_patient AND (r.purpose = p_purpose OR r.purpose = 'all')
       AND r.created_at <= p_at AND r.effective_from <= p_at AND (r.effective_until IS NULL OR p_at < r.effective_until);
    IF restrictions IS NOT NULL THEN
      evidence := evidence || restrictions;
      reasons := array_append(reasons, 'restriction-in-force');
    END IF;
  END IF;

  -- The fact and where it came from.
  IF p_fact_kind = 'capture' THEN
    SELECT d.id, d.origin INTO prov_id, prov_origin
      FROM public.data_provenance d
      JOIN public.report_captures c ON c.id = d.capture_id AND c.tenant_id = d.tenant_id
      JOIN public.reports rp ON rp.id = c.report_id AND rp.tenant_id = c.tenant_id
     WHERE d.tenant_id = p_tenant AND d.capture_id = p_fact_id AND rp.patient_id = p_patient AND d.created_at <= p_at;
  ELSIF p_fact_kind = 'evaluation' THEN
    SELECT d.id, d.origin INTO prov_id, prov_origin
      FROM public.data_provenance d
      JOIN public.evaluations e ON e.id = d.evaluation_id AND e.tenant_id = d.tenant_id
     WHERE d.tenant_id = p_tenant AND d.evaluation_id = p_fact_id AND e.patient_id = p_patient AND d.created_at <= p_at;
  END IF;
  IF prov_id IS NULL THEN
    reasons := array_append(reasons, 'origin-unknown');
  ELSE
    evidence := evidence || prov_id;
    IF prov_origin = 'real' AND p_purpose IS DISTINCT FROM 'clinical-care' THEN reasons := array_append(reasons, 'origin-not-allowed'); END IF;
  END IF;

  RETURN QUERY SELECT
    cardinality(reasons) = 0,
    COALESCE((SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(reasons) AS x), ARRAY[]::text[]),
    COALESCE((SELECT array_agg(DISTINCT y ORDER BY y) FROM unnest(evidence) AS y), ARRAY[]::uuid[]),
    authority,
    CASE WHEN class_ok THEN p_classification END,
    'use-eligibility-v1'::text;
END $$;
REVOKE ALL ON FUNCTION use_eligibility(text, uuid, text, text, text, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION use_eligibility(text, uuid, text, text, text, text, uuid, timestamptz) TO telesphoros_app;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. The ledger learns the five new event types and the tables they are about (0062's set, plus five).
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'data-provenance', 'use-grant', 'use-grant-validation', 'use-withdrawal', 'use-restriction', 'tenant-use-terms', 'redaction', 'checkpoint'));
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
