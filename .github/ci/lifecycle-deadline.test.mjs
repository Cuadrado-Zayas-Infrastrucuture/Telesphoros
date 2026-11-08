// Run with: node --test .github/ci/lifecycle-deadline.test.mjs   (pnpm test:ci-config, so the verify job on every pull request)
// The fixture-lifecycle control (scripts/test-fixtures/lifecycle.test.cjs) times some specs out on purpose, at the deadline it states. A spec
// it runs that sets a budget of its own with jest.setTimeout must take it through test/helpers/spec-deadline.ts, or the control's timeout
// never comes. The control itself runs only in service-postgres, which pull requests skip (.github/ci/scope.mjs), so this text check is what
// a pull request sees. It reads text; it does not catch a per-test timeout passed as the third argument of it().
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const control = read('scripts/test-fixtures/lifecycle.test.cjs');

/** Every spec path the control runs, from its list of cases. */
export const controlledSpecs = (source) => [...new Set([...source.matchAll(/'(test\/[^']+-spec\.ts)'/g)].map((match) => match[1]))];

/** What is wrong with a spec's own deadlines, for the control: each jest.setTimeout call must pass through specDeadline. */
export function deadlineProblems(path, source) {
  const calls = [...source.matchAll(/jest\.setTimeout\(([^;\n]*)\)/g)].map((match) => match[1].trim());
  const problems = calls.filter((argument) => !/^specDeadline\(/.test(argument)).map((argument) => `${path}: jest.setTimeout(${argument}) bypasses specDeadline`);
  const usesHelper = calls.some((argument) => /^specDeadline\(/.test(argument));
  if (usesHelper && !/from '\.{1,2}\/(?:[^']*\/)?helpers\/spec-deadline'/.test(source)) problems.push(`${path}: calls specDeadline without importing it from test/helpers/spec-deadline`);
  return problems;
}

test('the control states its deadline to every child, and asserts timeouts at that deadline', () => {
  assert.match(control, /const DEADLINE_MS = 5000;/);
  assert.match(control, /FIXTURE_TEST_TIMEOUT_MS: String\(DEADLINE_MS\)/);
  // The two timeouts this list of cases provokes are asserted at the stated deadline, not a copy of the number. (The drain tests further on
  // run their own children, which this deadline does not reach.)
  assert.match(control, /if \(mode === 'late'\) assert\.match\(output, new RegExp\(`Exceeded timeout of \$\{DEADLINE_MS\} ms for a hook`\)\);/);
  assert.match(control, /if \(mode === 'late-lock'\) assert\.match\(output, new RegExp\(`Exceeded timeout of \$\{DEADLINE_MS\} ms for a test`\)\);/);
});

test('every spec the control runs takes any budget of its own through specDeadline', () => {
  const specs = controlledSpecs(control);
  assert.ok(specs.includes('test/db/report-registration.pg-spec.ts'), 'the list of cases was read');
  assert.ok(specs.length >= 3);
  for (const spec of specs) assert.deepEqual(deadlineProblems(spec, read(`apps/backend/${spec}`)), [], spec);
});

test('the check refuses a literal budget, an unimported helper, and passes the default and the helper', () => {
  const imported = "import { specDeadline } from '../helpers/spec-deadline';\n";
  assert.deepEqual(deadlineProblems('a', 'jest.setTimeout(30_000);'), ['a: jest.setTimeout(30_000) bypasses specDeadline']);
  assert.deepEqual(deadlineProblems('a', `${imported}jest.setTimeout(30000);`), ['a: jest.setTimeout(30000) bypasses specDeadline']);
  assert.deepEqual(deadlineProblems('a', 'jest.setTimeout(specDeadline(30_000));'), ['a: calls specDeadline without importing it from test/helpers/spec-deadline']);
  assert.deepEqual(deadlineProblems('a', `${imported}jest.setTimeout(specDeadline(30_000));`), []);
  assert.deepEqual(deadlineProblems('a', "import { x } from '../../test/helpers/spec-deadline';\njest.setTimeout(specDeadline(1));"), []);
  assert.deepEqual(deadlineProblems('a', 'it("x", () => {});'), []);
});
