import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { Database } from './database';
import { PgCapabilityIssueStore } from '../issuer/issuer-core';
import { LedgerVerifier } from '../ledger/verifier';

// A controlled PostgreSQL wire peer accepts the connection but never answers its query.
// This is a transport-failure control; real PostgreSQL/RLS/schema behavior is covered by the service tier.
it.each(['api', 'issuer', 'ledger'] as const)('%s releases an established query when the server cannot deliver its timeout response', async (kind) => {
  const ready = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]); // AuthenticationOk + ReadyForQuery
  const sockets = new Set<Socket>();
  let queryArrived!: () => void;
  const received = new Promise<void>((resolve) => {
    queryArrived = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let connected = false;
    socket.on('data', () => {
      if (!connected) {
        connected = true;
        socket.write(ready);
      } else queryArrived(); // Suppress every query response; TCP itself stays open.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const url = `postgres://synthetic@127.0.0.1:${(server.address() as AddressInfo).port}/synthetic`;
  const options = { url, ssl: 'disable' as const, max: 1 };
  const api = kind === 'api' ? new Database(options) : undefined;
  const issuer = kind === 'issuer' ? new PgCapabilityIssueStore(options) : undefined;
  const ledger = kind === 'ledger' ? LedgerVerifier.connect(url, 'disable') : undefined;
  let outcome: unknown;
  const query = api
    ? api.ping()
    : issuer
      ? issuer.issue({ tenant: 'synthetic', sub: 'synthetic', purpose: 'request', tokenHash: Buffer.alloc(32, 1), requestId: 'synthetic' })
      : ledger!.tenants();
  const pending = query.then(
    () => {
      outcome = 'resolved';
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  try {
    await received;
    await jest.advanceTimersByTimeAsync(kind === 'ledger' ? 35000 : 7000);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/timeout/i);
  } finally {
    jest.useRealTimers();
    for (const socket of sockets) socket.destroy();
    await pending;
    await api?.onModuleDestroy();
    await issuer?.close();
    await ledger?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
