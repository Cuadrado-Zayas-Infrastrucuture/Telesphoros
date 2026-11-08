# A combination with no guideline cell is held as a knowledge gap

Date: 2026-11-08

A combination of phenotypes that the guideline file has no cell for used to be stored as `no-published-recommendation`, the same outcome as a verified "No recommendation" cell, so a reader took a missing entry for a published one. It is now held with the reason code `knowledge-gap`, with no citation and no wording, and a replaced single-gene table is not used as a fallback. A verified "No recommendation" cell keeps its outcome.

Under the production rules the loader refuses a guideline unless every combination of its genes' phenotypes is a cell or is signed under `notCovered` (schema 1.3). A combination signed as not covered is still held when it occurs.

Migration 0074 (`compat: breaking`, because it re-adds CHECK constraints) adds the code to the result checks. No stored result is rewritten. The down migration refuses while a `knowledge-gap` result exists.

Not done: the rule has only run on test files, since `knowledge/cpic` holds no reviewed guideline yet, and 0074 is not applied to staging.
