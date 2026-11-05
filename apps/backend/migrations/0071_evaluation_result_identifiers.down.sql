-- Refuse to drop identifiers that results already carry, including under the non-superuser migrator: they are inside the ledger hash. Repair forward.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE evaluation_results NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evaluation_results WHERE drug_rxcui IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to drop identifiers that stored results carry. Repair forward.';
  END IF;
END $$;
ALTER TABLE evaluation_results FORCE ROW LEVEL SECURITY;

ALTER TABLE evaluation_results
  DROP COLUMN cell_origin,
  DROP COLUMN pharmvar_versions,
  DROP COLUMN gene_hgnc_ids,
  DROP COLUMN drug_rxcui;
