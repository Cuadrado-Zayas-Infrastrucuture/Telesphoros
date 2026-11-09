import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import type { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import type { EvaluationPageView, EvaluationView, Projected } from '../storage/ledger-records';
import type { Principal } from '../auth/principal';
import { EvaluationsService } from './evaluations.service';

// Whether a result's guidelines are still the loaded ones. Each kind of evaluation is compared with its own set, and a dispute overlay is not a change.
const LAB = 'lab-set';
const SYNTHETIC = 'synthetic-set';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { tenantId: 't' } as Principal;

const pdf = (over: Record<string, unknown> = {}): Projected =>
  ({
    kind: 'evaluation',
    id: uuid(1),
    patientId: uuid(2),
    reportId: uuid(3),
    captureId: uuid(4),
    disposition: 'evaluated',
    holdCode: null,
    binding: {},
    knowledgeSetId: LAB,
    engineVersion: 'engine',
    geneInputs: [],
    results: [],
    geneStates: [],
    createdAt: '2026-11-08T00:00:00.000000Z',
    ...over,
  }) as unknown as Projected;
const structured = (over: Record<string, unknown> = {}) => pdf({ captureId: null, structuredRevisionId: uuid(5), knowledgeSetId: SYNTHETIC, ...over });

function service(record: Projected, sets: { lab?: string; synthetic?: string } = { lab: LAB, synthetic: SYNTHETIC }) {
  const context = { acceptance: null, corrections: [] };
  const view: EvaluationView = { record, context, current: true, patientLink: 'verified', activeDisputes: 0 };
  const page = {
    items: [record],
    total: 1,
    contexts: new Map([[record.id as string, context]]),
    currentIds: new Map([[record.reportId as string, record.id as string]]),
    links: new Map([[record.reportId as string, 'verified']]),
    activeDisputes: 0,
  } as unknown as EvaluationPageView;
  const ledger = { evaluationView: async () => view, evaluationPage: async () => page } as unknown as LedgerRecordsRepository;
  const set = (id?: string) => (id === undefined ? undefined : ({ id } as KnowledgeSet));
  return new EvaluationsService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    ledger,
    undefined,
    set(sets.lab),
    undefined,
    undefined,
    undefined,
    set(sets.synthetic),
  );
}

/** What the detail and the list both say, asserted to agree. */
async function advisoryOf(record: Projected, sets?: { lab?: string; synthetic?: string }) {
  const s = service(record, sets);
  const detail = await s.get(principal, record.id as string);
  const listed = await s.list(principal, { page: 1, pageSize: 10 });
  expect(listed.data[0]!.advisory.knowledge).toEqual(detail.advisory.knowledge);
  return detail.advisory.knowledge;
}

describe('advisory.knowledge', () => {
  it('reads same while a PDF evaluation used the set loaded for the pipeline', async () => {
    expect(await advisoryOf(pdf())).toEqual({ evaluatedWith: LAB, loadedNow: LAB, status: 'same' });
  });

  it('reads changed once another set is loaded, keeping both ids', async () => {
    expect(await advisoryOf(pdf(), { lab: 'next-release', synthetic: SYNTHETIC })).toEqual({ evaluatedWith: LAB, loadedNow: 'next-release', status: 'changed' });
  });

  it('compares a structured evaluation with the synthetic set, and only that one', async () => {
    expect(await advisoryOf(structured())).toEqual({ evaluatedWith: SYNTHETIC, loadedNow: SYNTHETIC, status: 'same' });
    expect(await advisoryOf(structured(), { lab: SYNTHETIC, synthetic: 'next-release' })).toEqual({ evaluatedWith: SYNTHETIC, loadedNow: 'next-release', status: 'changed' });
  });

  it('compares a dispute overlay by its base set: the effective id is not a release', async () => {
    const overlaid = pdf({ knowledgeSetId: 'effective-id', binding: { overlay: { version: 'overlay/1', baseKnowledgeSetId: LAB, cellKeys: ['k'] } } });
    expect(await advisoryOf(overlaid)).toEqual({ evaluatedWith: LAB, loadedNow: LAB, status: 'same' });
    expect(await advisoryOf(overlaid, { lab: 'next-release', synthetic: SYNTHETIC })).toMatchObject({ evaluatedWith: LAB, status: 'changed' });
  });

  it('reads unknown, and claims nothing, when that kind of evaluation is switched off', async () => {
    expect(await advisoryOf(pdf(), { synthetic: SYNTHETIC })).toEqual({ evaluatedWith: LAB, loadedNow: null, status: 'unknown' });
    expect(await advisoryOf(structured(), { lab: LAB })).toEqual({ evaluatedWith: SYNTHETIC, loadedNow: null, status: 'unknown' });
  });
});
