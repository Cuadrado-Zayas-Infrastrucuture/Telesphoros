import type { NextFunction, Request, Response } from 'express';

export const NO_STORE = 'private, no-store';

/**
 * Every API response is private and uncacheable: clinical metadata and the refusals around it must never be stored by a browser, a shared proxy or a CDN.
 * Set once, before routing, so it also covers 401, 403, 404, 429 and parse errors that never reach a controller. A route may still set a header of
 * its own afterwards (the download-link route repeats this value).
 */
export function noStoreMiddleware(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', NO_STORE);
  next();
}
