import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppException } from './app-exception';

/**
 * Validates and parses a body, query or param BEFORE any business logic runs.
 * Returns the parsed (typed, coerced, defaulted) value; throws a field-level VALIDATION_ERROR otherwise.
 * Details carry the field path and rule message only, never the submitted value.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw AppException.validation(
      result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : '(request)',
        message: issue.message,
      })),
    );
  }
}
