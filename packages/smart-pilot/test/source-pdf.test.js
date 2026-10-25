import http from 'node:http';
import crypto from 'node:crypto';
import { readSourcePdf } from '../src/source-pdf.js';

const bytes = Buffer.from('%PDF-1.4\nSYNTHETIC ONLY\n%%EOF\n');
const expected = { sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
let server, origin, link, mode, requests, headers, body;
beforeEach(async () => {
  mode = 'ok';
  requests = [];
  body = bytes;
  headers = { 'content-type': 'application/pdf', 'x-amz-version-id': 'pinned-v1' };
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (mode === 'redirect') {
      res.writeHead(302, { location: `${origin}/redirected` });
      return res.end();
    }
    if (mode === 'missing') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, headers);
    if (mode === 'drip') {
      res.flushHeaders();
      const timer = setInterval(() => res.write('x'), 100);
      res.once('close', () => clearInterval(timer));
      return;
    }
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  link = { url: `${origin}/synthetic/report.pdf?versionId=pinned-v1&X-Amz-Signature=synthetic-only`, expiresAt: new Date(Date.now() + 60000).toISOString() };
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});
const read = () => readSourcePdf(link, origin, expected);
test('reads exact bytes with a bounded GET, no bearer and no URL in output', async () => {
  const result = await read();
  expect(result).toMatchObject({ versionId: 'pinned-v1', data: bytes.toString('base64'), size: bytes.length, sha256: expected.sha256 });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  expect(requests[0].headers.authorization).toBeUndefined();
  expect(requests[0].headers.cookie).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('X-Amz');
});
test.each([
  [
    'redirect',
    () => {
      mode = 'redirect';
    },
  ],
  [
    'missing version',
    () => {
      mode = 'missing';
    },
  ],
  [
    'wrong response version',
    () => {
      headers['x-amz-version-id'] = 'latest-v2';
    },
  ],
  [
    'absent response version',
    () => {
      delete headers['x-amz-version-id'];
    },
  ],
  [
    'wrong content type',
    () => {
      headers['content-type'] = 'text/html';
    },
  ],
  [
    'content encoding',
    () => {
      headers['content-encoding'] = 'gzip';
    },
  ],
  [
    'digest mismatch',
    () => {
      body = Buffer.from(bytes);
      body[12] ^= 1;
    },
  ],
  [
    'short bytes',
    () => {
      body = bytes.subarray(0, 6);
    },
  ],
  [
    'oversized stream',
    () => {
      body = Buffer.concat([bytes, bytes]);
    },
  ],
])('withholds %s with a successful control', async (_name, mutate) => {
  await read();
  requests.length = 0;
  mutate();
  await expect(read()).rejects.toThrow();
  expect(requests).toHaveLength(1);
});
test.each([
  [
    'foreign origin',
    () => {
      link.url = 'http://127.0.0.1:1/file?versionId=pinned-v1';
    },
  ],
  [
    'remote origin',
    () => {
      link.url = 'https://example.com/file?versionId=pinned-v1';
    },
  ],
  [
    'latest',
    () => {
      link.url = `${origin}/file`;
    },
  ],
  [
    'ambiguous version',
    () => {
      link.url += '&versionId=other';
    },
  ],
  [
    'null version',
    () => {
      link.url = `${origin}/file?versionId=null`;
    },
  ],
  [
    'expired link',
    () => {
      link.expiresAt = '2000-01-01T00:00:00Z';
    },
  ],
])('refuses %s before any transport', async (_name, mutate) => {
  await read();
  requests.length = 0;
  mutate();
  await expect(read()).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
test('checks expiry again after receiving bytes', async () => {
  await read();
  let calls = 0;
  await expect(readSourcePdf(link, origin, expected, () => (++calls === 1 ? Date.now() : Date.now() + 120000))).rejects.toThrow('source_pdf_withheld');
});
test('refuses non-PDF bytes even with matching declared digest', async () => {
  await read();
  body = Buffer.alloc(bytes.length, 'x');
  await expect(readSourcePdf(link, origin, { sizeBytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') })).rejects.toThrow('source_pdf_withheld');
});

test('an active slow stream cannot extend the absolute download deadline', async () => {
  await read();
  mode = 'drip';
  const started = Date.now();
  await expect(readSourcePdf(link, origin, { ...expected, sizeBytes: 1024 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(8000);
});
