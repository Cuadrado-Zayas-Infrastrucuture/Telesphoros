/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test worker loads Jest-equivalent SWC source modules. */
/* global require, process, Buffer */
// Test-only fresh process. SWC mirrors Jest; production code and its real S3/PG protocols are reused.
const { readFileSync } = require('node:fs');
const { transformSync } = require('@swc/core');
require.extensions['.ts'] = (module, filename) => {
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    filename,
    jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } },
    module: { type: 'commonjs' },
  });
  module._compile(code, filename);
};
const { independentRecoveryProbe } = require('./independent-recovery.ts');
const { S3EvidenceStorage } = require('../../src/db/s3-evidence-storage.ts');
const {
  EvidenceError,
  IncompleteEvidenceListingError,
  byteDigest,
  catalogueSchema,
  completionSchema,
  decryptDocument,
  encryptDocument,
} = require('../../src/db/evidence-catalogue.ts');
const { readKeyFile } = require('../../src/db/backup-crypto.ts');
process.once('message', async (config) => {
  if (config.application) require('@nestjs/common').Logger.overrideLogger(false); // matches the test app's LOG_LEVEL=silent
  const settings = { region: 'us-east-1', endpoint: config.endpoint, credentials: { accessKeyId: 'SYNRECOVERYREADER', secretAccessKey: 'synthetic-only' } };
  const copy = new S3EvidenceStorage({ ...settings, bucket: config.copyBucket, prefix: 'catalogues/' });
  const backup = new S3EvidenceStorage({ ...settings, bucket: config.backupBucket, prefix: 'backups/' });
  const recovery = new S3EvidenceStorage({
    ...settings,
    credentials: { accessKeyId: 'SYNRECOVERYLOADER', secretAccessKey: 'synthetic-only' },
    bucket: config.recoveryBucket,
    prefix: config.recoveryPrefix ?? 'recovered/',
  });
  if (config.fault === 'lost-recovery-reply') {
    const put = recovery.put.bind(recovery);
    recovery.put = async (...args) => {
      await put(...args);
      throw new EvidenceError('storage');
    };
  }
  const get = copy.get.bind(copy);
  const versions = copy.versions.bind(copy);
  let cursorCalls = 0;
  let capPage;
  // Defect injections stay inside this test process; they never install an application storage provider.
  copy.versions = async (...args) => {
    if (config.fault === 'truncated') return { versions: [], truncated: true };
    if (config.fault === 'repeated') return { versions: [], truncated: true, keyMarker: 'same', versionMarker: 'null' };
    if (config.fault === 'timeout') throw new IncompleteEvidenceListingError('timeout');
    if (config.fault === 'terminal-cap' || config.fault === 'truncated-cap') {
      const page = (capPage ??= await versions(args[0], {}, args[2]));
      return ++cursorCalls === 1000
        ? { ...page, truncated: config.fault === 'truncated-cap', keyMarker: 'k1000', versionMarker: 'v1000' }
        : { versions: [], truncated: true, keyMarker: 'k' + cursorCalls, versionMarker: 'v' + cursorCalls };
    }
    return versions(...args);
  };
  copy.get = async (...args) => {
    const value = await get(...args);
    if (!value) return value;
    const object = args[0].includes('/objects/');
    if (object && config.fault === 'missing-object') return undefined;
    if (object && value.contentType === 'application/pdf' && config.fault === 'missing-pinned-pdf') return undefined;
    if (object && config.fault === 'interrupted' && ++config.readObjects === 2) throw new EvidenceError('limit');
    if (object && config.fault === 'wrong-encryption') return { ...value, encryption: 'aws:kms', keyId: 'wrong' };
    if (config.fault === 'short-retention') return { ...value, retainUntil: '2000-01-01T00:00:00Z' };
    if (object && config.fault === 'foreign-token') return { ...value, token: 'foreign' };
    if (object && value.contentType.startsWith('text/plain') && config.fault === 'text-corrupt') {
      const bytes = Buffer.from('corrupt text');
      return { ...value, bytes, sha256: byteDigest(bytes) };
    }
    if (args[0].endsWith('catalogue.enc') && config.fault === 'tampered-catalogue') {
      const bytes = Buffer.from(value.bytes);
      bytes[bytes.length - 1] ^= 1;
      return { ...value, bytes, sha256: byteDigest(bytes) };
    }
    if (['omitted-soft-delete', 'duplicate-mapping', 'missing-mapping', 'foreign-mapping', 'stale-binding'].includes(config.fault)) {
      const key = await readKeyFile(config.catalogueKeyFile);
      const catalogueKey = 'catalogues/' + config.generation + '/catalogue.enc';
      const pinnedCatalogueVersion = args[0].endsWith('completion.enc') ? (await decryptDocument(value.bytes, key, completionSchema)).catalogueVersion : args[1];
      const published = await get(catalogueKey, pinnedCatalogueVersion, 16 * 1024 ** 2 + 65536, args[3]);
      const catalogue = await decryptDocument(published.bytes, key, catalogueSchema);
      if (config.fault === 'omitted-soft-delete') {
        const omitted = catalogue.sources.find((s) => s.reference.kind === 'lab-pdf' && s.reference.tenantId === 'syn-f2-b');
        catalogue.sources = catalogue.sources.filter((s) => s.sourceId !== omitted.sourceId);
        catalogue.mappings = catalogue.mappings.filter((m) => m.sourceId !== omitted.sourceId);
      }
      if (config.fault === 'duplicate-mapping') catalogue.mappings.push(catalogue.mappings[0]);
      if (config.fault === 'missing-mapping') catalogue.mappings.pop();
      if (config.fault === 'foreign-mapping') catalogue.mappings[0].sourceId = '0'.repeat(64);
      if (config.fault === 'stale-binding') catalogue.binding.manifestSha256 = '0'.repeat(64);
      const bytes = await encryptDocument(catalogue, key);
      if (args[0].endsWith('completion.enc')) {
        const completion = await decryptDocument(value.bytes, key, completionSchema);
        completion.catalogueSha256 = byteDigest(bytes);
        completion.referenceCount = catalogue.sources.length;
        completion.objectCount = catalogue.mappings.length;
        const changed = await encryptDocument(completion, key);
        // Freeze this signed mutation for the subsequent exact catalogue read (encryption is randomized).
        config.mutatedCatalogue = bytes;
        return { ...value, bytes: changed, sha256: byteDigest(changed) };
      }
      if (args[0].endsWith('catalogue.enc')) return { ...value, bytes: config.mutatedCatalogue, sha256: byteDigest(config.mutatedCatalogue) };
    }
    return value;
  };
  try {
    config.readObjects = 0;
    let application;
    const afterBytesVerified = config.application
      ? async (url, catalogue) => {
          const { applicationAcceptance } = require('./application-recovery.ts');
          application = await applicationAcceptance(url, catalogue, config);
        }
      : undefined;
    const metrics = await independentRecoveryProbe({ ...config, copy, backup, recovery, afterBytesVerified });
    process.send({ status: 'passed', metrics, ...(application ? { application } : {}) });
  } catch (error) {
    process.send({
      status: 'refused',
      code: error instanceof EvidenceError ? error.code : 'internal',
      errorType: error instanceof IncompleteEvidenceListingError ? error.name : 'EvidenceError',
      independentBytesRecovered: false,
      applicationRecoveryComplete: false,
    });
  } finally {
    copy.destroy();
    backup.destroy();
    recovery.destroy();
    process.disconnect();
  }
});
