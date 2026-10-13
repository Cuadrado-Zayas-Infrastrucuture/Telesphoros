import type { Request,Response,NextFunction } from 'express';
import type { IncomingMessage, Server } from 'node:http';
import { isIntakePath } from './reports/intake/raw-intake';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { requestIdMiddleware } from './common/request-id.middleware';
import { noStoreMiddleware } from './common/no-store.middleware';

export const API_PREFIX = 'api';
export const JSON_BODY_LIMIT = '100kb';

export interface ConfigureOptions {
  /** Browser origins allowed to call the API. Empty or omitted: no cross-origin access at all. */
  corsOrigins?: string[];
  /**
   * How many reverse proxies sit in front of the app (TRUST_PROXY_HOPS). 0 or omitted: use the connection's own address and ignore
   * X-Forwarded-For, so the per-address rate limit cannot be dodged by a header the client controls.
   */
  trustProxyHops?: number;
}

/**
 * Everything about HOW the app is served, shared by main.ts and the tests so the tests exercise
 * the real configuration. Must be called before `app.init()` / `app.listen()`.
 */
export function configureApp(app: NestExpressApplication, options: ConfigureOptions = {}) {
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxyHops && options.trustProxyHops > 0 ? options.trustProxyHops : false);
  // Before everything else, so even 404s and parse errors carry a request id.
  app.use(requestIdMiddleware);
  app.use(noStoreMiddleware);
  app.use((req:Request,res:Response,next:NextFunction)=>{
    if(isIntakePath((req.url??'').split('?')[0]!,req.method)){
      const socket=req.socket;const previous=socket.timeout??0;const timeout=()=>req.destroy();
      req.setTimeout(10000,timeout);
      const clear=()=>{req.removeListener('timeout',timeout);if(!socket.destroyed)socket.setTimeout(previous);res.removeListener('finish',clear);res.removeListener('close',clear);};
      res.once('finish',clear);res.once('close',clear);
    }
    next();
  });

  const allowed = new Set(options.corsOrigins ?? []);
  if (allowed.size > 0) {
    app.enableCors({
      // Exact-match allowlist: a request from any other origin gets no CORS headers, so the browser blocks it.
      origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) =>
        callback(null, origin !== undefined && allowed.has(origin)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Upload-Revision'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
      credentials: false, // we authenticate with a bearer header, never cookies
    });
  }

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT, type: (req: IncomingMessage) => !isIntakePath((req.url ?? '').split('?')[0]!, req.method ?? '') && /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '') });
  // Finite pre-authentication header/body lifetime; intake imposes its tighter progress deadlines after admission.
  const server=app.getHttpServer() as Server; server.headersTimeout=30000;
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
