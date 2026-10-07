import { IntegrityError, toStorageError } from './errors';

describe('toStorageError', () => {
  it('turns unique and foreign-key violations into IntegrityError, keeping the constraint name', () => {
    for (const code of ['23505', '23503']) {
      const mapped = toStorageError({ code, constraint: 'some_constraint' });
      expect(mapped).toBeInstanceOf(IntegrityError);
      expect((mapped as IntegrityError).constraint).toBe('some_constraint');
    }
  });

  it('leaves every other error untouched, so real bugs still surface as 500s', () => {
    const notNull = { code: '23502' };
    const plain = new Error('boom');
    expect(toStorageError(notNull)).toBe(notNull);
    expect(toStorageError(plain)).toBe(plain);
    expect(toStorageError(undefined)).toBeUndefined();
    expect(toStorageError(null)).toBeNull();
  });
});
