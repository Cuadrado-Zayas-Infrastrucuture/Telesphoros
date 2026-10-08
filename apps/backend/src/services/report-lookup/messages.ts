import { REASONS, type LookupReason } from './contracts';

/** New boundary only. Never derive a message from a source value or caught exception. */
export const LOOKUP_MESSAGES: Readonly<Record<LookupReason, string>> = Object.freeze(
  Object.fromEntries(REASONS.map((code) => [code, 'The offline lookup is held. Review the bound evidence at the recorded admission stage.'])) as Record<LookupReason, string>,
);
export const LOOKUP_ACTIONS: Readonly<Record<LookupReason, string>> = Object.freeze(
  Object.fromEntries(REASONS.map((code) => [code, 'Check the current capture, source evidence and applicable reviews. Record a new decision; do not change source text.'])) as Record<LookupReason, string>,
);
