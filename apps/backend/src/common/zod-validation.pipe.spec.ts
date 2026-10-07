import { z } from 'zod';
import { AppException } from './app-exception';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.strictObject({ label: z.string().min(1), page: z.coerce.number().int().default(1) });
const pipe = new ZodValidationPipe(schema);

describe('ZodValidationPipe', () => {
  it('returns the parsed value with coercion and defaults applied', () => {
    expect(pipe.transform({ label: 'a' })).toEqual({ label: 'a', page: 1 });
    expect(pipe.transform({ label: 'a', page: '4' })).toEqual({ label: 'a', page: 4 });
  });

  it('throws a VALIDATION_ERROR with field paths and no submitted values', () => {
    let error: AppException | undefined;
    try {
      pipe.transform({ label: '', extra: 'SENSITIVE-VALUE' });
    } catch (e) {
      error = e as AppException;
    }
    expect(error).toBeInstanceOf(AppException);
    expect(error?.code).toBe('VALIDATION_ERROR');
    expect(error?.getStatus()).toBe(400);
    expect(error?.details?.map((d) => d.field).sort()).toEqual(['(request)', 'label']);
    expect(JSON.stringify(error?.details)).not.toContain('SENSITIVE-VALUE');
  });
});
