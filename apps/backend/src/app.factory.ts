import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { requestIdMiddleware } from './common/request-id.middleware';

export const API_PREFIX = 'api';
export const JSON_BODY_LIMIT = '100kb';

export interface ConfigureOptions {
  /** Browser origins allowed to call the API. Empty or omitted: no cross-origin access at all. */
  corsOrigins?: string[];
}

/**
 * Everything about HOW the app is served, shared by main.ts and the tests so the tests exercise
 * the real configuration. Must be called before `app.init()` / `app.listen()`.
 */
export function configureApp(app: NestExpressApplication, options: ConfigureOptions = {}) {
  app.disable('x-powered-by');
  // Before everything else, so even 404s and parse errors carry a request id.
  app.use(requestIdMiddleware);

  const allowed = new Set(options.corsOrigins ?? []);
  if (allowed.size > 0) {
    app.enableCors({
      // Exact-match allowlist: a request from any other origin gets no CORS headers, so the browser blocks it.
      origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) =>
        callback(null, origin !== undefined && allowed.has(origin)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
      credentials: false, // we authenticate with a bearer header, never cookies
    });
  }

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
