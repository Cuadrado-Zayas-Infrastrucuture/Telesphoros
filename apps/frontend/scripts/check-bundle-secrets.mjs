#!/usr/bin/env node
// Refuses a built frontend that carries something shaped like a credential. The browser can keep no secret: everything in the bundle is public
// (the VITE_* settings are public configuration by design, apps/frontend/.env.example). gitleaks checks the repository's history; this checks the
// files that are about to be published, which a build can fill from places git never sees. Run by scripts/staging/publish-frontend.sh and
// build-vercel-preview.sh on the upload set.
//   node apps/frontend/scripts/check-bundle-secrets.mjs DIR
// Prints the file and the kind of match, never the matched text. Exits 1 on a match, 2 on a usage error.
// Value shapes only: names such as `client_secret` appear in libraries as parameter names and are not secrets.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PATTERNS = [
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI or Stripe secret key', /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{32,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const TEXT = /\.(?:html|js|mjs|cjs|css|json|map|txt|svg|webmanifest|xml)$/i;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (TEXT.test(name)) yield path;
  }
}

/** Every `{ file, kind }` found under DIR, relative to it. */
export function scan(dir) {
  const found = [];
  for (const path of files(dir)) {
    const text = readFileSync(path, 'utf8');
    for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) found.push({ file: relative(dir, path), kind });
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || process.argv.length !== 3 || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write('usage: check-bundle-secrets.mjs DIR (an existing directory)\n');
    process.exit(2);
  }
  const found = scan(dir);
  for (const { file, kind } of found) process.stderr.write(`credential-shaped text in ${file}: ${kind}\n`);
  if (found.length) process.exit(1);
  process.stdout.write(`no credential-shaped text in ${dir}\n`);
}
