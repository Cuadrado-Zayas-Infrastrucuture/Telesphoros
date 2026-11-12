import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { PatientResults } from './PatientResults';
import { FollowupsSection } from './FollowupsSection';

/**
 * A patient's results and follow-ups. It also carries a decision from the result it was recorded on to the follow-up scheduled for it
 * (specs/038 D14). The two are separate saves, so this is where both outcomes are reported: a decision that is saved stays saved whether
 * its follow-up is saved, cancelled or still waiting to start.
 */
export function PatientClinicalSections({ patientId }: { patientId: string }) {
  const { search } = useLocation();
  const [decision, setDecision] = useState<DecisionLink | null>(null);
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const outcomeLine = useRef<HTMLParagraphElement>(null);
  const params = new URLSearchParams(search);
  const otherFormOpen = editing || params.has('followup');
  // A decision's second step starts after a network reply. If a follow-up form was opened meanwhile, the step waits for it to close:
  // it never replaces a form someone is filling in.
  const waiting = !!decision?.guided && otherFormOpen;
  const startFollowup = useCallback((link: DecisionLink) => {
    setOutcome(null);
    setDecision(link);
  }, []);
  // The form that held focus is gone when the second step ends: put focus on the line that says what happened.
  useEffect(() => {
    if (outcome) outcomeLine.current?.focus({ preventScroll: true });
  }, [outcome]);
  return (
    <>
      {/* The results use the page's full width, so a result's evidence can sit beside it (specs/038 D7). */}
      <PatientResults patientId={patientId} followupBusy={otherFormOpen || !!decision} onFollowup={startFollowup} initialResultId={params.get('result')} />
      <div className="flex max-w-3xl flex-col gap-2">
        {waiting && (
          <p role="status" className="text-sm">
            Decision saved. Its follow-up step opens when the follow-up form that is open now is closed. Until then no reminder exists for it.
          </p>
        )}
        {outcome && (
          <p ref={outcomeLine} tabIndex={-1} role="status" className="text-sm">
            {outcome}
          </p>
        )}
        <FollowupsSection
          patientId={patientId}
          decision={waiting ? undefined : (decision ?? undefined)}
          onDecisionClose={(saved) => {
            if (decision?.guided) setOutcome(saved ? 'Decision saved. Follow-up saved.' : 'Decision saved. No follow-up was scheduled, so no reminder exists for it.');
            setDecision(null);
          }}
          onEditingChange={setEditing}
        />
      </div>
    </>
  );
}
