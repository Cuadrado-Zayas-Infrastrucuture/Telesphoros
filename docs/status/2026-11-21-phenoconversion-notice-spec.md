# Spec 045: a notice when a current medication may change a gene's effect (phenoconversion, step 1; specification only)

Date: 2026-11-21

A draft specification, [spec 045](../../specs/045-phenoconversion-notice/spec.md), carries out step 1 of spec 006's deferred item D08:
when a medication's guidance rests on a gene and another current medication is a listed strong or moderate inhibitor or inducer of that
gene's protein, the genomic profile says so, with its source. It never computes an adjusted phenotype, changes the recommendation shown, or
reads the absence of a notice as "no interaction". The list is new signed knowledge (a gene modifier list) built from the FDA's table of
substrates, inhibitors and inducers, SLCO1B1 and CYP2C19 first; its reuse terms are a founder decision. No code, knowledge file or clinical
hold changes.
