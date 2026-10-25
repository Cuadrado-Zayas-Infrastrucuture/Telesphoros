// A dedicated synthetic-only cluster. No drop/reset/delete command exists.
const path=require('node:path');const fs=require('node:fs');const {execFileSync}=require('node:child_process');const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..');const state=path.join(root,'.local-review/postgres');const port=process.env.LOCAL_REVIEW_PG_PORT||'54359';
if(!/^[1-9][0-9]{3,4}$/.test(port)||Number(port)>65535)throw new Error('Invalid local port');
const bin=name=>process.env.LOCAL_PG_BIN?path.join(process.env.LOCAL_PG_BIN,name):name;
const run=(name,args)=>execFileSync(bin(name),args,{stdio:'inherit'});
async function setup(){
 const version=execFileSync(bin('postgres'),['--version'],{encoding:'utf8'});if(!/\b16\./.test(version))throw new Error('PostgreSQL16 required');
 if(!fs.existsSync(state)){fs.mkdirSync(path.dirname(state),{recursive:true});run('initdb',['-D',state,'-U','demo_owner','--encoding=UTF8','--locale=C','--auth=trust']);}
 if(fs.readFileSync(path.join(state,'PG_VERSION'),'utf8').trim()!=='16')throw new Error('Wrong cluster version');
 try{execFileSync(bin('pg_ctl'),['-D',state,'status'],{stdio:'ignore'});}catch{run('pg_ctl',['-D',state,'-l',path.join(root,'.local-review/postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -k /tmp`,'start']);}
 const req=createRequire(path.join(root,'apps/backend/package.json'));const {Client}=req('pg');const {migrateUp}=require('../../apps/backend/dist/db/migrator');
 const owner=new Client({connectionString:`postgresql://demo_owner@127.0.0.1:${port}/postgres`});await owner.connect();
 if(!(await owner.query('SELECT 1 FROM pg_database WHERE datname=$1',['synthetic_review'])).rowCount)await owner.query('CREATE DATABASE synthetic_review');await owner.end();
 const db=new Client({connectionString:`postgresql://demo_owner@127.0.0.1:${port}/synthetic_review`});await db.connect();await migrateUp(db);
 await db.query(`DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='demo_app') THEN CREATE ROLE demo_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_app; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='demo_verifier') THEN CREATE ROLE demo_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_ledger_verifier; END IF; END $$`);
 const seeded=await require('./seed.cjs').seedPersonas(db);await db.end();
 console.log(`Dedicated synthetic database ready. Loopback trust authentication: no real data. Demo users: ${seeded.members} members of ${seeded.tenants} organizations (${seeded.changed} changed).`);
}
const command=process.argv[2];
if(command==='setup')setup().catch(()=>{console.error('Local database setup failed; no connection values logged.');process.exitCode=1;});
else if(command==='stop')run('pg_ctl',['-D',state,'stop','-m','fast']);
else{console.error('Usage: node scripts/local-review/database.cjs setup|stop');process.exitCode=1;}
