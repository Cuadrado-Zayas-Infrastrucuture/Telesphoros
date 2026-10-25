import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_KEEP_ALIVE_TIMEOUT_MS, configureApp } from './app.factory';

// The load balancer closes a connection that has been idle for its idle timeout (60 s, infrastructure/terraform/api-edge.tf). If the API
// closes an idle connection first, the balancer can send a request down a socket the API is already closing and answer the caller 502.
// Node's default is 5 s. Measured on Node 22.22.0 with scaled-down timers: an idle keep-alive socket closes at keepAliveTimeout + 1 s,
// whatever headersTimeout is. The cross-check against the balancer's idle timeout is in infrastructure/terraform/api-compute.guard.test.mjs.
const LOAD_BALANCER_IDLE_MS = 60_000;

describe('the API keeps an idle connection open longer than the load balancer does', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('sets keepAliveTimeout above the balancer idle timeout, with room for clock and scheduling slack', () => {
    const server = app.getHttpServer() as { keepAliveTimeout: number };
    expect(server.keepAliveTimeout).toBe(API_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(LOAD_BALANCER_IDLE_MS + 5000);
  });

  it('still bounds how long a connection may take to send its headers', () => {
    expect((app.getHttpServer() as { headersTimeout: number }).headersTimeout).toBe(30_000);
  });

  it("detects the default (control: Node's own 5 s is below the balancer's idle timeout)", async () => {
    const { createServer } = await import('node:http');
    expect(createServer().keepAliveTimeout).toBeLessThan(LOAD_BALANCER_IDLE_MS);
  });
});
