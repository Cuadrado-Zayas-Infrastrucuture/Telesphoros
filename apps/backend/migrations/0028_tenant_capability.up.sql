-- compat: expand
-- DATA-01 slice 1 (specs/001-tenant-capability): the tenant capability, inert. Nothing reads it yet: every policy still binds on the
-- app.current_tenant_id setting, so this migration changes no request's behaviour.
--
--   * A capability is a 256-bit random token minted by the session issuer after it has verified the person's Cognito access token. The database
--     keeps only sha256(token), with the organization, the person, the membership version, a purpose, and issue and expiry times it stamps itself.
--   * Only the issuer login (a member of NOLOGIN telesphoros_issuer) can mint, through tenant_capability_issue, which re-checks the membership and
--     the organization and logs every attempt. No other login holds any privilege on the capability tables.
--   * app_tenant() / app_actor() turn the token in the transaction-local setting app.capability into an organization and a person. In the 'guc'
--     and 'dual' modes they fall back to the old settings when no token is set; in 'capability' mode they do not. The mode is a row only a
--     migration changes (tenant_binding_mode), never a setting, because the application login can set any setting.
--   * Rate limits per purpose are counted, not enforced (capability_purposes.enforce_limits is false): the numbers are provisional until they are
--     measured on synthetic staging (decision D3).
--   * The membership is read without a row lock: FOR SHARE would need UPDATE on tenant_memberships, which the issuer's definer must not have. A
--     removal that commits during an issue can leave one capability usable for reads until it expires (60 s); writes are still refused at commit by
--     membership_assert_current.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_capability') THEN
    CREATE ROLE telesphoros_capability NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_issuer') THEN
    CREATE ROLE telesphoros_issuer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- The migrator acts as the owner role to create its objects (a one-time membership). A superuser already can.
  IF NOT pg_has_role(current_user, 'telesphoros_capability', 'SET') THEN
    EXECUTE format('GRANT telesphoros_capability TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO telesphoros_capability, telesphoros_issuer;
GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked at its end)
-- The definer reads every organization and membership to decide whether to issue, and nothing else.
GRANT SELECT ON tenants, tenant_memberships TO telesphoros_capability;
GRANT REFERENCES ON tenants TO telesphoros_capability;
CREATE POLICY tenants_capability ON tenants FOR SELECT TO telesphoros_capability USING (true);
CREATE POLICY tenant_memberships_capability ON tenant_memberships FOR SELECT TO telesphoros_capability USING (true);

SET LOCAL ROLE telesphoros_capability;

-- One row per purpose: how long a capability lives and the limits counted per person. 'request' is the per-request capability of DATA-01;
-- P2 adds its own purposes as rows.
CREATE TABLE capability_purposes (
  purpose           text    PRIMARY KEY,
  lifetime_seconds  integer NOT NULL,
  burst_limit       integer NOT NULL,
  burst_seconds     integer NOT NULL,
  sustained_limit   integer NOT NULL,
  sustained_seconds integer NOT NULL,
  enforce_limits    boolean NOT NULL DEFAULT false,
  CONSTRAINT capability_purposes_name CHECK (purpose ~ '^[a-z][a-z0-9-]{0,31}$'),
  CONSTRAINT capability_purposes_lifetime CHECK (lifetime_seconds BETWEEN 1 AND 60),
  CONSTRAINT capability_purposes_limits CHECK (burst_limit >= 1 AND burst_seconds >= 1 AND sustained_limit >= burst_limit AND sustained_seconds >= burst_seconds)
);
-- Decision D1: 60 s. The limits are provisional and only counted (decision D3).
INSERT INTO capability_purposes (purpose, lifetime_seconds, burst_limit, burst_seconds, sustained_limit, sustained_seconds)
VALUES ('request', 60, 120, 60, 3000, 3600);

CREATE TABLE tenant_capabilities (
  token_hash         bytea       PRIMARY KEY,
  tenant_id          text        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  sub                text        NOT NULL,
  membership_version bigint      NOT NULL,
  purpose            text        NOT NULL REFERENCES capability_purposes (purpose) ON DELETE RESTRICT,
  request_id         text,
  issued_at          timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  CONSTRAINT tenant_capabilities_hash_len CHECK (length(token_hash) = 32),
  CONSTRAINT tenant_capabilities_sub_len CHECK (length(sub) BETWEEN 1 AND 128),
  CONSTRAINT tenant_capabilities_request_len CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT tenant_capabilities_window CHECK (expires_at > issued_at)
);
CREATE INDEX tenant_capabilities_expiry_idx ON tenant_capabilities (expires_at);
ALTER TABLE tenant_capabilities ENABLE ROW LEVEL SECURITY; -- no policy: nobody but the owner sees a row, even if a grant is added by mistake

-- Every attempt to issue, granted or refused. Never the token or its hash. Append-only.
CREATE TABLE capability_issuance_log (
  seq                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at        timestamptz NOT NULL,
  tenant_id          text,
  sub                text,
  purpose            text,
  membership_version bigint,
  request_id         text,
  outcome            text        NOT NULL,
  reason             text,
  over_limit         boolean     NOT NULL DEFAULT false,
  CONSTRAINT capability_issuance_outcome CHECK (outcome IN ('issued', 'refused')),
  CONSTRAINT capability_issuance_reason CHECK ((outcome = 'issued') = (reason IS NULL)
    AND (reason IS NULL OR reason IN ('malformed', 'unknown-purpose', 'tenant-inactive', 'membership-not-current', 'rate-limited'))),
  CONSTRAINT capability_issuance_lengths CHECK (length(tenant_id) <= 128 AND length(sub) <= 128 AND length(purpose) <= 64 AND length(request_id) <= 128)
);
CREATE INDEX capability_issuance_rate_idx ON capability_issuance_log (sub, purpose, occurred_at) WHERE outcome = 'issued';
CREATE INDEX capability_issuance_request_idx ON capability_issuance_log (request_id);
CREATE TRIGGER capability_issuance_append_only BEFORE UPDATE OR DELETE ON capability_issuance_log FOR EACH ROW EXECUTE FUNCTION public.refuse_mutation();
-- No statement-level guard against emptying the whole table here: the compat lint reads that trigger's event name as the statement itself. Only the
-- NOLOGIN owner holds that privilege on this table; a guard can be added in a migration labelled breaking if wanted.
ALTER TABLE capability_issuance_log ENABLE ROW LEVEL SECURITY;

-- guc: today. dual: capabilities bind, the settings still work without one. capability: only a capability binds. One row; only a migration moves it.
CREATE TABLE tenant_binding_mode (
  singleton boolean PRIMARY KEY DEFAULT true,
  mode      text    NOT NULL,
  CONSTRAINT tenant_binding_mode_one_row CHECK (singleton),
  CONSTRAINT tenant_binding_mode_value CHECK (mode IN ('guc', 'dual', 'capability'))
);
INSERT INTO tenant_binding_mode (mode) VALUES ('guc');
ALTER TABLE tenant_binding_mode ENABLE ROW LEVEL SECURITY;

-- The issuer's only way in. It has already verified the access token; this re-checks the organization and the membership version it read, counts the
-- limits, logs the attempt and mints. A refusal is returned (and logged), not raised, so the log row survives.
CREATE FUNCTION tenant_capability_issue(p_tenant text, p_sub text, p_membership_version bigint, p_purpose text, p_token_hash bytea, p_request_id text)
RETURNS TABLE (expires_at timestamptz, refusal text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_purpose public.capability_purposes%ROWTYPE;
  v_reason  text;
  v_burst   integer := 0;
  v_window  integer := 0;
  v_over    boolean := false;
BEGIN
  IF p_tenant IS NULL OR p_sub IS NULL OR p_membership_version IS NULL OR p_purpose IS NULL OR p_token_hash IS NULL
     OR length(p_token_hash) <> 32 OR length(p_tenant) NOT BETWEEN 1 AND 128 OR length(p_sub) NOT BETWEEN 1 AND 128 OR length(p_purpose) > 64
     OR (p_request_id IS NOT NULL AND length(p_request_id) NOT BETWEEN 1 AND 128) THEN
    v_reason := 'malformed';
  ELSE
    SELECT * INTO v_purpose FROM public.capability_purposes p WHERE p.purpose = p_purpose;
    IF NOT FOUND THEN
      v_reason := 'unknown-purpose';
    ELSIF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant AND t.status = 'active') THEN
      v_reason := 'tenant-inactive';
    ELSIF NOT EXISTS (SELECT 1 FROM public.tenant_memberships m
                       WHERE m.tenant_id = p_tenant AND m.sub = p_sub AND m.status = 'active' AND m.version = p_membership_version) THEN
      v_reason := 'membership-not-current';
    ELSE
      SELECT count(*) FILTER (WHERE l.occurred_at > v_now - make_interval(secs => v_purpose.burst_seconds)), count(*)
        INTO v_burst, v_window
        FROM public.capability_issuance_log l
       WHERE l.sub = p_sub AND l.purpose = p_purpose AND l.outcome = 'issued' AND l.occurred_at > v_now - make_interval(secs => v_purpose.sustained_seconds);
      v_over := v_burst >= v_purpose.burst_limit OR v_window >= v_purpose.sustained_limit;
      IF v_over AND v_purpose.enforce_limits THEN
        v_reason := 'rate-limited';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.capability_issuance_log (occurred_at, tenant_id, sub, purpose, membership_version, request_id, outcome, reason, over_limit)
  VALUES (v_now, left(p_tenant, 128), left(p_sub, 128), left(p_purpose, 64), p_membership_version, left(p_request_id, 128),
          CASE WHEN v_reason IS NULL THEN 'issued' ELSE 'refused' END, v_reason, v_over);
  IF v_reason IS NOT NULL THEN
    RETURN QUERY SELECT NULL::timestamptz, v_reason;
    RETURN;
  END IF;

  INSERT INTO public.tenant_capabilities (token_hash, tenant_id, sub, membership_version, purpose, request_id, issued_at, expires_at)
  VALUES (p_token_hash, p_tenant, p_sub, p_membership_version, p_purpose, p_request_id, v_now, v_now + make_interval(secs => v_purpose.lifetime_seconds));
  RETURN QUERY SELECT v_now + make_interval(secs => v_purpose.lifetime_seconds), NULL::text;
END
$$;
REVOKE ALL ON FUNCTION tenant_capability_issue(text, text, bigint, text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_capability_issue(text, text, bigint, text, bytea, text) TO telesphoros_issuer;

-- The one place a request's binding becomes an organization. A token that is unknown, expired, revoked, too long, or bound to another organization than
-- the setting names resolves to NULL; without a token the old setting is used only in the guc and dual modes. STABLE: evaluated once per statement when a
-- policy calls it as (SELECT app_tenant()).
CREATE FUNCTION app_tenant() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_token   text := nullif(current_setting('app.capability', true), '');
  v_setting text := nullif(current_setting('app.current_tenant_id', true), '');
  v_tenant  text;
BEGIN
  IF v_token IS NULL THEN
    IF (SELECT b.mode FROM public.tenant_binding_mode b) IN ('guc', 'dual') THEN
      RETURN v_setting;
    END IF;
    RETURN NULL;
  END IF;
  IF length(v_token) > 128 THEN
    RETURN NULL;
  END IF;
  SELECT c.tenant_id INTO v_tenant FROM public.tenant_capabilities c
   WHERE c.token_hash = sha256(convert_to(v_token, 'UTF8')) AND c.expires_at > statement_timestamp() AND c.revoked_at IS NULL;
  IF v_tenant IS NULL OR (v_setting IS NOT NULL AND v_setting <> v_tenant) THEN
    RETURN NULL;
  END IF;
  RETURN v_tenant;
END
$$;

-- The person, under the same rules, except that the actor setting is ignored when a token is present: the capability says who it is.
CREATE FUNCTION app_actor() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_token   text := nullif(current_setting('app.capability', true), '');
  v_setting text := nullif(current_setting('app.current_tenant_id', true), '');
  v_tenant  text;
  v_sub     text;
BEGIN
  IF v_token IS NULL THEN
    IF (SELECT b.mode FROM public.tenant_binding_mode b) IN ('guc', 'dual') THEN
      RETURN nullif(current_setting('app.current_actor', true), '');
    END IF;
    RETURN NULL;
  END IF;
  IF length(v_token) > 128 THEN
    RETURN NULL;
  END IF;
  SELECT c.tenant_id, c.sub INTO v_tenant, v_sub FROM public.tenant_capabilities c
   WHERE c.token_hash = sha256(convert_to(v_token, 'UTF8')) AND c.expires_at > statement_timestamp() AND c.revoked_at IS NULL;
  IF v_tenant IS NULL OR (v_setting IS NOT NULL AND v_setting <> v_tenant) THEN
    RETURN NULL;
  END IF;
  RETURN v_sub;
END
$$;
REVOKE ALL ON FUNCTION app_tenant() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor() FROM PUBLIC;
-- Every role whose policies or definer functions will bind through it (slice 3).
GRANT EXECUTE ON FUNCTION app_tenant(), app_actor() TO telesphoros_app, telesphoros_worker, telesphoros_ledger, telesphoros_redactor, telesphoros_jobs;

-- Removes capabilities that expired more than five minutes ago, at most p_limit per call. The scheduled job that calls it is wired in slice 2,
-- when capabilities are first minted outside tests.
CREATE FUNCTION tenant_capabilities_sweep(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_removed integer;
BEGIN
  WITH old AS (
    SELECT c.token_hash FROM public.tenant_capabilities c
     WHERE c.expires_at < clock_timestamp() - interval '5 minutes'
     ORDER BY c.expires_at LIMIT greatest(coalesce(p_limit, 0), 0)
  )
  DELETE FROM public.tenant_capabilities c USING old WHERE c.token_hash = old.token_hash;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END
$$;
REVOKE ALL ON FUNCTION tenant_capabilities_sweep(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_capabilities_sweep(integer) TO telesphoros_jobs;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;
