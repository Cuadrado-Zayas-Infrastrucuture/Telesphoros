import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FollowupsList } from './FollowupsList';
import { FollowupEntry } from './FollowupEntry';
import { FollowupForm } from './FollowupForm';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { useFollowupRecording } from '@/hooks/useFollowupRecording';

export function FollowupsSection({
  patientId,
  decision,
  onDecisionClose,
  onEditingChange,
}: {
  patientId: string;
  decision?: DecisionLink;
  onDecisionClose?: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  const params = new URLSearchParams(location.search);
  const selected = params.getAll('followup');
  const heading = useRef<HTMLHeadingElement>(null);
  // Paused recording: no form is offered, whichever link led here; the list explains why.
  const paused = useFollowupRecording() === 'paused';
  useEffect(() => {
    if (decision) {
      heading.current?.scrollIntoView({ block: 'start' });
      heading.current?.focus({ preventScroll: true });
    }
  }, [decision]);
  function close(wasSaved = false) {
    setSaved(wasSaved);
    const next = new URLSearchParams(location.search);
    next.delete('followup');
    void navigate({ pathname: location.pathname, search: next.toString(), hash: '#followups' }, { replace: true });
  }
  if (decision && !paused)
    return (
      <section id="followups" aria-label="Follow-up" className="flex flex-col gap-4 border-t border-border pt-6">
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
          Follow-up
        </h2>
        <FollowupForm
          key={decision.id}
          patientId={patientId}
          action="schedule"
          decision={decision}
          onClose={() => {
            setSaved(false);
            onDecisionClose?.();
          }}
          onSaved={() => {
            setSaved(true);
            onDecisionClose?.();
          }}
        />
      </section>
    );
  return selected.length && !paused ? (
    <FollowupEntry
      key={`${patientId}:${selected.join(':')}`}
      patientId={patientId}
      threadId={selected.length === 1 ? selected[0]! : ''}
      onClose={() => close()}
      onSaved={() => close(true)}
    />
  ) : (
    <FollowupsList patientId={patientId} initialSaved={saved} onEditingChange={onEditingChange} paused={paused} />
  );
}
