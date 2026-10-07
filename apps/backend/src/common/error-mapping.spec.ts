import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AppException } from './app-exception';
import { mapException } from './error-mapping';

describe('mapException', () => {
  it('passes our own AppException through unchanged', () => {
    const mapped = mapException(AppException.validation([{ field: 'label', message: 'Required' }]));
    expect(mapped).toEqual({
      status: 400, code: 'VALIDATION_ERROR', message: 'The request was not valid.',
      details: [{ field: 'label', message: 'Required' }],
    });
  });

  it('replaces the message of foreign HttpExceptions with a fixed generic one', () => {
    expect(mapException(new NotFoundException('Cannot GET /secret/internal/path'))).toEqual({
      status: 404, code: 'NOT_FOUND', message: 'Resource not found.',
    });
    expect(mapException(new ForbiddenException('rule x failed'))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(JSON.stringify(mapException(new BadRequestException('table users')))).not.toContain('users');
  });

  it.each([
    [{ status: 413, type: 'entity.too.large' }, 413, 'PAYLOAD_TOO_LARGE'],
    [{ statusCode: 400, type: 'entity.parse.failed' }, 400, 'BAD_REQUEST'],
    [{ status: 418 }, 418, 'BAD_REQUEST'],
  ])('maps body-parser style errors %j', (error, status, code) => {
    expect(mapException(error)).toMatchObject({ status, code });
  });

  it.each([
    ['an Error', new Error('boom password=x')],
    ['a TypeError', new TypeError('x is undefined')],
    ['a string', 'oops'],
    ['null', null],
    ['undefined', undefined],
    ['a 5xx-status object', { status: 502, message: 'upstream down' }],
  ])('maps %s to a generic 500', (_name, thrown) => {
    expect(mapException(thrown)).toEqual({ status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  });
});
