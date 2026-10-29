import { useEffect, useState } from 'react';
import type { ApiFetch } from '@/lib/api';
import { loadOrganization, OrganizationLoadError, type OrganizationProfile } from '@/lib/organizationProfile';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';

type Organization = OrganizationProfile | { state: 'loading' } | { state: 'failed'; message: string };

/** The organization row of Settings. Each attempt is a fresh mount (the parent keys it), so loading starts in its initial state. */
export function OrganizationValue({ apiFetch, onRetry }: { apiFetch: ApiFetch; onRetry: () => void }) {
  const [organization, setOrganization] = useState<Organization>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    loadOrganization(apiFetch, controller.signal).then(
      (loaded) => setOrganization(loaded),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setOrganization({ state: 'failed', message: error instanceof OrganizationLoadError ? error.message : 'The organization could not be loaded. Please retry.' });
      },
    );
    return () => controller.abort();
  }, [apiFetch]);

  if (organization.state === 'loading')
    return (
      <>
        <Skeleton className="h-5 w-48" />
        <span role="status" className="sr-only">
          Loading the organization…
        </span>
      </>
    );
  if (organization.state === 'ready') return <>{organization.name}</>;
  if (organization.state === 'unavailable') return <span className="text-muted-foreground">Not available on this server yet.</span>;
  return (
    <span className="flex flex-wrap items-center gap-3">
      <span role="alert">{organization.message}</span>
      <Button variant="outline" className="text-sm" onClick={onRetry}>
        Retry
      </Button>
    </span>
  );
}
