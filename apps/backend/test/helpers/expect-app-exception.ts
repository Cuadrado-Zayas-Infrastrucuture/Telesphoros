import { AppException } from '../../src/common/app-exception';

/** Asserts a promise rejects with an AppException of the given status and stable code. */
export async function expectAppException(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppException);
  expect((error as AppException).getStatus()).toBe(status);
  expect((error as AppException).code).toBe(code);
}
