import * as zlib from 'node:zlib';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorCode, errorResponseSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA } from './helpers/tokens';

// A compressed request body is decoded by Node's zlib before any guard runs, so an anonymous caller would reach the decoder. Every body
// parser refuses compression (inflate: false); only lab intake reads raw bytes, and it refuses compression itself.

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());

const encoders: Record<string, (body: Buffer) => Buffer> = {
  br: (body) => zlib.brotliCompressSync(body),
  gzip: (body) => zlib.gzipSync(body),
  deflate: (body) => zlib.deflateSync(body),
  zstd: (body) => zlib.zstdCompressSync(body),
};
const bodies = {
  'application/json': Buffer.from(JSON.stringify({ label: 'SYN-compressed' })),
  'application/x-www-form-urlencoded': Buffer.from('label=SYN-compressed'),
};
const cases = Object.entries(bodies).flatMap(([type, body]) => Object.keys(encoders).map((encoding) => [type, encoding, body] as const));

// Raw bytes on the wire: superagent would otherwise JSON-encode a Buffer sent with a JSON content type.
const asSent = (bytes: Buffer) => bytes as unknown as string;
const post = (type: string, bytes: Buffer, headers: Record<string, string> = {}) =>
  api()
    .post('/api/v1/patients')
    .set({ 'Content-Type': type, ...headers })
    .serialize(() => asSent(bytes))
    .send(asSent(bytes));

const labels = async () => {
  const res = await api()
    .get('/api/v1/patients')
    .set(bearer(await clinicianA()))
    .expect(200);
  return JSON.stringify(res.body);
};

it('the runtime offers every encoding the parsers know, so none of these cases is vacuous', () => {
  expect(typeof zlib.zstdCompressSync).toBe('function');
});

it.each(cases)('%s with Content-Encoding %s: 415 before authentication, in the error envelope', async (type, encoding, body) => {
  const res = await post(type, encoders[encoding]!(body), { 'Content-Encoding': encoding }).expect(415);
  expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
  expect(res.body.error.code).toBe(ErrorCode.BAD_REQUEST);
  expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
});

it.each(cases)('%s with Content-Encoding %s and a valid token: 415, nothing created', async (type, encoding, body) => {
  await post(type, encoders[encoding]!(body), { 'Content-Encoding': encoding, ...bearer(await clinicianA()) }).expect(415);
  expect(await labels()).not.toContain('SYN-compressed');
});

it('control: the same JSON body sent uncompressed (or as identity) is accepted', async () => {
  const token = bearer(await clinicianA());
  await post('application/json', bodies['application/json'], token).expect(201);
  await post('application/json', Buffer.from(JSON.stringify({ label: 'SYN-identity' })), { 'Content-Encoding': 'identity', ...token }).expect(201);
  const listed = await labels();
  expect(listed).toContain('SYN-compressed');
  expect(listed).toContain('SYN-identity');
});
