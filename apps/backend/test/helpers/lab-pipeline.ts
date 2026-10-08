import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { InMemoryObjectStorage } from '../../src/object-storage/in-memory-object-storage';
import { ObjectStorage } from '../../src/object-storage/object-storage';
import { withAdmin } from './database';
import { bearer, signToken } from './tokens';

export const FIXTURES = resolve(__dirname, '../../../../knowledge/lab-report-reader/v2-handoff/fixtures/captures');
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
    return (await this.api().post('/api/v1/patients').set(bearer(who.token)).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id as string;
  }

  /** What the browser does: PUT the bytes to the URL with the headers it was given. Returns the version the store reported. */
  async put(target: { uploadUrl: string; headers: Record<string, string> }, bytes: Buffer): Promise<string | undefined> {
    if (target.uploadUrl.startsWith('memory://')) {
      return (this.app.get(ObjectStorage) as InMemoryObjectStorage).put(target.uploadUrl.replace('memory://reports/', ''), bytes, target.headers['Content-Type']!);
    }
    const res = await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers, body: bytes });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const id = res.headers.get('x-amz-version-id');
    return id && id !== 'null' ? id : undefined;
  }

  /**
   * Creates a lab-pdf report, asks for the upload link (as `requester`), uploads, and completes it (as `completer`).
   * Each step may be a different person, which is what the independence rules are about.
   */
  async uploadedLabPdf(creator: Person, bytes: Buffer, options: { requester?: Person; completer?: Person; patientId?: string; complete?: boolean } = {}) {
    const requester = options.requester ?? creator;
    const completer = options.completer ?? creator;
    const patientId = options.patientId ?? (await this.patient(creator));
    const reportId = (
      await this.api().post('/api/v1/reports').set(bearer(creator.token)).send({ patientId, type: 'lab-pdf', filename: 'sample.pdf', sizeBytes: bytes.length }).expect(201)
    ).body.id as string;
    const target = (
      await this.api().post(`/api/v1/reports/${reportId}/upload-url`).set(bearer(requester.token)).send({ contentType: 'application/pdf', sha256: sha(bytes) }).expect(200)
    ).body;
    const version = await this.put(target, bytes);
    if (options.complete !== false) await this.api().post(`/api/v1/reports/${reportId}/complete`).set(bearer(completer.token)).expect(200);
    return { reportId, patientId, target, version, pdfSha256: sha(bytes) };
  }

  capture(who: Person, reportId: string) {
    return this.api().post(`/api/v1/reports/${reportId}/capture`).set(bearer(who.token));
  }

  decide(who: Person, captureId: string, body: object) {
    return this.api().post(`/api/v1/captures/${captureId}/decision`).set(bearer(who.token)).send(body);
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
