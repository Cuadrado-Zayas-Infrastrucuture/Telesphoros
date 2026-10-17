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
  ['lock', 'test/db/report-registration.pg-spec.ts', 'fails migration on bounded lock contention', 0],
  ['late-lock', 'test/db/report-registration.pg-spec.ts', 'fails migration on bounded lock contention', 1],
]) {
  test(`${mode}: real resources close naturally and checks retain their deadlines`, async () => {
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
