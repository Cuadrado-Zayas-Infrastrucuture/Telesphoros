import { Readable } from 'node:stream';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { S3ObjectStorage } from './s3-object-storage';

// The reports bucket is created with Object Lock (infrastructure/terraform/storage.tf). S3 refuses a PutObject to a locked bucket
// unless the request carries Content-MD5 or an x-amz-checksum-* value. The application sets neither itself: it relies on the SDK's
// default (requestChecksumCalculation WHEN_SUPPORTED). These tests pin that the application's real write paths still send one, so a
// later SDK default change or a "WHEN_REQUIRED" setting cannot silently break every upload in production. Nothing leaves the process:
// the last middleware records the signed request and answers in place of S3.

/** A real S3 client (no custom endpoint, as in production) whose requests are recorded and answered locally. */
function recordingClient(config: Partial<S3ClientConfig> = {}) {
  const client = new S3Client({ region: 'us-east-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, ...config });
  const sent: Record<string, string>[] = [];
  client.middlewareStack.add(
    () => async (args) => {
      const { headers } = args.request as { headers: Record<string, string> };
      sent.push(Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])));
      return { response: { statusCode: 200, headers: { 'x-amz-version-id': 'synthetic-version' }, body: Readable.from([]) } } as never;
    },
    // Innermost: after signing (so the recorded headers are the ones S3 would see) and inside the deserializer (so the answer is parsed).
    { step: 'deserialize', priority: 'low', name: 'recordAndAnswerLocally' },
  );
  return { client, sent };
}

/** True when the request proves its content to S3: Content-MD5, a checksum header, or a checksum announced as a trailer. */
const carriesChecksum = (headers: Record<string, string>) =>
  'content-md5' in headers || Object.keys(headers).some((name) => name.startsWith('x-amz-checksum-')) || /^x-amz-checksum-/.test(headers['x-amz-trailer'] ?? '');

describe('report writes carry a checksum, as Object Lock requires', () => {
  it('putObject (a buffered write) sends one', async () => {
    const { client, sent } = recordingClient();
    const result = await new S3ObjectStorage(client, 'synthetic-reports').putObject('reports/synthetic.json', Buffer.from('{"synthetic":true}'), 'application/json');
    expect(result.version).toBe('synthetic-version');
    expect(sent).toHaveLength(1);
    expect(carriesChecksum(sent[0]!)).toBe(true);
  });

  it('putStream (the validated intake path) sends one', async () => {
    const { client, sent } = recordingClient();
    const bytes = Buffer.from('{"synthetic":true}');
    await new S3ObjectStorage(client, 'synthetic-reports').putStream('reports/synthetic.json', Readable.from([bytes]), 'application/json', bytes.length, AbortSignal.timeout(5000));
    expect(sent).toHaveLength(1);
    expect(carriesChecksum(sent[0]!)).toBe(true);
  });

  it('control: with checksums only "when required", the same write sends none (what would break against a locked bucket)', async () => {
    const { client, sent } = recordingClient({ requestChecksumCalculation: 'WHEN_REQUIRED' });
    await new S3ObjectStorage(client, 'synthetic-reports').putObject('reports/synthetic.json', Buffer.from('{"synthetic":true}'), 'application/json');
    expect(sent).toHaveLength(1);
    expect(carriesChecksum(sent[0]!)).toBe(false);
  });
});
