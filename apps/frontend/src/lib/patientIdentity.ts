import { createContext, useContext } from 'react';
import { SubmitError } from './api';

/**
 * When the patient's identity cannot be read now (docs/design/plans/patient-page-identity-outage.md). The patient is known, but the name and
 * date of birth are not on screen: a third state beside "none recorded" and "erased", which must never look like "none recorded". The page
 * still shows what it read; anything that records something for this patient waits until the identity is read (B-D3).
 */

/** The founder-approved wording (B-D2). English only. No identity value is ever part of it, only the synthetic label (spec 025 D7). */
export const IDENTITY_WORDS = {
  unknown: (label: string) =>
    `The patient's identity could not be loaded, so their name and date of birth are not shown. Make sure this is patient ${label} before you act on anything below.`,
  retry: 'Retry',
  retryName: 'Retry loading the identity',
  section: 'The demographics could not be loaded. Use Retry above.',
  held: "Results, decisions and follow-ups open once the patient's identity has loaded.",
} as const;

/**
 * B-D1: a failure of the demographics read that still stands for the whole page. A 403 (the role cannot read demographics) and every 404 (the
 * patient is not available, or a requested earlier version does not exist) are answers about this patient. Anything else (503, another
 * 5xx, 429, a network or parse failure) is an identity that could not be read now.
 */
export function failsThePage(error: unknown): error is SubmitError {
  return error instanceof SubmitError && (error.status === 403 || error.status === 404);
}

/** True while the identity is unknown: the profile's "Record a decision" link, which leads to the held results, is hidden (B-D3). */
export const RecordingHeldContext = createContext(false);

export const useRecordingHeld = () => useContext(RecordingHeldContext);
