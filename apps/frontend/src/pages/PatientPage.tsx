import { useParams } from 'react-router-dom';
import { PatientRecord } from '@/components/patients/PatientRecord';

export default function PatientPage() {
  const { id = '' } = useParams();
  // A different patient owns fresh section state, errors and requests, even while its identity is loading.
  return <PatientRecord key={id} id={id} />;
}
