// Live local API + S3-protocol refusal checks. Never invokes an AWS endpoint.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const root=path.resolve(__dirname,'../..');
for (const name of Object.keys(process.env)) if (name.startsWith('AWS_')) delete process.env[name];
const req = createRequire(path.join(root, 'apps/backend/package.json'));
const { startFakeIdp, DEFAULT_USERS } = require('../../packages/fake-idp/dist/index.cjs');

(async () => {
  const idp = await startFakeIdp({ port: 0 });
  let app;
  try {
    req('reflect-metadata');
    const { NestFactory } = req('@nestjs/core');
    const { AppModule } = require('../../apps/backend/dist/app.module');
    const { configureApp } = require('../../apps/backend/dist/app.factory');
    const { loadEnv } = require('../../apps/backend/dist/config/env');
    // Credentials below are dummy emulator identifiers, never actual AWS credentials.
    process.env.AWS_ACCESS_KEY_ID = 'local-emulator'; process.env.AWS_SECRET_ACCESS_KEY = 'local-emulator';
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_VERIFIER: 'cognito', COGNITO_APP_CLIENT_ID: 'fake-client-id', COGNITO_ISSUER: idp.issuer, COGNITO_JWKS_URI: `${idp.issuer}/.well-known/jwks.json`, STORAGE_DRIVER:'postgres', DATABASE_URL:'postgresql://demo_app@127.0.0.1:'+(process.env.LOCAL_REVIEW_PG_PORT||'54359')+'/synthetic_review', LEDGER_VERIFIER_DATABASE_URL:'postgresql://demo_verifier@127.0.0.1:'+(process.env.LOCAL_REVIEW_PG_PORT||'54359')+'/synthetic_review', LAB_REPORT_PIPELINE:'enabled', LAB_REPORT_FIXTURES_DIR:path.join(root,'knowledge/lab-report-reader/v2-handoff/fixtures/captures'), KNOWLEDGE_DIR:path.join(root,'data/fixtures/knowledge/test-only-reader'), BUILD_VERSION:'local-review-test-1', OBJECT_STORAGE_DRIVER: 's3', S3_ENDPOINT: 'http://127.0.0.1:'+(process.env.LOCAL_REVIEW_MOTO_PORT||'5555'), S3_FORCE_PATH_STYLE: 'true', REPORTS_BUCKET: 'telesphoros-local-demo' });
    const { Test }=req('@nestjs/testing');const {TextCaptureRunner}=require('../../apps/backend/dist/lab-reports/runner/text-capture-runner');const {LocalPopplerRunner}=require('./local-poppler-runner.cjs');const moduleRef=await Test.createTestingModule({imports:[AppModule.register(env)]}).overrideProvider(TextCaptureRunner).useValue(await LocalPopplerRunner.open()).compile();app=moduleRef.createNestApplication({logger:false});
    configureApp(app); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const token = await idp.mintAccessToken();
    const reader = await idp.mintAccessToken({ user: DEFAULT_USERS[1] });
    const call = (p, body, auth = token, method = 'POST') => fetch(`${origin}/api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    const hal=await idp.mintAccessToken({user:DEFAULT_USERS[7]});
    const gina=await idp.mintAccessToken({user:DEFAULT_USERS[6]});
    const pr=await call('/patients',{label:'SYN-REVIEW-'+Date.now()},hal);assert.equal(pr.status,201);const patient=await pr.json();
    const bytes=readFileSync(path.join(root,'knowledge/lab-report-reader/v2-handoff/fixtures/captures/D01/source.pdf'));
    const sha=createHash('sha256').update(bytes).digest('hex');
    const cr=await call('/reports',{patientId:patient.id,type:'lab-pdf',filename:'source.pdf',sizeBytes:bytes.length},hal);assert.equal(cr.status,201);const report=await cr.json();
    const target=await(await call(`/reports/${report.id}/upload-url`,{contentType:'application/pdf',sha256:sha},hal)).json();
    assert.equal(new URL(target.uploadUrl).origin,'http://127.0.0.1:'+(process.env.LOCAL_REVIEW_MOTO_PORT||'5555'));
    assert.equal((await fetch(target.uploadUrl,{method:'PUT',headers:target.headers,body:bytes})).status,200);
    assert.equal((await call(`/reports/${report.id}/complete`,{},hal)).status,200);
    const cap=await call(`/reports/${report.id}/capture`,{},hal);assert.equal(cap.status,201);const capture=await cap.json();assert.equal(capture.runner,'poppler');
    assert.equal((await call(`/captures/${capture.id}/decision`,{decision:'accepted'},hal)).status,409);console.log('PASS same actor refused');
    const reject=await(await call(`/captures/${capture.id}/decision`,{decision:'rejected'},gina)).json();
    assert.equal((await call(`/reports/${report.id}/evaluations`,{captureId:capture.id,acceptanceId:reject.id},hal)).status,409);console.log('PASS rejected capture refused');
    const ac=await call(`/captures/${capture.id}/decision`,{decision:'accepted'},gina);assert.equal(ac.status,201);const accept=await ac.json();
    const er=await call(`/reports/${report.id}/evaluations`,{captureId:capture.id,acceptanceId:accept.id},hal);assert.equal(er.status,201);const e=await er.json();
    const expected=JSON.parse(readFileSync(path.join(root,'tests/report_adapter/golden.json'),'utf8')).cases.find(c=>c.id==='D01');assert.equal(e.disposition,expected.disposition);for(const result of e.results){const want=expected.engine[result.drug];assert.deepEqual({outcome:result.outcome,strength:result.strength,recommendationText:result.recommendationText},want);}
    assert.equal(e.scope,'synthetic-test-only/1');assert.equal(e.clinicalUse,'not-approved');assert.equal(e.actionable,false);
    assert.equal((await call(`/captures/${capture.id}`,undefined,reader,'GET')).status,404);
    const correctionPath='/evaluations/'+e.id+'/corrections';
    assert.equal((await call(correctionPath,{kind:'retraction',reasonCode:'software-defect'},token)).status,403);
    const retract=await call(correctionPath,{kind:'retraction',reasonCode:'software-defect'},gina);assert.equal(retract.status,201);const retraction=await retract.json();
    let detail=await(await call('/evaluations/'+e.id,undefined,hal,'GET')).json();assert.equal(detail.state,'retracted');assert.equal(detail.current,false);
    assert.equal((await call(correctionPath,{kind:'retraction',reasonCode:'software-defect'},gina)).status,409);
    assert.equal((await call(correctionPath,{kind:'reinstatement',reasonCode:'retraction-mistaken',previousCorrectionId:retraction.id},gina)).status,409);
    const restore=await call(correctionPath,{kind:'reinstatement',reasonCode:'retraction-mistaken',previousCorrectionId:retraction.id},hal);assert.equal(restore.status,201);const reinstatement=await restore.json();
    detail=await(await call('/evaluations/'+e.id,undefined,hal,'GET')).json();assert.equal(detail.state,'active');
    const renewed=await(await call(`/captures/${capture.id}/decision`,{decision:'accepted'},gina)).json();
    const replacementResponse=await call(`/reports/${report.id}/evaluations`,{captureId:capture.id,acceptanceId:renewed.id},hal);assert.equal(replacementResponse.status,201);const replacement=await replacementResponse.json();
    assert.equal((await call(correctionPath,{kind:'supersession',reasonCode:'software-defect',previousCorrectionId:reinstatement.id,replacementEvaluationId:replacement.id},gina)).status,201);
    detail=await(await call('/evaluations/'+e.id,undefined,hal,'GET')).json();assert.equal(detail.state,'superseded');assert.equal(detail.supersededBy,replacement.id);
    console.log('PASS corrections: role refusal, stale refusal, retraction, reinstatement, supersession');
    const disputeBody={guidelineId:'drugq-cyp2c19',locator:{table:'Synthetic Table Q',row:'Intermediate Metabolizer'},note:'Synthetic test dispute; not clinical evidence.'};
    const raised=await call('/cell-disputes',disputeBody,gina);assert.equal(raised.status,201);const dispute=await raised.json();
    assert.equal((await call('/cell-disputes/'+dispute.id+'/decision',{decision:'dismissed',evidenceNote:'Synthetic test decision.'},gina)).status,409);
    const impact=await(await call('/cell-disputes/'+dispute.id+'/evaluations?limit=50',undefined,hal,'GET')).json();assert.equal(impact.actionable,false);assert.ok(impact.entries.some(x=>x.evaluationId===replacement.id));
    assert.equal((await call('/cell-disputes/'+dispute.id+'/decision',{decision:'dismissed',evidenceNote:'Synthetic test decision.'},hal)).status,201);
    assert.equal((await call('/cell-disputes/'+dispute.id,undefined,reader,'GET')).status,404);
    console.log('PASS dispute: same-actor refusal, independent decision, impact listing, cross-tenant refusal');
    const admin=await idp.mintAccessToken({user:DEFAULT_USERS[2]});const ledgerResponse=await call('/ledger/verify?full=true',undefined,admin,'GET');assert.equal(ledgerResponse.status,200);const ledger=await ledgerResponse.json();assert.equal(ledger.status,'ok');assert.ok(ledger.eventsChecked>0);console.log('PASS full ledger verification');
    console.log('PASS D01 matches pinned hand-written outcome oracle; live synthetic evaluation, non-clinical flags, cross-tenant isolation');
  } finally { if (app) await app.close(); await idp.stop(); }
})().catch(e => { console.error(e.code ?? e.name); console.error('FAIL local upload checks (no token/configuration output)'); process.exitCode = 1; });
