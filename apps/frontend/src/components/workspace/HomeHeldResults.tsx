import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { readHeldResults, type HeldResults } from '@/lib/heldResults';

/**
 * The worklist's held results (spec 049 section 3): current results that show no guidance yet, each with the reason in its fixed words and
 * the way to the patient's page, where the result is. It reads its own route and fails on its own (WL-1, WL-2); an empty list says so in
 * a fixed sentence (WL-3); a count is the server's (WL-4); and a route switched off here is a state, with no retry (WL-7).
 */
export function HomeHeldResults() {
  const { apiFetch } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; held: HeldResults | null; failed: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readHeldResults(apiFetch, controller.signal).then(
      (held) => {
        if (!controller.signal.aborted) setResult({ attempt, held, failed: false });
      },
      () => {
        if (!controller.signal.aborted) setResult({ attempt, held: null, failed: true });
      },
    );
    return () => controller.abort();
  }, [apiFetch, attempt]);
  const current = result?.attempt === attempt ? result : null;
  const held = current?.held;
  return (
    <section aria-label="Held results" className="flex w-full flex-col gap-2 text-sm">
      <h2 className="font-medium">Held results</h2>
      {current?.failed ? (
        <>
          <p>Held results could not be loaded.</p>
          <Button variant="outline" size="sm" className="self-start" onClick={() => setAttempt((value) => value + 1)}>
            Retry held results
          </Button>
        </>
      ) : !held ? (
        <p className="text-muted-foreground">Loading held results…</p>
      ) : held.state === 'off' ? (
        <p className="text-muted-foreground">Held results are not available in this environment.</p>
      ) : held.rows.length === 0 ? (
        <p className="text-muted-foreground">No results are held.</p>
      ) : (
        <>
          <ul className="divide-y divide-divider">
            {held.rows.map((row) => (
              <li key={row.evaluationId} className="flex flex-col py-1">
                <Link
                  className="inline-flex min-h-control items-center font-medium underline-offset-2 wrap-anywhere hover:underline"
                  to={`/patients/${row.patientId}#patient-results`}
                  aria-label={`Open held result for ${row.label ?? row.patientId}`}
                >
                  <span className={row.label ? 'slashed-zero' : 'font-mono text-xs'}>{row.label ?? row.patientId}</span>
                </Link>
                <p className="text-muted-foreground">{row.hold}</p>
              </li>
            ))}
          </ul>
          {held.total > held.rows.length && <p className="text-muted-foreground">{held.total} held results in all. Each patient’s page lists their own.</p>}
          <p className="text-xs text-muted-foreground">A held result shows no guidance yet. Each line says why.</p>
        </>
      )}
    </section>
  );
}
