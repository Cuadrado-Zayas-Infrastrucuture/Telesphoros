-- Restores the 0008 constraints verbatim. Refuses while any stored result carries `knowledge-gap`, including under the non-superuser migrator: the
-- result is inside the ledger hash and rewriting it is not a revert. Repair forward.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE evaluation_results NO FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_gene_states NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evaluation_results WHERE reason_code = 'knowledge-gap') OR EXISTS (SELECT 1 FROM evaluation_gene_states WHERE reason_code = 'knowledge-gap') THEN
    RAISE EXCEPTION 'Refusing to revert: stored results carry knowledge-gap. Repair forward.';
  END IF;
END $$;
ALTER TABLE evaluation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_gene_states FORCE ROW LEVEL SECURITY;

ALTER TABLE evaluation_results
  DROP CONSTRAINT evaluation_results_reason,
  DROP CONSTRAINT evaluation_results_shape;
ALTER TABLE evaluation_results
  ADD CONSTRAINT evaluation_results_reason CHECK (reason_code IS NULL OR reason_code IN (
    'duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope', 'cell-disputed',
    'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition',
    'association-abstained', 'no-published-recommendation', 'no-guideline-for-drug')),
  ADD CONSTRAINT evaluation_results_shape CHECK (CASE outcome
    WHEN 'shown' THEN reason_code IS NULL AND strength IN ('Strong', 'Moderate', 'Optional') AND citation IS NOT NULL AND recommendation_text IS NOT NULL
    WHEN 'no-published-recommendation' THEN reason_code = 'no-published-recommendation' AND (
         (citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL)
      OR (citation IS NOT NULL AND strength = 'No recommendation' AND recommendation_text IS NOT NULL))
    WHEN 'held' THEN reason_code IN ('duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope',
                                     'cell-disputed', 'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition')
                     AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL
    WHEN 'abstained' THEN reason_code = 'association-abstained' AND citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL
    WHEN 'no-guideline' THEN reason_code = 'no-guideline-for-drug' AND citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL AND cardinality(genes) = 0
    ELSE false END);

ALTER TABLE evaluation_gene_states DROP CONSTRAINT evaluation_gene_states_reason;
ALTER TABLE evaluation_gene_states
  ADD CONSTRAINT evaluation_gene_states_reason CHECK (reason_code IS NULL OR reason_code IN (
    'duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope', 'cell-disputed',
    'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition',
    'association-abstained', 'no-published-recommendation', 'no-guideline-for-drug'));
