# Phenoconversion notice: the N2 plan (spec 045)

Date: 2026-11-21

A draft plan, `specs/045-phenoconversion-notice/plan-slice-n2.md`, for the notice in the genomic profile. The profile response gains
optional `contextNotices` on each medication check and gene card, and an optional `modifierLists.loaded`. They are worked out when the
profile is read, from the patient's current, active medications and the loaded gene modifier lists (N1). Facts only, no sentences, and
nothing else in the response changes. Two decisions wait on the founders (N2-D1, the reverse direction; N2-D2, inducers). No code,
setting, knowledge file or clinical hold changes.
