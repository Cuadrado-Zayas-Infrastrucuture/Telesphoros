import { type S3Client } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { bucketIsMissing } from '../src/storage';
import { REPORTS_BUCKET, s3Client } from './support';

// Against the S3 emulator, through the real SDK: the error that comes back for a bucket that is not there must be the one the check looks for.
let s3: S3Client;
beforeAll(async () => {
  s3 = await s3Client(); // creates the reports bucket
});

describe('bucketIsMissing against an S3 endpoint', () => {
  it('is true for a bucket that does not exist, and false for one that does', async () => {
    expect(await bucketIsMissing(s3, 'worker-test-no-such-bucket')).toBe(true);
    expect(await bucketIsMissing(s3, REPORTS_BUCKET)).toBe(false);
  });
});
