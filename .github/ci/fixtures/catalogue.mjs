// Numeric synthetic fixture only, matching the existing F1 producer's aggregate schema.
export function catalogueMetricControl() {
  const volume = bytes => ({ bytes, GB: bytes / 1e9, GiB: bytes / 1024 ** 3 });
  const metric = { format: 1, references: 5, uniqueObjects: 5, uncompletedRegistrations: 0, orphanTextObjects: 1,
    copiedObjectsVerified: 5, copiedBytesVerified: 40,
    requiredByKind: Object.fromEntries(['lab-pdf', 'structured', 'text'].map(kind => [kind, { objects: kind === 'lab-pdf' || kind === 'structured' ? 2 : 1, ...volume(kind === 'structured' ? 20 : 10) }])),
    volumes: Object.fromEntries(['restoredDatabase', 'archive', 'catalogue', 'requiredObjects', 'read', 'writeAttempted'].map(k => [k, volume(40)])),
    seconds: { restoreAndInventory: 1, resolve: 1, copyAndVerify: 1, publish: 1, total: 4 }, concurrency: 1,
    independentBytesRecovered: false, applicationRecoveryComplete: false };
  return { format: 1, synthetic: true, status: 'passed', controls: Array.from({ length: 12 }, (_, i) => ({ name: 'control-' + i, passed: true })),
    runtime: { node: 'v22.22.0', platform: 'linux', architecture: 'x64', gitHead: 'b'.repeat(40), storage: 'loopback PostgreSQL/Moto; metadata only' },
    sourceDatabase: volume(300), measurements: Array.from({ length: 3 }, () => structuredClone(metric)),
    independentBytesRecovered: false, applicationRecoveryComplete: false };
}
