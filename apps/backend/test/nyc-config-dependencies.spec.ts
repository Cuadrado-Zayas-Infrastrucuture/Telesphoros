import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';

type Manifest = { name: string; dependencies?: Record<string, string> };

function dependency(from: ReturnType<typeof createRequire>, name: string) {
  const entry = from.resolve(name);
  let directory = dirname(entry);
  while (directory !== parse(directory).root) {
    try {
      const file = join(directory, 'package.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      if (manifest.name === name) return { entry, file, manifest, from: createRequire(file) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
  throw new Error(`No package manifest for ${name}`);
}

// Follow the real Jest instrumentation caller using Node's resolver, not a
// hand-written pnpm store path or Jest's application module aliases.
let caller = createRequire(__filename);
for (const name of ['jest', '@jest/core', '@jest/transform', 'babel-plugin-istanbul']) {
  caller = dependency(caller, name).from;
}
const loader = dependency(caller, '@istanbuljs/load-nyc-config');
const { loadNycConfig, isLoading } = loader.from(loader.entry) as {
  loadNycConfig: (options: { cwd: string; nycrcPath?: string }) => Promise<Record<string, unknown>>;
  isLoading: () => boolean;
};

describe('the Jest coverage configuration dependency boundary', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'telesphoros-nyc-config-'));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, nyc: { extension: '.ts' } }));
  });
  // Only the fresh synthetic directory owned by this test is removed.
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('has no sprintf-js package anywhere in the installed loader dependency closure', () => {
    const seen = new Set<string>();
    const names: string[] = [];
    function visit(pkg: ReturnType<typeof dependency>) {
      if (seen.has(pkg.file)) return;
      seen.add(pkg.file);
      names.push(pkg.manifest.name);
      for (const name of Object.keys(pkg.manifest.dependencies ?? {})) visit(dependency(pkg.from, name));
    }
    visit(loader);
    expect(names).toContain('@istanbuljs/load-nyc-config');
    expect(names).toContain('js-yaml');
    expect(names).not.toContain('sprintf-js');
  });

  it('loads YAML aliases, inherited configuration and package defaults through the actual caller', async () => {
    writeFileSync(join(cwd, 'base.yaml'), 'reporter: [text, lcov]\ncheck-coverage: true\nbranches: 91\n');
    writeFileSync(join(cwd, '.nycrc.yaml'), [
      'extends: ./base.yaml',
      'all: true',
      'include: ["src/**/*.ts"]',
      'exclude: &excluded ["**/*.spec.ts"]',
      'labels: *excluded',
      'require: ./instrument.cjs',
      '',
    ].join('\n'));
    expect(await loadNycConfig({ cwd })).toEqual({
      cwd, extension: ['.ts'], all: true, include: ['src/**/*.ts'],
      exclude: ['**/*.spec.ts'], labels: ['**/*.spec.ts'], require: ['./instrument.cjs'],
      reporter: ['text', 'lcov'], checkCoverage: true, branches: 91,
    });
    expect(isLoading()).toBe(false);
  });

  it.each([
    ['malformed YAML', 'include: [unterminated\n'],
    ['duplicate keys', 'all: true\nall: false\n'],
  ])('refuses %s and clears the loading state', async (_name, yaml) => {
    writeFileSync(join(cwd, '.nycrc.yaml'), yaml);
    await expect(loadNycConfig({ cwd })).rejects.toThrow();
    expect(isLoading()).toBe(false);
  });

  it('refuses missing and circular configuration instead of silently dropping coverage settings', async () => {
    await expect(loadNycConfig({ cwd, nycrcPath: 'absent.yaml' })).rejects.toThrow(/not found/);
    writeFileSync(join(cwd, '.nycrc.yaml'), 'extends: ./loop.yaml\n');
    writeFileSync(join(cwd, 'loop.yaml'), 'extends: ./.nycrc.yaml\n');
    await expect(loadNycConfig({ cwd })).rejects.toThrow(/Circular/);
    expect(isLoading()).toBe(false);
  });
});
