import { Link } from 'react-router-dom';
import mascot from '@/assets/telesphoros-mascot.png';

/**
 * The empty conversation: the mascot, a greeting and what can be done here. It lists the supported tasks and says, before anyone types, that a typed
 * question is not answered (specs/038 D3).
 */
export function ConversationWelcome({
  preferredName,
  canAttach,
  canReadRecords = false,
}: {
  preferredName: string | null | undefined;
  canAttach: boolean;
  /** Roles that may open a patient's record; the others are not offered the link. */
  canReadRecords?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col justify-center py-6">
      <img className="one-screen-mascot mascot-plate" src={mascot} width="162" height="192" loading="eager" alt="Telesphoros mascot in a teal cloak" />
      <p className="mb-2 text-center text-sm break-words text-muted-foreground">{preferredName ? `Welcome, ${preferredName}.` : 'Welcome.'}</p>
      {/* The prototype does not interpret reports yet, so the heading does not promise a reading (specs/024 D3). */}
      <h1 className="mb-3 text-center font-heading text-3xl font-medium">Start with a synthetic report.</h1>
      <ul aria-label="What you can do here" className="mx-auto flex flex-col gap-1 text-sm text-muted-foreground">
        {canAttach && <li>Attach a synthetic report, choose its patient, and follow its status here.</li>}
        {canReadRecords && (
          <li>
            <Link to="/patients" className="underline">
              Open a patient
            </Link>{' '}
            to read stored results and their sources.
          </li>
        )}
        <li>Typed questions are not answered here. They stay in this chat and are not saved.</li>
      </ul>
    </div>
  );
}
