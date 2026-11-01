# Feature Specification: Patient medications, data capture only (MD)

**Feature Branch**: `docs/spec-029-patient-medications` (this spec); build branches follow its slices.

**Created**: 2026-10-31

**Status**: D1 to D10 approved as written (founder, "do all", 2026-11-01). Nothing is built until the slices in `tasks.md` are started; the licence items under Open questions block MD-a.

**Founder's direction (2026-10-31):** a patient page that includes medications makes sense for a PGx product. It is a separate spec from the demographics form (spec 025 PD-c). The agreed order: capture first, as its own spec; drug–gene flags later, under the clinical hold.

**Input**: the patient page (`/patients/:id`, spec 025 T303) shows demographics only, in sections so another can sit beside them. Nothing in the product records what a patient takes.

## What exists today (read at `main` `0c392de2`)

- **No medication data:** no table, route, shared type or screen. The only mentions of medications are in the landing copy and a synthetic interpretation demo (`apps/frontend/src/lib/interpretationDemo.ts`).
- **Drugs in knowledge files** are lower-case names (`drugNameSchema`, `packages/cpic-schema/src/knowledge.ts:35`), with no RxNorm id. The data-model plan maps CPIC's `drug` table, keyed like `RxNorm:2670`, to a future `drug` entity with "RxNorm id plus name" (`docs/design/plans/pgx-data-model-and-data-products.md`, R14 and §3). Adding RxNorm ids to knowledge files (K2) is scheduled with the first signed CPIC guideline.
- **Patterns to reuse:**
  - spec 025's versioned, ledgered, append-only records with corrections;
  - FORCE RLS;
  - coded columns with CHECKed vocabularies;
  - spec 020's `data_provenance` and `use_eligibility` for any later analytic use;
  - the clinical read and writer roles.
- **Inbound FHIR is deferred:** lab PDF is the only evaluated input format (founder, 2026-10-27).

## Decisions (for the founder)

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | **Scope** | **Capture and display only.** The list never changes a report, an evaluation or a recommendation, and shows no drug–gene flag. | A flag that says "this drug and this phenotype interact" is clinical decision support. It falls under the clinical hold, needs validation and signed CPIC content, and gets its own spec. A list is data. |
| D2 | **How a drug is identified** | **RxNorm, at the ingredient level** (TTY `IN`, or `MIN` for combinations): the RxCUI plus its name as stored with it. No free-text drug names. | CPIC keys drugs by RxNorm ingredient, so a later flag can match without guessing names. Free text cannot be matched or counted. |
| D3 | **Where the picker's drugs come from** | **A bundled, versioned list in the repository, starting with the CPIC drugs** (CC0), each with its RxCUI and RxNorm release, read at build time. No live call to RxNav or any outside service. | A live search would send what a clinician types to a third party, and the list would change under us. Starting with CPIC drugs covers every drug a PGx flag could ever name. A drug outside the list waits for a list update. |
| D4 | **Fields per entry** | Drug (D2); status (`active` or `stopped`); start and stop as **year-month**, optional; source (`clinician-entered` or `patient-reported`). **No dose, route, frequency or free-text note** in this version. | Year-month is enough for exposure analytics and leaks less than a day. Dose matters for some PGx drugs (warfarin), but it belongs with dosing logic under the hold. A free-text note is where PHI leaks. |
| D5 | **Versioning** | **Append-only and ledgered, like spec 025:** adding, stopping or correcting an entry adds a version, earlier versions stay readable, and the ledger verifies across them. | One audit model across clinical records. |
| D6 | **Protection** | **Coded, plain under FORCE RLS, not field-encrypted.** A drug list is PHI but not a direct identifier. It follows the same rules as ethnicity: never in logs, errors or security events. | Encryption is kept for direct identifiers (spec 025 D2). Analytics needs the codes, and spec 020 gates every analytic use. |
| D7 | **Who** | Clinicians add and change entries. Clinical read roles (reader, reviewer, clinician) read them. Administrators and members with no role see nothing. | Same as demographics (PD-6). |
| D8 | **Import** | **Entered by hand only.** Import from an EHR (FHIR `MedicationStatement`) is a later decision, alongside the inbound-FHIR question. | Inbound FHIR is deferred. Hand entry first shows what the record must hold. |
| D9 | **Analytics** | A medication entry becomes a fact kind that spec 020's `use_eligibility` can answer for. Nothing is released until spec 020 E3 and D07. | Collection for care is not permission for analytics, as with demographics. |
| D10 | **Look-alike, sound-alike (LASA) names (founder, 2026-10-31: "use tall man lettering for LASA drugs")** | **Tall Man lettering on every displayed drug name that is on the FDA or ISMP Tall Man list** (for example hydrOXYzine and hydrALAZINE). Each entry in the bundled list (D3) carries a `displayName` taken from those lists, with the list and its date, next to its canonical name. Tall Man is display only: the record keeps the RxCUI and the canonical name, the picker's search ignores case, and screen readers get the plain name (`aria-label`), because mixed capitals can be spelled out letter by letter. The rule applies wherever the product shows a drug name, including knowledge-file names a later recommendation would show. | Tall Man is the standard safeguard against picking the wrong one of two similar names, and a picker is exactly where that error happens. Keeping it display only means matching, counting and the ledger never depend on letter case. |

## Out of scope

- Drug–gene flags, alerts or any text that interprets a drug against a result (D1; a later spec under the clinical hold).
- Dose, route, frequency, indication and prescriber (D4).
- Import from an EHR, pharmacy claims or e-prescribing (D8).
- Real patient data: staging stays synthetic; the BAA and counsel come first.

## Requirements

- **MD-1** Each entry names one drug by an RxNorm ingredient RxCUI from the bundled list, with that list's version recorded on the entry.
- **MD-2** The list is a versioned file in the repository, and a test fails if an entry has no RxCUI, a duplicate RxCUI, or no RxNorm release.
- **MD-3** Status is `active` or `stopped`; start and stop are optional year-months, and stop is not before start.
- **MD-4** Every change adds a version; earlier versions stay readable to clinical read roles; the ledger verifies across versions.
- **MD-5** A test seeds a recognizable synthetic entry and finds it in no log line, error body or security event.
- **MD-6** No route, screen or job outputs anything that combines a medication with a genotype or phenotype (a test asserts the medication module is not imported by the engine, the interpreter or the verifier).
- **MD-8** Every displayed drug name on the FDA or ISMP Tall Man list renders in its Tall Man form, through one shared function, with the plain name as its accessible name. A test fails if a list entry with a Tall Man form renders without it, if search misses a name typed in lower case, or if a stored record holds the Tall Man form instead of the canonical name.
- **MD-7** The patient page shows a Medications section: active entries first, then stopped ones, each with its source and dates; clinicians can add, stop or correct.

## Open questions

- **List maintenance:** who updates the bundled list when CPIC adds a drug, and how often.
- **Drugs outside CPIC:** does the first version need them? If yes, D3 needs a larger RxNorm subset. **Read at source 2026-11-01:** NLM's RxNorm terms say RxCUIs and normalized names are public domain and may be freely distributed, ask for an attribution statement (the data is public, NLM does not endorse the product, no NLM name or logo) and say a redistributor keeps the data current or states that it may not. The full RxNorm release needs a free UMLS licence and includes source vocabularies that carry their own terms (UMLS licence section 12). The bundled list uses only RxCUIs and RxNorm's own names, so the list stays inside the public-domain part; a test fails if a name is not an RxNorm-normalized name. **CPIC confirmed:** the founder-held staff reply dated 2026-08-31 confirms CC0 1.0 for CPIC API content, including the drug endpoint, without ShareAlike or a non-commercial restriction. The private screenshot was inspected during MD-a and stays outside the repository. Public reference: [CPIC licensing](https://cpicpgx.org/licensing/); that page could not be independently fetched in this cloud session. [Release v1.61.0](https://github.com/cpicpgx/cpic-data/releases/tag/v1.61.0), read 2026-11-01, links the full database dump. The generator may instead use an honestly dated API snapshot with its associated release recorded. Source retrieval remains a separate gate; no codes are guessed.
- **Dose:** whether a later version captures it for the warfarin-type cases, and under which hold.
- **Tall Man sources, read at source 2026-11-01:** the FDA's name-differentiation page lists the names but states no copyright or reuse terms (current as of 2026-06-12), and does not say whether its list matches ISMP's. The ISMP list is now served by ECRI (the old ISMP address redirects there); a search snippet shows "©2023 ISMP. All Rights Reserved." and the PDF's readable text carries no usage terms, so **ISMP's terms for putting its list in a product are unknown**. Do not bundle ISMP-only entries until ISMP or ECRI grants permission in writing; the founder (or counsel) asks, not the agent. Until then MD-8 ships the FDA entries only, each with a source and date, and the shared function takes any list, so adding ISMP's later is a data change. Also undecided: which list wins when the two capitalize a name differently, and how often the copy is refreshed.

## Slices (after approval)

- **MD-a (backend):** the bundled drug list and its test, the migration (a ledgered `patient_medications` record), the routes, the shared types, the privacy test.
- **MD-b (frontend):** the Medications section on the patient page, with a coded drug picker.
