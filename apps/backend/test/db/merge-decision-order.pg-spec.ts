import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

// The decision in force for a patient is the one LAST IN THE LEDGER. A merge and an unmerge of one patient approved at once must not leave
// the earlier one in force (audit 2026-10-27, L1b). Synthetic data only.

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});

const PROPOSER = 'syn-proposer';
const owner = <T>(work: Parameters<typeof withAdmin<T>>[1]) => withAdmin(pg.adminUrl, work);

async function patient(t: string): Promise<string> {
  const id = randomUUID();
  await owner((c) => c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-registrar', $3)`, [id, t, `SYN-${randomUUID().slice(0, 8)}`]));
  return id;
}
const propose = (t: string, kind: 'merge' | 'unmerge', source: string, target: string) =>
  repo.insertMergeProposal(t, PROPOSER, { kind, sourcePatientId: source, targetPatientId: target, reasonCode: kind === 'merge' ? 'entered-twice' : 'merged-by-mistake' });

/** Where the LEDGER says the patient was merged into: its approved decision with the highest ledger position, or null after an unmerge. */
const ledgerSays = (t: string, source: string) =>
  owner(async (c) => {
    const { rows } = await c.query<{ kind: string; target: string }>(
      `SELECT p.kind, p.target_patient_id::text AS target FROM patient_merge_decisions d
         JOIN patient_merge_proposals p ON p.id = d.proposal_id AND p.tenant_id = d.tenant_id
         JOIN ledger_events e ON e.id = d.ledger_event_id AND e.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND p.source_patient_id = $2 AND d.decision = 'approved' ORDER BY e.seq DESC LIMIT 1`,
      [t, source],
    );
    return rows[0]?.kind === 'merge' ? rows[0].target : null;
  });
const mergedInto = (t: string, source: string) =>
  owner(async (c) => (await c.query<{ id: string | null }>(`SELECT patient_merged_into($1, $2::uuid)::text AS id`, [t, source])).rows[0]?.id ?? null);

it('leaves the decision last in the ledger in force when a merge and an unmerge of one patient are approved at once', async () => {
  // About 3% of unlocked trials invert, so 300 make a missed inversion vanishingly rare: a red run must not depend on luck.
  const trials = 300;
  let disagreements = 0;
  let bothApproved = 0;
  for (let i = 0; i < trials; i++) {
    const t = `tenant-${randomUUID().slice(0, 8)}`;
    const [a, b, c] = [await patient(t), await patient(t), await patient(t)];
    // Both merges are proposed while A is still on its own; A is then merged into B, and its unmerge is proposed.
    const intoB = await propose(t, 'merge', a, b);
    const intoC = await propose(t, 'merge', a, c);
    await repo.insertMergeDecision(t, 'syn-decider', { proposalId: intoB.record.id as string, decision: 'approved' });
    const unmerge = await propose(t, 'unmerge', a, b);
    // Two reviewers at once: one approves A into C, the other approves undoing A into B. Which starts first alternates, so both orders are
    // reached even when the first caller tends to win (with the lock, it does).
    const decisions = [
      () => repo.insertMergeDecision(t, 'syn-reviewer-1', { proposalId: intoC.record.id as string, decision: 'approved' }),
      () => repo.insertMergeDecision(t, 'syn-reviewer-2', { proposalId: unmerge.record.id as string, decision: 'approved' }),
    ];
    const settled = await Promise.allSettled((i % 2 === 0 ? decisions : [...decisions].reverse()).map((decide) => decide()));
    if (settled.every((s) => s.status === 'fulfilled')) bothApproved++;
    if ((await mergedInto(t, a)) !== (await ledgerSays(t, a))) disagreements++;
  }
  expect(bothApproved).toBeGreaterThan(0); // control: the race this guards was reached (the unmerge committed first, then the merge passed)
  expect(disagreements).toBe(0);
}, 60_000);
