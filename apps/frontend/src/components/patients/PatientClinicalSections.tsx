import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { PatientResults } from './PatientResults';
import { FollowupsSection } from './FollowupsSection';

export function PatientClinicalSections({ patientId }: { patientId: string }) {
  const { search } = useLocation();
  const [decision, setDecision] = useState<DecisionLink | null>(null);
  const [editing, setEditing] = useState(false);
  const params = new URLSearchParams(search);
  return (
    <>
      {/* The results use the page's full width, so a result's evidence can sit beside it (specs/038 D7). */}
      <PatientResults patientId={patientId} followupBusy={editing || !!decision || params.has('followup')} onFollowup={setDecision} initialResultId={params.get('result')} />
      <div className="max-w-3xl">
        <FollowupsSection patientId={patientId} decision={decision ?? undefined} onDecisionClose={() => setDecision(null)} onEditingChange={setEditing} />
      </div>
    </>
  );
}
