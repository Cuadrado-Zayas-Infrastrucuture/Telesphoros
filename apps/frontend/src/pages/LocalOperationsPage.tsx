import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { FieldError } from '@/components/ui/FieldError';
import { useRef } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  evaluationDtoSchema,
  evaluationSummaryDtoSchema,
  correctionCreateSchema,
  correctionDtoSchema,
  disputeCreateSchema,
  disputeDtoSchema,
  disputeDecisionCreateSchema,
  cellUsageDtoSchema,
  ledgerVerifyResultSchema,
  REASONS_FOR_KIND,
  type EvaluationDto,
  type EvaluationSummaryDto,
  type DisputeDto,
  type CorrectionKind,
  type CorrectionReasonCode,
} from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function LocalOperationsPage() {
  usePageTitle('Local review operations');
  const { apiFetch, roles } = useAuth();
  const [evaluations, setEvaluations] = useState<EvaluationSummaryDto[]>([]);
  const [selected, setSelected] = useState<EvaluationDto>();
  const [disputes, setDisputes] = useState<DisputeDto[]>([]);
  const [chosen, setChosen] = useState<DisputeDto>();
  const [kind, setKind] = useState<CorrectionKind>('retraction');
  const [reason, setReason] = useState<CorrectionReasonCode>('software-defect');
  const [replacement, setReplacement] = useState('');
  const [note, setNote] = useState('');
  const [guideline, setGuideline] = useState('');
  const [table, setTable] = useState('');
  const [row, setRow] = useState('');
  const [column, setColumn] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const [cursor, setCursor] = useState<string>();
  const locked = useRef(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  function validate(
    issues: readonly { path: readonly PropertyKey[]; message: string }[],
  ) {
    const errors: Record<string, string> = {};
    for (const issue of issues) {
      const key = issue.path.join('.');
      errors[key] =
        (
          {
            guidelineId: 'Enter a guideline ID.',
            'locator.table': 'Enter a table.',
            'locator.row': 'Enter a row.',
            note: 'Enter a synthetic note.',
            evidenceNote: 'Enter decision evidence.',
            replacementEvaluationId: 'Enter a valid replacement evaluation ID.',
          } as Record<string, string>
        )[key] ?? issue.message;
    }
    setFields(errors);
    const key = Object.keys(errors)[0];
    if (key)
      document.getElementById(key === 'evidenceNote' ? 'note' : key)?.focus();
    return !!key;
  }
  const reviewer = roles.includes('reviewer');
  async function json(path: string, body?: unknown) {
    if (!import.meta.env.DEV || window.location.hostname !== '127.0.0.1')
      throw new Error('Local experiment only.');
    const response = await apiFetch(
      '/api/v1' + path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok)
      throw new Error(
        `Request refused (${response.status}). Refresh the record before retrying.`,
      );
    return response.json();
  }
  async function act(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Step failed.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function guard() {
    if (!reviewer || !confirmed)
      throw new Error('Explicit reviewer confirmation required.');
  }
  async function history() {
    const data = await json('/evaluations');
    if (!Array.isArray(data)) throw new Error('Invalid history response.');
    setEvaluations(data.map((x) => evaluationSummaryDtoSchema.parse(x)));
  }
  async function open(id: string) {
    setSelected(undefined);
    setConfirmed(false);
    setSelected(evaluationDtoSchema.parse(await json('/evaluations/' + id)));
  }
  async function correct() {
    guard();
    if (!selected) throw new Error('Open an evaluation first.');
    const last = selected.corrections.at(-1);
    const parsed = correctionCreateSchema.safeParse({
      kind,
      reasonCode: reason,
      ...(last ? { previousCorrectionId: last.id } : {}),
      ...(kind === 'supersession'
        ? { replacementEvaluationId: replacement }
        : {}),
      ...(note.trim() ? { note } : {}),
    });
    if (!parsed.success) {
      validate(parsed.error.issues);
      return;
    }
    validate([]);
    const body = parsed.data;
    correctionDtoSchema.parse(
      await json('/evaluations/' + selected.id + '/corrections', body),
    );
    await open(selected.id);
    await history();
    setNote('');
  }
  async function listDisputes() {
    const data = await json('/cell-disputes');
    if (!Array.isArray(data)) throw new Error('Invalid dispute response.');
    setDisputes(data.map((x) => disputeDtoSchema.parse(x)));
  }
  async function raise() {
    guard();
    const parsed = disputeCreateSchema.safeParse({
      guidelineId: guideline,
      locator: { table, row, ...(column.trim() ? { column } : {}) },
      note,
    });
    if (!parsed.success) {
      validate(parsed.error.issues);
      return;
    }
    validate([]);
    const body = parsed.data;
    await json('/cell-disputes', body).then(disputeDtoSchema.parse);
    setConfirmed(false);
    setNote('');
    await listDisputes();
  }
  async function decide(decision: 'upheld' | 'dismissed') {
    guard();
    if (!chosen) throw new Error('Select a dispute.');
    const parsed = disputeDecisionCreateSchema.safeParse({
      decision,
      evidenceNote: note,
    });
    if (!parsed.success) {
      validate(parsed.error.issues);
      return;
    }
    validate([]);
    const body = parsed.data;
    const updated = disputeDtoSchema.parse(
      await json('/cell-disputes/' + chosen.id + '/decision', body),
    );
    setChosen(updated);
    setConfirmed(false);
    setNote('');
    await listDisputes();
  }
  async function impact(next = false) {
    if (!chosen) throw new Error('Select a dispute.');
    const data = cellUsageDtoSchema.parse(
      await json(
        '/cell-disputes/' +
          chosen.id +
          '/evaluations?limit=50&afterSeq=' +
          (next ? (cursor ?? '0') : '0'),
      ),
    );
    setCursor(data.nextAfterSeq ?? undefined);
    setOutput(JSON.stringify(data, null, 2));
  }
  return (
    <div className="min-w-0 space-y-6">
      <h1 className="text-2xl">Local review operations</h1>
      <p>
        Synthetic records only. Clinical use: not approved. Changes are explicit
        reviewer actions; the server enforces identity, stale-record and tenant
        rules.
      </p>
      <Button asChild variant="outline">
        <Link to="/local-review">PDF capture and review</Link>
      </Button>
      <section className="space-y-3">
        <h2 className="text-xl">Evaluation history</h2>
        <Button disabled={busy} onClick={() => void act(history)}>
          Refresh evaluations
        </Button>
        <div
          role="region"
          aria-label="Evaluation history table"
          tabIndex={0}
          className="max-w-full overflow-auto"
        >
          <table className="w-full">
            <caption className="sr-only">Synthetic evaluation history</caption>
            <thead>
              <tr>
                <th scope="col">Evaluation</th>
                <th scope="col">State</th>
                <th scope="col">Disposition</th>
                <th scope="col">Current</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td>{e.state}</td>
                  <td>{e.disposition}</td>
                  <td>{e.current ? 'yes' : 'no'}</td>
                  <td>
                    <Button
                      className="h-auto min-h-control whitespace-normal break-all py-2"
                      disabled={busy}
                      onClick={() => void act(() => open(e.id))}
                    >
                      Open {e.id}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected && (
          <>
            <p className="break-all">
              Selected: {selected.id}. State: {selected.state}. Actionable:
              false. A retraction must be reinstated by a different reviewer.
            </p>
            <pre
              role="region"
              aria-label="Synthetic record details"
              tabIndex={0}
              className="max-w-full overflow-auto rounded-md border border-border p-3"
            >
              {JSON.stringify(selected, null, 2)}
            </pre>
            <label htmlFor="localoperationspage-control-1" className="block">
              Correction{' '}
              <NativeSelect
                id="localoperationspage-control-1"
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as CorrectionKind;
                  setKind(k);
                  setReason(REASONS_FOR_KIND[k][0] as CorrectionReasonCode);
                  setConfirmed(false);
                }}
              >
                {(['retraction', 'supersession', 'reinstatement'] as const).map(
                  (k) => (
                    <option key={k}>{k}</option>
                  ),
                )}
              </NativeSelect>
            </label>
            <label htmlFor="localoperationspage-control-2" className="block">
              Reason{' '}
              <NativeSelect
                id="localoperationspage-control-2"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value as CorrectionReasonCode);
                  setConfirmed(false);
                }}
              >
                {REASONS_FOR_KIND[kind].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </NativeSelect>
            </label>
            {kind === 'supersession' && (
              <>
                <label htmlFor="replacementEvaluationId" className="block">
                  Replacement evaluation ID{' '}
                  <Input
                    id="replacementEvaluationId"
                    aria-invalid={!!fields['replacementEvaluationId']}
                    aria-describedby={
                      fields['replacementEvaluationId']
                        ? 'replacementEvaluationId-error'
                        : undefined
                    }
                    value={replacement}
                    onChange={(e) => {
                      setReplacement(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <FieldError
                  id="replacementEvaluationId-error"
                  message={fields['replacementEvaluationId']}
                />
              </>
            )}
            <Button
              disabled={busy || !reviewer || !confirmed}
              onClick={() => void act(correct)}
            >
              Record correction
            </Button>
          </>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl">Guideline-cell disputes</h2>
        <Button disabled={busy} onClick={() => void act(listDisputes)}>
          Refresh disputes
        </Button>
        <ul>
          {disputes.map((d) => (
            <li key={d.id}>
              <Button
                className="h-auto min-h-control whitespace-normal break-all py-2"
                disabled={busy}
                onClick={() => {
                  setChosen(d);
                  setConfirmed(false);
                  setCursor(undefined);
                  setOutput('');
                }}
              >
                {d.id} — {d.status}
              </Button>
            </li>
          ))}
        </ul>
        <label htmlFor="guidelineId" className="block">
          Guideline ID{' '}
          <Input
            id="guidelineId"
            aria-invalid={!!fields['guidelineId']}
            aria-describedby={
              fields['guidelineId'] ? 'guidelineId-error' : undefined
            }
            value={guideline}
            onChange={(e) => {
              setGuideline(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <FieldError id="guidelineId-error" message={fields['guidelineId']} />
        <label htmlFor="locator.table" className="block">
          Table{' '}
          <Input
            id="locator.table"
            aria-invalid={!!fields['locator.table']}
            aria-describedby={
              fields['locator.table'] ? 'locator.table-error' : undefined
            }
            value={table}
            onChange={(e) => {
              setTable(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <FieldError
          id="locator.table-error"
          message={fields['locator.table']}
        />
        <label htmlFor="locator.row" className="block">
          Row{' '}
          <Input
            id="locator.row"
            aria-invalid={!!fields['locator.row']}
            aria-describedby={
              fields['locator.row'] ? 'locator.row-error' : undefined
            }
            value={row}
            onChange={(e) => {
              setRow(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <FieldError id="locator.row-error" message={fields['locator.row']} />
        <label htmlFor="locator.column" className="block">
          Column (optional){' '}
          <Input
            id="locator.column"
            aria-invalid={!!fields['locator.column']}
            aria-describedby={
              fields['locator.column'] ? 'locator.column-error' : undefined
            }
            value={column}
            onChange={(e) => {
              setColumn(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <FieldError
          id="locator.column-error"
          message={fields['locator.column']}
        />
        <Button
          disabled={busy || !reviewer || !confirmed}
          onClick={() => void act(raise)}
        >
          Raise dispute
        </Button>
        {chosen && (
          <>
            <p className="break-all">
              Selected dispute: {chosen.id}. Status: {chosen.status}.
            </p>
            <Button
              disabled={
                busy || !reviewer || !confirmed || chosen.status !== 'open'
              }
              onClick={() => void act(() => decide('upheld'))}
            >
              Uphold dispute
            </Button>{' '}
            <Button
              disabled={
                busy || !reviewer || !confirmed || chosen.status !== 'open'
              }
              onClick={() => void act(() => decide('dismissed'))}
            >
              Dismiss dispute
            </Button>
            <p>
              A different reviewer must decide; the raiser is refused by the
              API.
            </p>
            <Button disabled={busy} onClick={() => void act(() => impact())}>
              Show affected evaluations
            </Button>
            {cursor && (
              <Button
                disabled={busy}
                onClick={() => void act(() => impact(true))}
              >
                Next impact page
              </Button>
            )}
          </>
        )}
      </section>
      <label htmlFor="note" className="block">
        Synthetic note or decision evidence{' '}
        <Textarea
          maxLength={1000}
          id="note"
          aria-invalid={!!fields['note'] || !!fields.evidenceNote}
          aria-describedby={
            fields['note'] || fields.evidenceNote ? 'note-error' : undefined
          }
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <FieldError
        id="note-error"
        message={fields['note'] ?? fields.evidenceNote}
      />
      <label
        htmlFor="localoperationspage-control-9"
        className="flex min-h-control items-center gap-3"
      >
        <Checkbox
          id="localoperationspage-control-9"
          disabled={busy}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{' '}
        I reviewed the selected record and intend this synthetic change
      </label>
      {roles.includes('admin') && (
        <Button
          disabled={busy}
          onClick={() =>
            void act(async () =>
              setOutput(
                JSON.stringify(
                  ledgerVerifyResultSchema.parse(
                    await json('/ledger/verify?full=true'),
                  ),
                  null,
                  2,
                ),
              ),
            )
          }
        >
          Verify full ledger
        </Button>
      )}
      {busy && <p role="status">Working locally…</p>}
      {error && <p role="alert">{error}</p>}
      {output && (
        <pre
          role="region"
          aria-label="Synthetic record details"
          tabIndex={0}
          className="max-w-full overflow-auto rounded-md border border-border p-3"
        >
          {output}
        </pre>
      )}
    </div>
  );
}
