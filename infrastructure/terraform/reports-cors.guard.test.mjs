// A source/config parity guard, not proof of an applied AWS policy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { reportsCorsRule, reportsCorsXml } from '../../scripts/local-storage/cors.cjs';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const storage = read('./storage.tf');
const contract = JSON.parse(read('./reports-cors.json'));
const expected = { allowed_methods: ['GET'], allowed_headers: ['Content-Type'], expose_headers: ['ETag'], max_age_seconds: 300 };
function check(source) {
  source = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  const block = source.match(/resource "aws_s3_bucket_cors_configuration" "reports"\s*{[\s\S]*?\n}/)?.[0];
  assert.ok(block, 'reports CORS resource required');
  assert.match(source, /reports_cors\s*=\s*jsondecode\(file\("\$\{path.module\}\/reports-cors.json"\)\)/);
  for (const field of Object.keys(expected)) assert.match(block, new RegExp(`${field}\\s*=\\s*local.reports_cors.${field}\\s*\\n`));
  assert.match(block, /allowed_origins\s*=\s*var.reports_cors_origins\s*\n/);
  assert.equal((block.match(/cors_rule\s*{/g) ?? []).length, 1);
}
test('the sole reports CORS rule consumes the shared GET-only contract and explicit deployment origins', () => {
  assert.deepEqual(contract, expected); check(storage);
});
test('drifting Terraform away from the contract or adding a wildcard origin is detected', () => {
  for (const broken of [storage.replace('local.reports_cors.allowed_methods', '["PUT"]'), storage.replace('var.reports_cors_origins', '["*"]'), storage.replace('reports-cors.json', 'other.json')]) assert.throws(() => check(broken));
});
test('all three fixtures and launchers consume that contract without permissive method/header copies', () => {
  const fixture = read('../../apps/frontend/scripts/upload-storage-fixture.mjs');
  const runtime = read('../../scripts/local-storage/runtime.cjs');
  const review = read('../../scripts/local-review/start.cjs');
  assert.match(fixture, /reportsCorsXml\('http:\/\/127\.0\.0\.1:4173'\)/);
  assert.match(runtime, /CORSRules:\s*\[reportsCorsRule\(/);
  assert.match(review, /CORSRules:\s*\[reportsCorsRule\(APP\)\]/);
  assert.doesNotMatch(fixture, /<AllowedMethod>|<AllowedHeader>/);
  assert.doesNotMatch(runtime, /AllowedMethods:|AllowedHeaders:/);
  assert.doesNotMatch(review, /AllowedMethods:|AllowedHeaders:/);
  const origin = 'http://127.0.0.1:4173';
  assert.deepEqual(reportsCorsRule(origin), { AllowedOrigins: [origin], AllowedMethods: ['GET'], AllowedHeaders: ['Content-Type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 300 });
  assert.equal(reportsCorsXml(origin), '<CORSConfiguration><CORSRule><AllowedOrigin>http://127.0.0.1:4173</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedHeader>Content-Type</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule></CORSConfiguration>');
});
test('local fixtures reject remote, wildcard and non-origin values', () => {
  for (const origin of ['https://example.test', 'http://*', 'http://127.0.0.1:4173/', 'http://127.0.0.1:4173/path', 'http://user@127.0.0.1:4173', 'http://127.0.0.1:4173?x=1']) assert.throws(() => reportsCorsRule(origin));
});
test('deployment origins reject broad or non-origin values', () => {
  const source = read('./variables.tf').match(/variable "reports_cors_origins"\s*{[\s\S]*?\n}/)[0];
  assert.match(source, /length\(var.reports_cors_origins\) >= 1/);
  const pattern = source.match(/can\(regex\("([^"]+)", o\)\)/)[1];
  assert.equal(new RegExp(pattern).test('https://app.example.test'), true);
  assert.equal(new RegExp(pattern).test('https://staging.example.test:8443'), true);
  for (const origin of ['http://app.example.test', 'https://*', 'https://*.example.test', 'https://app.example.test/', 'https://user@app.example.test', 'https://app.example.test?q=1', 'https://app.example.test#x']) assert.equal(new RegExp(pattern).test(origin), false, origin);
});

// Keep explicit SDK and XML expectations independent of the shared policy JSON.
for (const origin of ['http://127.0.0.1:4173', 'http://127.0.0.1:8080', 'http://127.0.0.1:65535']) {
  test(`canonical fixture origin ${origin} preserves the GET-only SDK and XML policies`, () => {
    assert.deepEqual(reportsCorsRule(origin), {
      AllowedOrigins: [origin],
      AllowedMethods: ['GET'],
      AllowedHeaders: ['Content-Type'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 300,
    });
    assert.equal(reportsCorsXml(origin), '<CORSConfiguration><CORSRule><AllowedOrigin>' + origin + '</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedHeader>Content-Type</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule></CORSConfiguration>');
  });
}

for (const origin of [
  'http://127.1:4173',
  'http://2130706433:4173',
  'http://0x7f000001:4173',
  'http://127.000.000.001:4173',
  'http://127.0.0.1:04173',
  'http://127.0.0.1:4173\n',
  'http://127.0.0.1:4173?',
  'http://127.0.0.1:4173#',
  'http://127.0.0.1:4173/',
  'http://synthetic:synthetic@127.0.0.1:4173',
  'http://127.0.0.1:4173@evil.invalid',
  'http://127.0.0.1.evil.invalid:4173',
  'http://127.0.0.1:4173/\\evil.invalid',
  'http://127.0.0.1%3A4173@evil.invalid',
  'http://localhost:4173',
  'http://[::1]:4173',
  'https://127.0.0.1:4173',
  'null',
  '*',
  'http://127.0.0.1:65536',
  'http://127.0.0.1:4173\r\nx:y',
]) {
  test(`reject adversarial fixture origin ${JSON.stringify(origin)} in both serializers`, () => {
    assert.throws(() => reportsCorsRule(origin));
    assert.throws(() => reportsCorsXml(origin));
  });
}

test('callers cannot widen later policies by mutating returned arrays', () => {
  const first = reportsCorsRule('http://127.0.0.1:4173');
  first.AllowedOrigins.push('*');
  first.AllowedMethods.push('PUT');
  first.AllowedHeaders.push('*');
  first.ExposeHeaders.push('*');
  first.MaxAgeSeconds = 99999;

  assert.deepEqual(reportsCorsRule('http://127.0.0.1:4173'), {
    AllowedOrigins: ['http://127.0.0.1:4173'],
    AllowedMethods: ['GET'],
    AllowedHeaders: ['Content-Type'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 300,
  });
});
