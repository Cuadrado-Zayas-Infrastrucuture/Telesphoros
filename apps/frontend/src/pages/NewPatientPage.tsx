import { BackToChatLink } from '@/components/layout/BackToChatLink';
import { Breadcrumb } from '@/components/layout/Breadcrumb';
import { PatientCreateForm } from '@/components/patients/PatientCreateForm';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function NewPatientPage() {
  usePageTitle('New patient');
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <Breadcrumb trail={[{ to: '/patients', label: 'Patients' }]} current="New patient" />
        <BackToChatLink />
      </div>
      <h1 className="text-2xl font-semibold">New patient</h1>
      <p className="text-sm text-muted-foreground">Add the patient's information here. Medications and follow-up belong to the saved patient record. Synthetic data only.</p>
      <PatientCreateForm />
    </div>
  );
}
