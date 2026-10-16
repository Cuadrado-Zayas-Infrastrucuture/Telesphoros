import { FileText } from 'lucide-react';

export const statusRows = [
  { name: 'SYN-001.vcf', status: 'Server verified', verified: true },
  { name: 'SYN-002.json', status: 'Not complete', verified: false },
  { name: 'SYN-003.vcf', status: 'Received', verified: false },
] as const;

/** Decorative fictional file list for a capability row; see PatientLinkFragment for the rules these fragments keep. */
export function FileStatusFragment() {
  return <div className="landing-fragment landing-fragment--status" aria-hidden="true">
    {statusRows.map(row => <span key={row.name} className="landing-fragment-row">
      <span><FileText />{row.name}</span>
      <span className={row.verified ? 'landing-fragment-verified' : undefined}>{row.status}</span>
    </span>)}
  </div>;
}
