import { useLandingLanguage } from '@/lib/landing/landing-language';

/**
 * Decorative fictional exchange for the chat capability row: a sample question, typing dots under motion, then the note the
 * chat really shows outside the local preview (specs/024 CH-4). See PatientLinkFragment for the rules these fragments keep.
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
