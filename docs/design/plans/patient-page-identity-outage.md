# Plan: the patient page when the identity cannot be read

**Status**: **approved by the founder on 2026-11-24: B-D1 to B-D4 as recommended.** The plan merged in #453; it is built in the
pull request after it. Read against `main` after PR #452. Frontend only. Called "option B" in #452's follow-ups.

## 1. The problem

`PatientPage` (`apps/frontend/src/pages/PatientPage.tsx`) reads the patient and its demographics together:
`Promise.all([getPatient(...), getDemographics(...)])`. If either read fails, the whole page is replaced by one line and a Retry button. That
is right when the patient itself cannot be read. It is wrong when only the identity read fails for a reason that will pass:

- **On a deployed build.** The read decrypts the identity with the patient's KMS data key. If the key cannot be opened, the API answers 503
  "The identity could not be opened just now" (`patient-demographics.service.ts:167`). The page then hides everything that did load: the
  genomic profile, the medications, the results, the decisions and the follow-ups.
- **On the in-memory store.** The read always answers 503, because demographics need PostgreSQL (#452). This is why
  `e2e/genomic-profile.spec.ts` answers the read itself.

## 2. What the page already does without a banner

The identity banner (`PatientBanner`: name, date of birth, age, sex) is the second identifier after the synthetic label. Two states
already show the whole page, guidance included, with no banner and only the label as the identifier:

- `none`: no demographics recorded yet. The section says "No demographics recorded yet."
- `erased`: the identity was erased. The section says so.

So this plan does not introduce "guidance without a banner". What it adds is a third such state, **unknown**: an identity that exists but
could not be read now. The risk to manage is that **unknown looks like none**. A clinician who sees no banner and no warning may think the
patient simply has none recorded.

## 3. The change

1. **Two reads, two outcomes.** The patient read stays page-level. The demographics read gets its own state on the page, so a failure there
   no longer replaces the page. The guards against stale answers when moving between patients stay as they are: abort on change, reset
   during render, and the late-answer checks. Their existing tests in `PatientPage.test.tsx` stay unchanged and must pass.
2. **Which failures stay page-level (B-D1).** These keep today's full-page message:
   - any failure of the patient read;
   - a demographics 403 ("Your role cannot read demographics.");
   - a demographics 404 that is not `no-demographics` ("This patient is not available.");
   - a 404 for a requested earlier version ("That version does not exist.").

   Everything else from the demographics read becomes **unknown**: 503, any other 5xx, 429, and a network or parse failure.
3. **The unknown state (B-D2 has the wording):**
   - In the banner's place, a warning with `role="alert"`, and next to it the page's one Retry for this case. It names the label and says
     the name and date of birth are not shown.
   - The Demographics section says the demographics could not be loaded, and points to that Retry. It must not say "No demographics
     recorded yet", show "Incomplete", or offer "Record demographics".
   - Retry reads the demographics again, and only them. The rest of the page stays as it is.
4. **What shows and what waits (B-D3):** the read-only parts render. Anything that records something for this patient waits until the
   identity is read.
5. **No backend change.** The API keeps answering 503. The in-memory store keeps having no demographics.

## 4. Decisions for the founder

- **B-D1, which failures stay page-level.** Recommended: the list in section 3.2. Alternative: make the version 404 local too, so it shows in
  the section with "Show the current version". It is left out to keep this slice small.
- **B-D2, the wording.** Draft text, English, for the founder to sign:
  - The warning: "The patient's identity could not be loaded, so their name and date of birth are not shown. Make sure this is patient
    [label] before you act on anything below." Retry.
  - The section: "The demographics could not be loaded. Use Retry above."
- **B-D3, what renders while the identity is unknown:**
  - **(b) Recommended.** These render: the genomic profile, and the medications list with its "Check a drug". These wait: the demographics
    form, recording or stopping a medication (`MedicationsSection` gets `canWrite={false}`), and the results area with its decisions and
    follow-ups (`PatientClinicalSections`). That area is replaced by one line: "Results, decisions and follow-ups open once the patient's
    identity has loaded." The profile's "Record a decision" link is hidden too, since it leads to that area. The reason: nothing is written
    to a chart that has only one identifier on screen when a second one exists.
  - **(a)** Render everything as for `none`, writes included. Simpler, and consistent with patients who have no demographics. But an
    "unknown" patient does have a second identifier, so this treats it as having one when it has two.
  - **(c)** Keep today's behaviour: the whole page waits. Nothing changes, and the outage keeps hiding the guidance.
- **B-D4, a clinical-validation note.** This changes how a patient is identified on screen, not clinical logic, so `CONTRIBUTING.md` does not
  require one. Recommended: add a short note anyway, `docs/clinical-validation/patient-identity-unknown.md`. It would record the three
  no-banner states, the wording and the tests, for the pharmacists' review.

## 5. What this touches

- `apps/frontend/src/pages/PatientPage.tsx`: the two reads, the unknown state, and the holds (B-D3).
- `apps/frontend/src/components/patients/DemographicsSection.tsx`: the unknown state's line, with no form and no "Incomplete".
- `apps/frontend/src/components/patients/GenomicDecisionControl.tsx`: hides "Record a decision" while held (B-D3 (b) only).
  *As built:* it reads a context the page sets, instead of a prop passed through four profile components.
- `apps/frontend/src/lib/patientIdentity.ts` (new, as built): the B-D2 wording, the B-D1 rule (`failsThePage`) and that context. The
  `SubmitError` that `getDemographics` throws already carries the response status, so `patientDemographics.ts` is unchanged.
- `apps/frontend/src/components/patients/IdentityUnknown.tsx` (new, as built): the warning and its Retry.
- Tests (section 6), the clinical-validation note (B-D4), and one status fragment.

## 6. Verification

- **Unit tests, `PatientPage.test.tsx`.** Each refusal has a control.
  - On 503, the heading, genomic profile and medications show. The warning names the label, and there is no banner.
  - On 503, the page shows none of: "No demographics recorded yet", "Incomplete", "Record demographics".
  - On 503, the holds of B-D3 apply.
  - Retry with a later 200 shows the banner and lifts the holds.
  - A network failure behaves like 503.
  - 403, a 404 without `no-demographics`, a version 404 and a failed patient read all stay page-level.
  - Control: `found`, `none` and `erased` render as today.
  - An axe check in the unknown state.
- **Defect injection.** Each of these must turn a test red, and is then reverted:
  - restoring `Promise.all`;
  - mapping 503 to `none`;
  - dropping one hold;
  - showing the warning without the label.
- **The existing guards.** The tests for moving between patients and for late answers pass unchanged.
- **Browser test, new `e2e/patient-identity-unknown.spec.ts`.** It opens a patient page against the real in-memory e2e API, which answers
  503 by itself, so the test needs no stand-in. At 375 and 1280 px, it checks the warning, the profile section, the holds and axe.
  `e2e/genomic-profile.spec.ts` keeps its 404 stand-in, because it tests the normal page.
- **Where it runs.** In an `opensandbox-pilot` job (`verify`'s steps, and the frontend suite), and in CI (`verify`, `browser`). This cloud
  session has no sandbox, so an implementation started here is first verified by CI, and the PR says so.

## 7. What this does NOT touch

- No backend, route, setting, role, migration or knowledge change.
- No change to what the API answers.
- The memory store still has no demographics.
- No change to `found`, `none` or `erased`.
- No change to the banner itself.
- No CI workflow or required-check change.
- Nothing applied.
- Staging gets this only with a frontend release. That release is the founder's separate step, and its plan quotes
  `scripts/staging/staging-status.sh`.

## 8. Slices

One pull request, after approval: the code, the tests, the note (B-D4) and one status fragment.
