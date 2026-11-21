# Spec 044: the patient's genomic profile and a medication check (specification only)

Date: 2026-11-21

A draft specification, [spec 044](../../specs/044-genomic-profile-medication-check/spec.md), puts the patient's genomic profile and a
medication check first, following the founder's direction to reduce trial-and-error prescribing for prescribers and pharmacists. It takes
over the draft spec 031: each current medication is matched to a stored result by RxCUI only and gets one of five words (Review, Held, No
recommendation, No guideline loaded, Guidelines changed), never "safe"; a drug can be checked before it is prescribed; everything is read
from stored evaluations through one proposed read-only route. It records that both co-founders are pharmacists, so the two-signer rule for
knowledge content can be met, and plans the first real CPIC content as a parallel slice. The direction plan carries a dated amendment (N1,
the slice order, and a correction about spec 041 slice C). No code, migration, knowledge file or clinical hold changes.
