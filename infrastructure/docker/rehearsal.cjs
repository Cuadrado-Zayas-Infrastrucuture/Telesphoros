// Local/CI only. Creates uniquely named disposable resources; never contacts AWS.
const assert=require('node:assert/strict');
const {postgresReady}=require('./postgres-readiness.cjs');
const {execFileSync}=require('node:child_process');
const {mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto');
const tag=process.argv[2] || 'telesphoros-fd4b:rehearsal';
const root=resolve(__dirname,'../..');
const scratch=mkdtempSync(join(tmpdir(),'telesphoros-fd4b-'));
const prefix=`telesphoros-fd4b-${randomUUID().slice(0,8)}`;
const network=prefix,pg=prefix+'-pg',moto=prefix+'-moto',api1=prefix+'-api1',api2=prefix+'-api2';
const containers=[];let networkCreated=false;
let phase='setup';
function run(cmd,args,options={}) {phase=cmd+' '+args.slice(0,3).filter(a=>!a.includes('://')).join(' ');return execFileSync(cmd,args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe'],...options});}
const docker=(...args)=>run('docker',args);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(probe,label,seconds=60) {for(let i=0;i<seconds;i++){try{if(await probe())return;}catch{}await sleep(1000);}throw new Error(`timeout: ${label}`);}
const password=randomBytes(32).toString('hex');
function start(name,args){docker('run','-d','--name',name,...args);containers.push(name);}
function inside(mode){return docker('run','--rm','--platform','linux/amd64','--read-only','--user','10001:10001','--network',network,'--env-file',join(scratch,'rehearsal.env'),'-v',`${join(scratch,'ca.crt')}:/test/ca.crt:ro`,'-v',`${join(root,'infrastructure/docker/rehearsal-driver.cjs')}:/test/driver.cjs:ro`,tag,'/test/driver.cjs',mode);}
function api(name){start(name,['--platform','linux/amd64','--read-only','--user','10001:10001','--network',network,'--env-file',join(scratch,'rehearsal.env'),'-v',`${join(scratch,'ca.crt')}:/test/ca.crt:ro`,'-v',`${join(root,'infrastructure/docker/rehearsal-driver.cjs')}:/test/driver.cjs:ro`,'-p','127.0.0.1::3000',tag,'/test/driver.cjs','api']);return Number(docker('port',name,'3000/tcp').trim().split(':').at(-1));}
async function response(port,path,status){const r=await fetch(`http://127.0.0.1:${port}/api/v1/${path}`,{signal:AbortSignal.timeout(2500)});assert.equal(r.status,status);return r.json();}
async function main(){
  // No existing container, database, volume or network is reused.
  run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(scratch,'ca.key'),'-out',join(scratch,'ca.crt'),'-days','1','-subj','/CN=synthetic-rehearsal-ca']);
  run('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',join(scratch,'server.key'),'-out',join(scratch,'server.csr'),'-subj','/CN=pg']);
  writeFileSync(join(scratch,'server.ext'),'subjectAltName=DNS:pg\nextendedKeyUsage=serverAuth\n');
  run('openssl',['x509','-req','-in',join(scratch,'server.csr'),'-CA',join(scratch,'ca.crt'),'-CAkey',join(scratch,'ca.key'),'-CAcreateserial','-out',join(scratch,'server.crt'),'-days','1','-extfile',join(scratch,'server.ext')]);
  writeFileSync(join(scratch,'pg.env'),`POSTGRES_PASSWORD=${password}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n`,{mode:0o600});
  writeFileSync(join(scratch,'rehearsal.env'),Object.entries({NODE_ENV:'production',NODE_EXTRA_CA_CERTS:'/test/ca.crt',DATABASE_SSL:'require',AUTH_VERIFIER:'cognito',COGNITO_REGION:'us-east-2',COGNITO_USER_POOL_ID:'us-east-2_Synthetic',COGNITO_APP_CLIENT_ID:'synthetic',STORAGE_DRIVER:'postgres',OBJECT_STORAGE_DRIVER:'s3',S3_ENDPOINT:'http://moto:5000',S3_FORCE_PATH_STYLE:'true',REPORTS_BUCKET:'synthetic-reports',AWS_REGION:'us-east-2',AWS_ACCESS_KEY_ID:'synthetic',AWS_SECRET_ACCESS_KEY:'synthetic',AWS_ENDPOINT_URL_SECRETS_MANAGER:'http://moto:5000',AWS_EC2_METADATA_DISABLED:'true',RATE_LIMIT_ENABLED:'true',TRUST_PROXY_HOPS:'1',BUILD_VERSION:'synthetic-fd4b',PORT:'3000',CORS_ALLOWED_ORIGINS:'https://synthetic.example.invalid',PROVISION_ADMIN_USER:'synthetic_admin',PROVISION_ADMIN_PASSWORD:password,DATABASE_HOST:'pg',REHEARSAL_WRONG_HOST:pg,DATABASE_PORT:'5432',DATABASE_NAME:'telesphoros',PROVISION_SECRET_APP:'synthetic/app',PROVISION_SECRET_VERIFIER:'synthetic/verifier',PROVISION_SECRET_MIGRATOR:'synthetic/migrator'}).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
  docker('network','create',network);networkCreated=true;
  start(pg,['--network',network,'--network-alias','pg','--env-file',join(scratch,'pg.env'),'postgres:16-bookworm@sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4']);
  await until(()=>postgresReady(docker,pg),'Postgres final TCP listener');
  docker('cp',join(scratch,'server.key'),`${pg}:/var/lib/postgresql/server.key`);docker('cp',join(scratch,'server.crt'),`${pg}:/var/lib/postgresql/server.crt`);
  docker('exec','-u','root',pg,'chown','postgres:postgres','/var/lib/postgresql/server.key','/var/lib/postgresql/server.crt');docker('exec','-u','root',pg,'chmod','600','/var/lib/postgresql/server.key');
  run('docker',['exec','-i',pg,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],{input:`ALTER SYSTEM SET ssl='on';
ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/server.crt';
ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/server.key';
CREATE ROLE synthetic_admin LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD '${password}';
CREATE DATABASE telesphoros OWNER synthetic_admin;
SELECT pg_reload_conf();
`});
  start(moto,['--network',network,'--network-alias','moto','motoserver/moto:5.2.3@sha256:91fd602a21f49cf9eb82fdf474015a3c131d40104c8297ea6a2ca920708ae32c']);
  await until(()=>{docker('exec',moto,'python','-c',"import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/moto-api/')");return true;},'moto');
  console.log(inside('initialize').trim());
  const p1=api(api1),p2=api(api2);
  for(const port of [p1,p2]) {
    await until(async()=>{await response(port,'ready',200);return true;},'API ready');
    await response(port,'health',200);await response(port,'me',401);
  }
  console.log('PASS two read-only production-mode API tasks: health 200, ready 200, unauthenticated 401');
  console.log(inside('record').trim());console.log(inside('check').trim());
  // Both running APIs learn containment from the DB through their normal incident poll.
  for(const port of [p1,p2]) await until(async()=> (await response(port,'ready',200)).checks.ledger==='contained','contained readiness',90);
  console.log('PASS both API tasks report contained readiness');
}
main().catch(e=>{for(const line of String(e.stderr || '').split('\n'))if(/^FAIL container rehearsal driver [a-z]+ \([A-Z0-9_]+\); captured errors withheld to protect credentials$/.test(line))console.error(line);console.error('FAIL rehearsal at '+phase+'; command output withheld to protect generated credentials');process.exitCode=1;}).finally(()=>{
  // Blast radius: ONLY unique names generated by this run; disposable synthetic cluster and keys.
  // Nothing needs restoring; rerunning creates a fresh cluster. No global prune/delete is used.
  for(const name of containers.reverse())try{docker('rm','-f','-v',name);}catch{process.exitCode=1;}
  if(networkCreated)try{docker('network','rm',network);}catch{process.exitCode=1;}
  rmSync(scratch,{recursive:true,force:true});
});
