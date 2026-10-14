import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/** The membership a request was admitted under: who, and which version of their membership row the guard read. */
export interface RequestAuthority {
  sub: string;
  version: number;
}

interface RequestStore {
  authority?: RequestAuthority;
}

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Opens a per-request slot that AuthGuard fills after it has resolved the caller's membership. Registered by configureApp before routing, so
 * everything the request does (including work started with `await` or a promise) runs inside it.
 */
export function authorityContextMiddleware(_req: Request, _res: Response, next: NextFunction) {
  storage.run({}, next);
}

/** Called by AuthGuard. Throws if the slot is missing: running protected work without the commit-time check would fail open. */
export function bindRequestAuthority(authority: RequestAuthority): void {
  const store = storage.getStore();
  if (!store) throw new Error('No request authority context: configureApp() must register authorityContextMiddleware before routing');
  store.authority = authority;
}

/** The authority of the request this code is running for, or undefined outside a request (background and organization-owned work). */
export function currentRequestAuthority(): RequestAuthority | undefined {
  return storage.getStore()?.authority;
}

/**
 * Runs `work` as organization-owned processing: not tied to the person whose request started it. A removed person's request must not abort
 * cleanup the organization still needs, so work that outlives its request (reconciling or sweeping stored files) runs through this.
 */
export function asOrganizationWork<T>(work: () => T): T {
  return storage.exit(work);
}
