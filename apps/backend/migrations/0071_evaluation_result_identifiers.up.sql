-- compat: breaking
-- Spec 033 K2-7: standard identifiers of the knowledge cell a result came from, copied by the engine from schema 1.3 knowledge. Every existing row
-- keeps NULL in all four columns and its meaning. Adding CHECK constraints to an existing table is not an `expand` change (docs/database.md), hence the
-- label, even though no older write sets these columns. Nothing here inserts a row.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE evaluation_results
  ADD COLUMN drug_rxcui text,
  ADD COLUMN gene_hgnc_ids text[],
  ADD COLUMN pharmvar_versions text[],
  ADD COLUMN cell_origin text,
  -- All four or none: a result from schema 1.2 knowledge carries none.
  ADD CONSTRAINT evaluation_results_identifiers_all_or_none CHECK (
    (drug_rxcui IS NULL) = (gene_hgnc_ids IS NULL) AND (drug_rxcui IS NULL) = (pharmvar_versions IS NULL) AND (drug_rxcui IS NULL) = (cell_origin IS NULL)),
  -- Identifiers name a cell, so they exist only beside a citation.
  ADD CONSTRAINT evaluation_results_identifiers_need_citation CHECK (drug_rxcui IS NULL OR citation IS NOT NULL),
  -- The real form, or the invented "syn-" form synthetic knowledge must use (the schema decides which a file may use).
  ADD CONSTRAINT evaluation_results_drug_rxcui CHECK (drug_rxcui IS NULL OR drug_rxcui ~ '^([1-9][0-9]{0,15}|syn-rxcui-[a-z0-9][a-z0-9-]{0,39})$'),
  -- One HGNC id per gene, in the order of `genes`, none missing.
  ADD CONSTRAINT evaluation_results_gene_hgnc_ids CHECK (gene_hgnc_ids IS NULL OR (
    cardinality(gene_hgnc_ids) = cardinality(genes) AND cardinality(genes) > 0 AND array_position(gene_hgnc_ids, NULL) IS NULL
    AND array_to_string(gene_hgnc_ids, ',') ~ '^(HGNC:[1-9][0-9]{0,6}|syn-hgnc-[a-z0-9][a-z0-9-]{0,39})(,(HGNC:[1-9][0-9]{0,6}|syn-hgnc-[a-z0-9][a-z0-9-]{0,39}))*$')),
  -- One PharmVar release per gene, in the order of `genes`; NULL for a gene reported as a phenotype only.
  ADD CONSTRAINT evaluation_results_pharmvar_versions CHECK (pharmvar_versions IS NULL OR (
    cardinality(pharmvar_versions) = cardinality(genes)
    AND array_to_string(pharmvar_versions, ',') ~ '^(([0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?|syn-pharmvar-[a-z0-9][a-z0-9.-]{0,39})(,([0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?|syn-pharmvar-[a-z0-9][a-z0-9.-]{0,39}))*)?$')),
  ADD CONSTRAINT evaluation_results_cell_origin CHECK (cell_origin IS NULL OR cell_origin IN ('cpic', 'pharmgkb', 'pharmvar', 'unknown'));
