import { FileText, UserRound } from 'lucide-react';
import { statusRows } from './FileStatusFragment';
import { useLandingLanguage } from '@/lib/landing/landing-language';

/**
 * The hero's main visual: a still, code-drawn synthetic report card, in the spirit of the public site's working
 * example but with nothing to operate. It reuses the fictional records and wording of the capability fragments,
 * makes no claim the page does not already make, and is hidden from assistive technology (the hero text and the
 * workflow below say the same thing, and are interactive where it matters).
 */
export function HeroReportCard() {
  const { card, statuses } = useLandingLanguage().copy;
  return (
    <div className="landing-report-card" aria-hidden="true">
      <div className="landing-report-head">
        <span>
          <UserRound />
          {card.patient}
        </span>
        <span>{card.label}</span>
      </div>
      <div className="landing-report-body">
        {statusRows.map((row) => (
          <span key={row.name} className="landing-report-row">
            <span>
              <FileText />
              {row.name}
            </span>
            <span className={row.status === 'verified' ? 'landing-report-verified' : undefined}>{statuses[row.status]}</span>
          </span>
        ))}
      </div>
      <p className="landing-report-foot">{card.foot}</p>
    </div>
  );
}
