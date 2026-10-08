import { LedgerStatus } from './ledger-status';
import { LedgerCompromisedError } from './ledger-types';
import type { FailureKind } from './verifier';

const finding = (tenantId: string, kind: FailureKind = 'payload-mismatch') => ({ tenantId, kind, seq: '3', source: 'startup' as const, at: new Date(0) });

describe('LedgerStatus', () => {
  it('lets writes through until something is latched, then refuses every one with LedgerCompromisedError', () => {
    const status = new LedgerStatus();
    expect(() => status.assertOpen()).not.toThrow();
    status.latch(finding('a'));
    expect(() => status.assertOpen()).toThrow(LedgerCompromisedError);
    expect(() => status.assertOpen()).toThrow(LedgerCompromisedError);
  });

  it('keeps the FIRST finding (the one an investigator needs), not the latest', () => {
    const status = new LedgerStatus();
    status.latch(finding('first', 'seq-gap'));
    status.latch(finding('second', 'head-mismatch'));
    expect(status.compromised).toMatchObject({ tenantId: 'first', kind: 'seq-gap' });
  });

  it('has no way to clear a latch: only a restart does', () => {
    const names = Object.getOwnPropertyNames(LedgerStatus.prototype).filter((n) => n !== 'constructor');
    expect(names.filter((n) => /^(clear|reset|unlatch|release|reopen|unlock)/i.test(n))).toEqual([]);
    const status = new LedgerStatus();
    status.latch(finding('a'));
    status.setTail('ok');
    status.markFullCompleted();
    status.setFullRunning(false);
    expect(() => status.assertOpen()).toThrow(LedgerCompromisedError);
    expect(status.readiness()).toBe('down');
  });

  it('maps its state to readiness: down, then verifying, then up', () => {
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
  });
});
