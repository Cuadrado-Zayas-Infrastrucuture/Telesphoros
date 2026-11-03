import mascot from '@/assets/telesphoros-mascot.png';

/** The empty conversation: the mascot, a greeting and what can be done here. */
export function ConversationWelcome({ preferredName, canAttach }: { preferredName: string | null | undefined; canAttach: boolean }) {
  return (
    <div className="flex flex-1 flex-col justify-center py-6">
      <img className="one-screen-mascot mascot-plate" src={mascot} width="162" height="192" loading="eager" alt="Telesphoros mascot in a teal cloak" />
      <p className="mb-2 text-center text-sm break-words text-muted-foreground">{preferredName ? `Welcome, ${preferredName}.` : 'Welcome.'}</p>
      {/* The prototype does not interpret reports yet, so the heading does not promise a reading (specs/024 D3). */}
      <h1 className="mb-3 text-center font-heading text-3xl font-medium">Start with a synthetic report.</h1>
      <p className="text-center text-sm text-muted-foreground">
        {canAttach ? 'Drop a report here, or attach one. Synthetic reports only.' : 'Typed questions are noted; reports are attached by clinicians.'}
      </p>
    </div>
  );
}
