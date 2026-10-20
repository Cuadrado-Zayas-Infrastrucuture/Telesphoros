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
    // Every line, ours, Nest's and pino-http's, passes through the allowlist before pino sees it (projectLogArguments, below).
    hooks: {
      logMethod(args, method) {
        method.apply(this, projectLogArguments(args) as Parameters<typeof method>);
      },
    },
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

/**
 * The only field names a log line may carry (audit finding INF-10). The worker does the same (apps/worker/src/log.ts). A field that is not listed
 * here is dropped and only its NAME is kept, in `droppedFields`, so the omission shows up in the logs instead of passing silently. Add a name here
 * only for an id, a count, a code or a fixed sentence: never a value a user, a patient record or an outside system supplied.
 */
export const LOG_FIELDS: ReadonlySet<string> = new Set([
  // pino-http, for every request (req is a binding and has its own serializer above)
  'res', 'responseTime', 'route',
  // Nest
  'context', 'err',
  // the application's own lines
  'event', 'message', 'requestId', 'tenantId', 'status', 'code', 'reason', 'type', 'source', 'outcome', 'mode', 'error', 'cause',
  'eventsChecked', 'tenantsChecked', 'failures', 'containedTenants', 'globalHold', 'fullWalks', 'deferred',
  // the report reader's failure line (services/report-reader)
  'textChars', 'invalidAt', 'signal', 'durationMs', 'exitCode', 'stderrBytes', 'readerError', 'frames',
]);

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_FRAMES = 20;

/** An error reduced to its class and code. Messages from drivers and SDKs can carry values, host names or user names, so they never reach a log. */
function errorSummary(error: Error): { type: string; code?: string | number } {
  const code = (error as { code?: unknown }).code;
  return { type: error.name, ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) };
}

/** The stack's frame lines only: its first line is the message. */
function frames(stack: string | undefined): string[] {
  return (stack ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at ')).slice(0, MAX_FRAMES);
}

/** pino's arguments, projected: `(object, message?, ...)` with the object reduced to listed fields and no error message anywhere. */
export function projectLogArguments(args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  if (first instanceof Error) {
    // pino would put error.message in the line's text: give it the class instead.
    return [{ err: { ...errorSummary(first), frames: frames(first.stack) } }, ...(typeof rest[0] === 'string' ? rest : [first.name])];
  }
  if (typeof first !== 'object' || first === null) return args;
  const projected: Record<string, unknown> = {};
  const dropped: string[] = [];
  let lostText: string | undefined;
  for (const [key, value] of Object.entries(first)) {
    if (!LOG_FIELDS.has(key)) {
      dropped.push(FIELD_NAME.test(key) ? key : '[unnamed]');
      continue;
    }
    if (value instanceof Error) {
      projected[key] = key === 'err' ? { ...errorSummary(value), frames: frames(value.stack) } : errorSummary(value);
      if (key === 'err') lostText = value.name;
    } else {
      projected[key] = value;
    }
  }
  if (dropped.length > 0) projected.droppedFields = dropped;
  // With no text of its own, pino would use err.message as the line's text (Nest's exception handlers log that way).
  if (lostText !== undefined && typeof rest[0] !== 'string') return [projected, lostText];
  return [projected, ...rest];
}
