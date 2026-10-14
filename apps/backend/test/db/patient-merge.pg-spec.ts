import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { LedgerIntegrityError, MergeAlreadyDecidedError, MergeRefusedError } from '../../src/ledger/ledger-types';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { seedLabReport } from '../helpers/ledger-fixtures';

/**
 * Possible-duplicate flags and the merge of two patient records, at the database (migration 0021): who may write what, the graph rules the
 * database enforces on its own (at COMMIT, under the ledger lock), and that a merge rewrites no row.
 */
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let verifier: LedgerVerifier;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
  verifier = LedgerVerifier.connect(pg.verifierUrl);
});
afterAll(async () => {
  await verifier?.close();
  await database?.onModuleDestroy();
  await pg?.drop();
});

const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);
const PROPOSER = 'syn-proposer';
const DECIDER = 'syn-decider';

async function patient(t: string, label = `SYN-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await owner((c) => c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-registrar', $3)`, [id, t, label]));
  return id;
}

async function asApplication<T>(tenantId: string | null, actor: string, work: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: pg.appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const propose = (t: string, kind: 'merge' | 'unmerge', source: string, target: string, by = PROPOSER, reasonCode = kind === 'merge' ? 'entered-twice' : 'merged-by-mistake') =>
  repo.insertMergeProposal(t, by, { kind, sourcePatientId: source, targetPatientId: target, reasonCode });
const decide = (t: string, proposalId: string, decision: 'approved' | 'declined', by = DECIDER) => repo.insertMergeDecision(t, by, { proposalId, decision });
/** Propose and approve in one go, as two different people. */
async function merged(t: string, source: string, target: string) {
  const p = await propose(t, 'merge', source, target);
  await decide(t, p.record.id, 'approved');
}
const groupOf = (t: string, patientId: string) => owner(async (c) => (await c.query<{ id: string }>(`SELECT patient_group_ids($1, $2::uuid)::text AS id`, [t, patientId])).rows.map((r) => r.id).sort());
const mergedInto = (t: string, patientId: string) => owner(async (c) => (await c.query<{ id: string | null }>(`SELECT patient_merged_into($1, $2::uuid)::text AS id`, [t, patientId])).rows[0]?.id ?? null);

describe('patient_duplicate_flags', () => {
  const flag = (t: string, a: string, b: string, system = 'hospital-a-mrn') => {
    const [x, y] = [a, b].sort();
    return asApplication(t, 'syn-clinician', (c) => c.query(`INSERT INTO patient_duplicate_flags (tenant_id, patient_id, other_patient_id, system, flagged_by) VALUES ($1, $2, $3, $4, 'syn-clinician')`, [t, x, y, system]));
  };

  it('lets the application login read and add flags within its own organization, and nothing else (no update, delete or truncate)', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    await flag(t, a, b);
    expect((await asApplication(t, 'syn-clinician', (c) => c.query('SELECT system FROM patient_duplicate_flags'))).rows).toEqual([{ system: 'hospital-a-mrn' }]);
    for (const sql of ['UPDATE patient_duplicate_flags SET system = \'x\'', 'DELETE FROM patient_duplicate_flags', 'TRUNCATE patient_duplicate_flags']) {
      await expect(asApplication(t, 'syn-clinician', (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses even the owner an edit, a delete or a truncate', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    await flag(t, a, b);
    await expect(owner((c) => c.query(`UPDATE patient_duplicate_flags SET system = 'x' WHERE tenant_id = $1`, [t]))).rejects.toMatchObject({ code: '23000' });
    await expect(owner((c) => c.query(`DELETE FROM patient_duplicate_flags WHERE tenant_id = $1`, [t]))).rejects.toMatchObject({ code: '23000' });
    await expect(owner((c) => c.query('TRUNCATE patient_duplicate_flags'))).rejects.toMatchObject({ code: '23000' });
  });

  it('keeps one flag per unordered pair, in a fixed order, and only between two patients of the same organization', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    await flag(t, a, b);
    await expect(flag(t, b, a)).rejects.toMatchObject({ code: '23505' }); // the same pair again, written either way round
    const [lo, hi] = [a, b].sort();
    await expect(asApplication(t, 'syn-clinician', (c) => c.query(`INSERT INTO patient_duplicate_flags (tenant_id, patient_id, other_patient_id, system, flagged_by) VALUES ($1, $2, $3, 'x', 'p')`, [t, hi, lo]))).rejects.toMatchObject({ code: '23514' });
    const other = tenant();
    const foreign = await patient(other);
    await expect(flag(t, a, foreign)).rejects.toMatchObject({ code: '23503' }); // a patient of another organization
  });

  it('is invisible to another organization, and holds no identifier or digest in any column', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    await flag(t, a, b);
    expect((await asApplication(tenant(), 'syn-clinician', (c) => c.query('SELECT 1 FROM patient_duplicate_flags'))).rowCount).toBe(0);
    const columns = await owner((c) => c.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'patient_duplicate_flags' ORDER BY ordinal_position`));
    expect(columns.rows.map((r) => r.column_name)).toEqual(['seq', 'id', 'tenant_id', 'patient_id', 'other_patient_id', 'system', 'flagged_by', 'flagged_at']);
  });
});

describe('merge proposals and decisions', () => {
  it('records a proposal and a decision by two different people, both as ledger records the verifier accepts', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, 'merge', a, b);
    expect(p.record).toMatchObject({ kind: 'patient-merge-proposal', mergeKind: 'merge', sourcePatientId: a, targetPatientId: b, reasonCode: 'entered-twice', createdBy: PROPOSER });
    const d = await decide(t, p.record.id, 'approved');
    expect(d.record).toMatchObject({ kind: 'patient-merge-decision', proposalId: p.record.id, decision: 'approved', createdBy: DECIDER });
    expect(await verifier.verify(t)).toMatchObject({ status: 'ok', eventsChecked: 2 });
  });

  it('refuses a decision by the proposer, even written straight to the table by the owner', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, 'merge', a, b);
    await expect(decide(t, p.record.id, 'approved', PROPOSER)).rejects.toBeInstanceOf(LedgerIntegrityError);
    await expect(
      owner(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(`INSERT INTO patient_merge_decisions (tenant_id, created_by, ledger_event_id, proposal_id, decision) VALUES ($1, $2, gen_random_uuid(), $3, 'approved')`, [t, PROPOSER, p.record.id]);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '23000' });
  });

  it('allows one decision per proposal: the same again returns it, a different one is refused', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, 'merge', a, b);
    const first = await decide(t, p.record.id, 'declined');
    const again = await decide(t, p.record.id, 'declined');
    expect(again).toMatchObject({ created: false, record: { id: first.record.id } });
    await expect(decide(t, p.record.id, 'approved')).rejects.toBeInstanceOf(MergeAlreadyDecidedError);
  });

  it('refuses the frozen vocabulary being broken: a merge for a mistake, an unmerge for a duplicate, an unknown kind or reason, a patient with itself', async () => {
    const t = tenant();
    const [a, b, c, d] = [await patient(t), await patient(t), await patient(t), await patient(t)];
    await merged(t, a, b); // so that an unmerge of a into b is possible and only its reason can be wrong
    const bad = (source: string, target: string, kind: string, reason: string) =>
      repo.insertMergeProposal(t, PROPOSER, { kind: kind as 'merge', sourcePatientId: source, targetPatientId: target, reasonCode: reason });
    for (const [kind, reason] of [['unmerge', 'entered-twice'], ['unmerge', 'shared-identifier'], ['unmerge', 'because'], ['swap', 'merged-by-mistake']]) {
      await expect(bad(a, b, kind!, reason!)).rejects.toBeInstanceOf(LedgerIntegrityError);
    }
    for (const [kind, reason] of [['merge', 'merged-by-mistake'], ['merge', 'because']]) {
      await expect(bad(c, d, kind!, reason!)).rejects.toBeInstanceOf(LedgerIntegrityError);
    }
    await expect(propose(t, 'merge', a, a)).rejects.toMatchObject({ reason: 'same-patient' });
  });

  it('keeps the two organizations apart: a patient of another organization cannot be named, and nothing leaks across', async () => {
    const t = tenant();
    const a = await patient(t);
    const foreign = await patient(tenant());
    await expect(propose(t, 'merge', a, foreign)).rejects.toThrow(); // the foreign key (and row-level security) refuse it
    const other = tenant();
    const [c1, c2] = [await patient(other), await patient(other)];
    const p = await propose(other, 'merge', c1, c2);
    expect(await repo.findMerge(t, p.record.id)).toBeUndefined();
    expect((await repo.pageMerges(t, { offset: 0, limit: 20 })).items.map((i) => i.proposal.id)).not.toContain(p.record.id);
  });

  it('lets the application login write the two records only through the ledger (no table-wide update, delete or truncate)', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, 'merge', a, b);
    for (const table of ['patient_merge_proposals', 'patient_merge_decisions']) {
      for (const sql of [`UPDATE ${table} SET created_by = 'x'`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        await expect(asApplication(t, 'syn-clinician', (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      }
    }
    await expect(owner((c) => c.query(`UPDATE patient_merge_proposals SET reason_code = 'entered-twice' WHERE id = $1`, [p.record.id]))).rejects.toMatchObject({ code: '23000' });
  });
});

describe('what a merge does, and refuses', () => {
  it('makes the source an alias of the target, rewrites no row, and an unmerge restores the groups exactly', async () => {
    const t = tenant();
    const r = await owner(async (c) => {
      const [a, b] = [randomUUID(), randomUUID()];
      for (const [id, label] of [[a, 'SYN-ALPHA'], [b, 'SYN-BRAVO']]) await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-registrar', $3)`, [id, t, label]);
      return { a: a!, b: b! };
    });
    const fingerprint = () => owner(async (c) => createHash('sha256').update(JSON.stringify((await c.query(`SELECT * FROM patients WHERE tenant_id = $1 ORDER BY id`, [t])).rows)).digest('hex'));
    const before = await fingerprint();
    await merged(t, r.a, r.b);
    expect(await mergedInto(t, r.a)).toBe(r.b);
    expect(await mergedInto(t, r.b)).toBeNull();
    expect(await groupOf(t, r.a)).toEqual([r.a, r.b].sort());
    expect(await groupOf(t, r.b)).toEqual([r.a, r.b].sort()); // resolved from either end
    expect(await fingerprint()).toBe(before); // nothing about either patient row moved
    const un = await propose(t, 'unmerge', r.a, r.b);
    await decide(t, un.record.id, 'approved');
    expect(await mergedInto(t, r.a)).toBeNull();
    expect(await groupOf(t, r.a)).toEqual([r.a]);
    expect(await groupOf(t, r.b)).toEqual([r.b]);
    expect(await fingerprint()).toBe(before);
    expect(await verifier.verify(t)).toMatchObject({ status: 'ok', eventsChecked: 4 });
  });

  it('changes nothing for a declined proposal, and allows a new proposal for the same pair afterwards', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, 'merge', a, b);
    await decide(t, p.record.id, 'declined');
    expect(await mergedInto(t, a)).toBeNull();
    expect(await groupOf(t, a)).toEqual([a]);
    await merged(t, a, b); // a later, separate proposal can still be approved
    expect(await mergedInto(t, a)).toBe(b);
  });

  it('refuses, when proposed, a merge that cannot happen now: source already merged, target merged, source with aliases, nothing to undo, a gone patient', async () => {
    const t = tenant();
    const [a, b, c, d] = [await patient(t), await patient(t), await patient(t), await patient(t)];
    await merged(t, a, b);
    await expect(propose(t, 'merge', a, c)).rejects.toMatchObject({ name: 'MergeRefusedError', reason: 'source-merged' });
    await expect(propose(t, 'merge', c, a)).rejects.toMatchObject({ reason: 'target-merged' });
    await expect(propose(t, 'merge', b, c)).rejects.toMatchObject({ reason: 'source-has-aliases' });
    await expect(propose(t, 'unmerge', c, d)).rejects.toMatchObject({ reason: 'not-merged' });
    await expect(propose(t, 'unmerge', b, a)).rejects.toMatchObject({ reason: 'not-merged' }); // the wrong way round
    await owner((x) => x.query(`UPDATE patients SET deleted_at = now() WHERE id = $1`, [d]));
    await expect(propose(t, 'merge', c, d)).rejects.toMatchObject({ reason: 'patient-gone' });
    expect(await groupOf(t, a)).toEqual([a, b].sort()); // none of the refusals changed anything
  });

  it('refuses a second undecided proposal for the same pair and kind', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    await propose(t, 'merge', a, b);
    await expect(propose(t, 'merge', a, b, 'syn-other-proposer')).rejects.toMatchObject({ reason: 'proposal-pending' });
  });

  it('checks the merge again when it is decided: a proposal that was possible when made but is not any more is refused, under the ledger lock', async () => {
    const t = tenant();
    const [a, b, c] = [await patient(t), await patient(t), await patient(t)];
    const one = await propose(t, 'merge', a, b);
    const two = await propose(t, 'merge', a, c); // both were possible when proposed
    await decide(t, one.record.id, 'approved');
    await expect(decide(t, two.record.id, 'approved')).rejects.toMatchObject({ name: 'MergeRefusedError', reason: 'source-merged' });
    expect(await mergedInto(t, a)).toBe(b);
    // the refused decision left nothing behind: the proposal can still be declined
    await decide(t, two.record.id, 'declined');
  });

  it('keeps groups one level deep: a patient that has aliases cannot itself become an alias, and an alias cannot be merged into', async () => {
    const t = tenant();
    const [a, b, c] = [await patient(t), await patient(t), await patient(t)];
    const bIntoC = await propose(t, 'merge', b, c); // possible while nothing is merged
    const cIntoA = await propose(t, 'merge', c, a);
    await merged(t, a, b); // now a is an alias of b
    await expect(decide(t, bIntoC.record.id, 'approved')).rejects.toMatchObject({ reason: 'source-has-aliases' });
    await expect(decide(t, cIntoA.record.id, 'approved')).rejects.toMatchObject({ reason: 'target-merged' });
    expect(await groupOf(t, b)).toEqual([a, b].sort());
    expect(await groupOf(t, c)).toEqual([c]);
  });

  it('lets two decisions race and lets exactly one win', async () => {
    const t = tenant();
    const [a, b, c] = [await patient(t), await patient(t), await patient(t)];
    const one = await propose(t, 'merge', a, b);
    const two = await propose(t, 'merge', a, c);
    const results = await Promise.allSettled([decide(t, one.record.id, 'approved'), decide(t, two.record.id, 'approved', 'syn-decider-2')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(MergeRefusedError);
    expect((await groupOf(t, a)).length).toBe(2); // a is merged into exactly one of them
  });

  it('enforces the graph rule in the database itself, whoever writes: the owner cannot approve an impossible merge either', async () => {
    const t = tenant();
    const [a, b, c] = [await patient(t), await patient(t), await patient(t)];
    await merged(t, a, b);
    const impossible = await propose(t, 'merge', c, a).catch(() => null); // refused already when proposed
    expect(impossible).toBeNull();
    // Write the proposal and an approving decision directly, with the commit-time rule made immediate, and roll everything back.
    const refused = owner(async (x) => {
      await x.query('BEGIN');
      try {
        const proposalId = randomUUID();
        await x.query(`INSERT INTO patient_merge_proposals (id, tenant_id, created_by, ledger_event_id, kind, source_patient_id, target_patient_id, reason_code) VALUES ($1, $2, 'syn-p', gen_random_uuid(), 'merge', $3, $4, 'entered-twice')`, [proposalId, t, c, a]);
        await x.query('SET CONSTRAINTS patient_merge_decisions_graph IMMEDIATE');
        await x.query(`INSERT INTO patient_merge_decisions (tenant_id, created_by, ledger_event_id, proposal_id, decision) VALUES ($1, 'syn-d', gen_random_uuid(), $2, 'approved')`, [t, proposalId]);
      } finally {
        await x.query('ROLLBACK');
      }
    });
    await expect(refused).rejects.toMatchObject({ code: 'PM001', message: 'target-merged' });
  });

  it('is usable only through its functions by the application login, and the functions respect row-level security', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    await merged(t, a, b);
    const seenByApp = await asApplication(t, 'syn-clinician', async (c) => (await c.query<{ id: string }>(`SELECT patient_group_ids($1, $2::uuid)::text AS id`, [t, a])).rows.map((r) => r.id).sort());
    expect(seenByApp).toEqual([a, b].sort());
    // Another organization's session asking about this organization's patients sees only the patient itself: it cannot read the merge records.
    const other = tenant();
    const seenByOther = await asApplication(other, 'syn-clinician', async (c) => (await c.query<{ id: string }>(`SELECT patient_group_ids($1, $2::uuid)::text AS id`, [t, a])).rows.map((r) => r.id));
    expect(seenByOther).toEqual([a]);
  });
});

describe('a link verified by identifier, once patients are merged', () => {
  const digest = () => Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex');
  const identifierOf = (t: string, patientId: string) =>
    owner(async (c) => (await c.query<{ id: string }>(`INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, created_by) VALUES ($1, $2, 'hospital-a-mrn', $3, 'syn-registrar') RETURNING id::text AS id`, [t, patientId, digest()])).rows[0]!.id);
  const match = (r: { tenantId: string; reportId: string; patientId: string; pdfSha256: string; objectVersion: string }, identifierId: string) =>
    repo.insertPatientDecision(r.tenantId, 'syn-reviewer', {
      reportId: r.reportId,
      expectedReport: { patientId: r.patientId, sha256: r.pdfSha256, objectVersion: r.objectVersion },
      decision: 'verified',
      method: 'identifier-match',
      identifierId,
    });

  it('accepts an identifier held by a patient of the report\'s patient\'s group, and still refuses one held by an unrelated patient', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t, 'syn-uploader');
    const root = await patient(t);
    const stranger = await patient(t);
    const rootIdentifier = await identifierOf(t, root);
    const strangerIdentifier = await identifierOf(t, stranger);
    await expect(match(report, rootIdentifier)).rejects.toBeInstanceOf(LedgerIntegrityError); // not one group yet
    await merged(t, report.patientId, root);
    await expect(match(report, strangerIdentifier)).rejects.toBeInstanceOf(LedgerIntegrityError); // never an unrelated patient's
    const decision = await match(report, rootIdentifier);
    expect(decision.record).toMatchObject({ decision: 'verified', method: 'identifier-match', identifierId: rootIdentifier, patientId: report.patientId });
    // The decision stays what it was when made: undoing the merge does not reach back and unverify it.
    const un = await propose(t, 'unmerge', report.patientId, root);
    await decide(t, un.record.id, 'approved');
    expect((await repo.latestPatientDecision(t, report.reportId))?.id).toBe(decision.record.id);
    expect(await verifier.verify(t)).toMatchObject({ status: 'ok' });
  });
});

describe('the ledger learns the new record types', () => {
  it('verifies a long mixed history and notices tampering with a merge record', async () => {
    const t = tenant();
    const [a, b, c] = [await patient(t), await patient(t), await patient(t)];
    await merged(t, a, b);
    const un = await propose(t, 'unmerge', a, b);
    await decide(t, un.record.id, 'declined');
    const m = await propose(t, 'merge', c, b);
    await decide(t, m.record.id, 'approved', 'syn-decider-2');
    expect(await verifier.verify(t)).toMatchObject({ status: 'ok', eventsChecked: 6 });
    // The ledger's event types and subject tables are closed lists that now include the two new ones.
    const types = await owner((x) => x.query<{ event_type: string; subject_table: string }>(`SELECT DISTINCT event_type, subject_table FROM ledger_events WHERE tenant_id = $1 ORDER BY 1`, [t]));
    expect(types.rows).toEqual([
      { event_type: 'patient-merge-decision', subject_table: 'patient_merge_decisions' },
      { event_type: 'patient-merge-proposal', subject_table: 'patient_merge_proposals' },
    ]);
    await expect(owner((x) => x.query(`UPDATE ledger_events SET event_type = 'patient-merge-decision' WHERE tenant_id = $1`, [t]))).rejects.toThrow();
  });
});
