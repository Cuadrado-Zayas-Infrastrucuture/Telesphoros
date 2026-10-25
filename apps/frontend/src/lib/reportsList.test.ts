import { expect, it, vi } from 'vitest';
import { listReports } from './ownedStorageApi';
import { NotSignedInError } from '@/auth/AuthProvider';

const patientId = '11111111-1111-4111-8111-111111111111';
const report = {
  id: '22222222-2222-4222-8222-222222222222',
  patientId,
  type: 'vcf',
  filename: 'synthetic.vcf',
  sizeBytes: 8,
  status: 'received',
  fileUploaded: false,
  contentType: null,
  sha256: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
};
const page = { data: [report], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('uses the existing bounded reports endpoint with a validated optional patient filter', async () => {
  const api = vi.fn().mockResolvedValue(json(page));
  const signal = new AbortController().signal;
  await expect(listReports(api, 1, signal, patientId)).resolves.toEqual(page);
  expect(api).toHaveBeenCalledWith(`/api/v1/reports?page=1&pageSize=20&patientId=${patientId}`, { signal });
});
it.each([
  { ...page, data: [{ ...report, patientId: report.id }] },
  { ...page, meta: { ...page.meta, page: 2 } },
  { ...page, meta: { ...page.meta, pageSize: 100 } },
  { ...page, meta: { ...page.meta, totalPages: 2 } },
  { ...page, meta: { ...page.meta, total: 0, totalPages: 0 } },
])('refuses page or patient disagreement instead of displaying it', async (bad) => {
  await expect(listReports(vi.fn().mockResolvedValue(json(bad)), 1, undefined, patientId)).rejects.toThrow('Reports could not be loaded');
});
it('rejects an invalid patient or page before making a request', async () => {
  const api = vi.fn();
  await expect(listReports(api, 1, undefined, '../private')).rejects.toThrow();
  await expect(listReports(api, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow();
  expect(api).not.toHaveBeenCalled();
});
it('does not expose service payloads, and preserves session control errors', async () => {
  await expect(listReports(vi.fn().mockResolvedValue(json({ message: 'private' }, 403)), 1)).rejects.toThrow('Reports could not be loaded. Please retry.');
  const expired = new NotSignedInError();
  await expect(listReports(vi.fn().mockRejectedValue(expired), 1)).rejects.toBe(expired);
});
