import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { PatientSearch } from '@/hooks/usePatientSearch';

/**
 * Spec 040 slice C: a search of every patient, for a patient choice that shows one page at a time (Attach a report). The field never filters
 * as the person types; Search all patients, or Enter, asks the server (D4). Only a 200 says the whole list was searched; any other answer
 * says it was not, with Retry, and the caller keeps its loaded choices (PS-10, PS-11). Changing the text drops the search.
 *
 * It is not a form: it sits inside the upload form, so Enter here searches and never submits the upload.
 */
export function PatientSearchField({
  state,
  onSearch,
  onMore,
  onReset,
}: {
  state: PatientSearch;
  onSearch: (text: string) => void;
  onMore: () => void;
  onReset: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const found = state.status === 'found' ? state : null;
  const sentence = found
    ? found.total === 0
      ? 'Searched all patients: no match.'
      : `Searched all patients: ${found.total} ${found.total === 1 ? 'match' : 'matches'}. The choices below are the matches.`
    : 'The list below shows one page at a time. Search all patients looks through every one.';
  const describedBy = state.status === 'refused' ? `${id}-refused ${id}-scope` : `${id}-scope`;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={`${id}-text`}>Find a patient</label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${id}-text`}
          className="min-w-0 flex-1 basis-48"
          aria-describedby={describedBy}
          aria-invalid={state.status === 'refused' || undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onReset();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onSearch(text.trim());
          }}
          autoComplete="off"
          spellCheck={false}
          placeholder="Patient code"
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-control"
          pending={state.status === 'searching'}
          pendingLabel="Searching all patients…"
          onClick={() => onSearch(text.trim())}
        >
          Search all patients
        </Button>
      </div>
      {state.status === 'refused' && (
        <p id={`${id}-refused`} className="text-xs text-destructive">
          {state.message}
        </p>
      )}
      <p id={`${id}-scope`} aria-live="polite" className="text-xs text-muted-foreground">
        {sentence}
      </p>
      {state.status === 'failed' && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-destructive">
            {state.message}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => onSearch(state.text)} aria-label="Retry searching all patients">
            Retry
          </Button>
        </div>
      )}
      {found?.moreFailed && (
        <p role="alert" className="text-destructive">
          More matches could not be loaded. Please retry.
        </p>
      )}
      {found?.hasMore && (
        <Button type="button" variant="outline" size="sm" className="self-start" pending={found.loadingMore} pendingLabel="Loading matches…" onClick={onMore}>
          More matches
        </Button>
      )}
    </div>
  );
}
