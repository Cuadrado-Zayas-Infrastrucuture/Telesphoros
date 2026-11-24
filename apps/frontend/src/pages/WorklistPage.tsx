import { Link } from 'react-router-dom';
import { ArrowUpFromLine, Search, UserPlus } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { CLINICAL_READ_ROLES, FOLLOWUP_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
import { Button } from '@/components/ui/Button';
import { HomeFollowups } from '@/components/workspace/HomeFollowups';
import { HomeHeldResults } from '@/components/workspace/HomeHeldResults';
import { usePageTitle } from '@/hooks/usePageTitle';

/**
 * The signed-in home (spec 049, direction plan A1): what needs a person, in a fixed order, each section only for the roles that may read it
 * (WL-6), each line opening the page where the work is done. Quick actions first. Nothing here ranks, infers or writes (WL-5, WL-8).
 */
export default function WorklistPage() {
  usePageTitle('Home');
  const { roles } = useAuth();
  const canRead = roles.some((role) => CLINICAL_READ_ROLES.includes(role));
  const canWrite = roles.some((role) => WRITER_ROLES.includes(role));
  const canFollowUp = roles.some((role) => FOLLOWUP_READ_ROLES.includes(role));
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-3xl leading-tight tracking-tight">Your worklist</h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">What needs you today. Open a line to work on it. Synthetic data only.</p>
      </div>
      {canRead && (
        <div role="group" aria-label="Start here" className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="min-h-control">
            <Link to="/patients">
              <Search aria-hidden="true" className="size-4" />
              Find a patient
            </Link>
          </Button>
          {canWrite && (
            <Button asChild variant="outline" className="min-h-control">
              <Link to="/patients/new">
                <UserPlus aria-hidden="true" className="size-4" />
                Add a patient
              </Link>
            </Button>
          )}
          {canWrite && (
            <Button asChild variant="outline" className="min-h-control">
              <Link to="/chat">
                <ArrowUpFromLine aria-hidden="true" className="size-4" />
                Attach a report
              </Link>
            </Button>
          )}
        </div>
      )}
      {canFollowUp && <HomeFollowups />}
      {canRead && <HomeHeldResults />}
      {!canRead && <p className="text-sm text-muted-foreground">Your account has no clinical role, so there is no work to show here.</p>}
    </div>
  );
}
