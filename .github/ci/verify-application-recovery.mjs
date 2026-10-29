import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allProfiles, profilesFromEnv } from './service-profiles.mjs';

const refuse = () => { throw new Error('Application recovery measurement validation failed.'); };
const keys = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) refuse();
};
const count = value => { if (!Number.isSafeInteger(value) || value < 0) refuse(); };
const volume = (value, objects = false) => {
  keys(value, objects ? ['objects', 'bytes', 'GB', 'GiB'] : ['bytes', 'GB', 'GiB']); count(value.bytes);
  if (objects) count(value.objects);
  if (value.GB !== value.bytes / 1e9 || value.GiB !== value.bytes / 1024 ** 3) refuse();
};
const controls = ['application-primary-copy-reads-and-target-writes-denied', 'actual-app-api-links-evaluations-isolation-and-holds',
  'tampered-install', 'foreign-destination', 'foreign-db', 'startup-missing', 'runtime-pdf', 'runtime-text',
  'missing-object', 'text-corrupt', 'missing-mapping', 'truncated', 'healthy-safe-resume-after-faults'];
const apiControls = ['restricted-login-rls', 'module-health-readiness', 'link-authentication-roles-and-tenant', 'verified-version-links',
  'standard-and-pdf-bytes', 'soft-deletion', 'golden-evaluations-and-clinical-holds', 'evaluation-tenant-isolation',
  'database-evidence-guard', 'ledger-validity', 'read-only-and-exact-pin-refusal', 'unchanged-evidence-inventory'];

/** Aggregate-only whitelist; no inventory, URLs, source IDs or credentials may enter retained artifacts. */
export function verifyApplicationRecovery(value) {
  keys(value, ['format', 'synthetic', 'status', 'controls', 'runtime', 'sourceDatabase', 'measurements', 'applicationRecoveryComplete', 'clinicalUseApproved', 'nativeReplicationVerified']);
  if (value.format !== 1 || value.synthetic !== true || value.status !== 'passed' || value.applicationRecoveryComplete !== true || value.clinicalUseApproved !== false || value.nativeReplicationVerified !== false) refuse();
  keys(value.runtime, ['node', 'platform', 'architecture', 'gitHead', 'storage', 'freshProcess']);
  if (value.runtime.node !== 'v22.22.0' || !/^[a-f0-9]{40}$/.test(value.runtime.gitHead) || !['linux', 'darwin'].includes(value.runtime.platform) || !['arm64', 'x64'].includes(value.runtime.architecture) || value.runtime.freshProcess !== true || value.runtime.storage !== 'loopback PostgreSQL/Moto; synthetic gateway, not AWS IAM') refuse();
  volume(value.sourceDatabase); if (!value.sourceDatabase.bytes) refuse();
  if (!Array.isArray(value.controls) || value.controls.length !== controls.length || JSON.stringify(value.controls.map(c => c.name).sort()) !== JSON.stringify([...controls].sort())) refuse();
  for (const control of value.controls) { keys(control, ['name', 'passed']); if (control.passed !== true) refuse(); }
  if (!Array.isArray(value.measurements) || value.measurements.length !== 2) refuse();
  for (const measurement of value.measurements) {
    keys(measurement, ['recovery', 'application']);
    const { recovery: r, application: a } = measurement;
    keys(a, ['applicationRecoveryComplete', 'clinicalUseApproved', 'apiControls', 'linkedBytes', 'seconds']);
    if (a.applicationRecoveryComplete !== true || a.clinicalUseApproved !== false || !Array.isArray(a.apiControls) || JSON.stringify([...a.apiControls].sort()) !== JSON.stringify([...apiControls].sort()) || !a.linkedBytes || !Number.isFinite(a.seconds) || a.seconds < 0) refuse();
    count(a.linkedBytes);
    keys(r, ['format', 'databaseRecoveryVerified', 'independentBytesRecovered', 'applicationRecoveryComplete', 'identityMode', 'references', 'recoveredObjects', 'requiredByKind', 'volumes', 'seconds', 'concurrency']);
    if (r.format !== 1 || r.databaseRecoveryVerified !== true || r.independentBytesRecovered !== true || r.applicationRecoveryComplete !== false || r.identityMode !== 'translated-test-only' || r.references !== 7 || r.recoveredObjects !== 7 || r.concurrency !== 1) refuse();
    keys(r.requiredByKind, ['lab-pdf', 'structured', 'text']);
    let bytes = 0; let objects = 0;
    for (const [kind, v] of Object.entries(r.requiredByKind)) {
      volume(v, true); if (!v.bytes || v.objects !== (kind === 'lab-pdf' ? 3 : 2)) refuse(); bytes += v.bytes; objects += v.objects;
    }
    if (objects !== 7) refuse();
    keys(r.volumes, ['restoredDatabase', 'archive', 'catalogue', 'recoveredObjects', 'read', 'writeAttempted']);
    for (const v of Object.values(r.volumes)) volume(v);
    if (!r.volumes.restoredDatabase.bytes || !r.volumes.archive.bytes || !r.volumes.catalogue.bytes || r.volumes.recoveredObjects.bytes !== bytes || r.volumes.read.bytes < bytes) refuse();
    keys(r.seconds, ['backupDownload', 'catalogue', 'restoreAndEvidence', 'evidenceVerification', 'total']);
    for (const duration of Object.values(r.seconds)) if (!Number.isFinite(duration) || duration < 0) refuse();
    if (r.seconds.total < r.seconds.restoreAndEvidence || r.seconds.restoreAndEvidence < r.seconds.evidenceVerification || a.seconds > r.seconds.restoreAndEvidence) refuse();
  }
  if (value.measurements[0].recovery.volumes.writeAttempted.bytes <= 0 || value.measurements[1].recovery.volumes.writeAttempted.bytes !== 0) refuse();
  return true;
}
export function verifyApplicationProfiles(directory, head, profiles = allProfiles) {
  for (const profile of profiles) {
    let value;
    try { value = JSON.parse(readFileSync(resolve(directory, 'application-recovery-' + profile + '.json'), 'utf8')); } catch { refuse(); }
    verifyApplicationRecovery(value); if (head && value.runtime.gitHead !== head) refuse();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { verifyApplicationProfiles('apps/backend/test-results', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), profilesFromEnv()); process.stdout.write('PASS the expected application recovery measurement profiles.\n'); }
  catch { process.stderr.write('FAIL application recovery measurement profiles.\n'); process.exitCode = 1; }
}
