import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { Queryable } from '@telesphoros/jobs';
import { PostgresSyntheticStore, type TenantTransactions } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import type { ScriptedActors } from '../../durable/kernel';
import { SYNTHETIC_JOB_TYPE, type FixtureCaller } from '../../durable/contracts';
import type { Candidate, Source } from '../../src/contracts';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

/**
 * Binds the caller to the transaction the way the API does after migration 0030: the settings (still set by `Database.withTenant`) and a tenant
 * capability in `app.capability`. The row is written by the owner, standing in for the issuer, because these suites test the P2 functions and not the
 * issuer (apps/backend/test/db/agentic-identity.pg-spec.ts mints through the real issuer login). An organization that does not exist gets no capability,
 * as the issuer would refuse it, and the call is then refused by the database.
 */
export async function bindCapability(adminUrl: string, client: Queryable, tenant: string, actor: string): Promise<void> {
  const value = randomBytes(32).toString('base64url');
  const owner = new Client({ connectionString: adminUrl });
  await owner.connect();
  try {
    await owner.query(`INSERT INTO public.tenant_capabilities (token_hash, tenant_id, sub, membership_version, purpose, request_id, issued_at, expires_at)
      VALUES ($1, $2, $3, 1, 'request', 'durable-harness', clock_timestamp(), clock_timestamp() + interval '60 seconds')`, [createHash('sha256').update(value, 'utf8').digest(), tenant, actor]);
  } catch (error) {
    if ((error as { code?: string }).code === '23503') return; // unknown organization: no capability
    throw error;
  } finally { await owner.end(); }
  await client.query(`SELECT set_config('app.capability',$1,true)`, [value]);
}

export const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const sopBody = 'Step one: wash both hands.\nStep two: dry them fully.';
export const claimOptions = { types: [SYNTHETIC_JOB_TYPE], batch: 1, tenantCap: 1, leaseSeconds: 15 };

export function candidateFrom(source: Source, spans: [number, number][]): Candidate {
  const bytes = Buffer.from(source.body, 'utf8');
  const claims = spans.map(([startByte, endByte], i) => ({ id: `claim-${i + 1}`, sourceId: source.id,
    startByte, endByte, text: bytes.subarray(startByte, endByte).toString('utf8') }));
  const text = claims.map(c => c.text).join('\n');
  return { text, digest: digest(text), claims };
}

export type Decision = 'accept' | 'repair' | 'hold';
export function scriptedActors(decisions: Decision[], trace: string[] = []): ScriptedActors {
  let director = 0;
  return {
    async draft(sources, attemptId) {
      trace.push(attemptId);
      return { artifact: candidateFrom(sources[0]!, [[0, 26]]), observation: { inputUnits: 120, generatedUnits: 40 } };
    },
    async director(candidate, evidenceDigest, attemptId) {
      trace.push(attemptId);
      const decision = decisions[director++] ?? 'hold';
      return { artifact: { decision, candidateDigest: candidate.digest, evidenceDigest,
        claimVerdicts: candidate.claims.map(c => ({ claimId: c.id, supported: true })) },
      observation: { inputUnits: 300, generatedUnits: 60 } };
    },
  };
}

/** Owner-seeded fixtures (never in the migration), app transactions and readback helpers for one owned database. */
export function durableHarness(fixture: () => EphemeralDatabase, owner: () => Client) {
  const app: TenantTransactions = { async withTenant<T>(tenantId: string, work: (db: Queryable) => Promise<T>,
    options: { actor: string }): Promise<T> {
    const client = new Client({ connectionString: fixture().appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [tenantId]);
      await client.query(`SELECT set_config('app.current_actor',$1,true)`, [options.actor]);
      await bindCapability(fixture().adminUrl, client, tenantId, options.actor);
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.end(); }
  } };

  async function seedTenant(): Promise<{ caller: FixtureCaller; tenant: string; grantId: string }> {
    const o = owner();
    const tenant = `p2-${randomUUID().slice(0, 8)}`;
    const actor = `requester-${randomUUID().slice(0, 8)}`;
    const grantId = randomUUID();
    await o.query(`INSERT INTO public.tenants(id,display_name,created_by,changed_by) VALUES ($1,'P2 Fixture','p2','p2')`, [tenant]);
    await o.query(`INSERT INTO public.tenant_memberships(tenant_id,sub,status,roles,changed_by)
      VALUES ($1,$2,'active',ARRAY['reader']::text[],'p2')`, [tenant, actor]);
    await o.query(`INSERT INTO public.agentic_synthetic_grants(tenant_id,grant_id,requester_ref,generation,purpose,
      capabilities,enabled,expires_at) VALUES ($1,$2,$3,1,'business-assistance',
      ARRAY['business.sop.read','business.sop.draft']::text[],true,clock_timestamp()+interval '1 hour')`, [tenant, grantId, actor]);
    await o.query(`INSERT INTO public.agentic_synthetic_sources(tenant_id,source_id,source_version,digest,body,eligible)
      VALUES ($1,'sop-handwash','v1',$2,$3,true)`, [tenant, digest(sopBody), sopBody]);
    await o.query(`INSERT INTO public.agentic_synthetic_grant_sources(tenant_id,grant_id,source_id,source_version,enabled)
      VALUES ($1,$2,'sop-handwash','v1',true)`, [tenant, grantId]);
    return { tenant, grantId, caller: { tenantId: tenant, requesterRef: actor, membershipVersion: '1', grantId, grantGeneration: '1' } };
  }

  async function admit(store: PostgresSyntheticStore, caller: FixtureCaller) {
    const admitted = await store.admit({ schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1',
      locale: 'en', question: 'How do I write the hand-washing SOP?', idempotencyKey: `p2/${randomUUID()}` }, caller);
    if (admitted.kind !== 'ok') throw new Error(`admit ${admitted.code}`);
    return admitted.value;
  }

  async function admitAndClaim(worker: Queryable, caller: FixtureCaller, workerId = 'worker-a') {
    const store = new PostgresSyntheticStore(worker, app);
    const queue = new SyntheticJobQueue(worker);
    const admitted = await admit(store, caller);
    const jobs = await queue.claim(workerId, claimOptions);
    const claim = queue.claimFor(admitted.jobId, workerId);
    if (jobs.length !== 1 || !claim) throw new Error('claim');
    return { store, queue, runId: admitted.runId, jobId: admitted.jobId, ...claim };
  }

  const row = async (sql: string, params: unknown[]) => (await owner().query(sql, params)).rows[0];
  const accounts = (tenant: string, runId: string) => row(`SELECT v.settled, v.in_flight, v.usage_state,
    v.observed_input + v.observed_generated AS observed,
    (SELECT reserved_units FROM public.agentic_synthetic_buckets WHERE scope='tenant' AND scope_key=$1) AS tenant_reserved,
    (SELECT consumed_units FROM public.agentic_synthetic_buckets WHERE scope='tenant' AND scope_key=$1) AS tenant_consumed,
    (SELECT count(*)::int FROM public.agentic_synthetic_invocations i WHERE i.run_id=$2) AS slots,
    (SELECT count(*)::int FROM public.agentic_synthetic_invocations i WHERE i.run_id=$2 AND i.usage_state='unknown') AS unknown_slots,
    (SELECT count(*)::int FROM public.agentic_synthetic_outcomes o WHERE o.run_id=$2) AS outcomes,
    (SELECT r.state FROM public.agentic_synthetic_runs r WHERE r.run_id=$2) AS run_state
    FROM public.agentic_synthetic_reservations v WHERE v.run_id=$2`, [tenant, runId]);
  /** Expire a held lease so the existing claim treats the job as abandoned. */
  const expireLease = (jobId: string) => owner().query(
    `UPDATE public.jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1`, [jobId]);

  /** Test-only teardown after evidence: a stuck or unknown run holds its fleet permit by design. */
  const releasePermit = (runId: string) => owner().query(
    'UPDATE public.agentic_synthetic_reservations SET in_flight=false WHERE run_id=$1 AND NOT settled', [runId]);
  /** Isolation between tests: free every unsettled permit a refused or stuck run still holds. */
  const releaseAllPermits = () => owner().query(
    'UPDATE public.agentic_synthetic_reservations SET in_flight=false WHERE in_flight AND NOT settled');
  /** Barrier: resolves once the backend is blocked on a heavyweight lock, never on a sleep. */
  const lockWaiting = (pid: number) => until(async () =>
    (await owner().query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock');
  /** Hold a row lock in a separate owner transaction until release() rolls it back. */
  async function holdLock(sql: string, params: unknown[]) {
    const holder = new Client({ connectionString: fixture().adminUrl });
    await holder.connect();
    await holder.query('BEGIN');
    const held = await holder.query(sql, params);
    if (held.rowCount !== 1) { await holder.end(); throw new Error('LOCK_TARGET'); }
    return { async release() { try { await holder.query('ROLLBACK'); } finally { await holder.end(); } } };
  }

  return { app, seedTenant, admit, admitAndClaim, row, accounts, expireLease, releasePermit, releaseAllPermits, lockWaiting, holdLock };
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await check()) return;
  throw new Error('UNTIL_TIMEOUT');
};
export const backendPid = async (db: Queryable) => (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
/** Exact draft/director input digests the SQL recomputes from protected rows. */
export function inputDigest(runId: string, sources: readonly Source[], role: 'draft' | 'director', n: 1 | 2, candidate?: Candidate) {
  const tuple = sources.map(s => [s.id, s.version, s.digest]);
  const evidence = digest(JSON.stringify(tuple));
  return role === 'draft' ? digest(JSON.stringify([`${runId}:draft:${n}`, evidence, tuple]))
    : digest(JSON.stringify([`${runId}:director:${n}`, candidate!.digest, evidence]));
}
