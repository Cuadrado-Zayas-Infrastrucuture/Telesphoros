import { describe, expect, it, vi } from 'vitest';
import { SubmitError } from '@/lib/api';
import { countReportStages, REPORT_STAGE_PAGE_SIZE, REPORT_STAGE_MAX_PAGES } from './reportStages';

const patient = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-12T00:00:00Z';
let serial = 0;
function report(status: string, fileUploaded: boolean, patientId = patient) {
  serial += 1;
  return {
    id: `33333333-3333-4333-8333-${String(serial).padStart(12, '0')}`,
    patientId,
    type: 'vcf',
    filename: 'synthetic.vcf',
    sizeBytes: 8,
    status,
    fileUploaded,
    contentType: fileUploaded ? 'text/x-vcf' : null,
    sha256: fileUploaded ? 'a'.repeat(64) : null,
    createdAt: date,
    updatedAt: date,
  };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
// A server holding `rows`, paged honestly at whatever size is asked for.
function server(rows: ReturnType<typeof report>[]) {
  return vi.fn(async (path: string) => {
    const url = new URL(path, 'https://api.test');
    const page = Number(url.searchParams.get('page'));
    const pageSize = Number(url.searchParams.get('pageSize'));
    const data = rows.slice((page - 1) * pageSize, page * pageSize);
    return json({ data, meta: { page, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) } });
  });
}

describe('countReportStages', () => {
  it('counts each stage across every page, Read only when the file is also uploaded', async () => {
    const rows = [
      ...Array.from({ length: 120 }, () => report('received', false)),
      ...Array.from({ length: 50 }, () => report('received', true)),
      ...Array.from({ length: 30 }, () => report('processed', true)),
      report('processed', false),
      report('failed', true),
      report('failed', false),
    ];
    const api = server(rows);
    const stages = await countReportStages(api);
    expect(stages).toEqual({ registered: 203, uploaded: 81, read: 30, failed: 2, total: 203, capped: false });
    expect(api).toHaveBeenCalledTimes(3);
    for (const [path] of api.mock.calls) expect(path).toContain(`pageSize=${REPORT_STAGE_PAGE_SIZE}`);
  });

  it('applies the patient filter to every page it asks for', async () => {
    const api = server(Array.from({ length: 150 }, () => report('processed', true)));
    await countReportStages(api, undefined, patient);
    expect(api).toHaveBeenCalledTimes(2);
    for (const [path] of api.mock.calls) expect(new URL(path, 'https://api.test').searchParams.get('patientId')).toBe(patient);
  });

  it('stops at the page cap and says how many it counted out of how many', async () => {
    const total = REPORT_STAGE_PAGE_SIZE * REPORT_STAGE_MAX_PAGES + 5;
    const api = server(Array.from({ length: total }, () => report('processed', true)));
    const stages = await countReportStages(api);
    expect(api).toHaveBeenCalledTimes(REPORT_STAGE_MAX_PAGES);
    expect(stages).toMatchObject({ registered: REPORT_STAGE_PAGE_SIZE * REPORT_STAGE_MAX_PAGES, total, capped: true });
  });

  it('counts an empty tenant in one request', async () => {
    const api = server([]);
    expect(await countReportStages(api)).toEqual({ registered: 0, uploaded: 0, read: 0, failed: 0, total: 0, capped: false });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('refuses a page that breaks the list contract', async () => {
    const wrongPatient = vi.fn(async () =>
      json({ data: [report('processed', true, '22222222-2222-4222-8222-222222222222')], meta: { page: 1, pageSize: 100, total: 1, totalPages: 1 } }),
    );
    await expect(countReportStages(wrongPatient, undefined, patient)).rejects.toBeInstanceOf(SubmitError);
    const shifting = vi.fn(async (path: string) => {
      const page = Number(new URL(path, 'https://api.test').searchParams.get('page'));
      return json({ data: [report('processed', true)], meta: { page, pageSize: 100, total: page === 1 ? 150 : 151, totalPages: 2 } });
    });
    await expect(countReportStages(shifting)).rejects.toBeInstanceOf(SubmitError);
    await expect(countReportStages(vi.fn(async () => json({}, 500)))).rejects.toBeInstanceOf(SubmitError);
  });
});
