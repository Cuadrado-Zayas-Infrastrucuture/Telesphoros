import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createTestApp } from './helpers/app';

function listen(server: Server, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const error = (cause: NodeJS.ErrnoException) => { server.removeListener('listening', listening); resolve(cause.code); };
    const listening = () => { server.removeListener('error', error); resolve(undefined); };
    server.once('error', error);
    server.once('listening', listening);
    server.listen(port, '127.0.0.1');
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  });
}

it('owns the client loopback port so another listener cannot answer its health requests', async () => {
  const app = await createTestApp();
  let competingRequests = 0;
  const competing = createServer((_req, res) => { competingRequests++; res.writeHead(404).end(); });
  try {
    // Positive control: this server can bind loopback and serve a real request.
    expect(await listen(competing, 0)).toBeUndefined();
    await request(competing).get('/api/v1/health').expect(404);
    expect(competingRequests).toBe(1);
    await close(competing);

    const address = app.getHttpServer().address() as AddressInfo;
    const collision = await listen(competing, address.port);
    // On macOS a wildcard IPv6 listener can share this port with the IPv4
    // competitor. The real request must reach the app, without a retry.
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(address.address).toBe('127.0.0.1');
    expect(collision).toBe('EADDRINUSE');
    expect(competingRequests).toBe(1);
  } finally {
    try { await close(competing); } finally { await app.close(); }
  }
});
