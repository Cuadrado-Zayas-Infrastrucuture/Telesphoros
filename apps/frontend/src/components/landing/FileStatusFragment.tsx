import { FileText } from 'lucide-react';
import { useLandingLanguage } from '@/lib/landing/landing-language';

/** Fictional file names and which status each shows; the words come from the landing copy in the chosen language. */
export const statusRows = [
  { name: 'SYN-001.vcf', status: 'verified' },
  { name: 'SYN-002.json', status: 'incomplete' },
  { name: 'SYN-003.vcf', status: 'received' },
] as const;

/** Decorative fictional file list for a capability row; see PatientLinkFragment for the rules these fragments keep. */
export function FileStatusFragment() {
  const { statuses } = useLandingLanguage().copy;
  return <div className="landing-fragment landing-fragment--status" aria-hidden="true">
    {statusRows.map(row => <span key={row.name} className="landing-fragment-row">
      <span><FileText />{row.name}</span>
      <span className={row.status === 'verified' ? 'landing-fragment-verified' : undefined}>{statuses[row.status]}</span>
    </span>)}
  </div>;
}
