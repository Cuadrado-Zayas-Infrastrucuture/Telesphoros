-- Application access events are distinct from the clinical record ledger.
-- The app can only call the constrained writer; it cannot read or edit audit rows.
GRANT CREATE ON SCHEMA public TO telesphoros_ledger;
SET LOCAL ROLE telesphoros_ledger;

CREATE TABLE security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  outcome text NOT NULL,
  tenant_id text,
  actor_sub text,
  route_key text NOT NULL,
  subject_id uuid,
  request_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_audit_kind CHECK (
    (event_type = 'api-auth' AND outcome IN ('accepted','refused') AND subject_id IS NULL) OR
    (event_type IN ('private-read','download-link') AND outcome IN ('succeeded','refused'))
  ),
  CONSTRAINT security_audit_identity CHECK (
    (event_type = 'api-auth' AND outcome = 'refused' AND tenant_id IS NULL AND actor_sub IS NULL) OR
    (tenant_id IS NOT NULL AND actor_sub IS NOT NULL AND length(tenant_id) BETWEEN 1 AND 128 AND
     length(actor_sub) BETWEEN 1 AND 128 AND tenant_id !~ '[[:cntrl:]]' AND actor_sub !~ '[[:cntrl:]]')
  ),
  CONSTRAINT security_audit_route CHECK (length(route_key) BETWEEN 1 AND 128 AND route_key ~ '^[A-Za-z][A-Za-z0-9_.]*$'),
  CONSTRAINT security_audit_request CHECK (request_id ~ '^[A-Za-z0-9._-]{8,64}$')
);
CREATE INDEX security_audit_tenant_time ON security_audit_events (tenant_id, occurred_at DESC, id) WHERE tenant_id IS NOT NULL;
CREATE INDEX security_audit_request_id ON security_audit_events (request_id);
CREATE TRIGGER security_audit_append_only BEFORE UPDATE OR DELETE ON security_audit_events FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER security_audit_no_truncate BEFORE TRUNCATE ON security_audit_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE security_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_audit_verifier_read ON security_audit_events FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON security_audit_events FROM PUBLIC;
GRANT SELECT ON security_audit_events TO telesphoros_ledger_verifier;

CREATE FUNCTION security_audit_record(p_type text, p_outcome text, p_tenant text, p_actor text,
                                      p_route text, p_subject uuid, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.security_audit_events (event_type, outcome, tenant_id, actor_sub, route_key, subject_id, request_id)
  VALUES (p_type, p_outcome, p_tenant, p_actor, p_route, p_subject, p_request_id);
END $$;
REVOKE ALL ON FUNCTION security_audit_record(text,text,text,text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security_audit_record(text,text,text,text,text,uuid,text) TO telesphoros_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
