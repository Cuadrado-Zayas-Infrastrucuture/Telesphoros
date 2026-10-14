import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { ErrorCode, type ErrorResponse } from '@telesphoros/shared-types';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { mapException } from './error-mapping';

/**
 * Last line of defence: every error, expected or not, leaves the API in the same envelope and
 * never with a stack trace. Logs contain fixed diagnostic fields and the request id, never the thrown value.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const mapped = mapException(exception);
    // pino-http types req.id loosely; our middleware always sets a string.
    const requestId = String(req.id);
    // Set by AuthGuard from the verified token; undefined (and so omitted from the JSON line) when nobody is authenticated.
    const tenantId = req.principal?.tenantId;

    if (mapped.status >= 500) {
      this.logger.error(
        {
          event: 'api-error',
          requestId,
          tenantId,
          status: mapped.status,
          code: mapped.code,
        },
        'Request failed',
      );
    } else {
      this.logger.warn({ requestId, tenantId, status: mapped.status, code: mapped.code }, 'Request rejected');
    }

    if (res.headersSent) return;
    if (mapped.code === ErrorCode.UNAUTHORIZED) res.setHeader('WWW-Authenticate', 'Bearer');
    if (mapped.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(mapped.retryAfterSeconds));

    const body: ErrorResponse = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
        requestId,
      },
    };
    res.status(mapped.status).json(body);
  }
}
