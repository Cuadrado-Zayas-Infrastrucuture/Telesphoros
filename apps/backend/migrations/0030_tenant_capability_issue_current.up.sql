-- compat: expand
-- DATA-01 slice 3 PR A (specs/001-tenant-capability, plan: docs/design/plans/): the guard asks for the capability BEFORE it reads the membership.
--
--   * tenant_capability_issue_current reads the CURRENT active membership version itself and issues through the existing tenant_capability_issue, so the
--     caller no longer names a version. The old six-argument function stays, with the same grants: an image from before this migration keeps working.
--     The version it read is returned (and stamped on the capability), so the API can bind its commit-time check to the version the capability carries.
--   * app_capability_version() answers the version a presented capability was issued at, under exactly the rules app_tenant() and app_actor() apply
--     (a token that is unknown, expired, revoked, too long or bound to another organization than the setting names answers NULL). Nothing calls it yet:
--     it is the accessor membership_assert_current will need when slice 3 proper makes it compare against the capability (FR-007).
--
-- Additive only: two new functions, no policy touched, no existing function replaced, the binding mode untouched ('guc'). The one REVOKE below hands
-- back the schema CREATE privilege this file grants for its own duration, exactly as 0028 did.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked at its end)

SET LOCAL ROLE telesphoros_capability;

-- Reads the active membership's version, then asks tenant_capability_issue to mint at that version. That function re-checks the organization and the
-- membership (a version that moved between the two statements is refused as 'membership-not-current', so the race fails closed), counts the limits and
-- logs the attempt. A person with no active membership is passed as version 0, which no membership ever has: the refusal is then logged as
-- 'membership-not-current' (or 'tenant-inactive' for an organization that is not active) with membership_version 0 in the log row. Returns the version
-- on success and NULL on a refusal.
CREATE FUNCTION tenant_capability_issue_current(p_tenant text, p_sub text, p_purpose text, p_token_hash bytea, p_request_id text)
RETURNS TABLE (expires_at timestamptz, refusal text, membership_version bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_version bigint;
  v_expires timestamptz;
  v_refusal text;
BEGIN
  SELECT m.version INTO v_version FROM public.tenant_memberships m
   WHERE m.tenant_id = p_tenant AND m.sub = p_sub AND m.status = 'active';
  SELECT i.expires_at, i.refusal INTO v_expires, v_refusal
    FROM public.tenant_capability_issue(p_tenant, p_sub, coalesce(v_version, 0), p_purpose, p_token_hash, p_request_id) i;
  IF v_refusal IS NOT NULL THEN
    RETURN QUERY SELECT NULL::timestamptz, v_refusal, NULL::bigint;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_expires, NULL::text, v_version;
END
$$;
REVOKE ALL ON FUNCTION tenant_capability_issue_current(text, text, text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_capability_issue_current(text, text, text, bytea, text) TO telesphoros_issuer;

-- The version a presented capability carries. STABLE: evaluated once per statement, like app_tenant().
CREATE FUNCTION app_capability_version() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_token   text := nullif(current_setting('app.capability', true), '');
  v_setting text := nullif(current_setting('app.current_tenant_id', true), '');
  v_tenant  text;
  v_version bigint;
BEGIN
  IF v_token IS NULL OR length(v_token) > 128 THEN
    RETURN NULL;
  END IF;
  SELECT c.tenant_id, c.membership_version INTO v_tenant, v_version FROM public.tenant_capabilities c
   WHERE c.token_hash = sha256(convert_to(v_token, 'UTF8')) AND c.expires_at > statement_timestamp() AND c.revoked_at IS NULL;
  IF v_tenant IS NULL OR (v_setting IS NOT NULL AND v_setting <> v_tenant) THEN
    RETURN NULL;
  END IF;
  RETURN v_version;
END
$$;
REVOKE ALL ON FUNCTION app_capability_version() FROM PUBLIC;
-- The roles whose policies or definer functions bind through app_tenant() / app_actor() (0028): the same set, and no one else.
GRANT EXECUTE ON FUNCTION app_capability_version() TO telesphoros_app, telesphoros_worker, telesphoros_ledger, telesphoros_redactor, telesphoros_jobs;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;
