import { defineWords } from './defineWords';

/*
 * The patient page's top-level fixed words (spec 050 LS3a): the page frame, banner, demographics section, medications section, and clinical
 * results/follow-up outcome wrapper. English only until the founders' Spanish (LS3b), which goes into each table's `es`. Patient identity values
 * (names, dates of birth), drug names, gene symbols and synthetic labels are data and never live here (R9, R12); placeholders carry only the
 * runtime value.
 *
 * Clinical and patient-safety tables (`DEMOGRAPHICS_WORDS`, `MEDICATIONS_WORDS`, `RESULTS_WORDS`, alongside `IDENTITY_TABLE` in
 * `lib/patientIdentity.ts`) require two named, dated pharmacist signers before Spanish can ship (R7). Interface tables (`PATIENT_PAGE_WORDS`,
 * `PATIENT_BANNER_WORDS`) are checked by one founder (LS-D4).
 */

export const PATIENT_PAGE_WORDS = defineWords({
  id: 'patient-page',
  en: {
    title: 'Patient',
    titleWithLabel: (label: string) => `Patient ${label}`,
    loadFailed: 'The patient could not be loaded. Please retry.',
    heading: 'Patient',
    retry: 'Retry',
    backToPatients: 'Back to patients',
    backToHome: 'Back to home',
    loading: 'Loading patient record…',
    patientsBreadcrumb: 'Patients',
    syntheticAdded: (addedAt: string) => `Synthetic patient · Added ${addedAt}`,
  },
});

export const PATIENT_BANNER_WORDS = defineWords({
  id: 'patient-banner',
  en: {
    groupLabel: 'Patient identity',
    born: (date: string) => `Born ${date}`,
    years: (age: string) => `${age} years`,
    sexMale: 'Male',
    sexFemale: 'Female',
  },
});

export const DEMOGRAPHICS_WORDS = defineWords({
  id: 'patient-demographics',
  clinical: true,
  en: {
    heading: 'Demographics',
    erased: "This patient's identity was erased. Its versions can no longer be read, and none can be added.",
    earlierVersion: (version: string) => `Showing version ${version}, an earlier version.`,
    showCurrent: 'Show the current version',
    empty: 'No demographics recorded yet.',
    correct: 'Correct',
    record: 'Record demographics',
  },
});

export const MEDICATIONS_WORDS = defineWords({
  id: 'patient-medications',
  clinical: true,
  namePairs: [
    ['details', 'detailsFor'],
    ['correct', 'correctFor'],
    ['stop', 'stopFor'],
    ['earlierVersions', 'earlierVersionsFor'],
  ],
  en: {
    heading: 'Medications',
    refresh: 'Refresh medications',
    disclaimer: 'Recorded medications only. This list does not change reports or provide drug–gene guidance.',
    counts: (active: string, stopped: string) => `${active} active · ${stopped} stopped`,
    filterLabel: 'Find recorded medication',
    saved: 'Medication saved.',
    loadFailed: 'Medications could not be loaded.',
    reload: 'Reload medications',
    loading: 'Loading medications…',
    empty: 'No medications recorded yet.',
    noFilterMatch: 'No recorded medications match this filter.',
    listLabel: 'Recorded medications',
    details: 'Details',
    detailsFor: (name: string) => `Details for ${name}`,
    currentVersion: (version: string) => `Version ${version} (current)`,
    correct: 'Correct',
    correctFor: (name: string) => `Correct ${name}`,
    stop: 'Stop',
    stopFor: (name: string) => `Stop ${name}`,
    earlierVersions: 'Earlier versions',
    earlierVersionsFor: (name: string) => `Earlier versions of ${name}`,
    add: 'Add medication',
    drugListUnavailable: 'The verified drug list is unavailable. Medication changes are disabled.',
  },
});

export const RESULTS_WORDS = defineWords({
  id: 'patient-results',
  clinical: true,
  en: {
    sectionLabel: 'Recorded results',
    heading: 'Results and decisions',
    followupWaiting: 'Decision saved. Its follow-up step opens when the follow-up form that is open now is closed. Until then no reminder exists for it.',
    decisionFollowupSaved: 'Decision saved. Follow-up saved.',
    decisionNoFollowup: 'Decision saved. No follow-up was scheduled, so no reminder was created.',
  },
});
