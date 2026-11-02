import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { PatientResults } from './PatientResults';
import { FollowupsSection } from './FollowupsSection';

export function PatientClinicalSections({ patientId }: { patientId: string }) {
  const { search } = useLocation();
  const [decision, setDecision] = useState<DecisionLink | null>(null);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <PatientResults patientId={patientId} followupBusy={editing || !!decision || new URLSearchParams(search).has('followup')} onFollowup={setDecision} />
      <FollowupsSection patientId={patientId} decision={decision ?? undefined} onDecisionClose={() => setDecision(null)} onEditingChange={setEditing} />
    </>
  );
}
