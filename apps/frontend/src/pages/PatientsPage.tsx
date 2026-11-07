import { Link } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { PatientRoster } from '@/components/patients/PatientRoster';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';

/** Specs/034 D2: the sidebar's Patients destination. The list that used to sit in the panel, with Add patient for writer roles. */
export default function PatientsPage() {
  usePageTitle('Patients');
  const { roles } = useAuth();
  const canAdd = roles.some((role) => WRITER_ROLES.includes(role));
  return (
    <div className="reports-workspace flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl leading-tight tracking-tight">Patients</h1>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">Synthetic patient codes, newest first. Synthetic data only.</p>
        </div>
        {canAdd && (
          <Button asChild className="min-h-control w-full whitespace-normal px-5 sm:w-auto">
            <Link to="/patients/new">
              <UserPlus aria-hidden="true" className="size-4 shrink-0" />
              Add patient
            </Link>
          </Button>
        )}
      </div>
      <PatientRoster />
    </div>
  );
}
