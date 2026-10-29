SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- The nonces are short-lived replay markers, not records: the issuance log (0028) keeps what was issued. Dropping them only reopens, for at most the
-- 120 s a signed request stays acceptable, the replay this table closes; a rollback that also removes the job route (0056 and the code) closes it again.
SET LOCAL ROLE telesphoros_capability;
DROP FUNCTION issuer_nonce_claim(text, text);
DROP TABLE issuer_request_nonces;
RESET ROLE;
