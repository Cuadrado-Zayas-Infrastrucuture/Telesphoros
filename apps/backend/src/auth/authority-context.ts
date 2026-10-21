import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { CAPABILITY_TOKEN_PATTERN } from '../issuer/capability-issuer.port';
import { assertSessionAuthority, type BrowserSessionAuthority } from './session-admission';

/** The membership a request was admitted under: who, and which version of their membership row the guard read. */
export interface RequestAuthority {
  sub: string;
  version: number;
  /** Only trusted session admission may supply this; bearer requests omit it. No cookie path is enabled yet. */
  readonly session?: BrowserSessionAuthority;
}

/** The proof of identity the issuer minted for this request (DATA-01): a bearer secret for at most its lifetime, so it is never logged or serialised. */
export interface RequestCapability {
  readonly token: string;
  readonly expiresAt: Date;
  /** The version of the person's membership the database stamped on the capability when it issued it: the version the request's commit-time check holds to. */
  readonly membershipVersion: number;
}

interface RequestStore {
  authority?: RequestAuthority;
  /** The request's ONE capability, set by the guard BEFORE it reads the membership and read by every `withTenant` call in the request, the lookup included. */
  capability?: RequestCapability;
  /** Why the request has no capability, once the guard has tried (`not-configured`, `issuer-unavailable`, ...). Only a label for the count. */
  capabilityAbsent?: string;
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

/** Called by the guard (through RequestCapabilities) once per request, before the membership lookup. The slot holds its own frozen copy and is written once. */
export function bindRequestCapability(capability: RequestCapability): void {
  const store = storage.getStore();
  if (!store) throw new Error('No request authority context: configureApp() must register authorityContextMiddleware before routing');
  if (store.capability) throw new Error('This request already has a capability');
  // Never echo the value: it is a bearer secret.
  if (typeof capability.token !== 'string' || !CAPABILITY_TOKEN_PATTERN.test(capability.token)) throw new Error('Malformed capability');
  if (!Number.isSafeInteger(capability.membershipVersion) || capability.membershipVersion < 1) throw new Error('Malformed capability');
  store.capability = Object.freeze({ token: capability.token, expiresAt: new Date(capability.expiresAt.getTime()), membershipVersion: capability.membershipVersion });
}

/** The capability of the request this code is running for (or the request that started this organization work), if it has one. */
export function currentRequestCapability(): RequestCapability | undefined {
  return storage.getStore()?.capability;
}

/** Records why this request has no capability. */
export function noteCapabilityAbsent(reason: string): void {
  const store = storage.getStore();
  if (store) store.capabilityAbsent = reason;
}

export function capabilityAbsentReason(): string | undefined {
  return storage.getStore()?.capabilityAbsent;
}

/**
 * Runs `work` as organization-owned processing: not tied to the person whose request started it. A removed person's request must not abort
 * cleanup the organization still needs, so work that outlives its request (reconciling or sweeping stored files) runs through this.
 */
export function asOrganizationWork<T>(work: () => T): T {
  // The work is not the person's, so the authority goes. The capability stays: it is the request's proof that the organization may be acted for, a fresh
  // issuance for a removed person would be refused, and a request that has none keeps the reason so its count stays labelled.
  const store = storage.getStore();
  const kept = store?.capability || store?.capabilityAbsent ? { capability: store.capability, capabilityAbsent: store.capabilityAbsent } : undefined;
  return storage.exit(() => (kept ? storage.run(kept, work) : work()));
}
