import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { requestIdMiddleware } from './common/request-id.middleware';

export const API_PREFIX = 'api';
export const JSON_BODY_LIMIT = '100kb';

/**
 * Everything about HOW the app is served, shared by main.ts and the tests so the tests exercise
 * the real configuration. Must be called before `app.init()` / `app.listen()`.
 */
export function configureApp(app: NestExpressApplication) {
  app.disable('x-powered-by');
  // Before everything else, so even 404s and parse errors carry a request id.
  app.use(requestIdMiddleware);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
