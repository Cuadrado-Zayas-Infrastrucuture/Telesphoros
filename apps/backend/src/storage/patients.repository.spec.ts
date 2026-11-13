import { randomUUID } from 'node:crypto';
import { InMemoryPatientsRepository } from './patients.repository';
import type { PatientRecord } from './records';

/** Spec 040, PS-2, PS-4 and PS-7 on the in-memory store, which has no row-level security behind it: the tenant filter is the only layer. */
const page = { offset: 0, limit: 20 };
const at = (n: number) => new Date(Date.UTC(2026, 10, 13, 0, 0, n)).toISOString();
const record = (tenantId: string, label: string, n: number): PatientRecord => ({
  id: randomUUID(),
  tenantId,
  createdBy: 'syn-clinician',
  label,
  createdAt: at(n),
  updatedAt: at(n),
});

async function store() {
  const repo = new InMemoryPatientsRepository();
  await repo.insert(record('syn-t1', 'SYN-1', 1));
  await repo.insert(record('syn-t1', 'SYN-A1', 2));
  await repo.insert(record('syn-t1', 'OTHER-2', 3));
  await repo.insert(record('syn-t2', 'SYN-1', 4));
  return repo;
}

describe('InMemoryPatientsRepository.list with a label search', () => {
  it('counts and pages the matches of one tenant only', async () => {
    const repo = await store();
    const found = await repo.list('syn-t1', page, { labelContains: 'syn-' });
    expect(found.items.map((p) => [p.tenantId, p.label])).toEqual([
      ['syn-t1', 'SYN-1'],
      ['syn-t1', 'SYN-A1'],
    ]);
    expect(found.total).toBe(2);
    const second = await repo.list('syn-t1', { offset: 1, limit: 1, order: 'desc' }, { labelContains: 'SYN' });
    expect(second).toEqual({ items: [expect.objectContaining({ label: 'SYN-1' })], total: 2 });
  });

  it('matches the text literally', async () => {
    const repo = await store();
    for (const text of ['%', '_', "'", '\\', 'SYN_1']) expect((await repo.list('syn-t1', page, { labelContains: text })).total).toBe(0);
  });

  it('control: without a search the tenant reads every patient, as before', async () => {
    expect((await (await store()).list('syn-t1', page)).total).toBe(3);
  });
});
