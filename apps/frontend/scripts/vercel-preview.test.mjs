// Guard for the Vercel design preview (plan: docs/design/plans/vercel-frontend-preview.md). The preview hosts only the
// frontend, with placeholder sign-in settings, so it can never reach a real backend. Each rule is proved by breaking an
// in-memory copy of the real files and watching it fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const realConfig = readFileSync(`${root}vercel.json`, 'utf8');
const realScript = readFileSync(`${root}apps/frontend/scripts/build-vercel-preview.sh`, 'utf8');
const REQUIRED = ['VITE_API_BASE_URL', 'VITE_COGNITO_DOMAIN', 'VITE_OIDC_AUTHORITY', 'VITE_OIDC_CLIENT_ID'];

export function findPreviewViolations(configText, scriptText) {
  const errors = [];
  const config = JSON.parse(configText);
  for (const key of ['services', 'functions', 'routes', 'env', 'build', 'crons', 'redirects']) {
    if (key in config) errors.push(`vercel.json: ${key} is outside the frontend-only preview`);
  }
  if (config.buildCommand !== 'bash apps/frontend/scripts/build-vercel-preview.sh') errors.push('vercel.json: buildCommand must run the preview build script');
  if (config.outputDirectory !== 'apps/frontend/dist') errors.push('vercel.json: outputDirectory must be the frontend build');
  const rewrites = config.rewrites ?? [];
  if (rewrites.length !== 1 || rewrites[0].source !== '/(.*)' || rewrites[0].destination !== '/index.html') errors.push('vercel.json: the only rewrite is the single-page fallback to /index.html');
  const headers = (config.headers ?? []).find(rule => rule.source === '/(.*)')?.headers ?? [];
  if (!headers.some(header => header.key === 'X-Robots-Tag' && /noindex/.test(header.value))) errors.push('vercel.json: every response must carry X-Robots-Tag noindex');

  if (!/compgen -e[\s\S]*VITE_\*\) unset/.test(scriptText)) errors.push('script: inherited VITE_ settings must be discarded');
  const assigned = [...scriptText.matchAll(/^\s*(VITE_[A-Z0-9_]+)=(\S+)/gm)];
  const names = assigned.map(([, name]) => name).sort();
  if (JSON.stringify(names) !== JSON.stringify(REQUIRED)) errors.push(`script: must set exactly ${REQUIRED.join(', ')}`);
  for (const [, name, value] of assigned) {
    const cleaned = value.replace(/\\$/, '');
    if (/^https?:/.test(cleaned) && !new URL(cleaned).hostname.endsWith('.invalid')) errors.push(`script: ${name} must use a reserved .invalid host`);
  }
  if (!/rm -rf dist\/\.vite/.test(scriptText) || !/-name '\*\.map' -delete/.test(scriptText)) errors.push('script: source maps and the build manifest must not be published');
  return errors;
}

test('the real preview configuration passes', () => {
  assert.deepEqual(findPreviewViolations(realConfig, realScript), []);
});

const configDefects = {
  'adds a backend service': config => ({ ...config, services: { backend: { root: 'apps/backend' } } }),
  'adds environment settings': config => ({ ...config, env: { VITE_API_BASE_URL: 'https://api.telesphoros.app' } }),
  'builds without the script': config => ({ ...config, buildCommand: 'pnpm -F @telesphoros/frontend build' }),
  'publishes another directory': config => ({ ...config, outputDirectory: 'apps/frontend' }),
  'proxies the API elsewhere': config => ({ ...config, rewrites: [{ source: '/api/(.*)', destination: 'https://api.telesphoros.app/api/$1' }, ...config.rewrites] }),
  'drops noindex': config => ({ ...config, headers: [] }),
};
for (const [name, mutate] of Object.entries(configDefects)) {
  test(`refuses a config that ${name}`, () => {
    const mutated = JSON.stringify(mutate(JSON.parse(realConfig)));
    assert.notDeepEqual(findPreviewViolations(mutated, realScript), []);
  });
}

const scriptDefects = {
  'keeps inherited settings': script => script.replace('VITE_*) unset', 'NEVER_*) unset'),
  'points at a real API': script => script.replace('https://api.invalid', 'https://api.telesphoros.app'),
  'points at a real sign-in domain': script => script.replace('https://auth.invalid', 'https://auth.telesphoros.app'),
  'turns on another frontend mode': script => script.replace('VITE_OIDC_CLIENT_ID=design-preview \\', 'VITE_OIDC_CLIENT_ID=design-preview \\\nVITE_LOCAL_STORAGE_INTAKE=true \\'),
  'publishes source maps': script => script.replace("find dist -name '*.map' -delete", ''),
};
for (const [name, mutate] of Object.entries(scriptDefects)) {
  test(`refuses a build script that ${name}`, () => {
    const mutated = mutate(realScript);
    assert.notEqual(mutated, realScript, 'the defect must change the script');
    assert.notDeepEqual(findPreviewViolations(realConfig, mutated), []);
  });
}
