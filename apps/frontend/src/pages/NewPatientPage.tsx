import { Link } from 'react-router-dom';
import { PatientCreateForm } from '@/components/patients/PatientCreateForm';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function NewPatientPage() {
  usePageTitle('New patient');
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Link to="/workspace" className="inline-flex min-h-control items-center text-sm underline">
        Back to chat
      </Link>
      <h1 className="text-2xl font-semibold">New patient</h1>
      <p className="text-sm text-muted-foreground">Add the patient's information here. Medications and follow-up belong to the saved patient record. Synthetic data only.</p>
      <PatientCreateForm />
    </div>
  );
}
