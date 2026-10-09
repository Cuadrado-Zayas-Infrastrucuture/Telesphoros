const {test}=require('node:test');const assert=require('node:assert/strict');const {readFile}=require('node:fs/promises');
const {LocalPopplerRunner}=require('./local-poppler-runner.cjs');
const {UnsupportedSourceError,RunnerMisconfiguredError}=require('../../apps/backend/dist/lab-reports/runner/text-capture-runner');
const fixture=require('node:path').resolve(__dirname,'../..')+'/knowledge/lab-report-reader/v2-handoff/fixtures/captures/D01/';
test('real pinned Poppler reproduces the independently stored D01 text exactly',async()=>{const r=await LocalPopplerRunner.open();const result=await r.capture(await readFile(fixture+'source.pdf'));assert.equal(result.text,await readFile(fixture+'report.txt','utf8'));assert.equal(r.name,'poppler');assert.match(r.manifestSha256,/^[a-f0-9]{64}$/);});
test('unknown PDF and invalid magic are refused',async()=>{const r=await LocalPopplerRunner.open();await assert.rejects(r.capture(Buffer.from('%PDF- unknown')),UnsupportedSourceError);await assert.rejects(r.capture(Buffer.from('not PDF')),UnsupportedSourceError);});
test('oversized source is refused',async()=>{const r=await LocalPopplerRunner.open();const huge=Buffer.alloc(10485761);huge.write('%PDF-');await assert.rejects(r.capture(huge),UnsupportedSourceError);});
test('missing installation refuses startup',async()=>{await assert.rejects(LocalPopplerRunner.open('/nonexistent/pdftotext'),RunnerMisconfiguredError);});
test('extractor build drift is refused',async()=>{const r=await LocalPopplerRunner.open();r.binaryHash='0'.repeat(64);await assert.rejects(r.capture(await readFile(fixture+'source.pdf')),RunnerMisconfiguredError);});

test('wrong extractor version refuses startup',async()=>{await assert.rejects(LocalPopplerRunner.open('/bin/echo'),RunnerMisconfiguredError);});
