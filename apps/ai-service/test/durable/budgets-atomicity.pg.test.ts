import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
const tenants = ['p2-cap-a', 'p2-cap-b', 'p2-cap-c'] as const;
const grants = new Map<string, string>();
const body = 'Synthetic bounded source';
const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;

async function admit(tenant: string, key: string) {
  const app = new Client({ connectionString: fixture.appUrl });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [tenant]);
    await app.query(`SELECT set_config('app.current_actor',$1,true)`, [`${tenant}-actor`]);
    const input = { schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1',
      locale: 'en', question: 'Draft a synthetic SOP', idempotencyKey: key };
    const caller = { tenantId: tenant, requesterRef: `${tenant}-actor`, membershipVersion: '1',
      grantId: grants.get(tenant), grantGeneration: '1' };
    const result = await app.query(`SELECT public.agentic_synthetic_admit($1::jsonb,$2::jsonb) AS decision`,
      [JSON.stringify(input), JSON.stringify(caller)]);
    await app.query('COMMIT');
    return result.rows[0].decision;
  } catch (error) { await app.query('ROLLBACK'); throw error; }
  finally { await app.end(); }
}

describe('owned PostgreSQL synthetic admission accounting', () => {
  beforeAll(async () => {
    fixture = await ownedPostgresFixture();
    const owner = new Client({ connectionString: fixture.adminUrl });
    await owner.connect();
    try {
      await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
        VALUES (1,5000000,300000000)`);
      for (const tenant of tenants) {
        const grant = randomUUID();
        grants.set(tenant, grant);
        await owner.query(`INSERT INTO public.tenants(id,display_name,created_by,changed_by)
          VALUES ($1,'P2 Capacity','p2-fixture','p2-fixture')`, [tenant]);
        await owner.query(`INSERT INTO public.tenant_memberships(tenant_id,sub,status,roles,changed_by)
          VALUES ($1,$2,'active',ARRAY['reader']::text[],'p2-fixture')`, [tenant,`${tenant}-actor`]);
        await owner.query(`INSERT INTO public.agentic_synthetic_grants(tenant_id,grant_id,requester_ref,generation,purpose,
          capabilities,enabled,expires_at) VALUES ($1,$2,$3,1,'business-assistance',
          ARRAY['business.sop.read','business.sop.draft']::text[],true,clock_timestamp()+interval '1 hour')`,
        [tenant,grant,`${tenant}-actor`]);
        await owner.query(`INSERT INTO public.agentic_synthetic_sources(tenant_id,source_id,source_version,digest,body,eligible)
          VALUES ($1,'capacity-source','v1',$2,$3,true)`, [tenant,digest,body]);
        await owner.query(`INSERT INTO public.agentic_synthetic_grant_sources(tenant_id,grant_id,source_id,source_version,enabled)
          VALUES ($1,$2,'capacity-source','v1',true)`, [tenant,grant]);
      }
    } finally { await owner.end(); }
  }, 180_000);
  afterAll(async () => { await fixture?.drop(); }, 60_000);

  test('tenant-day and fleet-month ceilings refuse before a queue or run exists', async () => {
    const owner = new Client({ connectionString: fixture.adminUrl });
    await owner.connect();
    try {
      await owner.query(`INSERT INTO public.agentic_synthetic_buckets
        (scope,scope_key,period_kind,period_start,limit_units,consumed_units)
        VALUES ('tenant',$1,'day',(clock_timestamp() AT TIME ZONE 'UTC')::date,5000000,4800001)`, [tenants[0]]);
      expect(await admit(tenants[0], 'day-cap')).toEqual({ kind: 'refused', code: 'BUDGET_REFUSED' });
      await owner.query(`UPDATE public.agentic_synthetic_buckets SET consumed_units=0 WHERE scope='tenant' AND scope_key=$1`, [tenants[0]]);
      await owner.query(`INSERT INTO public.agentic_synthetic_buckets
        (scope,scope_key,period_kind,period_start,limit_units,consumed_units)
        VALUES ('fleet','fleet','month',date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,
          300000000,299800001)`);
      expect(await admit(tenants[0], 'fleet-cap')).toEqual({ kind: 'refused', code: 'BUDGET_REFUSED' });
      await owner.query(`UPDATE public.agentic_synthetic_buckets SET consumed_units=0 WHERE scope='fleet'`);
      const counts = await owner.query(`SELECT (SELECT count(*)::integer FROM public.jobs WHERE type='test.agentic-synthetic') AS jobs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_runs) AS runs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_reservations) AS reservations`);
      expect(counts.rows[0]).toEqual({ jobs: 0, runs: 0, reservations: 0 });
    } finally { await owner.end(); }
  });

  test('three simultaneous tenants acquire only two fleet permits and one per tenant', async () => {
    const results = await Promise.all(tenants.map(tenant => admit(tenant, `race/${tenant}`)));
    expect(results.filter(result => result.kind === 'ok')).toHaveLength(2);
    expect(results.filter(result => result.code === 'CAPACITY_REFUSED')).toHaveLength(1);
    const winner = tenants[results.findIndex(result => result.kind === 'ok')];
    expect(await admit(winner, 'second-key')).toEqual({ kind: 'refused', code: 'CAPACITY_REFUSED' });
    const owner = new Client({ connectionString: fixture.adminUrl });
    await owner.connect();
    try {
      const { rows } = await owner.query(`SELECT (SELECT count(*)::integer FROM public.jobs WHERE type='test.agentic-synthetic') AS jobs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_runs) AS runs,
        (SELECT count(*)::integer FROM public.agentic_synthetic_reservations WHERE in_flight) AS permits,
        (SELECT coalesce(sum(reserved_units),0)::bigint FROM public.agentic_synthetic_buckets WHERE scope='fleet') AS fleet_reserved`);
      expect(rows[0]).toEqual({ jobs: 2, runs: 2, permits: 2, fleet_reserved: '500000' });
    } finally { await owner.end(); }
  });
});
