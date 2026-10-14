// Mounted into the test container, never baked into the application image.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {randomUUID, createHash} = require('node:crypto');
const fs = require('node:fs');
const {Client} = require('/app/node_modules/pg');
const {SecretsManagerClient,CreateSecretCommand,GetSecretValueCommand} = require('/app/node_modules/@aws-sdk/client-secrets-manager');
const {S3Client,CreateBucketCommand,PutBucketVersioningCommand,GetBucketVersioningCommand} = require('/app/node_modules/@aws-sdk/client-s3');
const {pgClientConfig} = require('/app/dist/db/tls');
const sm = new SecretsManagerClient({});
const hash = text => createHash('sha256').update(text).digest('hex');
async function credentials() {
  for (const [kind, key] of [['APP','DATABASE_URL'],['VERIFIER','LEDGER_VERIFIER_DATABASE_URL'],['MIGRATOR','DATABASE_MIGRATOR_URL'],['WORKER','WORKER_DATABASE_URL']]) {
    process.env[key] = (await sm.send(new GetSecretValueCommand({SecretId:process.env[`PROVISION_SECRET_${kind}`]}))).SecretString;
  }
}
async function connected(url, work) {
  const c = new Client(pgClientConfig(url,'require')); await c.connect();
  try {return await work(c);} finally {await c.end();}
}
function cli(args, expected=0) {
  return new Promise((resolve,reject) => {
    const child=spawn(process.execPath,['dist/db/cli.js',...args],{env:process.env,stdio:['ignore','pipe','pipe']});
    let out=''; child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
    child.on('error',reject);child.on('exit',code=> {
      // Never echo captured command output: it may contain a credential on failure.
      try {assert.equal(code,expected,'CLI exit status');resolve(out);}catch(e){reject(e);}
    });
  });
}
async function api() {
  await credentials();
  const child=spawn(process.execPath,['dist/main.js'],{env:process.env,stdio:'inherit'});
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
  child.on('exit',code=>process.exit(code ?? 1));
}
// The background worker, started as the image starts it (`node worker/main.js`, production mode, its own login and nothing else): it must come up, answer its
// health probe, and stop cleanly on SIGTERM. Nothing it logs is printed (the output may hold a connection detail).
async function workerCheck() {
  await credentials();
  const env={...process.env,DATABASE_URL:process.env.WORKER_DATABASE_URL,WORKER_ID:'rehearsal-worker',WORKER_HEALTH_PORT:'8081',WORKER_DRAIN_SECONDS:'5'};
  for(const key of ['WORKER_DATABASE_URL','LEDGER_VERIFIER_DATABASE_URL','DATABASE_MIGRATOR_URL','PROVISION_ADMIN_PASSWORD']) delete env[key];
  const child=spawn(process.execPath,['worker/main.js'],{env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const exited=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
  try {
    let live=false;
    for(let i=0;i<40&&!live;i++){
      await new Promise(r=>setTimeout(r,1000));
      try{live=(await fetch('http://127.0.0.1:8081/livez',{signal:AbortSignal.timeout(2000)})).status===200;}catch{}
    }
    assert.equal(live,true,'worker live');
    assert.equal((await fetch('http://127.0.0.1:8081/readyz')).status,200);
    assert.match(output,/"event":"worker-started"/);
    assert.doesNotMatch(output,/job-types-disabled/); // the bucket is configured, so the file jobs are registered
  } finally {
    child.kill('SIGTERM');
  }
  const done=await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve({code:'timeout'}),45000))]);
  assert.deepEqual(done,{code:0,signal:null});
  assert.match(output,/"event":"worker-stopped"/);
  console.log('PASS worker started with its own login, answered its probes and stopped cleanly');
}
async function seed(tenant) {
  const patient=randomUUID(), report=randomUUID(), sha=hash(report), version='synthetic-v1', key=`synthetic/${report}`;
  await connected(process.env.DATABASE_URL,async c=> {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)",[tenant]);
    await c.query('INSERT INTO patients (id,tenant_id,created_by,label) VALUES ($1,$2,$3,$4)',[patient,tenant,'synthetic-author',`SYN-${patient.slice(0,24)}`]);
    await c.query(`INSERT INTO reports (id,tenant_id,created_by,patient_id,type,original_filename,size_bytes,status,content_type,sha256,storage_key,uploaded_at,object_version,upload_requested_by,uploaded_by)
    VALUES ($1,$2,$3,$4,'lab-pdf','synthetic.pdf',1000,'received','application/pdf',$5,$6,now(),$7,$3,$3)`,[report,tenant,'synthetic-author',patient,sha,key,version]);
    await c.query('COMMIT');
  });
  return {reportId:report, expectedReport:{patientId:patient,sha256:sha,objectVersion:version,storageKey:key},pdfSha256:sha,textStorageKey:`synthetic/text/${report}`,textSha256:hash(report+'text'),textScalars:14,popplerVersion:'26.03.0',runner:'fake'};
}
async function write(tenant,input) {
  const {Database}=require('/app/dist/db/database');
  const {PostgresLedgerRecordsRepository}=require('/app/dist/storage/postgres/ledger-records.repository');
  // This process has no cached containment state: prove the DATABASE refuses it.
  const db=new Database({url:process.env.DATABASE_URL,ssl:'require'});
  try {return await new PostgresLedgerRecordsRepository(db).insertCapture(tenant,'synthetic-author',input);}finally{await db.onModuleDestroy();}
}
async function main() {
  assert.equal(process.getuid(),10001);
  assert.equal(process.version,'v22.22.0');
  for(const module of ['typescript','jest','@telesphoros/fake-idp']) assert.throws(()=>require.resolve(module,{paths:['/app']}));
  assert.equal(fs.existsSync('/app/src'),false);
  assert.throws(()=>fs.writeFileSync('/app/should-not-write','test'));
  const mode=process.argv[2];
  if(mode==='initialize') {
    for(const kind of ['APP','VERIFIER','MIGRATOR','WORKER']) await sm.send(new CreateSecretCommand({Name:process.env[`PROVISION_SECRET_${kind}`]}));
    await cli(['provision-logins']); await credentials();
    // Negative TLS control: same server and credentials, a hostname absent from its certificate.
    const wrong=new URL(process.env.DATABASE_URL);wrong.hostname=process.env.REHEARSAL_WRONG_HOST;
    await assert.rejects(connected(wrong.toString(),c=>c.query('SELECT 1')),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID');
    // Missing tables fail production bootstrap BEFORE listen, not a fabricated /ready 503.
    const child=spawn(process.execPath,['dist/main.js'],{env:process.env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('pristine startup did not refuse'));},30000);child.on('exit',code=>{clearTimeout(timer);resolve(code);});child.on('error',reject);});
    assert.notEqual(code,0);assert.match(output,/record log did not pass its check at start/);
    // Storage-only startup still requires genuine version pins. This fixture is
    // confined to the disposable Moto container; never fall back to an AWS endpoint.
    assert.equal(process.env.S3_ENDPOINT,'http://moto:5000');
    const s3=new S3Client({endpoint:process.env.S3_ENDPOINT,forcePathStyle:true});
    await s3.send(new CreateBucketCommand({Bucket:process.env.REPORTS_BUCKET,CreateBucketConfiguration:{LocationConstraint:process.env.AWS_REGION}}));
    await s3.send(new PutBucketVersioningCommand({Bucket:process.env.REPORTS_BUCKET,VersioningConfiguration:{Status:'Enabled'}}));
    assert.equal((await s3.send(new GetBucketVersioningCommand({Bucket:process.env.REPORTS_BUCKET}))).Status,'Enabled');
    await cli(['migrate','up']); await cli(['provision-logins','--require-migrated']);
    console.log('PASS provisioning, pristine startup refusal, migrations, privilege verification');
  } else if(mode==='api') await api();
  else if(mode==='worker') await workerCheck();
  else if(mode==='record') {
    await credentials();const input=await seed('synthetic-contained');await write('synthetic-contained',input);
    await connected(process.env.LEDGER_VERIFIER_DATABASE_URL,c=>c.query('SELECT ledger_record_incident($1,$2,$3::bigint,$4)',['synthetic-contained','payload-mismatch',1,'background']));
    console.log('PASS task one committed tenant containment');
  } else if(mode==='check') {
    await credentials();
    const before=await connected(process.env.LEDGER_VERIFIER_DATABASE_URL,async c=>(await c.query('SELECT count(*)::int AS n FROM report_captures WHERE tenant_id=$1',['synthetic-contained'])).rows[0].n);
    const input=await seed('synthetic-contained');
    const {LedgerCompromisedError}=require('/app/dist/ledger/ledger-types');
    await assert.rejects(write('synthetic-contained',input),LedgerCompromisedError);
    const after=await connected(process.env.LEDGER_VERIFIER_DATABASE_URL,async c=>(await c.query('SELECT count(*)::int AS n FROM report_captures WHERE tenant_id=$1',['synthetic-contained'])).rows[0].n);
    assert.equal(after,before);
    await write('synthetic-healthy',await seed('synthetic-healthy'));
    console.log('PASS task two refused contained write and rolled back; healthy tenant control succeeded');
  } else throw new Error('unknown rehearsal mode');
}
main().catch(e=>{console.error('FAIL container rehearsal driver '+process.argv[2]+' ('+(e.code || e.name)+'); captured errors withheld to protect credentials');process.exit(1);});
