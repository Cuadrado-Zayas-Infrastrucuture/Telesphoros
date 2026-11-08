-- compat: breaking
-- Audit DATA-01: a combination with no guideline cell is held as `knowledge-gap` instead of being stored as `no-published-recommendation`, which a
-- reader took for "the guideline publishes no recommendation". The code joins the reason lists (they mirror REASON_CODES) and the `held` branch of
-- the result shape. The `no-published-recommendation` branch keeps accepting the citation-less form, so every result stored before keeps its meaning;
-- nothing is rewritten. Re-adding CHECK constraints to existing tables is not an `expand` change (docs/database.md), hence the label.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE evaluation_results
  DROP CONSTRAINT evaluation_results_reason,
  DROP CONSTRAINT evaluation_results_shape;
ALTER TABLE evaluation_results
  ADD CONSTRAINT evaluation_results_reason CHECK (reason_code IS NULL OR reason_code IN (
    'duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope', 'cell-disputed',
    'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition', 'knowledge-gap',
    'association-abstained', 'no-published-recommendation', 'no-guideline-for-drug')),
  ADD CONSTRAINT evaluation_results_shape CHECK (CASE outcome
    WHEN 'shown' THEN reason_code IS NULL AND strength IN ('Strong', 'Moderate', 'Optional') AND citation IS NOT NULL AND recommendation_text IS NOT NULL
    WHEN 'no-published-recommendation' THEN reason_code = 'no-published-recommendation' AND (
         (citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL)
      OR (citation IS NOT NULL AND strength = 'No recommendation' AND recommendation_text IS NOT NULL))
    WHEN 'held' THEN reason_code IN ('duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope',
                                     'cell-disputed', 'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition',
                                     'knowledge-gap')
                     AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL
    WHEN 'abstained' THEN reason_code = 'association-abstained' AND citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL
    WHEN 'no-guideline' THEN reason_code = 'no-guideline-for-drug' AND citation IS NULL AND strength IS NULL AND recommendation_text IS NULL AND implication IS NULL AND cardinality(genes) = 0
    ELSE false END);

ALTER TABLE evaluation_gene_states DROP CONSTRAINT evaluation_gene_states_reason;
ALTER TABLE evaluation_gene_states
  ADD CONSTRAINT evaluation_gene_states_reason CHECK (reason_code IS NULL OR reason_code IN (
    'duplicate-gene-conflict', 'duplicate-identical', 'sentinel-literal-in-source', 'other-gene-unresolved', 'out-of-review-scope', 'cell-disputed',
    'gene-absent', 'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition', 'knowledge-gap',
    'association-abstained', 'no-published-recommendation', 'no-guideline-for-drug'));
