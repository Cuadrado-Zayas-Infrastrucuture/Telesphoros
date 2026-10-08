import { HttpException } from '@nestjs/common';
import { ErrorCode, type ErrorDetail } from '@telesphoros/shared-types';
import { DisputeChangedError, LedgerBusyError, LedgerCompromisedError, LedgerIntegrityError, SourceChangedError, StaleAcceptanceError } from '../ledger/ledger-types';
import { IntegrityError } from '../storage/errors';
import { AppException } from './app-exception';

export interface MappedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
  retryAfterSeconds?: number;
}

const GENERIC: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: ErrorCode.BAD_REQUEST, message: 'The request could not be understood.' },
  401: { code: ErrorCode.UNAUTHORIZED, message: 'Authentication required.' },
  403: { code: ErrorCode.FORBIDDEN, message: 'You do not have permission to do that.' },
  404: { code: ErrorCode.NOT_FOUND, message: 'Resource not found.' },
  409: { code: ErrorCode.CONFLICT, message: 'The request conflicts with the current state.' },
  413: { code: ErrorCode.PAYLOAD_TOO_LARGE, message: 'The request body is too large.' },
  429: { code: ErrorCode.RATE_LIMITED, message: 'Too many requests. Try again later.' },
  503: { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'The service is temporarily unavailable.' },
};

const INTERNAL: MappedError = {
  status: 500,
  code: ErrorCode.INTERNAL_ERROR,
  message: 'An unexpected error occurred.',
};

function fromStatus(status: number): MappedError {
  const generic = GENERIC[status];
  if (generic) return { status, ...generic };
  // Unlisted 4xx are still client errors; any other status is treated as our fault.
  if (status >= 400 && status < 500) return { status, ...GENERIC[400]! };
  return INTERNAL;
}

/**
 * Turns ANY thrown value into the public error shape. Messages come only from our own AppException
 * or from the fixed table above, so nothing from a foreign error (paths, SQL, stack) can leak.
 */
export function mapException(exception: unknown): MappedError {
  if (exception instanceof AppException) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      message: exception.message,
      details: exception.details,
      ...(exception.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: exception.retryAfterSeconds }),
    };
  }
  // The ledger said no. These two never reach a client as a 500: a refused write is a conflict, a lock timeout is "busy".
  if (exception instanceof StaleAcceptanceError) return mapException(AppException.conflictBecause('stale-acceptance', 'A later decision supersedes the acceptance named. Nothing was saved.'));
  if (exception instanceof DisputeChangedError) return mapException(AppException.conflictBecause('dispute-changed', 'A guideline dispute changed while this was being evaluated. Nothing was saved; try again.'));
  if (exception instanceof SourceChangedError) return mapException(AppException.conflictBecause('source-changed', 'The report changed while it was being captured. Nothing was saved; capture it again.'));
  if (exception instanceof LedgerCompromisedError) return mapException(AppException.ledgerCompromised());
  if (exception instanceof LedgerBusyError) return mapException(AppException.ledgerBusy());
  if (exception instanceof LedgerIntegrityError) return mapException(AppException.ledgerConflict());
  // A database integrity rule said no (duplicate, or a RESTRICT foreign key): a conflict, not a crash.
  if (exception instanceof IntegrityError) {
    return { status: 409, ...GENERIC[409]! };
  }
  if (exception instanceof HttpException) {
    return fromStatus(exception.getStatus());
  }
  // body-parser / http-errors style errors (malformed JSON, body too large) carry a numeric status.
  if (typeof exception === 'object' && exception !== null) {
    const status = (exception as { status?: unknown; statusCode?: unknown }).status ??
      (exception as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return fromStatus(status);
  }
  return INTERNAL;
}
