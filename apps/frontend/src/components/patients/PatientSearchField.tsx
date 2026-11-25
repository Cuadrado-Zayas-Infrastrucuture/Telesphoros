import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { PatientSearch } from '@/hooks/usePatientSearch';

export interface PatientSearchFieldProps {
  /** Current search state from `usePatientSearch`. */
  state: PatientSearch;
  /** Runs a server search for `text` across all patients. */
  onSearch: (text: string) => void;
  /** Loads the next page of matches for the active search. */
  onMore: () => void;
  /** Resets the search back to `idle` so the picker returns to the loaded pages. */
  onReset: () => void;
  /** Disable controls while an upload is in flight. */
  disabled?: boolean;
  /** Optional explicit id for the input (defaults to a generated id). */
  id?: string;
}

function foundSentence(total: number) {
  return total === 0 ? 'Searched all patients: no match.' : `Searched all patients: ${total} ${total === 1 ? 'match' : 'matches'}.`;
}

/**
 * Spec 040 slice C (PS-11, PS-12): reusable server-backed patient search above a `PatientPicker`.
 *
 * Intentionally renders no `<form>` element so it can live inside `UploadReportPage`'s upload form
 * and `WorkspaceConversation`'s drawer; pressing Enter submits only the search and never an outer form.
 */
export function PatientSearchField({ state, onSearch, onMore, onReset, disabled = false, id }: PatientSearchFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const refusedId = `${inputId}-refused`;
  const scopeId = `${inputId}-scope`;
  const [query, setQuery] = useState('');

  const found = state.status === 'found' ? state : null;
  const showClear = query.length > 0 || state.status !== 'idle';
  const describedBy = [state.status === 'refused' ? refusedId : null, found ? scopeId : null].filter(Boolean).join(' ') || undefined;

  function submit() {
    if (disabled) return;
    onSearch(query.trim());
  }

  function clear() {
    setQuery('');
    onReset();
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={inputId}>Find a patient</label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          className="min-w-0 flex-1 basis-44"
          aria-describedby={describedBy}
          aria-invalid={state.status === 'refused' || undefined}
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            if (state.status !== 'idle') onReset();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              submit();
            }
          }}
          autoComplete="off"
          spellCheck={false}
          placeholder="Patient code"
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-control"
          disabled={disabled}
          pending={state.status === 'searching'}
          pendingLabel="Searching all patients…"
          onClick={submit}
        >
          Search all patients
        </Button>
        {showClear && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label="Clear patient search" onClick={clear}>
            Clear
          </Button>
        )}
      </div>
      {state.status === 'refused' && (
        <p id={refusedId} className="text-xs text-destructive">
          {state.message}
        </p>
      )}
      <p id={scopeId} aria-live="polite" className="text-xs text-muted-foreground">
        {found ? foundSentence(found.total) : ''}
      </p>
      {state.status === 'failed' && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-xs text-destructive">
            {state.message}
          </p>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onSearch(state.text)} aria-label="Retry searching all patients">
            Retry
          </Button>
        </div>
      )}
      {found?.moreFailed && (
        <p role="alert" className="text-xs text-destructive">
          More matches could not be loaded. Please retry.
        </p>
      )}
      {found?.hasMore && (
        <Button type="button" variant="outline" size="sm" className="self-start" disabled={disabled} pending={found.loadingMore} pendingLabel="Loading matches…" onClick={onMore}>
          More matches
        </Button>
      )}
    </div>
  );
}
