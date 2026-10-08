import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LedgerBusyError, LedgerIntegrityError } from '../ledger/ledger-types';
import { IntegrityError } from '../storage/errors';
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

  it('maps a database integrity violation (duplicate key, RESTRICT foreign key) to 409 CONFLICT, not 500', () => {
    expect(mapException(new IntegrityError('patients_tenant_label_uq'))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'The request conflicts with the current state.',
    });
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

describe('mapException: the pipeline error contract', () => {
  it.each([
    ['pipelineDisabled', 503, 'PIPELINE_DISABLED', undefined],
    ['pipelineBusy', 503, 'PIPELINE_BUSY', 5],
    ['readerUnavailable', 503, 'READER_UNAVAILABLE', 30],
    ['ledgerBusy', 503, 'LEDGER_BUSY', 2],
    ['ledgerConflict', 409, 'LEDGER_CONFLICT', undefined],
    ['unsupportedSource', 422, 'UNSUPPORTED_SOURCE', undefined],
    ['pipelineMisconfigured', 500, 'PIPELINE_MISCONFIGURED', undefined],
  ] as const)('%s is %i %s, with Retry-After %s', (factory, status, code, retryAfter) => {
    const mapped = mapException(AppException[factory]());
    expect(mapped).toMatchObject({ status, code });
    expect(mapped.retryAfterSeconds).toBe(retryAfter);
  });

  it('only the three "try again" outcomes carry Retry-After; a switched-off pipeline or an installation fault never invites a retry', () => {
    for (const factory of ['pipelineDisabled', 'pipelineMisconfigured', 'ledgerConflict', 'unsupportedSource'] as const) {
      expect(mapException(AppException[factory]()).retryAfterSeconds).toBeUndefined();
    }
  });

  it('a business conflict names its reason in a stable field and keeps the shared CONFLICT code', () => {
    expect(mapException(AppException.conflictBecause('self-review', 'You cannot review your own work.'))).toEqual({
      status: 409, code: 'CONFLICT', message: 'You cannot review your own work.',
      details: [{ field: 'request', message: 'You cannot review your own work.', reason: 'self-review' }],
    });
  });

  it('turns a ledger refusal into LEDGER_CONFLICT and a lock timeout into LEDGER_BUSY, never a 500', () => {
    expect(mapException(new LedgerIntegrityError('x', '23000'))).toMatchObject({ status: 409, code: 'LEDGER_CONFLICT' });
    expect(mapException(new LedgerBusyError())).toMatchObject({ status: 503, code: 'LEDGER_BUSY', retryAfterSeconds: 2 });
    expect(JSON.stringify(mapException(new LedgerIntegrityError('table report_captures violated', '23000')))).not.toContain('report_captures');
  });
});
