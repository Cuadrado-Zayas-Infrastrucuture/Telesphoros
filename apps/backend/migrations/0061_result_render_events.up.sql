-- compat: breaking
-- Spec 019 slice D02b: render capture. One row is one measured fact about one result row on one clinical reader's screen, under the rule `render-v1`
-- (plan P2): at least half of the result's recommendation-summary region in the viewport (`viewport`), or keyboard or assistive-technology focus inside
-- it (`focus`), in a visible tab, for one continuous second. Seq 0 of an episode is its `exposure`; seq 1 and later are `duration` rows with the
-- continuous and cumulative visible time. No row is ever updated (R1). It is evidence of display, never of reading, and a missing row means unknown.
--
-- NOT a ledger record (P3): append-only for everyone, FORCE row-level security, tenant-isolated, but no ledger event, no projection and no change to
-- the ledger's type set. Ids and times only: no column can carry a drug, phenotype, recommendation text or patient label (FR-07).
--
-- Breaking by the lint's rule, not by effect: a new table with its own function and triggers, and nothing an older image reads or writes changes, but
-- the TRUNCATE refusal names TRUNCATE, which an `expand` migration may not (migration-lint.ts matches the keyword). The composite keys the foreign keys
-- below use were added by 0055 and are left as they are. See specs/019-presentation-events/plan.md, slice D02b, and the tasks' R1 to R3.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE result_render_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text NOT NULL,
  episode_id            uuid NOT NULL,            -- the client's id for one episode
  seq                   integer NOT NULL,         -- 0 is the exposure; 1 and later its duration rows
  kind                  text NOT NULL,
  result_id             uuid NOT NULL,            -- the result version displayed (evaluation results are immutable rows)
  evaluation_id         uuid NOT NULL,
  patient_id            uuid NOT NULL,
  viewer                text NOT NULL,            -- the signed-in person on whose screen it was measured
  viewer_roles          text[] NOT NULL,          -- copied by the trigger from the live membership row, never from the request
  membership_version    bigint NOT NULL,
  measurement           text NOT NULL,            -- R2: `viewport` or `focus`
  rule_version          text NOT NULL,
  schema_version        integer NOT NULL,
  capability            text[] NOT NULL,          -- what the browser supported when it measured
  occurred_at           timestamptz NOT NULL,     -- the client's clock: when the threshold was met (exposure) or the time was measured (duration)
  sent_at               timestamptz NOT NULL,     -- the client's clock: when the batch that stored this row was sent
  received_at           timestamptz NOT NULL DEFAULT now(), -- the server's clock: every timeliness measure uses this (FR-03)
  -- Clock uncertainty (T104): the server's receipt minus the client's send time. Network time and clock skew together; neither alone.
  clock_uncertainty_ms  bigint GENERATED ALWAYS AS ((extract(epoch FROM (received_at - sent_at)) * 1000)::bigint) STORED,
  continuous_ms         integer NOT NULL,         -- this episode's uninterrupted visible time
  cumulative_ms         integer NOT NULL,         -- all visible time of this result, path and page view, the episode's included
  CONSTRAINT result_render_events_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT result_render_events_viewer_len CHECK (length(viewer) BETWEEN 1 AND 128),
  CONSTRAINT result_render_events_viewer_human CHECK (viewer !~ '^system:'),
  CONSTRAINT result_render_events_viewer_roles CHECK (viewer_roles && ARRAY['reader', 'clinician', 'reviewer']::text[]),
  CONSTRAINT result_render_events_seq CHECK (seq BETWEEN 0 AND 100000),
  CONSTRAINT result_render_events_kind CHECK (kind IN ('exposure', 'duration')),
  CONSTRAINT result_render_events_kind_seq CHECK ((kind = 'exposure') = (seq = 0)),
  CONSTRAINT result_render_events_measurement CHECK (measurement IN ('viewport', 'focus')),
  CONSTRAINT result_render_events_rule_version CHECK (rule_version = 'render-v1'),
  CONSTRAINT result_render_events_schema_version CHECK (schema_version = 1),
  CONSTRAINT result_render_events_capability CHECK (
    cardinality(capability) BETWEEN 1 AND 3
    AND capability <@ ARRAY['intersection-observer', 'page-visibility', 'focus-events']::text[]
    AND 'page-visibility' = ANY (capability)
    AND (measurement <> 'viewport' OR 'intersection-observer' = ANY (capability))
    AND (measurement <> 'focus' OR 'focus-events' = ANY (capability))),
  CONSTRAINT result_render_events_client_times CHECK (occurred_at <= sent_at),
  -- render-v1: an episode exists only once one continuous second was met, so no row of it reports less; cumulative time includes the episode.
  CONSTRAINT result_render_events_ms CHECK (continuous_ms BETWEEN 1000 AND 86400000 AND cumulative_ms BETWEEN continuous_ms AND 86400000),
  -- FR-04: an episode's event is stored once, whatever the retries; the API skips one already stored.
  CONSTRAINT result_render_events_once_uq UNIQUE (tenant_id, viewer, episode_id, seq),
  CONSTRAINT result_render_events_result_fk FOREIGN KEY (result_id, evaluation_id, tenant_id)
    REFERENCES evaluation_results (id, evaluation_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT result_render_events_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id, patient_id)
    REFERENCES evaluations (id, tenant_id, patient_id) ON DELETE RESTRICT
);
CREATE INDEX result_render_events_result_idx ON result_render_events (tenant_id, result_id, received_at);
CREATE INDEX result_render_events_evaluation_idx ON result_render_events (evaluation_id, tenant_id, patient_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. BEFORE INSERT: the row is bound to the transaction's organization and person, the viewer is a clinical reader by the LIVE membership row (whose
--    roles and version are copied here, never taken from the request), and a duration row follows its episode's exposure, for the same result and
--    path. The route checks the role first to give a clear error, and the API checks the exposure for a clear refusal; this is the guarantee.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION result_render_events_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.viewer IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A render event must be by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT roles, version INTO m FROM public.tenant_memberships
   WHERE tenant_id = NEW.tenant_id AND sub = NEW.viewer AND status = 'active' AND roles && ARRAY['reader', 'clinician', 'reviewer']::text[];
  IF NOT FOUND OR NOT public.membership_assert_current(NEW.viewer, m.version) THEN
    RAISE EXCEPTION 'Only a current clinical reader of the organization may record a render.' USING ERRCODE = 'RR001';
  END IF;
  -- Rows earlier in the same statement are visible here, so an exposure and its durations may arrive in one batch, exposure first.
  IF NEW.kind = 'duration' AND NOT EXISTS (
    SELECT 1 FROM public.result_render_events x
     WHERE x.tenant_id = NEW.tenant_id AND x.viewer = NEW.viewer AND x.episode_id = NEW.episode_id AND x.seq = 0
       AND x.result_id = NEW.result_id AND x.measurement = NEW.measurement) THEN
    RAISE EXCEPTION 'A duration needs its exposure, for the same result and path.' USING ERRCODE = 'RR002';
  END IF;
  NEW.viewer_roles := m.roles;
  NEW.membership_version := m.version;
  NEW.received_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION result_render_events_check() FROM PUBLIC;
CREATE TRIGGER result_render_events_check BEFORE INSERT ON result_render_events FOR EACH ROW EXECUTE FUNCTION result_render_events_check();
CREATE TRIGGER result_render_events_append_only BEFORE UPDATE OR DELETE ON result_render_events FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER result_render_events_no_truncate BEFORE TRUNCATE ON result_render_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE result_render_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_render_events FORCE ROW LEVEL SECURITY;
CREATE POLICY result_render_events_tenant ON result_render_events FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
REVOKE ALL ON result_render_events FROM PUBLIC;
GRANT SELECT, INSERT ON result_render_events TO telesphoros_app;
