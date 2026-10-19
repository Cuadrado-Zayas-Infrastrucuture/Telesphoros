import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { Queryable } from '@telesphoros/jobs';
import { PostgresSyntheticStore, type TenantTransactions } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import type { ScriptedActors } from '../../durable/kernel';
import { SYNTHETIC_JOB_TYPE, type FixtureCaller } from '../../durable/contracts';
import type { Candidate, Source } from '../../src/contracts';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

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

  return { app, seedTenant, admit, admitAndClaim, row, accounts, expireLease };
}
