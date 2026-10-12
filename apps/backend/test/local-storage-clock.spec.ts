import { randomUUID } from 'node:crypto';
import { InMemoryReportsRepository } from '../src/storage/reports.repository';
import type { UploadAttempt } from '../src/storage/upload-attempt';
import { IntakeProgress } from '../src/reports/intake/stage';

// Controlled clocks belong only to deterministic tests. Live PostgreSQL and Moto clocks
// are measured in the operations rehearsal and are never patched by the runtime.
describe('independent local rehearsal clocks', () => {
  let wall: number;
  beforeEach(() => { wall = Date.parse('2026-01-01T00:00:00Z'); jest.spyOn(Date, 'now').mockImplementation(() => wall); });
  afterEach(() => jest.restoreAllMocks());
  async function declared() {
    const repo = new InMemoryReportsRepository(), id = randomUUID(), patientId = randomUUID(), runId = randomUUID();
    const stamp = new Date(wall).toISOString();
    await repo.insert({ id, patientId, tenantId: 'synthetic-clock', createdBy: 'synthetic-user', type: 'lab-pdf', filename: 'synthetic.pdf', sizeBytes: 10, status: 'received', createdAt: stamp, updatedAt: stamp });
    const revision = (await repo.findById('synthetic-clock', id))!.uploadRevision!;
    const raw: UploadAttempt = { id: randomUUID(), requestId: randomUUID(), runId, tenantId: 'synthetic-clock', reportId: id, patientId, principal: 'synthetic-user', revision, declarationRevision: revision, type: 'lab-pdf', sizeBytes: 10, contentType: 'application/pdf', sha256: 'a'.repeat(64), key: `local-storage/${runId}/${randomUUID()}`, cancelRequested: false, validated: false, state: 'declared', version: null, leaseUntil: new Date(wall + 3600000).toISOString(), writer: null, createdAt: stamp };
    const a = (await repo.declareAttempt(raw, revision))!;
    return { repo, a, identity: { tenantId: a.tenantId, principal: a.principal, reportId: id, id: a.id, revision: a.revision } };
  }
  it('permits a live lease and refuses intake exactly at expiry', async () => {
    const first = await declared(); wall += 3599999;
    expect(await first.repo.beginAttempt(first.identity, randomUUID())).toBe(true);
    const second = await declared(); wall += 3600000;
    expect(await second.repo.beginAttempt(second.identity, randomUUID())).toBe(false);
  });
  it('retains quota one millisecond before grace, then claims and releases exactly once', async () => {
    const { repo, a, identity } = await declared(); wall += 3600000 + 86400000 - 1;
    expect(await repo.claimCleanup(a.tenantId, a.id, 86400)).toBe(false);
    expect((await repo.runStatus(a.tenantId, a.runId)).pendingBytes).toBe(10);
    wall++; expect(await repo.claimCleanup(a.tenantId, a.id, 86400)).toBe(true);
    expect(await repo.beginAttempt(identity, randomUUID())).toBe(false);
    await repo.finishCleanup(a.tenantId, a.id); await repo.finishCleanup(a.tenantId, a.id);
    expect((await repo.runStatus(a.tenantId, a.runId)).pendingBytes).toBe(0);
  });
  it('a backwards wall-clock adjustment cannot extend a monotonic intake deadline', () => {
    let monotonic = 0; const progress = new IntakeProgress(() => monotonic);
    wall -= 7 * 86400000; monotonic = 60000;
    expect(() => progress.check(true)).toThrow('refused');
  });
});
