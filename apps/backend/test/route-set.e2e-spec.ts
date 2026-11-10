import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from './helpers/app';
import { type Route, type RouteGate, routeTable } from './helpers/route-table';

/**
 * The route set is a contract: other systems will call these paths, and each path's readers are a security decision. `route-set.json` pins every
 * route with who may call it and which switch opens it, so adding, removing or re-permissioning a route shows up as a reviewed change to that file.
 *
 * To accept a deliberate change: `UPDATE_ROUTE_SET=1 pnpm --filter @telesphoros/backend exec jest test/route-set`, then review the diff of the file.
 */
const FILE = resolve(__dirname, 'route-set.json');

interface PinnedRoute {
  route: string;
  /** `public` (no token), `any-member` (a token, no role needed) or the roles, sorted. */
  access: 'public' | 'any-member' | string[];
  gate: RouteGate;
}

function pin(route: Route): PinnedRoute {
  const roles = Array.isArray(route.roles) ? route.roles.map(String).sort() : [];
  return { route: route.key, access: route.isPublic ? 'public' : roles.length > 0 ? roles : 'any-member', gate: route.gate };
}

const byRoute = (a: PinnedRoute, b: PinnedRoute) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0);
const same = (a: PinnedRoute, b: PinnedRoute) => JSON.stringify(a) === JSON.stringify(b);

/** What differs, in the words a reviewer needs. Empty in all three when the two sets are the same. */
function difference(pinned: readonly PinnedRoute[], actual: readonly PinnedRoute[]) {
  const was = new Map(pinned.map((r) => [r.route, r]));
  const now = new Map(actual.map((r) => [r.route, r]));
  return {
    added: actual.filter((r) => !was.has(r.route)).map((r) => r.route),
    removed: pinned.filter((r) => !now.has(r.route)).map((r) => r.route),
    changed: actual.filter((r) => was.has(r.route) && !same(was.get(r.route)!, r)).map((r) => ({ pinned: was.get(r.route)!, actual: r })),
  };
}

/** One route per line, in the shape Prettier leaves alone, so a change to one route is a one-line diff. */
const serialise = (routes: readonly PinnedRoute[]): string =>
  `[\n${routes
    .map((r) => {
      const access = Array.isArray(r.access) ? `[${r.access.map((role) => JSON.stringify(role)).join(', ')}]` : JSON.stringify(r.access);
      return `  { "route": ${JSON.stringify(r.route)}, "access": ${access}, "gate": ${JSON.stringify(r.gate)} }`;
    })
    .join(',\n')}\n]\n`;

let app: NestExpressApplication;
let actual: PinnedRoute[];
beforeAll(async () => {
  app = await createTestApp();
  actual = routeTable(app).map(pin).sort(byRoute);
});
afterAll(async () => {
  await app.close();
});

const pinned = (): PinnedRoute[] => JSON.parse(readFileSync(FILE, 'utf8')) as PinnedRoute[];

describe('the route set is pinned', () => {
  it('the walk found the real route table, with no path and method registered twice', () => {
    expect(actual.length).toBeGreaterThan(60);
    expect(actual.map((r) => r.route).filter((route, i, all) => all.indexOf(route) !== i)).toEqual([]);
    expect(actual.find((r) => r.route === 'GET /api/v1/health')).toEqual({ route: 'GET /api/v1/health', access: 'public', gate: 'always' });
    expect(actual.find((r) => r.route === 'POST /api/v1/patients')).toEqual({ route: 'POST /api/v1/patients', access: ['clinician'], gate: 'always' });
  });

  it('every route, its readers and its switch are exactly those in route-set.json', () => {
    if (process.env.UPDATE_ROUTE_SET === '1') {
      // Never in CI: there the file is the reviewed truth and a difference must fail.
      if (process.env.CI) throw new Error('UPDATE_ROUTE_SET is refused in CI.');
      writeFileSync(FILE, serialise(actual));
    }
    expect(difference(pinned(), actual)).toEqual({ added: [], removed: [], changed: [] });
    // Order too, so the file stays sorted and a diff of it stays small.
    expect(pinned().map((r) => r.route)).toEqual(actual.map((r) => r.route));
  });
});

describe('controls: the comparison names each kind of change', () => {
  const base: PinnedRoute[] = [
    { route: 'GET /api/v1/a', access: ['reader'], gate: 'always' },
    { route: 'POST /api/v1/a', access: ['clinician'], gate: 'pipeline' },
  ];

  it('nothing, when the sets are the same', () => {
    expect(difference(base, structuredClone(base))).toEqual({ added: [], removed: [], changed: [] });
  });

  it('a route that was added, and one that was removed', () => {
    const extra: PinnedRoute = { route: 'DELETE /api/v1/a', access: ['clinician'], gate: 'always' };
    expect(difference(base, [...base, extra])).toMatchObject({ added: ['DELETE /api/v1/a'], removed: [] });
    expect(difference(base, base.slice(1))).toMatchObject({ added: [], removed: ['GET /api/v1/a'] });
  });

  it.each([
    ['opened to another role', { access: ['reader', 'reviewer'] }],
    ['opened to any member', { access: 'any-member' as const }],
    ['made public', { access: 'public' as const }],
    ['moved to another switch', { gate: 'pipeline' as const }],
  ])('a route that was %s', (_name, change) => {
    const after = [{ ...base[0]!, ...change }, base[1]!];
    expect(difference(base, after)).toEqual({ added: [], removed: [], changed: [{ pinned: base[0], actual: after[0] }] });
  });

  it('a public route, a route with no roles and a route with roles are three different things', () => {
    const route = (isPublic: boolean, roles: unknown): Route => ({ key: 'GET /api/v1/x', isPublic, roles, gate: 'always' });
    expect(pin(route(true, ['reader'])).access).toBe('public');
    expect(pin(route(false, undefined)).access).toBe('any-member');
    expect(pin(route(false, [])).access).toBe('any-member');
    expect(pin(route(false, ['reviewer', 'clinician'])).access).toEqual(['clinician', 'reviewer']);
  });
});
