import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresSyntheticStore, type TenantTransactions } from '../../durable/postgres';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { bindCapability } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';
import type { Queryable } from '@telesphoros/jobs';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const tenant = 'p2-fixture';
const actor = 'fixture-requester';
const question = '¿Cómo redacto un SOP sintético?';
const request = { schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1', locale: 'es', question, idempotencyKey: 'fixture/admit-1' } as const;
let fixture: EphemeralDatabase;
let grantId: string;
let sourceDigest: string;

async function appStore(): Promise<PostgresSyntheticStore> {
  const app: TenantTransactions = {
    async withTenant<T>(tenantId: string, work: (db: Queryable) => Promise<T>, options: { actor: string }): Promise<T> {
      const client = new Client({ connectionString: fixture.appUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [tenantId]);
        await client.query(`SELECT set_config('app.current_actor',$1,true)`, [options.actor]);
        await bindCapability(fixture.adminUrl, client, tenantId, options.actor);
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  const worker: Queryable = {
    async query() {
      throw new Error('WORKER_NOT_USED');
    },
  };
  return new PostgresSyntheticStore(worker, app);
}

describe('owned PostgreSQL synthetic admission', () => {
  beforeAll(async () => {
    fixture = await ownedPostgresFixture();
    grantId = randomUUID();
    const body = 'Synthetic admission source';
    sourceDigest = digest(body);
    const owner = new Client({ connectionString: fixture.adminUrl });
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO public.tenants(id,display_name,created_by,changed_by)
        VALUES ($1,'P2 Fixture','p2-fixture','p2-fixture')`,
        [tenant],
      );
      await owner.query(
        `INSERT INTO public.tenant_memberships(tenant_id,sub,status,roles,changed_by)
        VALUES ($1,$2,'active',ARRAY['reader']::text[],'p2-fixture')`,
        [tenant, actor],
      );
      await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
        VALUES (1,5000000,300000000)`);
      await owner.query(
        `INSERT INTO public.agentic_synthetic_grants(tenant_id,grant_id,requester_ref,generation,purpose,
        capabilities,enabled,expires_at) VALUES ($1,$2,$3,1,'business-assistance',
        ARRAY['business.sop.read','business.sop.draft']::text[],true,clock_timestamp()+interval '1 hour')`,
        [tenant, grantId, actor],
      );
      await owner.query(
        `INSERT INTO public.agentic_synthetic_sources(tenant_id,source_id,source_version,digest,body,eligible)
        VALUES ($1,'source-admit','v1',$2,$3,true)`,
        [tenant, sourceDigest, body],
      );
      await owner.query(
        `INSERT INTO public.agentic_synthetic_grant_sources(tenant_id,grant_id,source_id,source_version,enabled)
        VALUES ($1,$2,'source-admit','v1',true)`,
        [tenant, grantId],
      );
    } finally {
      await owner.end();
    }
  }, 180_000);
  afterAll(async () => {
    await fixture?.drop();
  }, 60_000);

  const caller = () => ({ tenantId: tenant, requesterRef: actor, membershipVersion: '1', grantId, grantGeneration: '1' });

  test('creates one bounded run, one ID-only queue job and exact UTF-8 tuple digests', async () => {
    const store = await appStore();
    const admitted = await store.admit(request, caller());
    expect(admitted.kind).toBe('ok');
    if (admitted.kind !== 'ok') return;
    expect(admitted.value).toMatchObject({ kind: 'new', state: 'queued', sequence: '1' });
    const owner = new Client({ connectionString: fixture.adminUrl });
    await owner.connect();
    try {
      const { rows } = await owner.query(
        `SELECT r.request_tuple_preimage,r.evidence_tuple_preimage,
        r.request_digest,r.evidence_digest,j.type,j.payload,j.requested_by
        FROM public.agentic_synthetic_runs r JOIN public.jobs j ON j.id=r.job_id WHERE r.run_id=$1`,
        [admitted.value.runId],
      );
      const requestTuple = JSON.stringify([request.schemaVersion, request.taskKey, request.locale, request.question]);
      const evidenceTuple = JSON.stringify([['source-admit', 'v1', sourceDigest]]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        request_tuple_preimage: requestTuple,
        evidence_tuple_preimage: evidenceTuple,
        request_digest: digest(requestTuple),
        evidence_digest: digest(evidenceTuple),
        type: 'test.agentic-synthetic',
        payload: { runId: admitted.value.runId },
        requested_by: actor,
      });
    } finally {
      await owner.end();
    }
  });

  test('exact repeat shares IDs while changed tuple and spoofed binding fail closed', async () => {
    const store = await appStore();
    const repeat = await store.admit(request, caller());
    expect(repeat).toMatchObject({ kind: 'ok', value: { kind: 'existing' } });
    const changed = await store.admit({ ...request, question: 'changed' }, caller());
    expect(changed).toEqual({ kind: 'refused', code: 'IDEMPOTENCY_CONFLICT' });
    const wrongTenant = await store.admit(request, { ...caller(), tenantId: 'other-tenant' });
    expect(wrongTenant).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
  });

  test('SQL entry rejects missing, null, coerced and scalar fields before admission', async () => {
    const app = new Client({ connectionString: fixture.appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [tenant]);
      await app.query(`SELECT set_config('app.current_actor',$1,true)`, [actor]);
      await bindCapability(fixture.adminUrl, app, tenant, actor);
      const invalid: [unknown, unknown][] = [
        [null, caller()],
        [[], caller()],
        ['scalar', caller()],
        [{ ...request, locale: null }, caller()],
        [{ ...request, locale: 1 }, caller()],
        [{ ...request, idempotencyKey: null }, caller()],
        [{ ...request, idempotencyKey: 12 }, caller()],
        [{ ...request, question: null }, caller()],
        [request, null],
        [request, []],
        [request, { ...caller(), membershipVersion: null }],
        [request, { ...caller(), membershipVersion: 1 }],
        [request, { ...caller(), grantGeneration: null }],
        [request, { ...caller(), grantGeneration: 1 }],
        [request, { ...caller(), grantId: null }],
        [request, { ...caller(), tenantId: null }],
      ];
      for (const [input, identity] of invalid) {
        const result = await app.query(`SELECT public.agentic_synthetic_admit($1::jsonb,$2::jsonb) AS decision`, [JSON.stringify(input), JSON.stringify(identity)]);
        expect(result.rows[0].decision).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
      }
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });

  test('reservation failure rolls back queue and buckets; concurrent duplicates admit once', async () => {
    const raceTenant = 'p2-race';
    const raceActor = 'fixture-racer';
    const raceGrant = randomUUID();
    const raceBody = 'Synthetic race source';
    const owner = new Client({ connectionString: fixture.adminUrl });
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO public.tenants(id,display_name,created_by,changed_by)
        VALUES ($1,'P2 Race','p2-fixture','p2-fixture')`,
        [raceTenant],
      );
      await owner.query(
        `INSERT INTO public.tenant_memberships(tenant_id,sub,status,roles,changed_by)
        VALUES ($1,$2,'active',ARRAY['reader']::text[],'p2-fixture')`,
        [raceTenant, raceActor],
      );
      await owner.query(
        `INSERT INTO public.agentic_synthetic_grants(tenant_id,grant_id,requester_ref,generation,purpose,
        capabilities,enabled,expires_at) VALUES ($1,$2,$3,1,'business-assistance',
        ARRAY['business.sop.read','business.sop.draft']::text[],true,clock_timestamp()+interval '1 hour')`,
        [raceTenant, raceGrant, raceActor],
      );
      await owner.query(
        `INSERT INTO public.agentic_synthetic_sources(tenant_id,source_id,source_version,digest,body,eligible)
        VALUES ($1,'race-source','v1',$2,$3,true)`,
        [raceTenant, digest(raceBody), raceBody],
      );
      await owner.query(
        `INSERT INTO public.agentic_synthetic_grant_sources(tenant_id,grant_id,source_id,source_version,enabled)
        VALUES ($1,$2,'race-source','v1',true)`,
        [raceTenant, raceGrant],
      );
      // Test-client-only injection: no failpoint or trigger ships in migration 0029.
      await owner.query(`CREATE FUNCTION public.p2_test_refuse_reservation() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'fixture rollback' USING ERRCODE = 'check_violation'; END $$`);
      await owner.query(`CREATE TRIGGER p2_test_refuse_reservation BEFORE INSERT ON public.agentic_synthetic_reservations
        FOR EACH ROW EXECUTE FUNCTION public.p2_test_refuse_reservation()`);
      const store = await appStore();
      const raceRequest = { ...request, question: 'Synthetic race?', idempotencyKey: 'race/one' };
      const raceCaller = { tenantId: raceTenant, requesterRef: raceActor, membershipVersion: '1', grantId: raceGrant, grantGeneration: '1' };
      try {
        expect(await store.admit(raceRequest, raceCaller)).toEqual({ kind: 'refused', code: 'STORAGE_UNAVAILABLE' });
      } finally {
        await owner.query(`DROP TRIGGER p2_test_refuse_reservation ON public.agentic_synthetic_reservations`);
        await owner.query(`DROP FUNCTION public.p2_test_refuse_reservation()`);
      }
      const noOrphans = await owner.query(
        `SELECT
        (SELECT count(*)::integer FROM public.jobs WHERE tenant_id=$1) AS jobs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_runs WHERE tenant_id=$1) AS runs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_reservations WHERE tenant_id=$1) AS reservations,
        (SELECT count(*)::integer FROM public.agentic_synthetic_buckets WHERE scope='tenant' AND scope_key=$1) AS buckets`,
        [raceTenant],
      );
      expect(noOrphans.rows[0]).toEqual({ jobs: 0, runs: 0, reservations: 0, buckets: 0 });
      const raced = await Promise.all([store.admit(raceRequest, raceCaller), store.admit(raceRequest, raceCaller)]);
      expect(raced.map((x) => (x.kind === 'ok' ? x.value.kind : x.code)).sort()).toEqual(['existing', 'new']);
      const values = raced.flatMap((x) => (x.kind === 'ok' ? [x.value] : []));
      expect(values[0]?.runId).toBe(values[1]?.runId);
      expect(values[0]?.jobId).toBe(values[1]?.jobId);
      const counts = await owner.query(
        `SELECT
        (SELECT count(*)::integer FROM public.jobs WHERE tenant_id=$1) AS jobs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_runs WHERE tenant_id=$1) AS runs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_reservations WHERE tenant_id=$1) AS reservations`,
        [raceTenant],
      );
      expect(counts.rows[0]).toEqual({ jobs: 1, runs: 1, reservations: 1 });
    } finally {
      await owner.end();
    }
  });

  test('current grant, membership and source are required even for an exact repeat', async () => {
    const owner = new Client({ connectionString: fixture.adminUrl });
    await owner.connect();
    try {
      const store = await appStore();
      expect(await store.admit(request, { ...caller(), membershipVersion: '2' })).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
      await owner.query(`UPDATE public.agentic_synthetic_grants SET enabled=false WHERE tenant_id=$1`, [tenant]);
      expect(await store.admit(request, caller())).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
      await owner.query(`UPDATE public.agentic_synthetic_grants SET enabled=true WHERE tenant_id=$1`, [tenant]);
      await owner.query(`UPDATE public.agentic_synthetic_sources SET eligible=false WHERE tenant_id=$1`, [tenant]);
      expect(await store.admit(request, caller())).toEqual({ kind: 'refused', code: 'SOURCE_UNAVAILABLE' });
      const counts = await owner.query(
        `SELECT (SELECT count(*)::integer FROM public.jobs WHERE tenant_id=$1) AS jobs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_runs WHERE tenant_id=$1) AS runs`,
        [tenant],
      );
      expect(counts.rows[0]).toEqual({ jobs: 1, runs: 1 });
    } finally {
      await owner.end();
    }
  });
});
