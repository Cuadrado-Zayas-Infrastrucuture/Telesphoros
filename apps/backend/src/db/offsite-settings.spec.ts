import { loadOffsiteSettings, OffsiteError } from './offsite';

/**
 * The KMS key settings are refused at load when the backups bucket policy would refuse the upload anyway (verified under the IAM policy simulator,
 * docs/verification/bucket-policy-simulation.md): `aws:kms` with no key id is DenyManagedKey, and a key that is not its full ARN is DenyOtherKey. Failing
 * here stops a backup before the dump, with a message that names the setting. The rest of the loader is tested in test/object-storage/offsite.s3-spec.ts.
 */
const ARN = 'arn:aws:kms:us-east-1:111122223333:key/22222222-2222-4222-8222-222222222222';

describe('the off-site KMS key settings', () => {
  it('load with no encryption header, so the bucket default applies (the documented set-up)', () => {
    expect(loadOffsiteSettings({})).toMatchObject({ sse: undefined, kmsKeyId: undefined });
  });

  it('load aws:kms with the full key ARN, from the environment or the command line (positive control)', () => {
    expect(loadOffsiteSettings({ BACKUP_S3_SSE: 'aws:kms', BACKUP_S3_KMS_KEY_ID: ARN })).toMatchObject({ sse: 'aws:kms', kmsKeyId: ARN });
    expect(loadOffsiteSettings({}, { sse: 'aws:kms', kmsKeyId: ARN })).toMatchObject({ sse: 'aws:kms', kmsKeyId: ARN });
    const multiRegion = 'arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab';
    expect(loadOffsiteSettings({ BACKUP_S3_SSE: 'aws:kms', BACKUP_S3_KMS_KEY_ID: multiRegion }).kmsKeyId).toBe(multiRegion);
  });

  it('refuse aws:kms with no key id: S3 would encrypt with the AWS-managed key, and the bucket refuses that', () => {
    expect(() => loadOffsiteSettings({ BACKUP_S3_SSE: 'aws:kms' })).toThrow(OffsiteError);
    expect(() => loadOffsiteSettings({ BACKUP_S3_SSE: 'aws:kms' })).toThrow(/BACKUP_S3_KMS_KEY_ID/);
  });

  it.each([
    ['a bare key id', '22222222-2222-4222-8222-222222222222'],
    ['an alias name', 'alias/telesphoros-backups'],
    ['an alias ARN', 'arn:aws:kms:us-east-1:111122223333:alias/telesphoros-backups'],
    ['an ARN of another service', 'arn:aws:s3:::example-backups'],
    ['an ARN with a short account', 'arn:aws:kms:us-east-1:1111:key/22222222-2222-4222-8222-222222222222'],
  ])('refuse %s as the key, from the environment or the command line, and never echo it', (_name, value) => {
    for (const load of [() => loadOffsiteSettings({ BACKUP_S3_SSE: 'aws:kms', BACKUP_S3_KMS_KEY_ID: value }), () => loadOffsiteSettings({}, { sse: 'aws:kms', kmsKeyId: value })]) {
      let message = '';
      try {
        load();
      } catch (error) {
        expect(error).toBeInstanceOf(OffsiteError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/full key ARN/);
      expect(message).not.toContain(value);
    }
  });
});
