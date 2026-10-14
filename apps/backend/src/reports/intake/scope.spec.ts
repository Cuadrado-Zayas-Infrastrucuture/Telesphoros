import { randomUUID } from 'node:crypto';
import { tenantPrefix } from '../../lab-reports/object-keys';
import { intakeScope, organizationRunId } from './scope';

const report = randomUUID();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('intake scope', () => {
  it('gives an organization one stable, valid reservation id that no other organization shares', () => {
    expect(organizationRunId('tenant-a')).toMatch(UUID);
    expect(organizationRunId('tenant-a')).toBe(organizationRunId('tenant-a'));
    expect(organizationRunId('tenant-a')).not.toBe(organizationRunId('tenant-b'));
  });

  it('keys an organization attempt under its own report, apart from legacy keys and captured text', () => {
    const scope = intakeScope({ LOCAL_STORAGE_RUN_ID: undefined }, 'tenant-a', report);
    const attempt = randomUUID();
    expect(scope.kind).toBe('organization');
    expect(scope.keyFor(attempt)).toBe(`reports/${tenantPrefix('tenant-a')}/${report}/intake/${attempt}`);
    expect(scope.keyFor(attempt).startsWith(scope.prefix)).toBe(true);
    // The inventory prefix of one report is neither another report's nor another organization's, and not a prefix of either.
    const other = intakeScope({ LOCAL_STORAGE_RUN_ID: undefined }, 'tenant-a', randomUUID());
    const foreign = intakeScope({ LOCAL_STORAGE_RUN_ID: undefined }, 'tenant-b', report);
    for (const s of [other, foreign]) {
      expect(s.prefix.startsWith(scope.prefix)).toBe(false);
      expect(scope.prefix.startsWith(s.prefix)).toBe(false);
    }
    // A legacy key (`reports/<tenant>/<report>/<random>`) and a captured-text key (`.../text/...`) are never under the intake prefix.
    expect(`reports/${tenantPrefix('tenant-a')}/${report}/${randomUUID()}`.startsWith(scope.prefix)).toBe(false);
    expect(`reports/${tenantPrefix('tenant-a')}/${report}/text/abc-26.03.0`.startsWith(scope.prefix)).toBe(false);
  });

  it('leaves a disposable local run exactly as it was', () => {
    const run = randomUUID();
    const scope = intakeScope({ LOCAL_STORAGE_RUN_ID: run }, 'tenant-a', report);
    expect(scope).toMatchObject({ kind: 'local-run', runId: run, prefix: `local-storage/${run}/` });
    expect(scope.keyFor('x')).toBe(`local-storage/${run}/x`);
  });
});
