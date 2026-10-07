import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
// Accept a caller-supplied id only if it is short and made of safe characters (prevents log injection).
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Gives every request a correlation id and echoes it in the X-Request-Id response header. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  req.id = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
