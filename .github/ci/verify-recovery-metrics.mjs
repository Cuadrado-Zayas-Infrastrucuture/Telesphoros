import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const refuse = () => { throw new Error('Independent recovery measurement validation failed.'); };
const keys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) refuse();
};
const count = value => { if (!Number.isSafeInteger(value) || value < 0) refuse(); };
const volume = (value, objects = false) => {
  keys(value, objects ? ['objects', 'bytes', 'GB', 'GiB'] : ['bytes', 'GB', 'GiB']); count(value.bytes);
  if (objects) count(value.objects);
  if (value.GB !== value.bytes / 1e9 || value.GiB !== value.bytes / 1024 ** 3) refuse();
};

/** Fixed whitelist: confidential catalogue/identifiers cannot silently become retained CI evidence. */
export function verifyRecoveryMetrics(value) {
  keys(value, ['format', 'synthetic', 'status', 'controls', 'runtime', 'sourceDatabase', 'measurements', 'applicationRecoveryComplete', 'nativeReplicationVerified']);
  if (value.format !== 1 || value.synthetic !== true || value.status !== 'passed' || value.applicationRecoveryComplete !== false || value.nativeReplicationVerified !== false) refuse();
  keys(value.runtime, ['node', 'platform', 'architecture', 'gitHead', 'storage', 'freshProcess']);
  if (!/^v22\.22\.0$/.test(value.runtime.node) || !/^[a-f0-9]{40}$/.test(value.runtime.gitHead) || !['linux', 'darwin'].includes(value.runtime.platform) || !['arm64', 'x64'].includes(value.runtime.architecture) || value.runtime.freshProcess !== true || value.runtime.storage !== 'loopback PostgreSQL/Moto; synthetic gateway, not AWS IAM') refuse();
  volume(value.sourceDatabase); if (!value.sourceDatabase.bytes) refuse();
  if (!Array.isArray(value.controls) || value.controls.length !== 30 || new Set(value.controls.map(c => c.name)).size !== 30) refuse();
  for (const control of value.controls) {
    keys(control, ['name', 'passed']); if (control.passed !== true || !/^[a-z0-9-]{1,80}$/.test(control.name)) refuse();
  }
  if (!Array.isArray(value.measurements) || value.measurements.length !== 7) refuse();
  for (const metric of value.measurements) {
    keys(metric, ['format', 'databaseRecoveryVerified', 'independentBytesRecovered', 'applicationRecoveryComplete', 'identityMode', 'references', 'recoveredObjects', 'requiredByKind', 'volumes', 'seconds', 'concurrency']);
    if (metric.format !== 1 || metric.databaseRecoveryVerified !== true || metric.independentBytesRecovered !== true || metric.applicationRecoveryComplete !== false || metric.identityMode !== 'translated-test-only' || metric.references !== 5 || metric.recoveredObjects !== 5 || metric.concurrency !== 1) refuse();
    keys(metric.requiredByKind, ['lab-pdf', 'vcf', 'structured', 'text']);
    let bytes = 0; let objects = 0;
    for (const value of Object.values(metric.requiredByKind)) { volume(value, true); if (!value.bytes || !value.objects) refuse(); bytes += value.bytes; objects += value.objects; }
    if (objects !== metric.recoveredObjects) refuse();
    keys(metric.volumes, ['restoredDatabase', 'archive', 'catalogue', 'recoveredObjects', 'read', 'writeAttempted']);
    for (const value of Object.values(metric.volumes)) volume(value);
    if (!metric.volumes.restoredDatabase.bytes || !metric.volumes.archive.bytes || !metric.volumes.catalogue.bytes || metric.volumes.recoveredObjects.bytes !== bytes || metric.volumes.read.bytes < bytes) refuse();
    keys(metric.seconds, ['backupDownload', 'catalogue', 'restoreAndEvidence', 'evidenceVerification', 'total']);
    for (const duration of Object.values(metric.seconds)) if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) refuse();
    if (metric.seconds.total < metric.seconds.restoreAndEvidence || metric.seconds.restoreAndEvidence < metric.seconds.evidenceVerification) refuse();
  }
  if (value.measurements.at(-1).volumes.writeAttempted.bytes !== 0 || !value.measurements.some(m => m.volumes.writeAttempted.bytes > 0)) refuse();
  return true;
}

export function verifyAllProfiles(directory, expectedHead) {
  for (const profile of ['memory', 'postgres', 'postgres-s3']) {
    let value;
    try { value = JSON.parse(readFileSync(resolve(directory, 'independent-recovery-' + profile + '.json'), 'utf8')); }
    catch { refuse(); }
    verifyRecoveryMetrics(value);
    if (expectedHead && value.runtime.gitHead !== expectedHead) refuse();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { verifyAllProfiles('apps/backend/test-results', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()); process.stdout.write('PASS all three independent recovery measurement profiles.\n'); }
  catch { process.stderr.write('FAIL independent recovery measurement profiles.\n'); process.exitCode = 1; }
}
