import { Paperclip, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import mascot from '@/assets/telesphoros-mascot.png';
import { Button } from '@/components/ui/Button';
import { HomeFollowups } from './HomeFollowups';

/**
 * The empty conversation: the mascot, a greeting and what can be done here, as buttons rather than sentences (specs/041 D6). It still says,
 * before anyone types, that a typed question is not answered (specs/038 D3).
 */
export function ConversationWelcome({
  preferredName,
  canAttach,
  onAttach,
  canReadRecords = false,
  canFollowUp = false,
}: {
  /** Roles that read follow-ups (clinician, reviewer): they get the list of follow-ups assigned to them. */
  canFollowUp?: boolean;
  preferredName: string | null | undefined;
  canAttach: boolean;
  /** Opens the same file chooser as the composer's paperclip. */
  onAttach?: () => void;
  /** Roles that may open a patient's record; the others are not offered the link. */
  canReadRecords?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col justify-center py-6">
      <img className="one-screen-mascot mascot-plate" src={mascot} width="162" height="192" loading="eager" alt="Telesphoros mascot in a teal cloak" />
      <p className="mb-2 text-center text-sm break-words text-muted-foreground">{preferredName ? `Welcome, ${preferredName}.` : 'Welcome.'}</p>
      {/* The prototype does not interpret reports yet, so the heading does not promise a reading (specs/024 D3). */}
      <h1 className="mb-4 text-center font-heading text-3xl font-medium">Start with a synthetic report.</h1>
      {(canAttach || canReadRecords) && (
        <div role="group" aria-label="What you can do here" className="mb-3 flex flex-wrap justify-center gap-2">
          {canAttach && onAttach && (
            <Button variant="outline" onClick={onAttach}>
              <Paperclip aria-hidden="true" className="size-4" />
              Attach a synthetic report
            </Button>
          )}
          {canReadRecords && (
            <Button asChild variant="outline" className="min-h-control">
              <Link to="/patients">
                <Users aria-hidden="true" className="size-4" />
                Open a patient
              </Link>
            </Button>
          )}
        </div>
      )}
      <p className="text-center text-sm text-muted-foreground">Typed questions are not answered or saved.</p>
      {canFollowUp && <HomeFollowups />}
    </div>
  );
}
