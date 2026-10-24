/**
 * PostgreSQL ends one of two transactions that wait on each other (40P01, deadlock_detected) and one that cannot be serialised (40001); the other side is unharmed and a second
 * attempt almost always succeeds. This runs the work again, ONCE, for those two codes only, so it is for calls that are safe to repeat: the unit of work is a whole transaction
 * (it was rolled back), and the caller's operation is idempotent (declareAttempt by its request id, commitAttempt by its attempt state). Nothing else is retried.
 */
export const RETRYABLE_SQLSTATES: readonly string[] = ['40P01', '40001'];

export async function retryOnConflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && RETRYABLE_SQLSTATES.includes(code)) return work();
    throw error;
  }
}
