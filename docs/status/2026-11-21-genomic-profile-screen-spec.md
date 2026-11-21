# Spec 044 slice B: the genomic profile screen, in three layers (specification only)

Date: 2026-11-21

The plan for the screen that shows a patient's genomic profile and checks their medications, written for prescribers and pharmacists who
are not PGx specialists: `specs/044-genomic-profile-medication-check/plan-slice-b.md`, with a mock-up of four screens on a synthetic
patient. Each medication leads with its name and one word, then CPIC's recommendation quoted exactly; the reason (CPIC's implication text)
and the evidence open on demand; a signed glossary explains each term; every state carries a fixed sentence, and "No guideline loaded" always
says it does not mean safe. The founder approved decisions B-D1 to B-D4 on 2026-11-21: medications first, a sentence for combination
products, no `drugRxcui` on the evaluation DTO, and the glossary as signed content shared with the help assistant. The wording (G3) is still
open. No code, route or setting changes.
