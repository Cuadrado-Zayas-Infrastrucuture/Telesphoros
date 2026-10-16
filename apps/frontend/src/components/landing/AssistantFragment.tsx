/**
 * Decorative fictional exchange for the assistant capability row: a sample question, typing dots under motion, then a
 * fixed answer that says it is not connected to any report. See PatientLinkFragment for the rules these fragments keep.
 */
export function AssistantFragment() {
  return <div className="landing-fragment landing-fragment--assistant" aria-hidden="true">
    <span className="landing-fragment-bubble landing-fragment-bubble--question">What can this preview show me?</span>
    <span className="landing-fragment-reply">
      <span className="landing-fragment-typing"><span /><span /><span /></span>
      <span className="landing-fragment-bubble landing-fragment-answer">Sample response. Not connected to your reports.</span>
    </span>
  </div>;
}
