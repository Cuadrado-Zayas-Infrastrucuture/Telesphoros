import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { routeTable, type Route } from './helpers/route-table';

// Every route that is not @Public() answers 401 to a request with no token, and to one with a token that is not a valid bearer token, before it
// reads a parameter, a body or a switch. route-set.e2e-spec.ts pins which routes are public from metadata; this sends the requests, so a route
// that a guard change left open shows up here even though its metadata still says it is closed.

let app: NestExpressApplication;
let routes: Route[];
beforeAll(async () => {
  app = await createTestApp();
  routes = routeTable(app);
});
afterAll(async () => {
  await app.close();
});

const ID = '00000000-0000-4000-8000-000000000000';
const send = (route: Route, headers: Record<string, string> = {}) => {
  const [verb, template] = route.key.split(' ') as [string, string];
  const path = template.replace(/:[A-Za-z0-9_]+/g, ID);
  const agent = request(app.getHttpServer());
  const call =
    verb === 'GET'
      ? agent.get(path)
      : verb === 'POST'
        ? agent.post(path)
        : verb === 'PUT'
          ? agent.put(path)
          : verb === 'PATCH'
            ? agent.patch(path)
            : verb === 'DELETE'
              ? agent.delete(path)
              : undefined;
  if (!call) throw new Error(`no request builder for ${route.key}`);
  for (const [name, value] of Object.entries(headers)) call.set(name, value);
  return call;
};

describe('every non-public route refuses a request without a valid token', () => {
  it('finds the routes to test (positive control: the table is not empty, and the two public routes answer without a token)', async () => {
    expect(routes.filter((r) => !r.isPublic).length).toBeGreaterThan(50);
    const open = routes
      .filter((r) => r.isPublic)
      .map((r) => r.key)
      .sort();
    expect(open).toEqual(['GET /api/v1/health', 'GET /api/v1/ready']);
    await send(routes.find((r) => r.key === 'GET /api/v1/health')!).expect(200);
  });

  it.each([
    ['no Authorization header', {}],
    ['a header that is not a bearer token', { Authorization: 'Basic c3luOnN5bg==' }],
    ['a bearer token that is not a token', { Authorization: 'Bearer not-a-token' }],
  ])('answers 401 UNAUTHORIZED to %s, on every one', async (_what, headers) => {
    const wrong: string[] = [];
    for (const route of routes.filter((r) => !r.isPublic)) {
      const res = await send(route, headers);
      if (res.status !== 401 || res.body?.error?.code !== 'UNAUTHORIZED') wrong.push(`${route.key} -> ${res.status} ${res.body?.error?.code ?? ''}`);
    }
    expect(wrong).toEqual([]);
  });
});
