/**
 * Spec 044 K2 (decision K2-D3). The scope the server stores on an assessment of a synthetic patient made against the signed, real knowledge
 * (`SIGNED_ASSESSMENT_SCOPE` in the backend's evaluations service). The patient and report are still synthetic; only the guideline wording is real.
 */
export const SIGNED_ASSESSMENT_SCOPE = 'synthetic-patient-signed-knowledge';

/** The founders' wording (K2-D3), in English. The Spanish text is still to be written; nothing else on these screens is translated yet. */
export const SIGNED_KNOWLEDGE_LABEL = 'Real CPIC guideline wording. Fictional patient. Not approved for clinical use.';

export const usesSignedKnowledge = (evaluation: { scope: string | null }): boolean => evaluation.scope === SIGNED_ASSESSMENT_SCOPE;

/** Said once per result made with signed knowledge, beside the synthetic labels already on the screen, which stay true. */
export function SignedKnowledgeLabel({ evaluation }: { evaluation: { scope: string | null } }) {
  if (!usesSignedKnowledge(evaluation)) return null;
  return (
    <p className="text-sm font-medium" data-label="signed-knowledge">
      {SIGNED_KNOWLEDGE_LABEL}
    </p>
  );
}
