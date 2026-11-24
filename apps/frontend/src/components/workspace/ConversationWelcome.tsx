import { Paperclip, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import mascot from '@/assets/telesphoros-mascot.png';
import { Button } from '@/components/ui/Button';

/**
 * The empty conversation: the mascot, a greeting and what can be done here, as buttons rather than sentences (specs/041 D6). It still says,
 * before anyone types, that a typed question is not answered (specs/038 D3).
 */
export function ConversationWelcome({
  preferredName,
  canAttach,
  onAttach,
  canReadRecords = false,
}: {
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
      {/* The heading's last words take the signal colour, as the landing page's headline does (specs/043 D6): decoration, never a status. */}
      <h1 className="mb-3 text-center font-heading text-3xl font-medium">
        Start with a <span className="text-signal">synthetic report.</span>
      </h1>
      {/* A short line in the signal colour under it (specs/043 D3). */}
      <span aria-hidden="true" className="one-screen-signal-rule" />
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
    </div>
  );
}
