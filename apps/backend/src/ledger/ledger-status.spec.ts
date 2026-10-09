import { type Compromise, LedgerStatus, type OpenIncident } from './ledger-status';
import { LedgerCompromisedError } from './ledger-types';
import type { FailureKind } from './verifier';

const finding = (tenantId: string, kind: FailureKind = 'payload-mismatch'): Compromise => ({ tenantId, kind, seq: '3', source: 'startup', at: new Date(0) });
const incident = (over: Partial<OpenIncident> & { tenantId: string | null }): OpenIncident => ({
  id: `i-${over.tenantId ?? 'global'}`, scope: over.tenantId === null ? 'global' : 'tenant', kind: 'payload-mismatch', seq: '3', source: 'background', detectedAt: new Date(0), ...over,
});

describe('LedgerStatus', () => {
  it('refuses writes for a latched tenant only: other tenants keep writing', () => {
    const status = new LedgerStatus();
    expect(() => status.assertOpen('a')).not.toThrow();
    status.latch(finding('a'));
    expect(() => status.assertOpen('a')).toThrow(LedgerCompromisedError);
    expect(() => status.assertOpen('b')).not.toThrow();
  });

  it('keeps the FIRST finding of a tenant (the one an investigator needs), not the latest', () => {
    const status = new LedgerStatus();
    status.latch(finding('t', 'seq-gap'));
    status.latch(finding('t', 'head-mismatch'));
    expect(status.finding('t')).toMatchObject({ kind: 'seq-gap' });
    expect(status.compromised).toMatchObject({ tenantId: 't', kind: 'seq-gap' });
  });

  it('has no method that clears a finding by itself: only the database\'s record of a clearance does', () => {
    const names = Object.getOwnPropertyNames(LedgerStatus.prototype).filter((n) => n !== 'constructor');
    expect(names.filter((n) => /^(clear|reset|unlatch|release|reopen|unlock)/i.test(n))).toEqual([]);
  });

  describe('mirroring the database', () => {
    it('contains exactly the tenants with an open incident, and releases a tenant once its incident is no longer open', () => {
      const status = new LedgerStatus();
      status.syncOpen([incident({ tenantId: 'a' }), incident({ tenantId: 'b' })]);
      expect(status.containedTenants().sort()).toEqual(['a', 'b']);
      expect(() => status.assertOpen('b')).toThrow(LedgerCompromisedError);
      status.syncOpen([incident({ tenantId: 'a' })]); // a person cleared b
      expect(() => status.assertOpen('b')).not.toThrow();
      expect(() => status.assertOpen('a')).toThrow(LedgerCompromisedError);
      status.syncOpen([]);
      expect(status.containedTenants()).toEqual([]);
    });

    it('does not forget a finding the database has not been told about yet, and lets it go once it was recorded and later cleared', () => {
      const status = new LedgerStatus();
      status.latch(finding('a'));
      expect(status.unrecorded().map((f) => f.tenantId)).toEqual(['a']);
      status.syncOpen([]); // the database cannot have heard of it yet
      expect(() => status.assertOpen('a')).toThrow(LedgerCompromisedError);
      status.markRecorded('a');
      expect(status.unrecorded()).toEqual([]);
      status.syncOpen([]); // recorded, then cleared by a person
      expect(() => status.assertOpen('a')).not.toThrow();
    });

    it('a global hold refuses every tenant, is not a tenant incident, and ends when it is cleared', () => {
      const status = new LedgerStatus();
      status.syncOpen([incident({ tenantId: null, kind: 'manual-hold', seq: null, source: 'manual' })]);
      expect(() => status.assertOpen('anyone')).toThrow(LedgerCompromisedError);
      expect(status.hasIncident('anyone')).toBe(false);
      expect(status.containedTenants()).toEqual([]);
      expect(status.hold).toMatchObject({ tenantId: null, kind: 'manual-hold' });
      status.syncOpen([]);
      expect(() => status.assertOpen('anyone')).not.toThrow();
    });
  });

  it('maps its state to readiness: down, verifying, up; a contained tenant is "contained" (still ready); a global hold or a failed start check is down', () => {
    const status = new LedgerStatus();
    expect(status.readiness()).toBe('down');
    status.setTail('ok');
    expect(status.readiness()).toBe('verifying');
    status.setFullRunning(true);
    expect(status.readiness()).toBe('verifying');
    status.setFullRunning(false);
    status.markFullCompleted();
    expect(status.readiness()).toBe('up');
    status.setFullRunning(true); // a later scheduled walk is running again
    expect(status.readiness()).toBe('verifying');
    status.setFullRunning(false);

    status.latch(finding('a'));
    expect(status.readiness()).toBe('contained');
    status.syncOpen([incident({ tenantId: null, kind: 'manual-hold', seq: null, source: 'manual' })]);
    expect(status.readiness()).toBe('down');
    status.syncOpen([]);
    status.setTail('failed');
    expect(status.readiness()).toBe('down');
  });
});
