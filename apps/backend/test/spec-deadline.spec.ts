import { specDeadline } from './helpers/spec-deadline';

// test/helpers/spec-deadline.ts: a spec's own budget, unless the fixture-lifecycle control states the deadline it is testing.
describe('specDeadline', () => {
  const saved = process.env.FIXTURE_TEST_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.FIXTURE_TEST_TIMEOUT_MS;
    else process.env.FIXTURE_TEST_TIMEOUT_MS = saved;
  });

  it('gives the spec its own budget when the control states nothing', () => {
    delete process.env.FIXTURE_TEST_TIMEOUT_MS;
    expect(specDeadline(30_000)).toBe(30_000);
  });

  it('gives the deadline the control states, shorter or longer than the budget', () => {
    process.env.FIXTURE_TEST_TIMEOUT_MS = '5000';
    expect(specDeadline(30_000)).toBe(5000);
    process.env.FIXTURE_TEST_TIMEOUT_MS = '60000';
    expect(specDeadline(30_000)).toBe(60_000);
  });

  it('stops on a value that is not a whole number of milliseconds, rather than run without a deadline', () => {
    for (const value of ['', '0', '-5', '5s', '5000.5', '5e3', ' 5000', 'NaN']) {
      process.env.FIXTURE_TEST_TIMEOUT_MS = value;
      expect(() => specDeadline(30_000)).toThrow('FIXTURE_TEST_TIMEOUT_MS must be a whole number of milliseconds');
    }
  });
});
