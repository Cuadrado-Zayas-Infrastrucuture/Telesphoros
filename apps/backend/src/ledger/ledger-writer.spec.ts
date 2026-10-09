import { LedgerStatus } from './ledger-status';
import { LedgerCompromisedError } from './ledger-types';
import { appendEvent } from './ledger-writer';

/** A client that fails the test if anything is sent to the database. */
const silentClient = () => {
  const query = jest.fn(async () => {
    throw new Error('the database must not be touched');
  });
  return { client: { query } as never, query };
};

describe('appendEvent and the ledger gate', () => {
  it('asks the gate before it reads the record or touches the ledger: a closed gate sends nothing to the database', async () => {
    const status = new LedgerStatus();
    status.latch({ tenantId: 't', kind: 'seq-gap', seq: '2', source: 'background', at: new Date(0) });
    const { client, query } = silentClient();
    await expect(appendEvent(status, 't', client, 'report_captures', 'r', 'e')).rejects.toBeInstanceOf(LedgerCompromisedError);
    expect(query).not.toHaveBeenCalled();
  });

  it('asks the gate about THIS tenant: another tenant\'s contained record log does not stop the write', async () => {
    const status = new LedgerStatus();
    status.latch({ tenantId: 'other', kind: 'seq-gap', seq: '2', source: 'background', at: new Date(0) });
    const { client, query } = silentClient();
    await expect(appendEvent(status, 't', client, 'report_captures', 'r', 'e')).rejects.toThrow('the database must not be touched');
    expect(query).toHaveBeenCalled();
  });

  it('control: an open gate goes on to read the record (so the refusal above is the gate, not a broken client)', async () => {
    const { client, query } = silentClient();
    await expect(appendEvent(new LedgerStatus(), 't', client, 'report_captures', 'r', 'e')).rejects.toThrow('the database must not be touched');
    expect(query).toHaveBeenCalled();
  });
});
