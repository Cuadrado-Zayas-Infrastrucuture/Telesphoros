// The founder's clinical-hold switch (audit CLIN-13; docs/ai-safety-and-hallucination-controls.md). What keeps model output off today
// is code: liveReadiness() always answers MODEL_EXECUTION_DISABLED and the only model client is the scripted stand-in (apps/ai-service,
// readiness.test.ts and boundaries.test.ts). PGX_CLINICAL_HOLD_LIFTED is read by nothing until a real model client arrives with the
// adapter that turns exactly 'true' into readiness()'s founderFlagSet. These checks keep the two together: code that reads the switch
// anywhere else, or a model client added without updating this file, turns CI red.
// Heuristic, not proof: it sees the switch's name written in source, not a name built at run time.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SWITCH = 'PGX_CLINICAL_HOLD_LIFTED';
/** Where code may read the switch. Empty until the real model client: its adapter is added here, with a test that only 'true' counts. */
export const READERS = [];
/** The model clients that exist. A new one is the change that must also add the adapter above (FR-012, spec 003). */
export const MODEL_CLIENTS = ['port.ts', 'scripted.ts'];
const CODE = /\.(ts|tsx|js|jsx|cjs|mjs|py|sh)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.vite']);
const THIS_FILE = '.github/ci/clinical-hold.test.mjs';

/** Code files under the given folders of `root` whose text names the switch, as paths relative to `root`. */
export function readersOf(root, folders = ['apps', 'packages', 'scripts', 'infrastructure', '.github']) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (CODE.test(entry.name) && readFileSync(path, 'utf8').includes(SWITCH)) found.push(relative(root, path));
    }
  };
  for (const folder of folders) walk(join(root, folder));
  return found.filter((p) => p !== THIS_FILE).sort();
}

const ROOTS = [];
after(() => ROOTS.forEach((r) => rmSync(r, { recursive: true, force: true })));

test('no code reads the clinical-hold switch except the adapter named here (today: none)', () => {
  assert.deepEqual(readersOf(ROOT), [...READERS].sort());
});

test('the model clients are the port and the scripted stand-in only', () => {
  const dir = join(ROOT, 'apps/ai-service/src/model-clients');
  assert.deepEqual(readdirSync(dir).sort(), [...MODEL_CLIENTS].sort());
});

test('controls: the scan finds a reader in any code folder and ignores documentation and examples', () => {
  const root = mkdtempSync(join(tmpdir(), 'clinical-hold-'));
  ROOTS.push(root);
  const put = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('apps/backend/src/config/env.ts', `const lifted = process.env.${SWITCH} === 'true';\n`);
  put('packages/x/src/a.mjs', `export const name = '${SWITCH}';\n`);
  put('apps/backend/node_modules/dep/index.js', `process.env.${SWITCH}`);
  put('apps/backend/README.md', `${SWITCH} is documented here.\n`);
  put('.env.example', `${SWITCH}=false\n`);
  assert.deepEqual(readersOf(root), ['apps/backend/src/config/env.ts', 'packages/x/src/a.mjs']);
});
