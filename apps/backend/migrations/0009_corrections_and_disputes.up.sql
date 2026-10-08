-- Corrections of stored evaluations (specification section 4) and disputes of guideline cells (section 5). Append-only record tables,
-- each row with its own ledger event.

CREATE TABLE corrections (
  seq                       bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 text NOT NULL,
  created_by                text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  ledger_event_id           uuid NOT NULL,
  evaluation_id             uuid NOT NULL,
  report_id                 uuid NOT NULL,   -- copied from the evaluation (composite key), so a supersession can be tied to the same report
  kind                      text NOT NULL,
  reason_code               text NOT NULL,
  previous_correction_id    uuid,
  replacement_evaluation_id uuid,
  note_id                   uuid,
  CONSTRAINT corrections_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT corrections_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT corrections_kind CHECK (kind IN ('retraction', 'supersession', 'reinstatement')),
  -- The frozen vocabulary: which reason codes each kind may carry.
  CONSTRAINT corrections_reason_for_kind CHECK (
       (kind = 'retraction'    AND reason_code IN ('capture-wrong', 'wrong-patient', 'input-misread', 'knowledge-error-found', 'software-defect', 'clinical-review-disagrees'))
    OR (kind = 'supersession'  AND reason_code IN ('capture-wrong', 'input-misread', 'knowledge-error-found', 'software-defect'))
    OR (kind = 'reinstatement' AND reason_code = 'retraction-mistaken')),
  CONSTRAINT corrections_replacement CHECK (
       (kind = 'supersession' AND replacement_evaluation_id IS NOT NULL AND replacement_evaluation_id <> evaluation_id)
    OR (kind <> 'supersession' AND replacement_evaluation_id IS NULL)),
  CONSTRAINT corrections_note_required CHECK (reason_code <> 'clinical-review-disagrees' OR note_id IS NOT NULL),
  CONSTRAINT corrections_reinstatement_chain CHECK (kind <> 'reinstatement' OR previous_correction_id IS NOT NULL),
  CONSTRAINT corrections_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id, report_id) REFERENCES evaluations (id, tenant_id, report_id) ON DELETE RESTRICT,
  -- A link can only point at a correction ON THE SAME EVALUATION.
  CONSTRAINT corrections_previous_fk FOREIGN KEY (previous_correction_id, evaluation_id, tenant_id)
    REFERENCES corrections (id, evaluation_id, tenant_id) ON DELETE RESTRICT,
  -- A replacement must be an evaluation of the SAME report.
  CONSTRAINT corrections_replacement_fk FOREIGN KEY (replacement_evaluation_id, tenant_id, report_id)
    REFERENCES evaluations (id, tenant_id, report_id) ON DELETE RESTRICT,
  CONSTRAINT corrections_note_fk FOREIGN KEY (note_id, tenant_id) REFERENCES event_notes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT corrections_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT corrections_id_eval_tenant_uq UNIQUE (id, evaluation_id, tenant_id),
  CONSTRAINT corrections_id_tenant_uq UNIQUE (id, tenant_id)
);
-- At most one child per node, in the database: two reviewers acting at once cannot both succeed.
CREATE UNIQUE INDEX corrections_one_child_uq ON corrections (previous_correction_id) WHERE previous_correction_id IS NOT NULL;
CREATE UNIQUE INDEX corrections_one_first_uq ON corrections (evaluation_id) WHERE previous_correction_id IS NULL;
CREATE INDEX corrections_tenant_evaluation_idx ON corrections (tenant_id, evaluation_id, seq);
CREATE INDEX corrections_evaluation_idx ON corrections (evaluation_id);
CREATE INDEX corrections_replacement_idx ON corrections (replacement_evaluation_id) WHERE replacement_evaluation_id IS NOT NULL;

-- The state machine. An evaluation is active (no corrections, or the last is a reinstatement), retracted, or superseded (terminal).
-- Because of the unique indexes above, a non-null previous correction is always the LAST one of its evaluation.
CREATE FUNCTION corrections_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE prev record;
BEGIN
  IF NEW.previous_correction_id IS NULL THEN
    IF NEW.kind = 'reinstatement' THEN
      RAISE EXCEPTION 'Only a retracted evaluation can be reinstated.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT kind, created_by INTO prev FROM public.corrections
   WHERE id = NEW.previous_correction_id AND evaluation_id = NEW.evaluation_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The previous correction is not on this evaluation.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF prev.kind = 'supersession' THEN
    RAISE EXCEPTION 'A superseded evaluation takes no further corrections.' USING ERRCODE = 'integrity_constraint_violation';
  ELSIF prev.kind = 'retraction' THEN
    IF NEW.kind <> 'reinstatement' THEN
      RAISE EXCEPTION 'A retracted evaluation can only be reinstated.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.created_by = prev.created_by THEN
      RAISE EXCEPTION 'A retraction cannot be reinstated by the person who made it.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.kind = 'reinstatement' THEN -- previous is a reinstatement: the evaluation is active again
    RAISE EXCEPTION 'Only a retracted evaluation can be reinstated.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER corrections_check BEFORE INSERT ON corrections FOR EACH ROW EXECUTE FUNCTION corrections_check();

CREATE TABLE cell_disputes (
  seq                       bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 text NOT NULL,
  created_by                text NOT NULL,   -- the reviewer who raised it
  created_at                timestamptz NOT NULL DEFAULT now(),
  ledger_event_id           uuid NOT NULL,
  guideline_id              text NOT NULL,
  guideline_version         text NOT NULL,
  -- The content hash of the signed knowledge file that was disputed: a corrected, re-signed file has another hash, which lifts the hold.
  guideline_content_sha256  text NOT NULL,
  locator_table             text NOT NULL,
  locator_row               text NOT NULL,
  locator_column            text,
  note_id                   uuid NOT NULL,
  CONSTRAINT cell_disputes_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT cell_disputes_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT cell_disputes_hash CHECK (guideline_content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cell_disputes_labels CHECK (length(guideline_id) BETWEEN 1 AND 100 AND length(guideline_version) BETWEEN 1 AND 50
    AND length(locator_table) BETWEEN 1 AND 100 AND length(locator_row) BETWEEN 1 AND 100 AND (locator_column IS NULL OR length(locator_column) BETWEEN 1 AND 100)),
  CONSTRAINT cell_disputes_note_fk FOREIGN KEY (note_id, tenant_id) REFERENCES event_notes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cell_disputes_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT cell_disputes_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX cell_disputes_tenant_guideline_idx ON cell_disputes (tenant_id, guideline_id, guideline_content_sha256);

CREATE TABLE cell_dispute_decisions (
  seq              bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  created_by       text NOT NULL,            -- must differ from the person who raised the dispute
  created_at       timestamptz NOT NULL DEFAULT now(),
  ledger_event_id  uuid NOT NULL,
  dispute_id       uuid NOT NULL,
  decision         text NOT NULL,
  evidence_note_id uuid NOT NULL,
  CONSTRAINT cell_dispute_decisions_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT cell_dispute_decisions_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT cell_dispute_decisions_decision CHECK (decision IN ('upheld', 'dismissed')),
  CONSTRAINT cell_dispute_decisions_dispute_fk FOREIGN KEY (dispute_id, tenant_id) REFERENCES cell_disputes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cell_dispute_decisions_note_fk FOREIGN KEY (evidence_note_id, tenant_id) REFERENCES event_notes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cell_dispute_decisions_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  -- One final decision per dispute.
  CONSTRAINT cell_dispute_decisions_dispute_uq UNIQUE (dispute_id),
  CONSTRAINT cell_dispute_decisions_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX cell_dispute_decisions_dispute_idx ON cell_dispute_decisions (dispute_id);

CREATE FUNCTION cell_dispute_decisions_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE raised_by text;
BEGIN
  SELECT created_by INTO raised_by FROM public.cell_disputes WHERE id = NEW.dispute_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR raised_by = NEW.created_by THEN
    RAISE EXCEPTION 'A dispute is decided by someone other than the person who raised it.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cell_dispute_decisions_check BEFORE INSERT ON cell_dispute_decisions FOR EACH ROW EXECUTE FUNCTION cell_dispute_decisions_check();

-- Each record is described by its own ledger event (checked at COMMIT, from the record's side).
CREATE CONSTRAINT TRIGGER corrections_has_event AFTER INSERT ON corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE CONSTRAINT TRIGGER cell_disputes_has_event AFTER INSERT ON cell_disputes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE CONSTRAINT TRIGGER cell_dispute_decisions_has_event AFTER INSERT ON cell_dispute_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();

CREATE TRIGGER corrections_append_only BEFORE UPDATE OR DELETE ON corrections FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER corrections_no_truncate BEFORE TRUNCATE ON corrections FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER cell_disputes_append_only BEFORE UPDATE OR DELETE ON cell_disputes FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER cell_disputes_no_truncate BEFORE TRUNCATE ON cell_disputes FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER cell_dispute_decisions_append_only BEFORE UPDATE OR DELETE ON cell_dispute_decisions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER cell_dispute_decisions_no_truncate BEFORE TRUNCATE ON cell_dispute_decisions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE cell_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_disputes FORCE ROW LEVEL SECURITY;
ALTER TABLE cell_dispute_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_dispute_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY corrections_tenant ON corrections FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY corrections_ledger ON corrections FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY corrections_verifier ON corrections FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY cell_disputes_tenant ON cell_disputes FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY cell_disputes_ledger ON cell_disputes FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY cell_disputes_verifier ON cell_disputes FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY cell_dispute_decisions_tenant ON cell_dispute_decisions FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY cell_dispute_decisions_ledger ON cell_dispute_decisions FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY cell_dispute_decisions_verifier ON cell_dispute_decisions FOR SELECT TO telesphoros_ledger_verifier USING (true);

REVOKE ALL ON corrections, cell_disputes, cell_dispute_decisions FROM PUBLIC;
GRANT SELECT, INSERT ON corrections, cell_disputes, cell_dispute_decisions TO telesphoros_app;
GRANT SELECT ON corrections, cell_disputes, cell_dispute_decisions TO telesphoros_ledger, telesphoros_ledger_verifier;
