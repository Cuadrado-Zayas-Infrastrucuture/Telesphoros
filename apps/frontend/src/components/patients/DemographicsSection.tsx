import { useState } from 'react';
import { Completeness } from '@/components/patients/Completeness';
import { DemographicsForm } from '@/components/patients/DemographicsForm';
import { DemographicsValues } from '@/components/patients/DemographicsValues';
import { DemographicsVersions } from '@/components/patients/DemographicsVersions';
import { Button } from '@/components/ui/Button';
import { draftFrom, EMPTY_DRAFT } from '@/lib/demographicsDraft';
import type { DemographicsRead } from '@/lib/patientDemographics';

export function DemographicsSection(props: {
  patientId: string;
  read: DemographicsRead;
  version: number | undefined;
  canWrite: boolean;
  onViewVersion: (version: number | undefined) => void;
  onSaved: () => void;
}) {
  const { read, version, canWrite, onViewVersion } = props;
  const [editing, setEditing] = useState(false);
  const heading = (
    <h2 id="demographics-heading" className="text-lg font-semibold">
      Demographics
    </h2>
  );

  if (read.kind === 'erased') {
    return (
      <section aria-labelledby="demographics-heading" className="flex flex-col gap-2">
        {heading}
        <p className="text-sm text-muted-foreground">This patient's identity was erased. Its versions can no longer be read, and none can be added.</p>
      </section>
    );
  }

  const current = read.kind === 'found' ? read.value : null;
  const viewingEarlier = current !== null && !current.current;
  return (
    <section aria-labelledby="demographics-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {heading}
        <Completeness value={current} />
      </div>
      {viewingEarlier && (
        <p role="status" className="text-sm text-muted-foreground">
          Showing version {current.version}, an earlier version.{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => onViewVersion(undefined)}>
            Show the current version
          </button>
        </p>
      )}
      {editing ? (
        <DemographicsForm
          patientId={props.patientId}
          initial={current && current.current ? draftFrom(current) : EMPTY_DRAFT}
          correction={current !== null}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            props.onSaved();
          }}
        />
      ) : current ? (
        <DemographicsValues value={current} />
      ) : (
        <p className="text-sm text-muted-foreground">No demographics recorded yet.</p>
      )}
      {canWrite && !editing && !viewingEarlier && (
        <div>
          <Button size="sm" variant={current ? 'outline' : 'default'} onClick={() => setEditing(true)}>
            {current ? 'Correct' : 'Record demographics'}
          </Button>
        </div>
      )}
      {current && current.versions.length > 0 && <DemographicsVersions value={current} shown={version ?? current.version} onView={onViewVersion} />}
    </section>
  );
}
