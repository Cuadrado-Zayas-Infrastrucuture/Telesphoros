import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./web.tf', import.meta.url), 'utf8');
const routing = readFileSync(new URL('./web-routing.js.tftpl', import.meta.url), 'utf8');
const code = (text) => text.replace(/^\s*#.*$/gm, '').replace(/[ \t]+/g, ' ');
const has = (text, fragment) => assert.ok(code(text).includes(code(fragment)), fragment);
function block(text, name) {
  const index = text.indexOf(name);
  assert.ok(index >= 0, `missing ${name}`);
  const start = text.indexOf('{', index);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  assert.fail(`unclosed ${name}`);
}

// Scoped to real blocks rather than a comment or another resource carrying the same setting.
test('web hosting is opt-in and every web resource/data block is gated', () => {
  has(block(source, 'variable "enable_web_hosting"'), 'default = false');
  has(source, 'web_count = var.enable_web_hosting ? 1 : 0');
  for (const match of source.matchAll(/(?:resource|data) "[^"]+" "web"/g)) {
    has(block(source, match[0]), 'count = local.web_count');
  }
  assert.ok([...source.matchAll(/(?:resource|data) "[^"]+" "web"/g)].length >= 10);
});

test('web bucket is private, versioned, encrypted and cannot be force emptied', () => {
  has(block(source, 'resource "aws_s3_bucket" "web"'), 'force_destroy = false');
  const access = block(source, 'resource "aws_s3_bucket_public_access_block" "web"');
  for (const flag of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) has(access, `${flag} = true`);
  has(block(source, 'resource "aws_s3_bucket_ownership_controls" "web"'), 'object_ownership = "BucketOwnerEnforced"');
  has(block(source, 'resource "aws_s3_bucket_versioning" "web"'), 'status = "Enabled"');
  has(block(source, 'resource "aws_s3_bucket_server_side_encryption_configuration" "web"'), 'sse_algorithm = "AES256"');
});

test('CloudFront reads only this bucket through signed OAC and a distribution-bound policy', () => {
  const oac = block(source, 'resource "aws_cloudfront_origin_access_control" "web"');
  has(oac, 'signing_behavior = "always"');
  has(oac, 'signing_protocol = "sigv4"');
  const policy = block(source, 'data "aws_iam_policy_document" "web"');
  has(policy, 'actions = ["s3:GetObject"]');
  has(policy, 'resources = ["${aws_s3_bucket.web[0].arn}/*"]');
  has(policy, 'identifiers = ["cloudfront.amazonaws.com"]');
  has(policy, 'variable = "AWS:SourceArn"');
  has(policy, 'values = [aws_cloudfront_distribution.web[0].arn]');
  has(policy, 'variable = "aws:SecureTransport"');
  has(policy, 'effect = "Deny"');
  const distribution = block(source, 'resource "aws_cloudfront_distribution" "web"');
  has(distribution, 'domain_name = aws_s3_bucket.web[0].bucket_regional_domain_name');
  has(distribution, 'origin_access_control_id = aws_cloudfront_origin_access_control.web[0].id');
});

test('certificate uses us-east-1; viewers require HTTPS/TLS 1.2; shell is not cached', () => {
  const provider = block(source, 'provider "aws"');
  has(provider, 'alias = "web_certificate"');
  has(provider, 'region = "us-east-1"');
  has(block(source, 'resource "aws_acm_certificate" "web"'), 'provider = aws.web_certificate');
  const distribution = block(source, 'resource "aws_cloudfront_distribution" "web"');
  has(distribution, 'acm_certificate_arn = aws_acm_certificate_validation.web[0].certificate_arn');
  has(distribution, 'viewer_protocol_policy = "redirect-to-https"');
  has(distribution, 'minimum_protocol_version = "TLSv1.2_2021"');
  has(distribution, 'allowed_methods = ["GET", "HEAD"]');
  has(distribution, 'cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"');
  assert.ok(!code(distribution).includes('custom_error_response'), 'do not disguise origin or missing-asset failures');
  has(distribution, 'event_type = "viewer-request"');
});

// Only the hashed build output is cached at the edge. The shell (index.html, the auth callback, every route) stays on CachingDisabled, and the
// cached behaviour trusts the origin's Cache-Control, so the publish script is checked too.
test('only /assets/* is cached at the edge; everything else is never cached', () => {
  const distribution = block(source, 'resource "aws_cloudfront_distribution" "web"');
  const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
  // Read from the staging account on 2026-10-31 (`aws cloudfront list-cache-policies --type managed`: Managed-CachingOptimized), not from documentation or memory.
  const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
  const fallback = code(block(distribution, 'default_cache_behavior'));
  assert.ok(fallback.includes(`cache_policy_id = "${CACHING_DISABLED}"`), 'the default behaviour (the shell) must stay on CachingDisabled');
  assert.ok(!fallback.includes(CACHING_OPTIMIZED), 'the default behaviour must never use the caching policy');
  assert.equal([...code(distribution).matchAll(/ordered_cache_behavior \{/g)].length, 1, 'exactly one path is cached');
  const assets = code(block(distribution, 'ordered_cache_behavior'));
  assert.ok(assets.includes('path_pattern = "/assets/*"'), 'the cached path is exactly /assets/*');
  assert.ok(assets.includes(`cache_policy_id = "${CACHING_OPTIMIZED}"`));
  assert.ok(assets.includes('compress = true'));
  assert.ok(assets.includes('allowed_methods = ["GET", "HEAD"]') && assets.includes('cached_methods = ["GET", "HEAD"]'), 'read-only methods only');
  assert.ok(assets.includes('viewer_protocol_policy = "redirect-to-https"'));
  assert.ok(assets.includes('response_headers_policy_id = aws_cloudfront_response_headers_policy.web[0].id'), 'the same security headers as every other path');
  assert.ok(assets.includes('function_arn = aws_cloudfront_function.web[0].arn'), 'the host redirects apply to assets too');
  const publish = readFileSync(new URL('../../scripts/staging/publish-frontend.sh', import.meta.url), 'utf8');
  assert.ok(/s3 sync "\$stage\/assets" "s3:\/\/\$WEB_BUCKET\/assets" --cache-control "public,max-age=31536000,immutable"/.test(publish), '/assets is uploaded as immutable');
  assert.ok(/--exclude "assets\/\*" --exclude "index\.html" --cache-control "no-cache"/.test(publish) && /index\.html" --cache-control "no-cache"/.test(publish), 'everything else is uploaded no-cache');
});

// The first attempt to apply this change failed with NoSuchCachePolicy: the id in web.tf, the plan check and their tests had been copied from memory with the
// last two blocks transposed, and every test agreed with the typo, so none could notice. The id is pinned above from the account; this keeps the typo out.
test('the cache policy id that does not exist in the account appears nowhere in the Terraform, the plan check or their tests', () => {
  const wrong = ['658327ea', 'f89d', '4fab', 'a63d', '7e88639e058f'].join('-');
  const here = new URL('./', import.meta.url);
  const staging = new URL('../../scripts/staging/', import.meta.url);
  const files = [
    ...readdirSync(here).filter((name) => /\.(tf|hcl|mjs|tftpl)$/.test(name)).map((name) => new URL(name, here)),
    ...readdirSync(staging).filter((name) => /\.(mjs|sh)$/.test(name)).map((name) => new URL(name, staging)),
  ];
  assert.ok(files.length > 20, 'the scan found the files');
  const found = files.filter((file) => readFileSync(file, 'utf8').includes(wrong)).map((file) => file.pathname.split('/').pop());
  assert.deepEqual(found, [], `the id is a typo of the managed CachingOptimized policy: ${found.join(', ')}`);
});

test('headers forbid inline scripts, framing and referrer leaks; HSTS preload stays off', () => {
  const headers = block(source, 'resource "aws_cloudfront_response_headers_policy" "web"');
  has(headers, "script-src 'self';");
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(headers));
  has(headers, "style-src 'self';");
  assert.ok(!/style-src[^;]*unsafe-inline/.test(headers), 'style-src must not allow unsafe-inline');
  has(headers, "frame-ancestors 'none'");
  has(headers, 'referrer_policy = "no-referrer"');
  has(headers, 'preload = false');
  has(headers, 'include_subdomains = false');
  assert.match(headers, /^\s*access_control_max_age_sec = 31536000$/m, 'HSTS must last one year (31536000 seconds)');
  has(headers, 'override = true');
  has(headers, 'camera=(), microphone=(), geolocation=()');
  const connect = block(source, 'locals');
  assert.ok(!connect.includes('https://*'));
  has(connect, '"https://${aws_s3_bucket.reports.bucket_regional_domain_name}"');
});

test('enablement requires the exact existing auth paths and upload origin', () => {
  has(source, 'contains(var.app_callback_urls, "https://${local.web_app}/auth/callback")');
  has(source, 'contains(var.app_logout_urls, "https://${local.web_app}/signed-out")');
  has(source, 'contains(var.reports_cors_origins, "https://${local.web_app}")');
});

const functionCode = routing.replace('${app_host_json}', '"app.example.test"').replace('${redirect_hosts_json}', '["example.test", "www.example.test"]');
function call(host, uri, querystring = {}, method = 'GET') {
  const event = { request: { headers: { host: { value: host } }, uri, querystring, method } };
  return runInNewContext(`${functionCode}\nhandler(event)`, { event }, { timeout: 100 });
}

test('apex and www redirect to the fixed app host, preserving path and encoded repeated queries', () => {
  for (const host of ['example.test', 'www.example.test', 'WWW.EXAMPLE.TEST']) {
    const result = call(host, '/auth/callback', { code: { value: 'a%2Fb' }, tag: { value: 'one', multiValue: [{ value: 'one' }, { value: 'two' }] }, blank: { value: '' } });
    assert.equal(result.statusCode, 301);
    assert.equal(result.headers.location.value, 'https://app.example.test/auth/callback?code=a%2Fb&tag=one&tag=two&blank=');
    assert.equal(result.headers['cache-control'].value, 'no-store');
  }
  assert.equal(call('example.test', '/').headers.location.value, 'https://app.example.test/');
});

test('browser navigation rewrites to the shell and preserves callback parameters', () => {
  for (const route of ['/', '/signin', '/auth/callback', '/signed-out', '/reports/upload', '/unknown-route']) {
    const request = call('app.example.test', route, { code: { value: 'synthetic-code' } });
    assert.equal(request.uri, '/index.html');
    assert.equal(request.querystring.code.value, 'synthetic-code');
  }
  assert.equal(call('app.example.test', '/signin', {}, 'HEAD').uri, '/index.html');
});

test('assets, API paths, file extensions, other hosts and POST are never rewritten', () => {
  for (const path of ['/assets/missing.js', '/assets/missing', '/api', '/api/v1/reports', '/favicon.ico', '/index.html']) assert.equal(call('app.example.test', path).uri, path);
  assert.equal(call('app.example.test', '/signin', {}, 'POST').uri, '/signin');
  assert.equal(call('unrelated.example.test', '/signin').uri, '/signin');
});
