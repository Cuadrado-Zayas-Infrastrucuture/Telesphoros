import { useLandingLanguage } from '@/lib/landing/landing-language';

/**
 * Decorative fictional exchange for the worklist and Help capability row: a question about using the app, typing dots under motion, then
 * the kind of answer Help gives (landing copy refresh, LC-D2). Never a question about a patient. See PatientLinkFragment for the rules these
 * fragments keep.
 */
export function AssistantFragment() {
  const { fragments } = useLandingLanguage().copy;
  return (
    <div className="landing-fragment landing-fragment--assistant" aria-hidden="true">
      <span className="landing-fragment-bubble landing-fragment-bubble--question">{fragments.question}</span>
      <span className="landing-fragment-reply">
        <span className="landing-fragment-typing">
          <span />
          <span />
          <span />
        </span>
        <span className="landing-fragment-bubble landing-fragment-answer">{fragments.answer}</span>
      </span>
    </div>
  );
}
