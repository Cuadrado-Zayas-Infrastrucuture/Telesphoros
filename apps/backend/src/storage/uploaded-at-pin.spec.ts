import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// M2.2b: a report's file is "uploaded" (and pinned to an object version) only when a validated intake attempt commits. The direct-upload routes that used to
// set it are gone; this pins that nothing else in the application's source can write it, the way the evaluation gate is pinned for evaluations.
const SRC = join(__dirname, '..');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [join(dir, e.name)] : []));
const sources = files(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));
const where = (re: RegExp) => sources.filter((s) => re.test(s.text)).map((s) => s.path).sort();

describe('who can mark a report uploaded', () => {
  it('only a committed attempt sets uploaded_at in SQL', () => {
    expect(where(/uploaded_at\s*=[^=]/)).toEqual(['storage/postgres/reports.repository.ts']);
    const repo = sources.find((s) => s.path === 'storage/postgres/reports.repository.ts')!.text;
    const statements = repo.match(/UPDATE reports SET[^`]*uploaded_at\s*=[^`]*/g) ?? [];
    expect(statements).toHaveLength(1);
    // That one statement is the commit: it requires a stored attempt of the same report, key, hash, type and size.
    expect(statements[0]).toMatch(/state='stored'/);
    expect(repo.indexOf(statements[0]!)).toBeGreaterThan(repo.indexOf('async commitAttempt'));
    expect(repo.indexOf(statements[0]!)).toBeLessThan(repo.indexOf('async runStatus'));
  });

  it('a report is created without any file: its only production writer builds the record with no upload fields', () => {
    expect(where(/\breports\.(insert|insertOrReplay)\(/)).toEqual(['reports/reports.service.ts']);
    const service = sources.find((s) => s.path === 'reports/reports.service.ts')!.text;
    const literal = service.slice(service.indexOf('const record: ReportRecord = {'), service.indexOf('if (input.requestId) return this.reports.insertOrReplay'));
    expect(literal).not.toMatch(/\b(uploadedAt|objectVersion|uploadedBy|uploadRequestedBy|storageKey|sha256|contentType)\s*:/);
  });

  it('the in-memory store marks a report uploaded in its commit step only', () => {
    expect(where(/uploadedAt:\s*now/)).toEqual(['storage/reports.repository.ts']);
    const memory = sources.find((s) => s.path === 'storage/reports.repository.ts')!.text;
    expect(memory.indexOf('uploadedAt: now')).toBeGreaterThan(memory.indexOf('async commitAttempt'));
  });

  it('the removed direct-upload entry points do not exist anywhere in the source', () => {
    for (const name of ['createUploadTarget', 'recordUploadRequest', 'markUploaded', 'createUploadUrl', 'completeUpload', 'upload-url']) expect(where(new RegExp(`\\b${name}\\b`))).toEqual([]);
  });
});
