/**
 * The deadline a spec passes to `jest.setTimeout` when its own work needs more than Jest's five-second default. The fixture-lifecycle
 * control (`scripts/test-fixtures/lifecycle.test.cjs`) sets FIXTURE_TEST_TIMEOUT_MS to the deadline it is testing: it provokes a timeout on
 * purpose, and a spec's own budget must not hide it. Read only by tests; a value that is not a whole number of milliseconds stops the run.
 */
export function specDeadline(ms: number): number {
  const stated = process.env.FIXTURE_TEST_TIMEOUT_MS;
  if (stated === undefined) return ms;
  if (!/^[1-9][0-9]*$/.test(stated)) throw new Error('FIXTURE_TEST_TIMEOUT_MS must be a whole number of milliseconds');
  return Number(stated);
}
