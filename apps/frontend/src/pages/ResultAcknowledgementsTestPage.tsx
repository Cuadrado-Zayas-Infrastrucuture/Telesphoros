import { useSearchParams } from 'react-router-dom';
import { ReviewedControl } from '@/components/acknowledgements/ReviewedControl';
import { usePageTitle } from '@/hooks/usePageTitle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Spec 019 D02a, test only: mounted in the e2e build alone (routes.tsx), never in production (scripts/check-chunks.mjs proves it). It lists synthetic
 * fixture results by id, with no clinical text, each with a ReviewedControl: `?patient=<id>&result=<id>&result=<id>`. Each control is keyed by patient
 * and result, so changing the patient remounts every row and nothing pending for the previous patient can finish or submit. The clinical result view
 * is a separate build and adopts the control.
 */
export default function ResultAcknowledgementsTestPage() {
  usePageTitle('Result acknowledgements (test)');
  const [params] = useSearchParams();
  const patient = (params.get('patient') ?? '').toLowerCase();
  const results = params.getAll('result').map((id) => id.toLowerCase());
  const valid = UUID.test(patient) && results.length > 0 && results.length <= 20 && results.every((id) => UUID.test(id));

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl leading-tight tracking-tight">Result acknowledgements</h1>
        <p className="text-muted-foreground">Test page. Synthetic fixture results, listed by id only.</p>
      </div>
      {valid ? (
        <section aria-label={`Patient ${patient}`} className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Patient <span className="font-mono">{patient}</span>
          </p>
          <ul className="flex flex-col divide-y divide-divider">
            {results.map((id) => (
              <li key={`${patient}:${id}`} className="flex flex-col gap-2 py-3">
                <span className="font-mono text-sm">{id}</span>
                <ReviewedControl key={`${patient}:${id}`} resultId={id} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-muted-foreground">Name a patient and up to 20 results by id in the address.</p>
      )}
    </div>
  );
}
