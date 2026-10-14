-- M2.1c-2: possible-duplicate flags, and merge / unmerge of patients as two-person ledger records.
-- See docs/design/plans/m2-1c-2-duplicates-and-merge.md and docs/design/plans/m2-1c-wrong-chart-and-duplicates.md.
--
-- A merge never rewrites a row: `patients`, `reports`, `evaluations` and every other record keep the tenant_id and patient_id they were
-- written with. An approved merge makes the source patient an ALIAS of the target; an approved unmerge of that pair ends it. Reads resolve the
-- alias through patient_alias_edges() below. Groups are one level deep (a root and its direct aliases): the commit-time rule refuses a merge
-- whose source has aliases of its own, so a chain cannot be written and no recursion is needed.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- A possible duplicate: an identifier collision between two patients of the same organization. No number and no digest is stored, only the
-- assigning system's short code, so the flag is as harmless as a patient label. One row per unordered pair (patient_id < other_patient_id).
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE patient_duplicate_flags (
  seq              bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  patient_id       uuid NOT NULL,
  other_patient_id uuid NOT NULL,
  system           text NOT NULL,
  flagged_by       text NOT NULL,
  flagged_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_duplicate_flags_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT patient_duplicate_flags_flagged_by_len CHECK (length(flagged_by) BETWEEN 1 AND 128),
  CONSTRAINT patient_duplicate_flags_system_shape CHECK (system ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  CONSTRAINT patient_duplicate_flags_pair_order CHECK (patient_id < other_patient_id),
  CONSTRAINT patient_duplicate_flags_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_duplicate_flags_other_fk FOREIGN KEY (other_patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_duplicate_flags_pair_uq UNIQUE (tenant_id, patient_id, other_patient_id)
);
CREATE INDEX patient_duplicate_flags_tenant_idx ON patient_duplicate_flags (tenant_id, seq DESC);

CREATE TRIGGER patient_duplicate_flags_append_only BEFORE UPDATE OR DELETE ON patient_duplicate_flags FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_duplicate_flags_no_truncate BEFORE TRUNCATE ON patient_duplicate_flags FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE patient_duplicate_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_duplicate_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_duplicate_flags_tenant ON patient_duplicate_flags FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
REVOKE ALL ON patient_duplicate_flags FROM PUBLIC;
GRANT SELECT, INSERT ON patient_duplicate_flags TO telesphoros_app;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- A proposal to merge one patient into another, or to undo a merge. A ledger record: append-only, one event each.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE patient_merge_proposals (
  seq               bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL,
  created_by        text NOT NULL,   -- the proposer
  created_at        timestamptz NOT NULL DEFAULT now(),
  ledger_event_id   uuid NOT NULL,
  kind              text NOT NULL,
  source_patient_id uuid NOT NULL,   -- the one that becomes (or stops being) an alias
  target_patient_id uuid NOT NULL,   -- the one it is (or was) merged into
  reason_code       text NOT NULL,
  CONSTRAINT patient_merge_proposals_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT patient_merge_proposals_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT patient_merge_proposals_kind CHECK (kind IN ('merge', 'unmerge')),
  CONSTRAINT patient_merge_proposals_distinct CHECK (source_patient_id <> target_patient_id),
  -- The frozen vocabulary: a merge states why the two are one person; an unmerge says the merge was a mistake.
  CONSTRAINT patient_merge_proposals_reason CHECK (
       (kind = 'merge' AND reason_code IN ('shared-identifier', 'entered-twice'))
    OR (kind = 'unmerge' AND reason_code = 'merged-by-mistake')),
  CONSTRAINT patient_merge_proposals_source_fk FOREIGN KEY (source_patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_merge_proposals_target_fk FOREIGN KEY (target_patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_merge_proposals_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT patient_merge_proposals_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX patient_merge_proposals_source_idx ON patient_merge_proposals (tenant_id, source_patient_id, seq);
CREATE INDEX patient_merge_proposals_target_idx ON patient_merge_proposals (tenant_id, target_patient_id, seq);

CREATE CONSTRAINT TRIGGER patient_merge_proposals_has_event AFTER INSERT ON patient_merge_proposals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER patient_merge_proposals_append_only BEFORE UPDATE OR DELETE ON patient_merge_proposals FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_merge_proposals_no_truncate BEFORE TRUNCATE ON patient_merge_proposals FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The decision on a proposal, by someone other than the proposer. One decision per proposal.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE patient_merge_decisions (
  seq             bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  created_by      text NOT NULL,   -- the person who decided
  created_at      timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  proposal_id     uuid NOT NULL,
  decision        text NOT NULL,
  CONSTRAINT patient_merge_decisions_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT patient_merge_decisions_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT patient_merge_decisions_decision CHECK (decision IN ('approved', 'declined')),
  CONSTRAINT patient_merge_decisions_proposal_fk FOREIGN KEY (proposal_id, tenant_id) REFERENCES patient_merge_proposals (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_merge_decisions_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT patient_merge_decisions_proposal_uq UNIQUE (tenant_id, proposal_id),
  CONSTRAINT patient_merge_decisions_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX patient_merge_decisions_seq_idx ON patient_merge_decisions (tenant_id, seq);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The alias edges in force. For each source patient, its newest APPROVED decision decides: a merge puts an edge from the source to the target,
-- an unmerge leaves none. `p_exclude` leaves one decision out, so the commit-time rule can look at the state just before the decision it checks.
-- Invoker's rights: the caller's row-level security applies, so a tenant only ever sees its own proposals and decisions.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION patient_alias_edges(p_tenant text, p_exclude uuid DEFAULT NULL)
RETURNS TABLE (source_patient_id uuid, target_patient_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
$$
  SELECT e.source_patient_id, e.target_patient_id
    FROM (SELECT DISTINCT ON (p.source_patient_id) p.source_patient_id, p.target_patient_id, p.kind
            FROM public.patient_merge_decisions d
            JOIN public.patient_merge_proposals p ON p.id = d.proposal_id AND p.tenant_id = d.tenant_id
           WHERE d.tenant_id = p_tenant AND d.decision = 'approved' AND (p_exclude IS NULL OR d.id <> p_exclude)
           ORDER BY p.source_patient_id, d.seq DESC) e
   WHERE e.kind = 'merge'
$$;

-- The patient a given patient was merged into, or no row.
CREATE FUNCTION patient_merged_into(p_tenant text, p_patient uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
$$ SELECT target_patient_id FROM public.patient_alias_edges(p_tenant) WHERE source_patient_id = p_patient $$;

-- The patients that count as one: the root and its aliases. Groups are one level deep (see patient_merge_refusal).
CREATE FUNCTION patient_group_ids(p_tenant text, p_patient uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
$$
  WITH edges AS (SELECT * FROM public.patient_alias_edges(p_tenant)),
       root AS (SELECT COALESCE((SELECT target_patient_id FROM edges WHERE source_patient_id = p_patient), p_patient) AS id)
  SELECT id FROM root
  UNION
  SELECT source_patient_id FROM edges WHERE target_patient_id = (SELECT id FROM root)
$$;

-- Why a merge or an unmerge may not happen now, or NULL when it may. One rule, used in two places: the service calls it when a proposal is made
-- (an impossible proposal is refused early) and the deferred trigger below calls it at commit, under the ledger lock, for the decision.
CREATE FUNCTION patient_merge_refusal(p_tenant text, p_kind text, p_source uuid, p_target uuid, p_exclude uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF p_source = p_target THEN RETURN 'same-patient'; END IF;
  IF p_kind = 'merge' THEN
    IF (SELECT count(*) FROM public.patients WHERE tenant_id = p_tenant AND id IN (p_source, p_target) AND deleted_at IS NULL) <> 2 THEN RETURN 'patient-gone'; END IF;
    IF EXISTS (SELECT 1 FROM public.patient_alias_edges(p_tenant, p_exclude) WHERE source_patient_id = p_source) THEN RETURN 'source-merged'; END IF;
    IF EXISTS (SELECT 1 FROM public.patient_alias_edges(p_tenant, p_exclude) WHERE source_patient_id = p_target) THEN RETURN 'target-merged'; END IF;
    IF EXISTS (SELECT 1 FROM public.patient_alias_edges(p_tenant, p_exclude) WHERE target_patient_id = p_source) THEN RETURN 'source-has-aliases'; END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patient_alias_edges(p_tenant, p_exclude) WHERE source_patient_id = p_source AND target_patient_id = p_target) THEN RETURN 'not-merged'; END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION patient_alias_edges(text, uuid), patient_merged_into(text, uuid), patient_group_ids(text, uuid), patient_merge_refusal(text, text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_alias_edges(text, uuid), patient_merged_into(text, uuid), patient_group_ids(text, uuid), patient_merge_refusal(text, text, uuid, uuid, uuid) TO telesphoros_app;

-- A decision is made by someone other than the proposer (the service gives the clear answer first; this is the guarantee).
CREATE FUNCTION patient_merge_decisions_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  p record;
BEGIN
  SELECT created_by INTO p FROM public.patient_merge_proposals WHERE id = NEW.proposal_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR p.created_by = NEW.created_by THEN
    RAISE EXCEPTION 'A merge is decided by someone other than the person who proposed it.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient_merge_decisions_check() FROM PUBLIC;
CREATE TRIGGER patient_merge_decisions_check BEFORE INSERT ON patient_merge_decisions FOR EACH ROW EXECUTE FUNCTION patient_merge_decisions_check();

-- The graph rule, at COMMIT. By then this transaction's ledger event holds the tenant's head lock (the event is the last statement), so every
-- decision committed before ours is visible and none can commit between this check and our commit: two decisions cannot both pass on a stale
-- picture. SQLSTATE PM001 carries the reason code as its message; the API maps it to 409.
CREATE FUNCTION patient_merge_decisions_graph() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  p record;
  why text;
BEGIN
  IF NEW.decision <> 'approved' THEN RETURN NULL; END IF;
  SELECT kind, source_patient_id, target_patient_id INTO p FROM public.patient_merge_proposals WHERE id = NEW.proposal_id AND tenant_id = NEW.tenant_id;
  why := public.patient_merge_refusal(NEW.tenant_id, p.kind, p.source_patient_id, p.target_patient_id, NEW.id);
  IF why IS NOT NULL THEN
    RAISE EXCEPTION '%', why USING ERRCODE = 'PM001';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION patient_merge_decisions_graph() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER patient_merge_decisions_graph AFTER INSERT ON patient_merge_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION patient_merge_decisions_graph();

CREATE CONSTRAINT TRIGGER patient_merge_decisions_has_event AFTER INSERT ON patient_merge_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER patient_merge_decisions_append_only BEFORE UPDATE OR DELETE ON patient_merge_decisions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_merge_decisions_no_truncate BEFORE TRUNCATE ON patient_merge_decisions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient_merge_proposals', 'patient_merge_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL TO telesphoros_app
      USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true))$p$, t || '_tenant', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true))$p$, t || '_ledger', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO telesphoros_ledger_verifier USING (true)', t || '_verifier', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO telesphoros_app', t);
    EXECUTE format('GRANT SELECT ON %I TO telesphoros_ledger, telesphoros_ledger_verifier', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- A link verified by identifier may name an identifier held by ANY patient of the report's patient's group (a number registered on the patient
-- a duplicate was merged into verifies the duplicate's report too). Identifiers are never copied or moved. 0020 tied the identifier to the
-- decision's own patient; this widens that to the group, and an unrelated patient's identifier is still refused. The decision stays what it was
-- when made: a later unmerge does not reach back and unverify it.
-- ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE patient_identifiers ADD CONSTRAINT patient_identifiers_id_tenant_uq UNIQUE (id, tenant_id);
ALTER TABLE report_patient_decisions DROP CONSTRAINT report_patient_decisions_identifier_fk;
ALTER TABLE report_patient_decisions ADD CONSTRAINT report_patient_decisions_identifier_fk
  FOREIGN KEY (identifier_id, tenant_id) REFERENCES patient_identifiers (id, tenant_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION report_patient_decisions_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  r record;
  i record;
BEGIN
  SELECT created_by, upload_requested_by, uploaded_by, patient_id, sha256, object_version, uploaded_at, deleted_at INTO r
    FROM public.reports WHERE id = NEW.report_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR r.deleted_at IS NOT NULL OR r.uploaded_at IS NULL OR r.sha256 IS DISTINCT FROM NEW.report_sha256
     OR r.object_version IS DISTINCT FROM NEW.object_version OR r.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'A decision must be about the report''s current file and patient.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.created_by IN (r.created_by, r.upload_requested_by, r.uploaded_by) THEN
    RAISE EXCEPTION 'A report''s link is decided by someone other than the people who registered or uploaded it.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.method = 'identifier-match' THEN
    SELECT status, patient_id INTO i FROM public.patient_identifiers WHERE id = NEW.identifier_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR i.status <> 'active' OR i.patient_id NOT IN (SELECT public.patient_group_ids(NEW.tenant_id, NEW.patient_id)) THEN
      RAISE EXCEPTION 'A match must name an active identifier of this patient or of a patient merged with it.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The ledger learns the two new event types and the tables they are about.
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'redaction', 'checkpoint'));
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
  WHEN 'capture'                THEN 'report_captures'
  WHEN 'capture-decision'       THEN 'capture_acceptances'
  WHEN 'evaluation'             THEN 'evaluations'
  WHEN 'correction'             THEN 'corrections'
  WHEN 'dispute'                THEN 'cell_disputes'
  WHEN 'dispute-decision'       THEN 'cell_dispute_decisions'
  WHEN 'patient-link-decision'  THEN 'report_patient_decisions'
  WHEN 'patient-merge-proposal' THEN 'patient_merge_proposals'
  WHEN 'patient-merge-decision' THEN 'patient_merge_decisions'
  WHEN 'redaction'              THEN 'event_notes'
  WHEN 'checkpoint'             THEN 'ledger_checkpoints'
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
