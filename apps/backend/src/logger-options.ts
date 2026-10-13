import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import type { Options } from 'pino-http';
import { LOG_ROUTE } from './common/log-route';
import type { Env } from './config/env';

/**
 * The application's log settings. Logs are one JSON object per line on stdout, and objects logged through Nest's Logger keep their fields at the
 * top level: the `ledger-compromised` alarm (infrastructure/terraform/api-compute.tf) matches a top-level `event` field, so do not nest or rename
 * (log-shape.spec.ts pins this).
 */
export function pinoHttpOptions(config: Pick<Env, 'LOG_LEVEL'>): Options {
  return {
    level: config.LOG_LEVEL,
    genReqId: (req: IncomingMessage) => (req as Request).id ?? randomUUID(),
    // Defence in depth: secrets are redacted even if the serializers below are ever loosened.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[redacted]',
    },
    serializers: {
      // Route templates only: both path parameters and query strings can carry private values.
      req: (req: IncomingMessage & { id: string }) => ({
        id: req.id,
        method: req.method,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    // These run at response time, after the boundary interceptor has captured the route template.
    customSuccessObject: (req, _res, value) => ({
      res: value.res,
      responseTime: value.responseTime,
      route: (req as Request & { [LOG_ROUTE]?: string })[LOG_ROUTE] ?? '[unmatched]',
    }),
    customErrorObject: (req, _res, _error, value) => ({
      res: value.res,
      responseTime: value.responseTime,
      route: (req as Request & { [LOG_ROUTE]?: string })[LOG_ROUTE] ?? '[unmatched]',
    }),
    // The organization is a correlation id for operators (which tenant is slow or failing), not patient data. It comes only from the verified
    // principal, never from a header or query, and is absent on unauthenticated requests.
    customProps: (req: IncomingMessage) => ({
      userId: (req as Request).principal?.sub,
      tenantId: (req as Request).principal?.tenantId,
    }),
  };
}
