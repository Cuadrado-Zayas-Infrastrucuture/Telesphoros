import { patientListQuerySchema, reportListQuerySchema } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { listPatients } from './api';

const empty = { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
const ok = () => new Response(JSON.stringify(empty), { headers: { 'Content-Type': 'application/json' } });

describe('list order (patients and reports)', () => {
  it('defaults to oldest first, accepts only asc and desc, and refuses any other word', () => {
    expect(patientListQuerySchema.parse({}).order).toBe('asc');
    expect(reportListQuerySchema.parse({}).order).toBe('asc');
    expect(patientListQuerySchema.parse({ order: 'desc' }).order).toBe('desc');
    expect(reportListQuerySchema.parse({ order: 'desc' }).order).toBe('desc');
    expect(patientListQuerySchema.safeParse({ order: 'newest' }).success).toBe(false);
    expect(reportListQuerySchema.safeParse({ order: 'DESC' }).success).toBe(false);
  });

  it('listPatients sends order=desc only when asked for newest first', async () => {
    const api = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => ok());
    await listPatients(api, 1);
    await listPatients(api, 1, undefined, 'newest');
    expect(api.mock.calls.map((call) => call[0])).toEqual(['/api/v1/patients?page=1&pageSize=20', '/api/v1/patients?page=1&pageSize=20&order=desc']);
  });
});
