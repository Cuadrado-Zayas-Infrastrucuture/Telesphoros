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
  ) {
    super(message, status);
  }

  static notFound(message = 'Resource not found.') {
    return new AppException(404, ErrorCode.NOT_FOUND, message);
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
}
