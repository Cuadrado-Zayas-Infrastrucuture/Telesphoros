-- compat: breaking
-- Audit item 25: POST /members/invitations could not be retried. A retry of an invitation that had been made answered 409 invitation-pending, which says nothing about whether the
-- first attempt went through. Same cure as the report create (0014), the patient create and the identifier registration: an optional retry identity per administrator, with a
-- fingerprint of the original request (the address's keyed digest and the roles, never the address). Legacy rows are unkeyed and nothing is rewritten.
-- The application role cannot write this table, so the way in is a new SECURITY DEFINER function beside invitation_create (which is left as it is, for the images that call it).
-- A CHECK, a UNIQUE constraint and a trigger on an existing table make this migration `breaking` under the lint: a release that includes it is a breaking release.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE invitations
  ADD COLUMN creation_request_id uuid,
  ADD COLUMN creation_request_hash text,
  ADD CONSTRAINT invitations_creation_request_pair CHECK (
    (creation_request_id IS NULL AND creation_request_hash IS NULL)
    OR (creation_request_id IS NOT NULL AND creation_request_hash IS NOT NULL
        AND creation_request_hash ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT invitations_creation_request_uq UNIQUE (tenant_id, created_by, creation_request_id);

-- The existing guard (0019) names the columns an update may not touch and lets a decision through; the retry identity is set at insert and never changes.
CREATE FUNCTION invitations_creation_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id
     OR NEW.creation_request_hash IS DISTINCT FROM OLD.creation_request_hash THEN
    RAISE EXCEPTION 'An invitation creation retry identity cannot be changed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION invitations_creation_request_guard() FROM PUBLIC;
CREATE TRIGGER invitations_creation_request_guard BEFORE UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION invitations_creation_request_guard();

-- invitation_create with a retry identity. member_admin_context() takes the organization's one-administrative-change-at-a-time lock, so two repeats cannot interleave:
-- the second sees the first's row. A repeat with the same fingerprint returns the stored invitation (whatever its status now is); another fingerprint is refused.
CREATE FUNCTION invitation_create_keyed(p_email_digest bytea, p_email_hint text, p_roles text[], p_request_id uuid, p_request_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_ctx record;
  v_prior record;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM public.member_admin_context();
  IF (p_request_id IS NULL) <> (p_request_hash IS NULL) THEN
    RAISE EXCEPTION 'A retry id and its fingerprint go together.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_request_id IS NOT NULL THEN
    SELECT i.id, i.creation_request_hash INTO v_prior FROM public.invitations i
     WHERE i.tenant_id = v_ctx.o_tenant AND i.created_by = v_ctx.o_actor AND i.creation_request_id = p_request_id;
    IF FOUND THEN
      IF v_prior.creation_request_hash = p_request_hash THEN RETURN v_prior.id; END IF;
      RAISE EXCEPTION 'request-id-reused' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF (SELECT count(*) FROM public.invitations WHERE tenant_id = v_ctx.o_tenant AND status = 'pending' AND expires_at > now()) >= 100 THEN
    RAISE EXCEPTION 'invitation-limit' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.invitations SET status = 'cancelled', decided_by = 'expired', decided_at = now()
   WHERE tenant_id = v_ctx.o_tenant AND email_digest = p_email_digest AND status = 'pending' AND expires_at <= now();
  INSERT INTO public.invitations (tenant_id, email_digest, email_hint, roles, expires_at, created_by, creation_request_id, creation_request_hash)
  VALUES (v_ctx.o_tenant, p_email_digest, p_email_hint, ARRAY(SELECT x FROM unnest(p_roles) WITH ORDINALITY u (x, o) GROUP BY x ORDER BY min(o)), now() + interval '14 days', v_ctx.o_actor,
          p_request_id, p_request_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION invitation_create_keyed(bytea, text, text[], uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_create_keyed(bytea, text, text[], uuid, text) TO telesphoros_app;
