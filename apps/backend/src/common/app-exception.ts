import { HttpException } from '@nestjs/common';
import { ErrorCode, type ErrorDetail } from '@telesphoros/shared-types';

/**
 * The only exception type application code throws. Its `message` is written by us and is safe to
 * show a client. (Foreign exceptions get a generic message in AllExceptionsFilter instead.)
 */
export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
    /** Sent as the Retry-After header. Present only where waiting can help. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message, status);
  }

  static notFound(message = 'Resource not found.') {
    return new AppException(404, ErrorCode.NOT_FOUND, message);
  }
  /** A 404 with a stable `reason` for the one thing that was not found (e.g. a guideline the loaded knowledge does not have). */
  static notFoundBecause(reason: string, message: string) {
    return new AppException(404, ErrorCode.NOT_FOUND, message, [{ field: 'request', message, reason }]);
  }
  static conflict(message: string) {
    return new AppException(409, ErrorCode.CONFLICT, message);
  }
  static unauthorized(message = 'Authentication required.') {
    return new AppException(401, ErrorCode.UNAUTHORIZED, message);
  }
  static forbidden(message = 'You do not have permission to do that.') {
    return new AppException(403, ErrorCode.FORBIDDEN, message);
  }
  static validation(details: ErrorDetail[]) {
    return new AppException(400, ErrorCode.VALIDATION_ERROR, 'The request was not valid.', details);
  }
  static unavailable(message: string, details?: ErrorDetail[]) {
    return new AppException(503, ErrorCode.SERVICE_UNAVAILABLE, message, details);
  }

  /** A business conflict with a stable `reason` the caller can act on (it must change something; retrying as-is will not help). */
  static conflictBecause(reason: string, message: string) {
    return new AppException(409, ErrorCode.CONFLICT, message, [{ field: 'request', message, reason }]);
  }
  /** 429 with Retry-After. The message never says which limit or key was hit. */
  static rateLimited(retryAfterSeconds: number) {
    return new AppException(429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.', undefined, retryAfterSeconds);
  }
  static pipelineDisabled() {
    return new AppException(503, ErrorCode.PIPELINE_DISABLED, 'Lab report processing is switched off.');
  }
  static pipelineBusy() {
    return new AppException(503, ErrorCode.PIPELINE_BUSY, 'The reader is busy. Try again shortly.', undefined, 5);
  }
  static ledgerCheckBusy() {
    return new AppException(503, ErrorCode.PIPELINE_BUSY, 'A record log check is already running. Try again shortly.', undefined, 5);
  }
  static readerUnavailable() {
    return new AppException(503, ErrorCode.READER_UNAVAILABLE, 'The report could not be read just now. Nothing was saved; try again later.', undefined, 30);
  }
  /** No database connection could be had in time (pool full, or the database not answering). Nothing was started, so repeating is safe. */
  static databaseBusy() {
    return new AppException(503, ErrorCode.SERVICE_UNAVAILABLE, 'The service is busy. Nothing was saved; try again shortly.', undefined, 2);
  }
  static ledgerBusy() {
    return new AppException(503, ErrorCode.LEDGER_BUSY, 'The record log is busy. Nothing was saved; try again.', undefined, 2);
  }
  /** No Retry-After on purpose: retrying cannot help, only an operator can clear this. */
  static ledgerCompromised() {
    return new AppException(503, ErrorCode.LEDGER_COMPROMISED, 'The record log failed a verification check, so no records can be saved right now. An operator must investigate.');
  }
  static ledgerConflict() {
    return new AppException(409, ErrorCode.LEDGER_CONFLICT, 'A record rule refused this change. Re-read the current state before deciding.');
  }
  static unsupportedSource() {
    return new AppException(422, ErrorCode.UNSUPPORTED_SOURCE, 'This file is not one this build can read.');
  }
  static pipelineMisconfigured() {
    return new AppException(500, ErrorCode.PIPELINE_MISCONFIGURED, 'Lab report processing is not installed correctly. An operator must fix this.');
  }
}
