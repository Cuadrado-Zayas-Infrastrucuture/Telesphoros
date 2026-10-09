import type { LedgerStatus } from '../ledger/ledger-status';
import type { ReadinessCheck } from './readiness.service';

/**
 * The record log is ready when its check at start passed and no global hold is open. While the full walk is still running (or has not yet
 * finished) the answer is `verifying`: the instance IS ready, the check is simply not complete. While some tenant's record log is contained
 * (an open incident) the answer is `contained`: still ready, because the other tenants keep working. It reads in-memory state, so it cannot
 * time out on the database.
 */
export function ledgerChainCheck(status: LedgerStatus): ReadinessCheck {
  return {
    name: 'ledger',
    check: async () => {
      const state = status.readiness();
      if (state === 'down') throw new Error('the record log has not passed verification');
      return state === 'verifying' || state === 'contained' ? state : undefined;
    },
  };
}
