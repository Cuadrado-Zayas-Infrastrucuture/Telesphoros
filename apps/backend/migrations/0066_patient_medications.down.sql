-- A populated ledger record cannot be removed; repair forward. Lift FORCE only for the owner's emptiness check.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE patient_medications NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM patient_medications) THEN
    RAISE EXCEPTION 'Refusing to drop populated patient medications. Repair forward with a new migration.';
  END IF;
END $$;
ALTER TABLE patient_medications FORCE ROW LEVEL SECURITY;
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

-- Restore the prior eligibility policy before removing its medication reference.
CREATE OR REPLACE FUNCTION use_eligibility(
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
DROP TABLE patient_medications;
DROP FUNCTION patient_medications_check();
