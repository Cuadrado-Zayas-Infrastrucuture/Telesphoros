import { createServer, type RequestListener, type Server } from 'node:http';
import { EvidenceBudget } from '../src/db/evidence-storage';
import { S3EvidenceStorage } from '../src/db/s3-evidence-storage';
import { IncompleteEvidenceListingError } from '../src/db/evidence-catalogue';
import { run } from '../src/db/pg-process';

describe('operational S3 response boundaries', () => {
  let server: Server;
  let store: S3EvidenceStorage;
  afterEach(async () => {
    store?.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  async function start(handler: RequestListener) {
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    store = new S3EvidenceStorage({
      bucket: 'synthetic',
      prefix: 'reports/',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:' + port,
      credentials: { accessKeyId: 'syn', secretAccessKey: 'synthetic' },
    });
  }
  it('aborts a stalled body after headers have arrived and releases the socket', async () => {
    await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100', 'x-amz-version-id': 'v1' });
      res.write('a');
    });
    await expect(store.get('reports/stalled', 'v1', 100, new EvidenceBudget({ requestMs: 150 }))).rejects.toMatchObject({ code: 'limit' });
  });
  it('throws typed incomplete-listing timeout rather than returning a partial window', async () => {
    await start(() => undefined);
    await expect(store.versions('reports/stalled', {}, new EvidenceBudget({ requestMs: 100 }))).rejects.toBeInstanceOf(IncompleteEvidenceListingError);
  });
  it('retries transient read failures at most three times and strips provider payloads', async () => {
    let requests = 0;
    await start((_req, res) => {
      requests++;
      res.writeHead(500, { 'content-type': 'application/xml' });
      res.end('<Error><Code>InternalError</Code><Message>must-never-escape</Message></Error>');
    });
    await expect(store.keys(undefined, new EvidenceBudget())).rejects.toMatchObject({ code: 'storage', message: 'Evidence catalogue refused: storage.' });
    expect(requests).toBe(3);
  });
  it('rejects a key outside its fixed prefix without sending any request', async () => {
    let requests = 0;
    await start((_req, res) => {
      requests++;
      res.end();
    });
    await expect(store.get('foreign/key', 'v1', 10, new EvidenceBudget())).rejects.toMatchObject({ code: 'storage' });
    expect(requests).toBe(0);
  });
  it('records honest unversioned null-state and refuses a missing header for an explicitly pinned read', async () => {
    await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '3' });
      res.end('abc');
    });
    expect((await store.get('reports/unversioned', undefined, 3, new EvidenceBudget()))!.version).toBe('null');
    expect((await store.get('reports/unversioned', 'null', 3, new EvidenceBudget()))!.version).toBe('null');
    await expect(store.get('reports/unversioned', 'real-pdf-pin', 3, new EvidenceBudget())).rejects.toMatchObject({ code: 'integrity' });
  });
});

it('kills an over-budget restore subprocess instead of leaving an unbounded command', async () => {
  await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { PATH: process.env.PATH }, 50)).rejects.toThrow('exited with code');
});
