const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const prepared = 'TELESPHOROS_WORKSPACE_PREPARED';
const libraries = ['shared-types', 'cpic-schema', 'fake-idp'];

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
  if (mode !== 'run' || rest.length || !['typecheck', 'test', 'build'].includes(command)) return 1;
  // Never trust an inherited marker at the top-level boundary.
  const cleanEnv = { ...env };
  delete cleanEnv[prepared];
  if (command !== 'build') {
    const status = call(libraries.flatMap(name => ['--filter', `@telesphoros/${name}`]).concat('build'), cleanEnv);
    if (status !== 0) return status;
  }
  // For build, pnpm's topological graph itself builds libraries before their consumers.
  return call(['-r', '--if-present', command], { ...cleanEnv, [prepared]: '1' });
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
module.exports = { run, libraries, prepared };
