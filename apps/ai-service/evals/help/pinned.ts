/**
 * The digests the help gate was last measured against (help-lane.md FR-H7, FR-010): the template, the HC3 and HC4 lexicons, the product's
 * articles and glossary, the gated model's identity and the limits. Changing any of them changes the help lane's version; the gate is red
 * until these are updated in a reviewed diff, which is the moment to re-measure. A content change to an article re-pins here too.
 *
 * No code runs in an agent session (P2), so these start unset: the gate test prints the current values, and the values from the pull
 * request's first CI run are committed in a reviewed follow-up commit on the same pull request (plan C2c section 5).
 */
export const HELP_PINNED: Readonly<Record<string, string>> = {
  template: 'unset',
  lexicon: 'unset',
  corpus: 'unset',
  model: 'unset',
  limits: 'unset',
};
