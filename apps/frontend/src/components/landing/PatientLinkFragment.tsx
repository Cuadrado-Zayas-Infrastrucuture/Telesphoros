import { FileText, UserRound } from 'lucide-react';
import { useLandingLanguage } from '@/lib/landing/landing-language';

/*
 * Code-drawn interface fragment for a capability row. It illustrates the sentence beside it with fictional records in
 * the product's own vocabulary, is hidden from assistive technology (the row text says the same thing), and makes no
 * claim the row does not already make. Its motion plays once, when the row is revealed (landing-motion.css).
 */
export function PatientLinkFragment() {
  const { fragments } = useLandingLanguage().copy;
  return (
    <div className="landing-fragment landing-fragment--link" aria-hidden="true">
      <span className="landing-fragment-chip">
        <UserRound />
        {fragments.patient}
      </span>
      <span className="landing-fragment-wire" />
      <span className="landing-fragment-chip landing-fragment-chip--file">
        <FileText />
        SYN-001.json
      </span>
    </div>
  );
}
