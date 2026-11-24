import { useState } from 'react';
import { BackToHomeLink } from '@/components/layout/BackToHomeLink';
import { Breadcrumb } from '@/components/layout/Breadcrumb';
import { PatientCreateForm } from '@/components/patients/PatientCreateForm';
import { InfoButton } from '@/components/ui/InfoButton';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function NewPatientPage() {
  usePageTitle('New patient');
  // How-to text opens on demand; the synthetic-data notice always shows (specs/041 D7).
  const [about, setAbout] = useState(false);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <Breadcrumb trail={[{ to: '/patients', label: 'Patients' }]} current="New patient" />
        <BackToHomeLink />
      </div>
      <div className="flex items-center gap-1">
        <h1 className="text-2xl font-semibold">New patient</h1>
        <InfoButton label="About a new patient" open={about} controls="new-patient-about" onToggle={() => setAbout((value) => !value)} />
      </div>
      {about && (
        <p id="new-patient-about" className="text-sm text-muted-foreground">
          Add the patient's information here. Medications and follow-up belong to the saved patient record.
        </p>
      )}
      <p className="text-sm text-muted-foreground">Synthetic data only.</p>
      <PatientCreateForm />
    </div>
  );
}
