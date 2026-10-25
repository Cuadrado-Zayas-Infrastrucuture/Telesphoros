/** Dispose every owned resource, retaining the original failure and all cleanup failures. */
export async function disposeFixtures(disposers: Array<() => Promise<unknown>>, causes: unknown[] = []): Promise<void> {
  const errors = [...causes];
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Fixture construction or cleanup failed');
}

/** Concurrent callers share disposal, including its failure; cleanup cannot run twice. */
export function onceFixtureCleanup(dispose: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= Promise.resolve().then(dispose));
}
