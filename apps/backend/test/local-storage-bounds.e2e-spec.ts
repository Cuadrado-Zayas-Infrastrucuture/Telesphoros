import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { bearer, clinicianA } from './helpers/tokens';
const suite = usingPostgres() && usingS3() ? describe : describe.skip;
const size = 10485760;
const head = Buffer.from('%PDF-1.7\n');
const tail = Buffer.from('\n%%EOF\n');
const block = Buffer.alloc(65536, 0x20);
function* chunks() { yield head; let left = size - head.length - tail.length; while (left) {
    const n = Math.min(left, block.length);
    yield block.subarray(0, n);
    left -= n;
} yield tail; }
const hash = () => { const h = createHash('sha256'); for (const b of chunks())
    h.update(b); return h.digest('hex'); };
suite('stream and process bounds with real storage', () => {
    let app: NestExpressApplication, token: string;
    const api = () => request(app.getHttpServer());
    beforeAll(async () => { app = await createTestApp(); token = await clinicianA(); });
    afterAll(async () => { await app.close(); });
    async function attempt() { const patientId = (await api().post('/api/v1/patients').set(bearer(token)).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id; const id = (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId, type: 'lab-pdf', filename: 'inert.pdf', sizeBytes: size }).expect(201)).body.id; const revision = (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token))).body.revision; return { id, ...(await api().post(`/api/v1/reports/${id}/upload-attempts`).set(bearer(token)).send({ revision, requestId: randomUUID(), contentType: 'application/pdf', sha256: hash() }).expect(201)).body }; }
    async function stream(a: Awaited<ReturnType<typeof attempt>>) { const req = httpRequest(`${await app.getUrl()}/api/v1/reports/${a.id}/upload-attempts/${a.attemptId}/bytes`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'X-Upload-Revision': a.revision } }); const result = new Promise<number>((resolve, reject) => { req.on('error', reject); req.on('response', r => { r.resume(); r.on('end', () => resolve(r.statusCode!)); }); }); for (const b of chunks())
        if (!req.write(b))
            await once(req, 'drain'); req.end(); return result; }
    it('two simultaneous 10 MiB chunked intakes never concatenate payload-sized buffers', async () => { const [a, b] = await Promise.all([attempt(), attempt()]); let maxConcat = 0; const concat = Buffer.concat; const spy = jest.spyOn(Buffer, 'concat').mockImplementation((list, total) => { maxConcat = Math.max(maxConcat, total ?? list.reduce((n, b) => n + b.length, 0)); return concat(list, total); }); const baseline = process.memoryUsage(); let peak = baseline.rss; const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2); const start = performance.now(); let status: number[]; try {
        status = await Promise.all([stream(a), stream(b)]);
    }
    finally {
        clearInterval(sample);
        spy.mockRestore();
    } expect(status).toEqual([200, 200]); expect(maxConcat).toBeLessThanOrEqual(262144); expect(peak - baseline.rss).toBeLessThan(100663296); await mkdir('test-results', { recursive: true }); await writeFile('test-results/local-intake-memory-postgres-s3.json', JSON.stringify({ synthetic: true, concurrentIntakes: 2, datasetBytes: 2 * size, durationMs: performance.now() - start, peakRssDeltaBytes: Math.max(0, peak - baseline.rss), rssDeltaCeilingBytes: 100663296, maxConcatenationBytes: maxConcat, concatenationCeilingBytes: 262144 }, null, 2)); }, 30000);
    it('refuses a third intake immediately while two owned writers are active', async () => { const [a, b, c] = await Promise.all([attempt(), attempt(), attempt()]); const storage = app.get(ObjectStorage); const put = storage.putStream.bind(storage); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered = 0; let both!: () => void; const ready = new Promise<void>(resolve => { both = resolve; }); const spy = jest.spyOn(storage, 'putStream').mockImplementation(async (...args) => { if (++entered === 2)
        both(); await gate; return put(...args); }); const writers = Promise.all([stream(a), stream(b)]); try {
        await ready;
        const rejected = await api().put(`/api/v1/reports/${c.id}/upload-attempts/${c.attemptId}/bytes`).set(bearer(token)).set('X-Upload-Revision', c.revision).set('Content-Type', 'application/pdf').send(head).expect(503);
        expect(rejected.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(entered).toBe(2);
    }
    finally {
        release();
        spy.mockRestore();
    } expect(await writers).toEqual([200, 200]); }, 30000);
    it('a stalled body releases the socket and intake slot before the absolute deadline with zero writes', async () => { const a = await attempt(); const storage = app.get(ObjectStorage); const spy = jest.spyOn(storage, 'putStream'); const start = performance.now(); const req = httpRequest(`${await app.getUrl()}/api/v1/reports/${a.id}/upload-attempts/${a.attemptId}/bytes`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'X-Upload-Revision': a.revision, 'Content-Length': size } }); const ended = new Promise<void>(resolve => { req.on('error', () => resolve()); req.on('response', r => { r.resume(); r.on('end', resolve); }); }); req.write(head); await ended; expect(performance.now() - start).toBeLessThan(15000); expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); const healthy = await attempt(); expect(await stream(healthy)).toBe(200); }, 25000);
});
