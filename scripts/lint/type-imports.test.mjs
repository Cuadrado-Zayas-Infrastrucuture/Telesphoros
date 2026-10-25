// In a package whose tsconfig turns on emitDecoratorMetadata, consistent-type-imports is safe only with type information: without it the
// rule asks for `import type` on a class that a decorated constructor needs at run time, and its autofix breaks dependency injection.
// This test reads each such package's computed ESLint config for every TypeScript file it lints and fails if the rule is on there
// without the project service. Run by `pnpm test`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const rule = '@typescript-eslint/consistent-type-imports';

/** Packages (apps/*, packages/*) that have an ESLint config and whose tsconfig.json turns on decorator metadata. */
function decoratorPackages() {
  const found = [];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group))) {
      const dir = join(root, group, name), tsconfig = join(dir, 'tsconfig.json');
      if (!existsSync(tsconfig) || !readdirSync(dir).some((f) => /^eslint\.config\.m?js$/.test(f))) continue;
      if (/"emitDecoratorMetadata"\s*:\s*true/.test(readFileSync(tsconfig, 'utf8'))) found.push(dir);
    }
  }
  return found;
}

function typeScriptFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...typeScriptFiles(path));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

async function eslintFor(dir, overrideConfig) {
  const resolved = createRequire(join(dir, 'package.json')).resolve('eslint');
  const { ESLint } = await import(pathToFileURL(resolved).href);
  return new ESLint({ cwd: dir, overrideConfig });
}

const on = (setting) => setting !== undefined && setting !== 'off' && setting !== 0 && !(Array.isArray(setting) && (setting[0] === 'off' || setting[0] === 0));

/** Files in `dir` where the rule is on but the project service is not. Also returns how many files had the rule on (a floor). */
async function unsafeFiles(dir, eslint) {
  const unsafe = [];
  let checked = 0;
  for (const file of typeScriptFiles(dir)) {
    if (await eslint.isPathIgnored(file)) continue;
    const config = await eslint.calculateConfigForFile(file);
    if (!on(config?.rules?.[rule])) continue;
    checked += 1;
    if (config.languageOptions?.parserOptions?.projectService !== true) unsafe.push(relative(root, file));
  }
  return { unsafe, checked };
}

test('every file with decorator metadata that gets consistent-type-imports also gets type information', async () => {
  const packages = decoratorPackages();
  // A floor, so a broken scan cannot pass: today the backend is the one package with decorator metadata.
  assert.ok(packages.some((dir) => relative(root, dir) === join('apps', 'backend')), `found ${packages.map((d) => relative(root, d)).join(', ') || 'none'}`);
  for (const dir of packages) {
    const { unsafe, checked } = await unsafeFiles(dir, await eslintFor(dir));
    assert.deepEqual(unsafe, [], `${relative(root, dir)}: the rule runs without type information here`);
    assert.ok(checked > 100, `${relative(root, dir)}: only ${checked} files had the rule on`);
  }
});

test('a config that drops the type information is reported (control)', async () => {
  const backend = join(root, 'apps', 'backend');
  const eslint = await eslintFor(backend, [{ files: ['src/**/*.ts'], languageOptions: { parserOptions: { projectService: false } } }]);
  const { unsafe } = await unsafeFiles(backend, eslint);
  assert.ok(unsafe.includes(join('apps', 'backend', 'src', 'main.ts')), `reported ${unsafe.length} files`);
  assert.ok(unsafe.every((file) => file.startsWith(join('apps', 'backend', 'src'))), 'only the files the override touched');
});
