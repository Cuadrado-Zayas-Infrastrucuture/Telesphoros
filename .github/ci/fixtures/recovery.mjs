export function recoveryMetricControl() {
  const volume = bytes => ({ bytes, GB: bytes / 1e9, GiB: bytes / 1024 ** 3 });
  const metric = { format: 1, databaseRecoveryVerified: true, independentBytesRecovered: true, applicationRecoveryComplete: false, identityMode: 'translated-test-only', references: 5, recoveredObjects: 5, concurrency: 1,
    requiredByKind: Object.fromEntries(['lab-pdf', 'structured', 'text'].map(kind => [kind, { objects: kind === 'lab-pdf' || kind === 'structured' ? 2 : 1, ...volume(kind === 'structured' ? 20 : 10) }])),
    volumes: { restoredDatabase: volume(300), archive: volume(100), catalogue: volume(90), recoveredObjects: volume(40), read: volume(100), writeAttempted: volume(10) },
    seconds: { backupDownload: 1, catalogue: 1, restoreAndEvidence: 3, evidenceVerification: 2, total: 5 } };
  const measurements = Array.from({ length: 7 }, () => structuredClone(metric)); measurements.at(-1).volumes.writeAttempted = volume(0);
  return { format: 1, synthetic: true, status: 'passed', controls: Array.from({ length: 30 }, (_, i) => ({ name: 'control-' + i, passed: true })),
    runtime: { node: 'v22.22.0', platform: 'linux', architecture: 'x64', gitHead: 'a'.repeat(40), storage: 'loopback PostgreSQL/Moto; synthetic gateway, not AWS IAM', freshProcess: true }, sourceDatabase: volume(300), measurements, applicationRecoveryComplete: false, nativeReplicationVerified: false };
}

export function applicationMetricControl() {
  const value = recoveryMetricControl();
  const r = value.measurements[0]; r.references = 7; r.recoveredObjects = 7;
  for (const [kind, v] of Object.entries(r.requiredByKind)) v.objects = kind === 'lab-pdf' ? 3 : 2;
  const application = { applicationRecoveryComplete: true, clinicalUseApproved: false, apiControls: ['restricted-login-rls', 'module-health-readiness', 'link-authentication-roles-and-tenant', 'verified-version-links',
    'standard-and-pdf-bytes', 'soft-deletion', 'golden-evaluations-and-clinical-holds', 'evaluation-tenant-isolation', 'database-evidence-guard', 'ledger-validity', 'read-only-and-exact-pin-refusal', 'unchanged-evidence-inventory'], linkedBytes: 20, seconds: 1 };
  const measurements = [{ recovery: r, application }, structuredClone({ recovery: r, application })];
  measurements[1].recovery.volumes.writeAttempted = { bytes: 0, GB: 0, GiB: 0 };
  const names = ['application-primary-copy-reads-and-target-writes-denied', 'actual-app-api-links-evaluations-isolation-and-holds',
    'tampered-install', 'foreign-destination', 'foreign-db', 'startup-missing', 'runtime-pdf', 'runtime-text', 'missing-object', 'text-corrupt', 'missing-mapping', 'truncated', 'healthy-safe-resume-after-faults'];
  return { ...value, controls: names.map(name => ({ name, passed: true })), measurements, applicationRecoveryComplete: true, clinicalUseApproved: false };
}
