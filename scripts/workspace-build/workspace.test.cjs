const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { run, libraries, prepared } = require('./workspace.cjs');

for (const command of ['typecheck', 'test']) {
  test(`${command}: one library producer finishes before consumer hooks and checks`, () => {
    const events = [];
    const execute = (_bin, args, options) => {
      if (args[0] === '--filter') {
        assert.equal(options.env[prepared], undefined);
        events.push('libraries ready');
      } else {
        assert.deepEqual(args, ['-r', '--if-present', command]);
        assert.deepEqual(events, ['libraries ready']);
        for (const consumer of ['backend', 'smart-pilot']) {
          const status = run(['prepare', 'shared-types'], options.env, () => {
            // A second producer here would clean files while the other consumer is reading them.
            events.push('unsafe rebuild');
            return { status: 0 };
          });
          assert.equal(status, 0);
          events.push(`${consumer} checked`);
        }
      }
      return { status: 0 };
    };
    assert.equal(run(['run', command], {}, execute), 0);
    assert.deepEqual(events, ['libraries ready', 'backend checked', 'smart-pilot checked']);
  });
}

test('recursive build delegates the dependency graph once without nested rebuilds', () => {
  const calls = [];
  assert.equal(run(['run', 'build'], {}, (bin, args, options) => {
    calls.push([bin, args]);
    assert.equal(run(['prepare', ...libraries], options.env, () => { throw new Error('nested writer'); }), 0);
    return { status: 0 };
  }), 0);
  assert.deepEqual(calls, [['pnpm', ['-r', '--if-present', 'build']]]);
});

test('standalone hooks still build every declared prerequisite', () => {
  for (const file of ['apps/backend/package.json', 'packages/smart-pilot/package.json']) {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../..', file), 'utf8'));
    for (const name of ['pretypecheck', 'prebuild', 'pretest']) {
      const script = pkg.scripts[name];
      if (!script) continue;
      const args = script.split(' ').slice(2);
      assert.equal(args[0], 'prepare');
      const expected = args.slice(1);
      assert.ok(expected.includes('shared-types'));
      const calls = [];
      assert.equal(run(args, {}, (_bin, argv) => { calls.push(argv); return { status: 0 }; }), 0);
      assert.deepEqual(calls, [expected.flatMap(n => ['--filter', `@telesphoros/${n}`]).concat('build')]);
      for (const dependency of expected) assert.ok(libraries.includes(dependency));
    }
  }
});

test('a failed prerequisite stops consumers and preserves the exit code', () => {
  let calls = 0;
  assert.equal(run(['run', 'typecheck'], {}, () => { calls++; return { status: 17 }; }), 17);
  assert.equal(calls, 1);
  assert.equal(run(['prepare', 'shared-types'], {}, () => ({ status: 9 })), 9);
});

test('a failed or interrupted check cannot report success', () => {
  for (const result of [{ status: 23 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failed') }]) {
    assert.notEqual(run(['run', 'build'], {}, () => result), 0);
  }
});

test('an inherited prepared marker cannot bypass the root prerequisite phase', () => {
  let calls = 0;
  assert.equal(run(['run', 'typecheck'], { [prepared]: '1' }, (_bin, _args, options) => {
    if (++calls === 1) assert.equal(options.env[prepared], undefined);
    return { status: 0 };
  }), 0);
  assert.equal(calls, 2);
});

test('invalid modes, commands and prerequisite names run nothing', () => {
  for (const args of [[], ['run', 'lint'], ['run', 'build', 'extra'], ['prepare'], ['prepare', 'unknown']]) {
    assert.equal(run(args, {}, () => { throw new Error('must not run'); }), 1);
  }
});
