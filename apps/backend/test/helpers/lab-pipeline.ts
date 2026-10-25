import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { InMemoryObjectStorage } from '../../src/object-storage/in-memory-object-storage';
import { ObjectStorage } from '../../src/object-storage/object-storage';
import { withAdmin } from './database';
import { bearer, signToken } from './tokens';

export const TEST_KNOWLEDGE = resolve(__dirname, '../../../../data/fixtures/knowledge/test-only-reader');
export const REPO_ROOT = resolve(__dirname, '../../../..');
const ENGINE_FIXTURES = resolve(__dirname, '../../../../knowledge/lab-report-reader/v2-handoff/fixtures/captures');
// Without the imported reader engine (the public repository has none) the pipeline specs use the public synthetic fixtures (D01, D02, D08; see
// data/fixtures/lab-reports/README.md), whose ids match the same hand-written oracle, and the test stand-in reader (see app.ts).
const PUBLIC_FIXTURES = resolve(__dirname, '../../../../data/fixtures/lab-reports/captures');
export const FIXTURES = existsSync(ENGINE_FIXTURES) ? ENGINE_FIXTURES : PUBLIC_FIXTURES;
export const fixturePdf = (id: string) => readFileSync(join(FIXTURES, id, 'source.pdf'));
export const fixtureText = (id: string) => readFileSync(join(FIXTURES, id, 'report.txt'), 'utf8');
export const fixtureManifest = (id: string) => JSON.parse(readFileSync(join(FIXTURES, id, 'capture.json'), 'utf8')) as { source_pdf_sha256: string; stored_text_sha256: string };
export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const DOCUMENT_IDS = Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`);

export interface Person {
  sub: string;
  token: string;
}

/**
 * Drives the lab-report pipeline over HTTP the way a browser and four different people would. Synthetic data only.
 * A "person" is a token: one individual (`sub`) in one tenant, holding exactly the roles given.
 */
export class LabPipeline {
  constructor(
    readonly app: NestExpressApplication,
    readonly adminUrl: string,
    readonly tenant = `tenant-${randomUUID().slice(0, 8)}`,
  ) {}

  api() {
    return request(this.app.getHttpServer());
  }

  async person(name: string, roles: string[], tenant = this.tenant): Promise<Person> {
    const sub = `${name}-${randomUUID().slice(0, 6)}`;
    return { sub, token: await signToken({ sub, roles, tenant }) };
  }

  async patient(who: Person): Promise<string> {
    return (
      await this.api()
        .post('/api/v1/patients')
        .set(bearer(who.token))
        .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
        .expect(201)
    ).body.id as string;
  }

  /** Writes bytes at a key in the report store, as a person with write access to the bucket could (a newer version). Returns the version the store assigned. */
  async put(target: { key: string }, bytes: Buffer): Promise<string | undefined> {
    return (await this.app.get(ObjectStorage).putObject(target.key, bytes, 'application/pdf')).version;
  }

  /**
   * Creates a lab-pdf report and stores its file through the validated intake: declare, then send the bytes (unless `complete: false`, which stops after
   * the declaration). One person does all of it: the attempt belongs to whoever declared it, so the report's upload requester and uploader are that person.
   *
   * Tests of the independence rules need a requester or an uploader who is a different person; the intake cannot produce that, so for `requester` or
   * `completer` the report is seeded at the database with a real stored object instead (see `seededLabPdf`).
   */
  async uploadedLabPdf(creator: Person, bytes: Buffer, options: { requester?: Person; completer?: Person; patientId?: string; complete?: boolean } = {}) {
    if (options.requester || options.completer) return this.seededLabPdf(creator, bytes, options);
    const patientId = options.patientId ?? (await this.patient(creator));
    const reportId = (
      await this.api().post('/api/v1/reports').set(bearer(creator.token)).send({ patientId, type: 'lab-pdf', filename: 'sample.pdf', sizeBytes: bytes.length }).expect(201)
    ).body.id as string;
    const state = (await this.api().get(`/api/v1/reports/${reportId}/upload-state`).set(bearer(creator.token)).expect(200)).body;
    const attempt = (
      await this.api()
        .post(`/api/v1/reports/${reportId}/upload-attempts`)
        .set(bearer(creator.token))
        .send({ requestId: randomUUID(), revision: state.revision, contentType: 'application/pdf', sha256: sha(bytes) })
        .expect(201)
    ).body as { attemptId: string; revision: string };
    if (options.complete !== false) {
      await this.api()
        .put(`/api/v1/reports/${reportId}/upload-attempts/${attempt.attemptId}/bytes`)
        .set(bearer(creator.token))
        .set('X-Upload-Revision', attempt.revision)
        .set('Content-Type', 'application/pdf')
        .send(bytes)
        .expect(200);
    }
    const [row] = await this.row<{ storage_key: string; object_version: string | null }>('SELECT storage_key, object_version FROM reports WHERE id = $1', [reportId]);
    return { reportId, patientId, target: { key: row!.storage_key }, version: row!.object_version ?? undefined, pdfSha256: sha(bytes) };
  }

  /**
   * A lab-pdf report whose requester and uploader are chosen people, for the tests of the independence rules. The report is created through the API; the
   * file is written to the store directly and the evidence columns are set with one owner statement, the way the legacy completion once set them.
   * Test fixture only: no route can do this.
   */
  async seededLabPdf(creator: Person, bytes: Buffer, options: { requester?: Person; completer?: Person; patientId?: string; complete?: boolean } = {}) {
    const requester = options.requester ?? creator;
    const completer = options.completer ?? creator;
    const patientId = options.patientId ?? (await this.patient(creator));
    const reportId = (
      await this.api().post('/api/v1/reports').set(bearer(creator.token)).send({ patientId, type: 'lab-pdf', filename: 'sample.pdf', sizeBytes: bytes.length }).expect(201)
    ).body.id as string;
    const key = `reports/seeded/${reportId}/${randomUUID()}`;
    const target = { key };
    if (options.complete === false) {
      await this.row('UPDATE reports SET storage_key = $2, content_type = $3, sha256 = $4, upload_requested_by = $5 WHERE id = $1', [
        reportId,
        key,
        'application/pdf',
        sha(bytes),
        requester.sub,
      ]);
      return { reportId, patientId, target, version: undefined as string | undefined, pdfSha256: sha(bytes) };
    }
    const version = await this.put(target, bytes);
    await this.row(
      'UPDATE reports SET storage_key = $2, content_type = $3, sha256 = $4, upload_requested_by = $5, uploaded_at = now(), object_version = $6, uploaded_by = $7 WHERE id = $1',
      [reportId, key, 'application/pdf', sha(bytes), requester.sub, version, completer.sub],
    );
    return { reportId, patientId, target, version, pdfSha256: sha(bytes) };
  }

  capture(who: Person, reportId: string) {
    return this.api().post(`/api/v1/reports/${reportId}/capture`).set(bearer(who.token));
  }

  decide(who: Person, captureId: string, body: object) {
    return this.api().post(`/api/v1/captures/${captureId}/decision`).set(bearer(who.token)).send(body);
  }

  evaluate(who: Person, reportId: string, body: object) {
    return this.api().post(`/api/v1/reports/${reportId}/evaluations`).set(bearer(who.token)).send(body);
  }

  patientLink(who: Person, reportId: string) {
    return this.api().get(`/api/v1/reports/${reportId}/patient-link`).set(bearer(who.token));
  }

  /** `POST /reports/:id/patient-link/decisions`. */
  decideLink(who: Person, reportId: string, body: object) {
    return this.api().post(`/api/v1/reports/${reportId}/patient-link/decisions`).set(bearer(who.token)).send(body);
  }

  /** A second person attests that this file belongs to its patient (the weaker method, which needs no registered identifier). */
  verifyLink(who: Person, reportId: string) {
    return this.decideLink(who, reportId, { decision: 'verified', method: 'person-confirmed', basisCode: 'documented-clinic-procedure' });
  }

  /**
   * The whole run up to an evaluation, by different people: a clinician uploads and captures, an independent reviewer accepts.
   * Then (unless `verified: false`) the reviewer, who took no part in registering or uploading it, verifies the report's patient link.
   * Returns the ids an evaluation request names.
   */
  async reviewedCapture(bytes: Buffer, who: { clinician?: Person; reviewer?: Person; verified?: boolean } = {}) {
    const clinician = who.clinician ?? (await this.person('clin', ['clinician']));
    const reviewer = who.reviewer ?? (await this.person('rev', ['reviewer']));
    const up = await this.uploadedLabPdf(clinician, bytes);
    const capture = (await this.capture(clinician, up.reportId).expect(201)).body;
    const acceptance = (await this.decide(reviewer, capture.id, { decision: 'accepted' }).expect(201)).body;
    if (who.verified !== false) await this.verifyLink(reviewer, up.reportId).expect(201);
    return { clinician, reviewer, reportId: up.reportId, patientId: up.patientId, captureId: capture.id as string, acceptanceId: acceptance.id as string, upload: up };
  }

  row<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    return withAdmin(this.adminUrl, async (c) => (await c.query(sql, values)).rows as T[]);
  }

  async count(table: string, where = 'true', values: unknown[] = []): Promise<number> {
    return (await this.row<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values))[0]!.n;
  }

  /** Removes one object version from the store, as an operator with break-glass rights could. */
  async deleteVersion(key: string, version: string): Promise<void> {
    const storage = this.app.get(ObjectStorage);
    if (storage instanceof InMemoryObjectStorage) return storage.deleteVersion(key, version);
    const client = new S3Client({ region: 'us-east-1', endpoint: process.env.TEST_S3_ENDPOINT, forcePathStyle: true });
    await client.send(new DeleteObjectCommand({ Bucket: (storage as unknown as { bucket: string }).bucket, Key: key, VersionId: version }));
  }
}
