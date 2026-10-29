-- compat: expand
-- Spec 012 slice 2 (specs/012-worker-capability, founder 2026-10-29): a signed worker request is accepted once, across every issuer task.
--
--   * issuer_request_nonces holds the nonce of every signed request an issuer task accepted, with the caller and the time it was first seen. Production
--     runs at least two issuer tasks behind the load balancer, so a nonce kept in one task's memory would not stop a copy sent to another; the database
--     is the one place every task shares.
--   * issuer_nonce_claim(caller, nonce) is the issuer's only way in: true the first time, false for a copy. Two tasks claiming the same nonce at once
--     meet on the primary key, and the second answers false once the first commits. A malformed caller or nonce is false, never an error.
--   * A request's timestamp is accepted within 60 s of the issuer's clock either way (worker-signature.ts), so a nonce can be replayed for at most
--     120 s after it was first seen. Each claim forgets nonces older than 10 minutes, well past that.
--   * Owned by the NOLOGIN capability owner, as the other capability tables are (0028); row-level security is on with no policy, and no login holds a
--     table privilege.
-- Additive only: one table and one function. No existing table, policy or function changes.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_capability;

CREATE TABLE issuer_request_nonces (
  caller  text        NOT NULL,
  nonce   text        NOT NULL,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (caller, nonce),
  CONSTRAINT issuer_request_nonces_caller CHECK (caller ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT issuer_request_nonces_nonce CHECK (nonce ~ '^[A-Za-z0-9_-]{22,64}$')
);
CREATE INDEX issuer_request_nonces_seen_idx ON issuer_request_nonces (seen_at);
ALTER TABLE issuer_request_nonces ENABLE ROW LEVEL SECURITY; -- no policy: nobody but the owner sees a row

CREATE FUNCTION issuer_nonce_claim(p_caller text, p_nonce text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_caller IS NULL OR p_nonce IS NULL OR p_caller !~ '^[a-z][a-z0-9-]{0,63}$' OR p_nonce !~ '^[A-Za-z0-9_-]{22,64}$' THEN
    RETURN false;
  END IF;
  DELETE FROM public.issuer_request_nonces WHERE seen_at < v_now - interval '10 minutes';
  INSERT INTO public.issuer_request_nonces (caller, nonce, seen_at) VALUES (p_caller, p_nonce, v_now) ON CONFLICT DO NOTHING;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION issuer_nonce_claim(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issuer_nonce_claim(text, text) TO telesphoros_issuer;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;
