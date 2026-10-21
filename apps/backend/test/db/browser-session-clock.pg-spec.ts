// Sixteen clock review probes retained permanently. Reuse the cluster-wide fixture role
// across test profiles; its restricted flags are asserted below before migrations run.
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { BrowserSessionCustody } from '../../src/auth/browser-session';
import { SessionCrypto } from '../../src/auth/session-crypto';
import { Database } from '../../src/db/database';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { PostgresBrowserSessionRepository } from '../../src/storage/postgres/browser-session.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { migrationsThrough } from '../helpers/migrations-through';
import { registeringAdmin } from '../helpers/membership';
import { revertAbove } from '../helpers/migration-history';

const A='tenant-clock-review-a', B='tenant-clock-review-b';
let pg:EphemeralDatabase, db:Database, otherDb:Database;
let repo:PostgresBrowserSessionRepository, other:PostgresBrowserSessionRepository, crypto:SessionCrypto;
const custody=(skew=0, repository=repo)=>new BrowserSessionCustody(repository,crypto,()=>Date.now()+skew);
function input(tenant=A,skew=0,expiry=Date.now()+120_000){return {identity:{tenantId:tenant,sub:tenant+'-person',roles:[],issuedAt:Math.floor((Date.now()+Math.min(0,skew))/1000)-1},accessToken:'synthetic-clock-review-token',tokenExpiresAt:new Date(expiry)};}
const digest=(cookie:string)=>crypto.hashHandle(crypto.openLocator(cookie)!.handle);
beforeAll(async()=>{
 pg=await createEphemeralDatabase();db=new Database({url:pg.appUrl,ssl:'disable',applicationName:'clock-review-reader'});otherDb=new Database({url:pg.appUrl,ssl:'disable',applicationName:'clock-review-revoker'});
 repo=new PostgresBrowserSessionRepository(db);other=new PostgresBrowserSessionRepository(otherDb);crypto=new SessionCrypto('review',new Map([['review',randomBytes(32)]]));
 await withAdmin(pg.adminUrl,async c=>{for(const tenant of [A,B])await registeringAdmin(c).grant({tenantId:tenant,sub:tenant+'-person',roles:['reader'],by:'review-fixture',reason:'synthetic clock review'});});
});
afterAll(async()=>{await db?.onModuleDestroy();await otherDb?.onModuleDestroy();await pg?.drop();});
async function app(tenant=A){const c=new Client({connectionString:pg.appUrl});await c.connect();await c.query('BEGIN');await c.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);return c;}
async function end(c:Client){await c.query('ROLLBACK').catch(()=>undefined);await c.end();}
async function waitFor(application:string){for(let n=0;n<150;n++){
 const found=await withAdmin(pg.adminUrl,async c=>(await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'",[pg.name,application])).rows[0].n);
 if(found)return;await new Promise(r=>setTimeout(r,10));
}throw Error('Expected confirmed row-lock wait did not occur');}
async function past(expiry:Date){await withAdmin(pg.adminUrl,c=>c.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))+0.03))',[expiry]));expect(await withAdmin(pg.adminUrl,async c=>(await c.query('SELECT clock_timestamp()>$1::timestamptz AS expired',[expiry])).rows[0].expired)).toBe(true);}

it.each([-120_000,-20_000,0,29_000])('immediate terminal database-timed revocation with application offset %d ms',async skew=>{
 const session=custody(skew);const made=await session.create(input(A,skew));const hash=digest(made.cookie);
 expect(Boolean(await session.read(made.cookie))).toBe(true);
 expect(await session.revoke(made.cookie)).toBe(true);expect(Boolean(await session.read(made.cookie))).toBe(false);expect(await session.revoke(made.cookie)).toBe(false);
 expect(await withAdmin(pg.adminUrl,async c=>(await c.query('SELECT isfinite(revoked_at) AS finite,revoked_at<=clock_timestamp() AS not_future FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2',[A,hash])).rows[0])).toEqual({finite:true,not_future:true});
});
it('still refuses out-of-tolerance future creation without inserting a row',async()=>{
 const before=await withAdmin(pg.adminUrl,async c=>(await c.query('SELECT count(*)::int AS n FROM browser_sessions WHERE tenant_id=$1',[A])).rows[0].n);
 await expect(custody(60_000).create(input(A,60_000))).rejects.toMatchObject({code:'unavailable'});
 expect(await withAdmin(pg.adminUrl,async c=>(await c.query('SELECT count(*)::int AS n FROM browser_sessions WHERE tenant_id=$1',[A])).rows[0].n)).toBe(before);
});
it('never accepts a caller-selected revocation time, including infinity',async()=>{
 const made=await custody(29_000).create(input(A,29_000));const c=await app();
 try{
  await c.query("UPDATE browser_sessions SET revoked_at='infinity' WHERE tenant_id=$1 AND handle_hash=$2",[A,digest(made.cookie)]);
  expect((await c.query('SELECT isfinite(revoked_at) AS finite,revoked_at<created_at AS precedes_app,revoked_at<=clock_timestamp() AS not_future FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2',[A,digest(made.cookie)])).rows[0]).toEqual({finite:true,precedes_app:true,not_future:true});
  await c.query('COMMIT');
 }finally{await end(c);}
 expect(Boolean(await custody().read(made.cookie))).toBe(false);
});
it('concurrent skewed-session revokers have exactly one winner',async()=>{
 const made=await custody(29_000).create(input(A,29_000));const hash=digest(made.cookie);
 expect((await Promise.all([repo.revoke(A,hash),other.revoke(A,hash)])).sort()).toEqual([false,true]);
 expect(Boolean(await custody().read(made.cookie))).toBe(false);
});
it('clock repairs do not let a different tenant revoke or read the session',async()=>{
 const made=await custody(29_000).create(input(A,29_000));const hash=digest(made.cookie);
 expect(await other.revoke(B,hash)).toBe(false);expect(Boolean(await other.findActive(B,hash))).toBe(false);
 expect(Boolean(await custody().read(made.cookie))).toBe(true);expect(await other.revoke(A,hash)).toBe(true);
});

it.each([
 {name:'unchanged row commits before expiry',revoke:false,finish:'COMMIT',expire:false,skew:-20_000,expected:true},
 {name:'revocation rolls back before expiry',revoke:true,finish:'ROLLBACK',expire:false,skew:-20_000,expected:true},
 {name:'revocation rolls back after expiry',revoke:true,finish:'ROLLBACK',expire:true,skew:-20_000,expected:false},
 {name:'revocation commits before expiry',revoke:true,finish:'COMMIT',expire:false,skew:-20_000,expected:false},
 {name:'unchanged row commits after expiry with a slow clock',revoke:false,finish:'COMMIT',expire:true,skew:-20_000,expected:false},
 {name:'unchanged row commits after expiry with a synchronized clock',revoke:false,finish:'COMMIT',expire:true,skew:0,expected:false},
])('lock ordering: $name',async test=>{
 const session=custody(test.skew);const made=await session.create(input(A,test.skew,Date.now()+(test.expire?1_200:60_000)));const hash=digest(made.cookie);const c=await app();let read:ReturnType<typeof session.read>|undefined;
 try{
  expect(Boolean(await session.read(made.cookie))).toBe(true);
  if(test.revoke)await c.query('UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND handle_hash=$2',[A,hash]);
  else await c.query('SELECT handle_hash FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2 FOR NO KEY UPDATE',[A,hash]);
  read=session.read(made.cookie);await waitFor('clock-review-reader');if(test.expire)await past(made.expiresAt);
  await c.query(test.finish);expect(Boolean(await read)).toBe(test.expected);
 }finally{await end(c);await read;}
});
it('cleanup skips a locked expiring session, and removes it after its waiting read refuses expiry',async()=>{
 await repo.cleanupExpired(A,100);
 const session=custody(-20_000);const made=await session.create(input(A,-20_000,Date.now()+1_200));const hash=digest(made.cookie);const c=await app();let read:ReturnType<typeof session.read>|undefined;
 try{
  expect(Boolean(await session.read(made.cookie))).toBe(true);
  await c.query('SELECT handle_hash FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2 FOR UPDATE',[A,hash]);read=session.read(made.cookie);await waitFor('clock-review-reader');await past(made.expiresAt);
  expect(await other.cleanupExpired(A,100)).toBe(0);
  await c.query('COMMIT');expect(Boolean(await read)).toBe(false);expect(await other.cleanupExpired(A,100)).toBe(1);
 }finally{await end(c);await read;}
});
it('a non-superuser owner upgrades populated custody and refuses incompatible downgrade without losing it',async()=>{
 const through0027=migrationsThrough('0027');
 const isolated=await createEphemeralDatabase();const isolatedDb=new Database({url:isolated.appUrl,ssl:'disable'});const isolatedRepo=new PostgresBrowserSessionRepository(isolatedDb);const fast=custody(29_000,isolatedRepo),slow=custody(-20_000,isolatedRepo);
 try{
  await withAdmin(isolated.adminUrl,async c=>{
   await registeringAdmin(c).grant({tenantId:A,sub:A+'-person',roles:['reader'],by:'review-fixture',reason:'synthetic populated migration review'});
   const aboveClocks=revertAbove('browser_session_clocks');expect(await migrateDown(c, aboveClocks.steps)).toEqual(aboveClocks.reverted); // this test is about 0027 as its own owner: the later (empty) migrations are out of the way
   await c.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='m51_clock_review_owner') THEN CREATE ROLE m51_clock_review_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
   await c.query('GRANT USAGE,CREATE ON SCHEMA public TO m51_clock_review_owner');
   await c.query('ALTER TABLE browser_sessions OWNER TO m51_clock_review_owner');await c.query('ALTER TABLE schema_migrations OWNER TO m51_clock_review_owner');
  });
  const made=await fast.create(input(A,29_000));const otherMade=await slow.create(input(A,-20_000));
  await withAdmin(isolated.adminUrl,async c=>{
   await c.query('SET ROLE m51_clock_review_owner');
   try{
    expect((await c.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    expect(await migrateDown(c, 1, through0027)).toEqual(['0027']);expect(await migrateUp(c, through0027)).toEqual(['0027']);
   }finally{await c.query('RESET ROLE');}
  });
  expect(Boolean(await fast.read(made.cookie))).toBe(true);expect(Boolean(await slow.read(otherMade.cookie))).toBe(true);
  expect(await fast.revoke(made.cookie)).toBe(true);
  await withAdmin(isolated.adminUrl,async c=>{
   await c.query('SET ROLE m51_clock_review_owner');
   try{await expect(migrateDown(c, 1, through0027)).rejects.toThrow(/Migration 0027 failed and was rolled back/);}finally{await c.query('RESET ROLE');}
   expect((await c.query('SELECT count(*)::int AS n FROM browser_sessions WHERE tenant_id=$1',[A])).rows[0].n).toBe(2);
   expect((await c.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='browser_sessions'::regclass AND conname='browser_sessions_revoked_at_bound'")).rows[0].def).toContain('isfinite');
   expect((await c.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0].version).toBe('0027');
  });
  expect(Boolean(await slow.read(otherMade.cookie))).toBe(true);expect(Boolean(await fast.read(made.cookie))).toBe(false);
 }finally{await isolatedDb.onModuleDestroy();await isolated.drop();}
});
