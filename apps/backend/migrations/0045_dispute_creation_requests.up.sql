-- compat: breaking
-- Raising a dispute could not be retried. A repeat of a raise that had been made made a second dispute for the same cell, and a dispute in force holds the evaluations that rely on
-- its cell, so after the first was dismissed the duplicate kept the cell disputed until someone also decided it. Same cure as the report create (0014), the patient create (0039),
-- the identifier registration (0040) and the invitation (0041): an optional retry identity per reviewer, with a fingerprint of the original request (the guideline, the cell and the
-- note). Legacy rows are unkeyed and nothing is rewritten. The table is append-only already (a trigger refuses every update), so the identity cannot change and no guard trigger
-- is added. The ledger's projection of a dispute names its columns, so neither new column reaches an event hash.
-- A CHECK and a UNIQUE constraint on an existing table make this migration `breaking` under the lint: a release that includes it is a breaking release.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE cell_disputes
  ADD COLUMN creation_request_id uuid,
  ADD COLUMN creation_request_hash text,
  ADD CONSTRAINT cell_disputes_creation_request_pair CHECK (
    (creation_request_id IS NULL AND creation_request_hash IS NULL)
    OR (creation_request_id IS NOT NULL AND creation_request_hash IS NOT NULL
        AND creation_request_hash ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT cell_disputes_creation_request_uq UNIQUE (tenant_id, created_by, creation_request_id);
