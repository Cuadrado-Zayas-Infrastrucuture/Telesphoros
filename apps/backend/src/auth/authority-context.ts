import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { assertSessionAuthority, type BrowserSessionAuthority } from './session-admission';

/** The membership a request was admitted under: who, and which version of their membership row the guard read. */
export interface RequestAuthority {
  sub: string;
  version: number;
  /** Only trusted session admission may supply this; bearer requests omit it. No cookie path is enabled yet. */
  readonly session?: BrowserSessionAuthority;
}

interface RequestStore {
  authority?: RequestAuthority;
  /** The request's correlation id, so a security event can be matched to the diagnostic log line for the same request. */
  requestId?: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Opens a per-request slot that AuthGuard fills after it has resolved the caller's membership. Registered by configureApp before routing, so
 * everything the request does (including work started with `await` or a promise) runs inside it.
 */
export function authorityContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  storage.run({ requestId: typeof req.id === 'string' ? req.id : undefined }, next);
}

/** The correlation id of the request this code is running for, if any. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Called by AuthGuard. Throws if the slot is missing: running protected work without the commit-time check would fail open. */
export function bindRequestAuthority(authority: RequestAuthority): void {
  const store = storage.getStore();
  if (!store) throw new Error('No request authority context: configureApp() must register authorityContextMiddleware before routing');
  if ('session' in authority) {
    assertSessionAuthority(authority.session);
    // Own the binding: a caller mutating the original object must not remove/change the later transaction check.
    const { tenantId, handleHash, issuedAt, createdAt, expiresAt } = authority.session;
    store.authority = Object.freeze({ sub: authority.sub, version: authority.version,
      session: Object.freeze({ tenantId, handleHash, issuedAt, createdAt, expiresAt }) });
  } else {
    store.authority = Object.freeze({ sub: authority.sub, version: authority.version });
  }
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
