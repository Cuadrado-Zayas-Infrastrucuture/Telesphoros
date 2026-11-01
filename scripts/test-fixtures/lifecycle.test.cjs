// Real PostgreSQL regression. No forced Jest exit or modified test/hook timeout.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const cwd = path.resolve(__dirname, '../../apps/backend');
const backendRequire = require('node:module').createRequire(path.join(cwd, 'package.json'));
const { Client } = backendRequire('pg');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required: use a disposable PostgreSQL cluster');
async function databases() {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await client.connect();
    return (await client.query('SELECT datname FROM pg_database WHERE left(datname, 5)=$1 ORDER BY datname', ['test_'])).rows.map(row => row.datname);
  } finally { await client.end(); }
}
for (const [mode, file, name, expected] of [
  ['split', 'test/local-storage-intake.e2e-spec.ts', 'stores and retrieves exact lab-pdf', 0],
  ['late', 'test/local-storage-intake.e2e-spec.ts', 'stores and retrieves exact lab-pdf', 1],
  ['split', 'test/input-boundaries.e2e-spec.ts', 'rejects unexpected query and body', 0],
  ['late', 'test/input-boundaries.e2e-spec.ts', 'rejects unexpected query and body', 1],
  ['lock', 'test/db/report-registration.pg-spec.ts', 'fails migration on bounded lock contention', 0],
  ['late-lock', 'test/db/report-registration.pg-spec.ts', 'fails migration on bounded lock contention', 1],
]) {
  test(`${mode}: real resources close naturally and checks retain their deadlines [${file}]`, async () => {
    const before = await databases();
    const result = spawnSync(process.execPath, [backendRequire.resolve('jest/bin/jest'), '--runInBand',
      '--runTestsByPath', file, '--testNamePattern', name,
      '--setupFilesAfterEnv', path.join(__dirname, 'fixture-delay.cjs')], {
      cwd, env: { ...process.env, TEST_STORAGE: 'postgres', TEST_OBJECT_STORAGE: 'memory', FIXTURE_REGRESSION_MODE: mode },
      encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024,
    });
    // Preserve the child's complete permitted evidence in the producer output, including expected failure.
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Jest must exit naturally; the outer bound cannot make a failing child pass');
    assert.equal(result.status, expected);
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    assert.doesNotMatch(output, /Cannot read properties|environment has been torn down|Jest did not exit/);
    if (mode === 'late') assert.match(output, /Exceeded timeout of 5000 ms for a hook/);
    if (mode === 'late-lock') assert.match(output, /Exceeded timeout of 5000 ms for a test/);
    assert.deepEqual(await databases(), before, 'fixture databases must be reclaimed, including after a timed-out hook');
  });
}

// Unlike the single-case finite-delay controls, this outlasts setup AND teardown.
test('late setup retains its original scope across the next test', () => {
  const fs = require('node:fs'), os = require('node:os');
  const ts = backendRequire('typescript');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-scope-'));
  const events = path.join(directory, 'result.json');
  const source = fs.readFileSync(path.join(cwd, 'test/local-storage-intake.e2e-spec.ts'), 'utf8');
  const hooks = source.slice(source.indexOf('interface IntakeFixture'), source.indexOf('async function registration'));
  assert.ok(hooks.startsWith('interface IntakeFixture'), 'must exercise the actual scoped fixture hooks');
  const prelude = `import {writeFileSync} from 'node:fs';
    type EphemeralDatabase={appUrl:string,drop:()=>Promise<void>}; type NestExpressApplication={close:()=>Promise<void>};
    const live=new Set<string>(); const events:string[]=[];let databases=0,apps=0;
    const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
    const usingPostgres=()=>true;
    const createEphemeralDatabase=async()=>{const appUrl='db'+(++databases);live.add(appUrl);return{appUrl,drop:async()=>{events.push('drop:'+appUrl);live.delete(appUrl);}};};
    const createTestApp=async(options:any)=>{if(++apps===1)await delay(11500);return{close:async()=>{events.push('close:'+options.postgresUrl);}};};
    const clinicianA=async()=> 'synthetic';let app:NestExpressApplication;let token:string;
`;
  const cases = `it('first times out',()=>{});it('second owns its database',async()=>{await delay(2500);expect(live.has('db2')).toBe(true);});afterAll(()=>writeFileSync(${JSON.stringify(events)},JSON.stringify({events,remaining:[...live]})));`;
  fs.writeFileSync(path.join(directory, 'scope.spec.js'), ts.transpileModule(prelude + hooks + cases, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
  const config = path.join(directory, 'jest.json');
  fs.writeFileSync(config, JSON.stringify({rootDir:directory,testEnvironment:'node',transform:{},testMatch:['**/scope.spec.js']}));
  const result = spawnSync(process.execPath, [backendRequire.resolve('jest/bin/jest'),'--config',config,'--runInBand'], {encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024});
  process.stdout.write(result.stdout ?? '');process.stderr.write(result.stderr ?? '');
  assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,1);
  assert.match(result.stderr,/1 failed, 1 passed, 2 total/);
  const outcome = JSON.parse(fs.readFileSync(events,'utf8'));
  assert.deepEqual(outcome.remaining,[]);assert.ok(outcome.events.includes('drop:db1'));
});

test('construction rejection reclaims real resources and preserves unrelated fixtures', () => {
  const result = spawnSync(process.execPath, [backendRequire.resolve('jest/bin/jest'),'--runInBand',
    '--runTestsByPath','test/helpers/fixture-construction.control.ts','--testRegex','fixture-construction\\.control\\.ts$'], {
    cwd,env:{...process.env,TEST_STORAGE:'postgres',TEST_OBJECT_STORAGE:'memory'},encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024,
  });
  process.stdout.write(result.stdout ?? '');process.stderr.write(result.stderr ?? '');
  assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0);
});

// The cause of the 2026-10-17 and 2026-10-20 hangs: Jest abandons, but does not cancel, a fixture build that outlasts its hook or test.
// Each child fails its own test on purpose (status 1). With the end-of-file drain it must exit by itself, with its databases dropped.
// The same children with the plain Node environment must go wrong (hang, or leave a database behind): that proves the controls can go red
// and that the drain is not a forced exit.
const drainControl = (mode, { drain, boundMs }) => spawnSync(process.execPath, [backendRequire.resolve('jest/bin/jest'), '--runInBand',
  '--runTestsByPath', 'test/helpers/fixture-drain.control.ts', '--testRegex', 'fixture-drain\\.control\\.ts$', ...(drain ? [] : ['--testEnvironment', 'node'])], {
  cwd, env: { ...process.env, TEST_STORAGE: 'postgres', TEST_OBJECT_STORAGE: 'memory', FIXTURE_DRAIN_CONTROL: mode },
  encoding: 'utf8', timeout: boundMs, maxBuffer: 2 * 1024 * 1024,
});
async function dropLeaked(before) {
  const leaked = (await databases()).filter(name => !before.includes(name));
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  try { await client.connect(); for (const name of leaked) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await client.end(); }
  return leaked;
}
for (const [mode, expectedFailure, reclaimed] of [
  ['app', /Exceeded timeout of 5000 ms for a hook/, /ended with 1 fixture build\(s\) unfinished \(settled\) and 0 fixture\(s\) unclosed/],
  ['db', /Exceeded timeout of 5000 ms for a test/, /ended with 1 fixture build\(s\) unfinished \(settled\) and 0 fixture\(s\) unclosed/],
  ['app-late', /Exceeded timeout of 5000 ms for a hook/, /ended with 0 fixture build\(s\) unfinished \(settled\) and [1-9]\d* fixture\(s\) unclosed/],
]) {
  test(`drain ${mode}: an abandoned fixture build is reclaimed and Jest exits by itself`, async () => {
    const before = await databases();
    const result = drainControl(mode, { drain: true, boundMs: 25000 });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Jest must exit naturally; the outer bound cannot make a hung child pass');
    assert.equal(result.status, 1, 'the child fails its own test on purpose; a pass would mean the control did not run');
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    assert.match(output, expectedFailure);
    assert.match(output, new RegExp('\\[fixture-drain\\] test/helpers/fixture-drain\\.control\\.ts: ' + reclaimed.source));
    assert.doesNotMatch(output, /Jest did not exit|environment has been torn down/);
    assert.deepEqual(await databases(), before, 'the abandoned build must drop the database it created');
  });
}

test('drain control without the drain, abandoned build still running at the end: Jest warns and a database is left behind', async () => {
  const before = await databases();
  const result = drainControl('app', { drain: false, boundMs: 25000 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const leaked = await dropLeaked(before);
  assert.match(output, /Jest did not exit one second after the test run has completed/);
  assert.ok(leaked.length > 0, 'without the drain the abandoned build leaves its database behind');
});

test('drain control without the drain, abandoned build finished during the file: the same child never exits', async () => {
  const before = await databases();
  const result = drainControl('app-late', { drain: false, boundMs: 20000 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  await dropLeaked(before);
  assert.equal(result.signal, 'SIGTERM', 'without the drain the unowned, listening application keeps Jest alive until the bound kills it');
  assert.match(output, /Jest did not exit one second after the test run has completed/);
});
