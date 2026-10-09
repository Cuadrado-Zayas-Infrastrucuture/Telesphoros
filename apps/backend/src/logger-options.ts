import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import type { Options } from 'pino-http';
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
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
    serializers: {
      // Log the path only: query strings can carry identifiers.
      req: (req: IncomingMessage & { id: string }) => ({
        id: req.id,
        method: req.method,
        url: String(req.url).split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    customProps: (req: IncomingMessage) => ({ userId: (req as Request).principal?.sub }),
  };
}
