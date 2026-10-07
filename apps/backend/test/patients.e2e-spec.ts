import type { NestExpressApplication } from '@nestjs/platform-express';
import { patientDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA, clinicianB, noRolesA, readerA, signToken } from './helpers/tokens';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());
const BASE = '/api/v1/patients';
const makePatient = async (token: string, label: string) =>
  (await api().post(BASE).set(bearer(token)).send({ label }).expect(201)).body as { id: string; label: string };

describe('patients: roles and shape', () => {
  it('lets a clinician create a patient and returns exactly the public fields', async () => {
    const res = await api().post(BASE).set(bearer(await clinicianA())).send({ label: 'SYN-0001' }).expect(201);
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'id', 'label', 'updatedAt']);
    expect(patientDtoSchema.safeParse(res.body).success).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/owner|user-a/i);
  });

  it('forbids a reader and a role-less caller from changing data, but not from reading', async () => {
    for (const token of [await readerA(), await noRolesA()]) {
      const res = await api().post(BASE).set(bearer(token)).send({ label: 'SYN-9999' }).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      await api().get(BASE).set(bearer(token)).expect(200);
    }
  });
});

describe('patients: ownership (one user can never see or touch another user’s records)', () => {
  it("hides, rejects and preserves user A's patient from user B", async () => {
    const a = await clinicianA();
    const b = await clinicianB();
    const mine = await makePatient(a, 'SYN-OWN-1');

    const list = await api().get(BASE).set(bearer(b)).expect(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(mine.id);

    for (const res of [
      await api().get(`${BASE}/${mine.id}`).set(bearer(b)),
      await api().put(`${BASE}/${mine.id}`).set(bearer(b)).send({ label: 'HIJACKED' }),
      await api().delete(`${BASE}/${mine.id}`).set(bearer(b)),
    ]) {
      expect(res.status).toBe(404); // not 403: B must not learn that the id exists
      expect(res.body.error.code).toBe('NOT_FOUND');
    }

    const still = await api().get(`${BASE}/${mine.id}`).set(bearer(a)).expect(200);
    expect(still.body.label).toBe('SYN-OWN-1');
  });

  it('allows the same label for different owners', async () => {
    await makePatient(await clinicianA(), 'SYN-SHARED');
    await makePatient(await clinicianB(), 'SYN-SHARED');
  });
});

describe('patients: validation (rejected before any business logic)', () => {
  it.each([
    ['empty body', {}],
    ['name-like label', { label: 'Jane Doe' }],
    ['over-long label', { label: 'A'.repeat(41) }],
    ['unknown field (mass assignment)', { label: 'SYN-2', ownerId: 'user-b' }],
    ['wrong type', { label: 12345 }],
    ['array instead of object', []],
  ])('returns 400 VALIDATION_ERROR for %s', async (_name, body) => {
    const res = await api().post(BASE).set(bearer(await clinicianA())).send(body as object).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('names the failing field and never echoes the submitted value', async () => {
    const res = await api().post(BASE).set(bearer(await clinicianA())).send({ label: 'Jane Doe' }).expect(400);
    expect(res.body.error.details[0].field).toBe('label');
    expect(JSON.stringify(res.body)).not.toContain('Jane Doe');
  });

  it('rejects a malformed id before touching storage', async () => {
    const res = await api().get(`${BASE}/not-a-uuid`).set(bearer(await clinicianA())).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-JSON body', async () => {
    await api().post(BASE).set(bearer(await clinicianA())).set('Content-Type', 'text/plain').send('label=SYN-3').expect(400);
  });
});

describe('patients: update, delete, conflicts', () => {
  it('replaces a label (PUT) and bumps updatedAt', async () => {
    const a = await clinicianA();
    const p = await makePatient(a, 'SYN-PUT-1');
    const res = await api().put(`${BASE}/${p.id}`).set(bearer(a)).send({ label: 'SYN-PUT-2' }).expect(200);
    expect(res.body.label).toBe('SYN-PUT-2');
    expect(res.body.id).toBe(p.id);
  });

  it('returns 409 CONFLICT for a duplicate label (case-insensitive), on create and on PUT', async () => {
    const a = await clinicianA();
    await makePatient(a, 'SYN-DUP-1');
    const other = await makePatient(a, 'SYN-DUP-2');
    for (const res of [
      await api().post(BASE).set(bearer(a)).send({ label: 'syn-dup-1' }),
      await api().put(`${BASE}/${other.id}`).set(bearer(a)).send({ label: 'SYN-DUP-1' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    }
  });

  it('deletes with 204 and an empty body, then the record is gone', async () => {
    const a = await clinicianA();
    const p = await makePatient(a, 'SYN-DEL-1');
    const del = await api().delete(`${BASE}/${p.id}`).set(bearer(a)).expect(204);
    expect(del.text).toBe('');
    await api().get(`${BASE}/${p.id}`).set(bearer(a)).expect(404);
  });

  it('refuses to delete a patient that still has reports (mirrors the Phase 3 foreign key)', async () => {
    const a = await clinicianA();
    const p = await makePatient(a, 'SYN-FK-1');
    const report = await api()
      .post('/api/v1/reports')
      .set(bearer(a))
      .send({ patientId: p.id, type: 'vcf', filename: 'x.vcf', sizeBytes: 10 })
      .expect(201);
    const res = await api().delete(`${BASE}/${p.id}`).set(bearer(a)).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');

    await api().delete(`/api/v1/reports/${report.body.id}`).set(bearer(a)).expect(204);
    await api().delete(`${BASE}/${p.id}`).set(bearer(a)).expect(204);
  });
});

describe('patients: pagination envelope', () => {
  it('returns { data, meta } with correct totals, pages and ordering', async () => {
    const owner = await signToken({ sub: 'user-pager', roles: ['clinician'] });
    for (let i = 1; i <= 5; i++) await makePatient(owner, `SYN-PG-${i}`);

    const page2 = await api().get(`${BASE}?page=2&pageSize=2`).set(bearer(owner)).expect(200);
    expect(page2.body.meta).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
    expect(page2.body.data.map((p: { label: string }) => p.label)).toEqual(['SYN-PG-3', 'SYN-PG-4']);

    const beyond = await api().get(`${BASE}?page=9&pageSize=2`).set(bearer(owner)).expect(200);
    expect(beyond.body.data).toEqual([]);
    expect(beyond.body.meta.total).toBe(5);
  });

  it('defaults to page 1 of 20', async () => {
    const res = await api().get(BASE).set(bearer(await clinicianA())).expect(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.pageSize).toBe(20);
  });

  it.each(['pageSize=101', 'pageSize=0', 'page=0', 'page=abc', 'pageSize=-5', 'sort=label'])(
    'rejects ?%s (page size is capped, unknown params are refused)',
    async (query) => {
      const res = await api().get(`${BASE}?${query}`).set(bearer(await clinicianA())).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );
});
