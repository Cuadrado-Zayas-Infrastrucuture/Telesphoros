# Spanish for the patient page (spec 050 LS3)

For the founders to fill in. Each row is one fixed string of a word table on the `patient` screen, with its key and its English exactly as the app
shows it. `{1}` and `{2}` are placeholders: the app puts a value there (a synthetic label, a date, an age, a count, a version, a drug name), and the
Spanish must keep each one. Write the Spanish in the last column. It is not machine translated (spec 050 R8).

- **Clinical and patient-safety tables** (`patient-identity`, `patient-demographics`, `patient-medications`, `patient-results`): written by the
  founders and signed by two pharmacists with names and a date (spec 050 R7, LS-D4).
- **Interface tables** (`patient-page`, `patient-banner`): written by the founders and checked by one founder (LS-D4).
- **Accessible-name pairs (WCAG 2.5.3, R10):** in Spanish, `patient-identity.retryName` must start with `patient-identity.retry`, and
  `patient-medications.detailsFor`, `correctFor`, `stopFor`, and `earlierVersionsFor` must each start with their matching button text (`details`,
  `correct`, `stop`, `earlierVersions`).

`apps/frontend/src/lib/words/ls3List.test.ts` keeps this list in step with `SCREEN_TABLES.patient`: a string added, removed or changed in the code
without its row here fails the test. Subcomponents (`DemographicsForm`, `DemographicsValues`, `DemographicsVersions`, `MedicationForm`,
`MedicationValues`, `MedicationHistory`, `ResultsList`, `StoredResult`, `FollowupsSection`, and `GenomicProfileSection` in LS4) stay English until
their tables are extracted and signed; `TRANSLATED_SCREENS` does not add `patient` until LS3b.

## The `patient` screen

### `patient-identity` (clinical — two pharmacist signers required; see `docs/design/plans/patient-identity-spanish.md`)

| Key | English | Spanish |
| --- | --- | --- |
| `patient-identity.unknown` | The patient's identity could not be loaded, so their name and date of birth are not shown. Make sure this is patient {1} before you act on anything below. |  |
| `patient-identity.retry` | Retry |  |
| `patient-identity.retryName` | Retry loading the identity |  |
| `patient-identity.section` | The demographics could not be loaded. Use Retry above. |  |
| `patient-identity.held` | Results, decisions and follow-ups open once the patient's identity has loaded. |  |

### `patient-page` (interface — one founder check)

| Key | English | Spanish |
| --- | --- | --- |
| `patient-page.title` | Patient |  |
| `patient-page.titleWithLabel` | Patient {1} |  |
| `patient-page.loadFailed` | The patient could not be loaded. Please retry. |  |
| `patient-page.heading` | Patient |  |
| `patient-page.retry` | Retry |  |
| `patient-page.backToPatients` | Back to patients |  |
| `patient-page.backToHome` | Back to home |  |
| `patient-page.loading` | Loading patient record… |  |
| `patient-page.patientsBreadcrumb` | Patients |  |
| `patient-page.syntheticAdded` | Synthetic patient · Added {1} |  |

### `patient-banner` (interface — one founder check)

| Key | English | Spanish |
| --- | --- | --- |
| `patient-banner.groupLabel` | Patient identity |  |
| `patient-banner.born` | Born {1} |  |
| `patient-banner.years` | {1} years |  |
| `patient-banner.sexMale` | Male |  |
| `patient-banner.sexFemale` | Female |  |

### `patient-demographics` (clinical — two pharmacist signers required)

| Key | English | Spanish |
| --- | --- | --- |
| `patient-demographics.heading` | Demographics |  |
| `patient-demographics.erased` | This patient's identity was erased. Its versions can no longer be read, and none can be added. |  |
| `patient-demographics.earlierVersion` | Showing version {1}, an earlier version. |  |
| `patient-demographics.showCurrent` | Show the current version |  |
| `patient-demographics.empty` | No demographics recorded yet. |  |
| `patient-demographics.correct` | Correct |  |
| `patient-demographics.record` | Record demographics |  |

### `patient-medications` (clinical — two pharmacist signers required)

| Key | English | Spanish |
| --- | --- | --- |
| `patient-medications.heading` | Medications |  |
| `patient-medications.refresh` | Refresh medications |  |
| `patient-medications.disclaimer` | Recorded medications only. This list does not change reports or provide drug–gene guidance. |  |
| `patient-medications.counts` | {1} active · {2} stopped |  |
| `patient-medications.filterLabel` | Find recorded medication |  |
| `patient-medications.saved` | Medication saved. |  |
| `patient-medications.loadFailed` | Medications could not be loaded. |  |
| `patient-medications.reload` | Reload medications |  |
| `patient-medications.loading` | Loading medications… |  |
| `patient-medications.empty` | No medications recorded yet. |  |
| `patient-medications.noFilterMatch` | No recorded medications match this filter. |  |
| `patient-medications.listLabel` | Recorded medications |  |
| `patient-medications.details` | Details |  |
| `patient-medications.detailsFor` | Details for {1} |  |
| `patient-medications.currentVersion` | Version {1} (current) |  |
| `patient-medications.correct` | Correct |  |
| `patient-medications.correctFor` | Correct {1} |  |
| `patient-medications.stop` | Stop |  |
| `patient-medications.stopFor` | Stop {1} |  |
| `patient-medications.earlierVersions` | Earlier versions |  |
| `patient-medications.earlierVersionsFor` | Earlier versions of {1} |  |
| `patient-medications.add` | Add medication |  |
| `patient-medications.drugListUnavailable` | The verified drug list is unavailable. Medication changes are disabled. |  |

### `patient-results` (clinical — two pharmacist signers required)

| Key | English | Spanish |
| --- | --- | --- |
| `patient-results.sectionLabel` | Recorded results |  |
| `patient-results.heading` | Results and decisions |  |
| `patient-results.followupWaiting` | Decision saved. Its follow-up step opens when the follow-up form that is open now is closed. Until then no reminder exists for it. |  |
| `patient-results.decisionFollowupSaved` | Decision saved. Follow-up saved. |  |
| `patient-results.decisionNoFollowup` | Decision saved. No follow-up was scheduled, so no reminder was created. |  |
