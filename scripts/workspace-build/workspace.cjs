const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const prepared = 'TELESPHOROS_WORKSPACE_PREPARED';
const libraries = ['shared-types', 'cpic-schema', 'fake-idp', 'jobs'];

/**
 * `run typecheck|test --except a,b` leaves out those workspace packages (`@telesphoros/a`, ...). CI's verify job uses it for suites that
 * another job runs under the same condition with its services; see .github/workflows/ci.yml. An exclude-only pnpm filter never selects the
 * workspace root (checked 2026-11-19), so the root's own `test` cannot recurse. Builds are a dependency graph and are never partial.
 * Returns the names, [] when there is no option, or null when the option is malformed.
 */
function exceptOption(rest, command) {
  if (rest.length === 0) return [];
  if (command === 'build' || rest.length !== 2 || rest[0] !== '--except' || !/^[a-z0-9-]+(,[a-z0-9-]+)*$/.test(rest[1])) return null;
  const names = rest[1].split(',');
  return names.some(name => libraries.includes(name)) ? null : names; // a library is built here first: leaving it out would be misleading
}

// Only redundant dependency builds are suppressed; consumer build/check commands always run.
function run(args, env = process.env, execute = spawnSync) {
  const [mode, command, ...rest] = args;
  const call = (argv, childEnv) => {
    const result = execute('pnpm', argv, { cwd: root, env: childEnv, stdio: 'inherit' });
    return result.error || result.signal ? 1 : (result.status ?? 1);
  };
  const buildLibraries = names => call(names.flatMap(name => ['--filter', `@telesphoros/${name}`]).concat('build'), env);
  if (mode === 'prepare') {
    const names = [command, ...rest];
    if (names.some(name => !libraries.includes(name))) return 1;
    return env[prepared] === '1' ? 0 : buildLibraries(names);
  }
  const except = exceptOption(rest, command);
  if (mode !== 'run' || except === null || !['typecheck', 'test', 'build'].includes(command)) return 1;
  // Never trust an inherited marker at the top-level boundary.
  const cleanEnv = { ...env };
  delete cleanEnv[prepared];
  if (command !== 'build') {
    const status = call(libraries.flatMap(name => ['--filter', `@telesphoros/${name}`]).concat('build'), cleanEnv);
    if (status !== 0) return status;
  }
  // For build, pnpm's topological graph itself builds libraries before their consumers.
  return call(['-r', ...except.flatMap(name => ['--filter', `!@telesphoros/${name}`]), '--if-present', command], { ...cleanEnv, [prepared]: '1' });
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
module.exports = { run, libraries, prepared };
