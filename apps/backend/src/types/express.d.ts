import type { Principal } from '../auth/principal';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id, set by requestIdMiddleware. Also echoed as the X-Request-Id header. */
      id: string;
      /** Set by AuthGuard after the bearer token verifies. */
      principal?: Principal;
    }
  }
}

export {};
