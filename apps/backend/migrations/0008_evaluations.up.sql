-- An evaluation is what the pipeline produced for one report: held as a whole, or evaluated with one result per drug and one state per gene.
-- Immutable. The header, its results and its gene states are inserted in one transaction BEFORE the ledger event; after the event
-- is visible no child can be added (guard below), and the event's payload hash covers the whole aggregate.

-- reports.(id, patient_id, tenant_id) lets an evaluation prove that its report belongs to its patient.
ALTER TABLE reports ADD CONSTRAINT reports_id_patient_tenant_uq UNIQUE (id, patient_id, tenant_id);

CREATE TABLE evaluations (
  seq                    bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              text NOT NULL,
  created_by             text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  ledger_event_id        uuid NOT NULL,
  patient_id             uuid NOT NULL,
  report_id              uuid NOT NULL,
  capture_id             uuid NOT NULL,
  -- Null only for a held evaluation that was held BEFORE any acceptance (hold code capture-not-accepted).
  capture_acceptance_id  uuid,
  disposition            text NOT NULL,
  hold_code              text,
  -- The adapter's SourceBinding: textSha256, popplerVersion, packetHash, generatorCodeHash, captureAcceptanceId.
  binding                jsonb NOT NULL,
  -- The loaded knowledge set INCLUDING any dispute overlay.
  knowledge_set_id       text NOT NULL,
  engine_version         text NOT NULL,
  -- Exactly what was passed to evaluate(): the only place values from the report appear. Empty when held.
  gene_inputs            jsonb NOT NULL,
  -- The adapter's audit trail: offsets, hashes, states, codes. No report text.
  occurrences            jsonb NOT NULL,
  identity_key           text NOT NULL,
  CONSTRAINT evaluations_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT evaluations_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT evaluations_disposition CHECK (disposition IN ('held', 'evaluated')),
  CONSTRAINT evaluations_hold_code CHECK (hold_code IS NULL OR hold_code IN (
    'capture-not-accepted', 'capture-hash-mismatch', 'poppler-version-mismatch', 'reader-binding-mismatch', 'packet-invalid', 'evidence-overlap',
    'unsupported-layout', 'alignment-unsupported', 'unsupported-column-layout', 'unaccounted-text', 'mixed-frame-set', 'selector-quarantined',
    'source-limit', 'candidate-or-frame-limit', 'source-time-budget', 'worker-error')),
  CONSTRAINT evaluations_hold_consistent CHECK (
    (disposition = 'held' AND hold_code IS NOT NULL AND gene_inputs = '[]'::jsonb AND occurrences = '[]'::jsonb)
    OR (disposition = 'evaluated' AND hold_code IS NULL AND capture_acceptance_id IS NOT NULL)),
  CONSTRAINT evaluations_json_shapes CHECK (jsonb_typeof(binding) = 'object' AND jsonb_typeof(gene_inputs) = 'array' AND jsonb_typeof(occurrences) = 'array'
                                            AND jsonb_array_length(gene_inputs) <= 200),
  CONSTRAINT evaluations_hash_formats CHECK (knowledge_set_id ~ '^[0-9a-f]{64}$' AND identity_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evaluations_engine_version_len CHECK (length(engine_version) BETWEEN 1 AND 100),
  CONSTRAINT evaluations_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evaluations_report_fk FOREIGN KEY (report_id, patient_id, tenant_id) REFERENCES reports (id, patient_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evaluations_capture_fk FOREIGN KEY (capture_id, tenant_id) REFERENCES report_captures (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evaluations_acceptance_fk FOREIGN KEY (capture_acceptance_id, tenant_id) REFERENCES capture_acceptances (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evaluations_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  -- The same inputs, knowledge and code give the existing evaluation instead of a duplicate.
  CONSTRAINT evaluations_identity_uq UNIQUE (tenant_id, identity_key),
  CONSTRAINT evaluations_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT evaluations_id_tenant_report_uq UNIQUE (id, tenant_id, report_id)
);
CREATE INDEX evaluations_tenant_report_idx ON evaluations (tenant_id, report_id, seq);
CREATE INDEX evaluations_tenant_patient_idx ON evaluations (tenant_id, patient_id, seq);
CREATE INDEX evaluations_report_idx ON evaluations (report_id);
CREATE INDEX evaluations_patient_idx ON evaluations (patient_id);
CREATE INDEX evaluations_capture_idx ON evaluations (capture_id);

CREATE TABLE evaluation_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL,
  evaluation_id       uuid NOT NULL,
  ordinal             integer NOT NULL,
  drug                text NOT NULL,
  genes               text[] NOT NULL,
  outcome             text NOT NULL,
  reason_code         text,
  strength            text,
  -- Present only when the engine gave a citation (a verified cell, or an unverified/disputed one for a reviewer to find).
  citation            jsonb,
  guideline_id        text,
  guideline_version   text,
  recommendation_text text,
  implication         text,
  gene_evidence       jsonb NOT NULL,
  CONSTRAINT evaluation_results_ordinal CHECK (ordinal >= 0),
  CONSTRAINT evaluation_results_outcome CHECK (outcome IN ('shown', 'held', 'abstained', 'no-published-recommendation', 'no-guideline')),
  CONSTRAINT evaluation_results_reason CHECK (reason_code IS NULL OR reason_code IN (
    'duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope', 'cell-disputed',
    'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition',
    'association-abstained', 'no-published-recommendation', 'no-guideline-for-drug')),
  CONSTRAINT evaluation_results_strength CHECK (strength IS NULL OR strength IN ('Strong', 'Moderate', 'Optional', 'No recommendation')),
  CONSTRAINT evaluation_results_json CHECK ((citation IS NULL OR jsonb_typeof(citation) = 'object') AND jsonb_typeof(gene_evidence) = 'array'),
  CONSTRAINT evaluation_results_citation_ids CHECK ((citation IS NULL) = (guideline_id IS NULL) AND (guideline_id IS NULL) = (guideline_version IS NULL)),
  -- The engine's result schema, enforced: wording and strength exist ONLY for a shown result and for a verified "No recommendation";
  -- a held, abstained or no-guideline result never stores wording (an unverified or disputed cell never exposes its text).
  CONSTRAINT evaluation_results_shape CHECK (CASE outcome
    WHEN 'shown' THEN reason_code IS NULL AND strength IN ('Strong', 'Moderate', 'Optional') AND citation IS NOT NULL AND recommendation_text IS NOT NULL
    WHEN 'no-published-recommendation' THEN reason_code = 'no-published-recommendation' AND (
         (citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL)
      OR (citation IS NOT NULL AND strength = 'No recommendation' AND recommendation_text IS NOT NULL))
    WHEN 'held' THEN reason_code IN ('duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope',
                                     'cell-disputed', 'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition')
                     AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL
    WHEN 'abstained' THEN reason_code = 'association-abstained' AND citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL
    WHEN 'no-guideline' THEN reason_code = 'no-guideline-for-drug' AND citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL AND cardinality(genes) = 0
    ELSE false END),
  CONSTRAINT evaluation_results_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id) REFERENCES evaluations (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evaluation_results_ordinal_uq UNIQUE (evaluation_id, ordinal)
);
CREATE INDEX evaluation_results_tenant_evaluation_idx ON evaluation_results (tenant_id, evaluation_id, ordinal);
CREATE INDEX evaluation_results_evaluation_idx ON evaluation_results (evaluation_id);

CREATE TABLE evaluation_gene_states (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  evaluation_id uuid NOT NULL,
  gene          text NOT NULL,
  state         text NOT NULL,
  phenotype     text,
  diplotype     text,
  activity_score numeric(6, 2),
  reason_code   text,
  CONSTRAINT evaluation_gene_states_gene CHECK (gene ~ '^[A-Z][A-Za-z0-9-]{0,19}$'),
  CONSTRAINT evaluation_gene_states_state CHECK (state IN ('canonical', 'absent', 'null', 'unresolved')),
  CONSTRAINT evaluation_gene_states_reason CHECK (reason_code IS NULL OR reason_code IN (
    'duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope', 'cell-disputed',
    'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition',
    'association-abstained', 'no-published-recommendation', 'no-guideline-for-drug')),
  -- A canonical gene has a phenotype and no reason; every other state has neither phenotype, diplotype nor score, and a reason.
  CONSTRAINT evaluation_gene_states_shape CHECK (
       (state = 'canonical' AND phenotype IS NOT NULL AND reason_code IS NULL)
    OR (state <> 'canonical' AND phenotype IS NULL AND diplotype IS NULL AND activity_score IS NULL AND reason_code IS NOT NULL)),
  CONSTRAINT evaluation_gene_states_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id) REFERENCES evaluations (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evaluation_gene_states_gene_uq UNIQUE (evaluation_id, gene)
);
CREATE INDEX evaluation_gene_states_tenant_evaluation_idx ON evaluation_gene_states (tenant_id, evaluation_id);
CREATE INDEX evaluation_gene_states_evaluation_idx ON evaluation_gene_states (evaluation_id);

-- The acceptance an evaluation relied on is the LATEST decision for its capture, it accepted, and the capture belongs to this report.
CREATE FUNCTION evaluations_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; a record;
BEGIN
  SELECT report_id INTO c FROM public.report_captures WHERE id = NEW.capture_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR c.report_id <> NEW.report_id THEN
    RAISE EXCEPTION 'The capture does not belong to this report.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.capture_acceptance_id IS NOT NULL THEN
    SELECT decision, capture_id, seq INTO a FROM public.capture_acceptances WHERE id = NEW.capture_acceptance_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR a.capture_id <> NEW.capture_id THEN
      RAISE EXCEPTION 'The acceptance does not belong to this capture.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.disposition = 'evaluated' AND (a.decision <> 'accepted' OR EXISTS (
         SELECT 1 FROM public.capture_acceptances later WHERE later.capture_id = NEW.capture_id AND later.tenant_id = NEW.tenant_id AND later.seq > a.seq)) THEN
      RAISE EXCEPTION 'An evaluation relies on the latest decision about its capture, and it must be an acceptance.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluations_check BEFORE INSERT ON evaluations FOR EACH ROW EXECUTE FUNCTION evaluations_check();

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs
SET LOCAL ROLE telesphoros_ledger;
-- Once an evaluation's ledger event is visible, nothing may be added to it.
CREATE FUNCTION evaluation_child_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.evaluations ev JOIN public.ledger_events e ON e.id = ev.ledger_event_id
              WHERE ev.id = NEW.evaluation_id AND ev.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'A finalized evaluation cannot gain rows.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION evaluation_child_guard() FROM PUBLIC;
DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION evaluation_child_guard() TO %I', session_user); END $$; -- the migrator creates the triggers
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
CREATE TRIGGER evaluation_results_child_guard BEFORE INSERT ON evaluation_results FOR EACH ROW EXECUTE FUNCTION evaluation_child_guard();
CREATE TRIGGER evaluation_gene_states_child_guard BEFORE INSERT ON evaluation_gene_states FOR EACH ROW EXECUTE FUNCTION evaluation_child_guard();

-- A report with evaluations can never be soft-deleted (evaluations are never deleted). Replaces the guard from 0001.
CREATE OR REPLACE FUNCTION block_report_soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM recommendations WHERE report_id = OLD.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'report still has live recommendations' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM evaluations WHERE report_id = OLD.id) THEN
    RAISE EXCEPTION 'report has evaluations' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Each record is described by its own ledger event (checked at COMMIT, from the record's side).
CREATE CONSTRAINT TRIGGER evaluations_has_event AFTER INSERT ON evaluations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
-- Append-only, tenant-scoped, readable by the ledger functions and the verifier.
CREATE TRIGGER evaluations_append_only BEFORE UPDATE OR DELETE ON evaluations FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluations_no_truncate BEFORE TRUNCATE ON evaluations FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_results_append_only BEFORE UPDATE OR DELETE ON evaluation_results FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_results_no_truncate BEFORE TRUNCATE ON evaluation_results FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_gene_states_append_only BEFORE UPDATE OR DELETE ON evaluation_gene_states FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_gene_states_no_truncate BEFORE TRUNCATE ON evaluation_gene_states FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluations FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_gene_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_gene_states FORCE ROW LEVEL SECURITY;
CREATE POLICY evaluations_tenant ON evaluations FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY evaluations_ledger ON evaluations FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY evaluations_verifier ON evaluations FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY evaluation_results_tenant ON evaluation_results FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY evaluation_results_ledger ON evaluation_results FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY evaluation_results_verifier ON evaluation_results FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY evaluation_gene_states_tenant ON evaluation_gene_states FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY evaluation_gene_states_ledger ON evaluation_gene_states FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY evaluation_gene_states_verifier ON evaluation_gene_states FOR SELECT TO telesphoros_ledger_verifier USING (true);

REVOKE ALL ON evaluations, evaluation_results, evaluation_gene_states FROM PUBLIC;
GRANT SELECT, INSERT ON evaluations, evaluation_results, evaluation_gene_states TO telesphoros_app;
GRANT SELECT ON evaluations, evaluation_results, evaluation_gene_states TO telesphoros_ledger, telesphoros_ledger_verifier;
