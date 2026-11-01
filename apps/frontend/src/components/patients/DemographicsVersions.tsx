import type { PatientDemographicsDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { SEX_LABELS } from '@/lib/demographicsDraft';
import { when } from '@/lib/formatWhen';

/** Every version, newest first: who recorded it and when, and its coded fields only (the list carries no identity). */
export function DemographicsVersions({ value, shown, onView }: { value: PatientDemographicsDto; shown: number; onView: (version: number | undefined) => void }) {
  const newest = Math.max(...value.versions.map((v) => v.version));
  const versions = [...value.versions].sort((a, b) => b.version - a.version);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Versions</h3>
      <ol className="flex flex-col divide-y divide-border rounded-md border border-border text-sm">
        {versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span>
              Version {v.version}
              {v.version === newest ? ' (current)' : ''} · {when(v.createdAt)} · {v.sex ? SEX_LABELS[v.sex] : 'sex not recorded'}, born {v.birthYear}
            </span>
            {v.version === shown ? (
              <span className="text-muted-foreground">Shown</span>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => onView(v.version === newest ? undefined : v.version)}>
                View
              </Button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
