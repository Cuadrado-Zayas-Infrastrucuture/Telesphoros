import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertReaderEnginePresent, missingReaderEngineFiles } from './engine-presence';
import { DEFAULT_CLI_PATH, DEFAULT_ENGINE_DIR } from './subprocess-report-reader';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const helper = require('../../../test/helpers/reader-engine.cjs') as {
  ENGINE_DIR: string; FIXTURES_DIR: string; CLI_PATH: string; SPECS_NEEDING_ENGINE: string[]; readerEnginePresent: () => boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const list = require('../../../test/helpers/reader-engine-specs.json') as { specs: string[]; partialSkip: Record<string, string> };

const BACKEND = resolve(__dirname, '../../..');

/**
 * The reader engine is optional (it is not in the public repository). This file is the guard: it runs with or without the engine, and
 * fails when the list of specs that are skipped without it drifts from the code. The measurement behind the list is
 * scripts/check-without-reader.sh, which removes the engine and runs the whole suite.
 */
describe('the skip list for a checkout without the reader engine', () => {
  it('uses the same paths as the code that runs the engine', () => {
    expect(helper.ENGINE_DIR).toBe(DEFAULT_ENGINE_DIR);
    expect(helper.CLI_PATH).toBe(DEFAULT_CLI_PATH);
  });

  it('names only spec files that exist, once each, in sorted order', () => {
    expect(list.specs.length).toBeGreaterThan(0);
    expect(new Set(list.specs).size).toBe(list.specs.length);
    expect([...list.specs].sort()).toEqual(list.specs);
    for (const spec of list.specs) expect({ spec, exists: existsSync(join(BACKEND, spec)) }).toEqual({ spec, exists: true });
    for (const spec of Object.keys(list.partialSkip)) expect(list.specs).toContain(spec);
  });

  it('is not skipped by this very file', () => {
    expect(list.specs).not.toContain('src/services/report-reader/reader-engine.spec.ts');
  });

  // A spec that names the engine's paths or its fixture helpers, and is not on the list, would pass here and fail in a checkout without
  // the engine. The two that remain were measured: they mention the names but do not run the engine.
  const MENTIONS_BUT_NEEDS_NOTHING = new Set([
    'src/config/env.spec.ts', // the name of the LAB_REPORT_FIXTURES_DIR variable only
    'src/services/report-lookup/strict-json.spec.ts', // imports the lookup helper but never starts the engine
    'src/services/report-reader/reader-engine.spec.ts', // this file
    'test/db/application-recovery.pg-spec.ts', // runs on the public synthetic fixtures and the test stand-in reader (the evidence gate needs its metric)
    'test/stand-in-reader.spec.ts', // tests that stand-in and those fixtures
  ]);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === 'node_modules' ? [] : walk(join(dir, entry.name))) : [join(dir, entry.name)]));
  const specFiles = [...walk(join(BACKEND, 'src')), ...walk(join(BACKEND, 'test'))].filter((file) => /\.(spec|e2e-spec|pg-spec|s3-spec)\.ts$/.test(file));

  it('covers every spec that names the engine paths or the fixture helpers', () => {
    const naming = /v2-handoff|reader_cli|DEFAULT_ENGINE_DIR|DEFAULT_CLI_PATH|helpers\/lab-pipeline|helpers\/report-lookup|LAB_REPORT_FIXTURES_DIR/;
    const unlisted = specFiles
      .map((file) => file.slice(BACKEND.length + 1))
      .filter((spec) => naming.test(readFileSync(join(BACKEND, spec), 'utf8')) && !list.specs.includes(spec) && !MENTIONS_BUT_NEEDS_NOTHING.has(spec));
    expect(unlisted).toEqual([]);
  });

  describe('jest.config.js', () => {
    const configFor = (readerEngine: string | undefined) => {
      const previous = process.env.READER_ENGINE;
      const write = process.stderr.write.bind(process.stderr);
      let announced = '';
      process.stderr.write = ((chunk: string | Uint8Array) => { announced += String(chunk); return true; }) as typeof process.stderr.write;
      try {
        if (readerEngine === undefined) delete process.env.READER_ENGINE; else process.env.READER_ENGINE = readerEngine;
        let config!: { testPathIgnorePatterns: string[] };
        jest.isolateModules(() => { config = require('../../../jest.config.js'); }); // eslint-disable-line @typescript-eslint/no-require-imports
        return { patterns: config.testPathIgnorePatterns, announced };
      } finally {
        process.stderr.write = write;
        if (previous === undefined) delete process.env.READER_ENGINE; else process.env.READER_ENGINE = previous;
      }
    };

    it('skips exactly the listed specs, and says so, when the engine is absent', () => {
      const { patterns, announced } = configFor('absent');
      for (const spec of list.specs) expect(patterns.some((p) => new RegExp(p.replace('<rootDir>', BACKEND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).test(join(BACKEND, spec)))).toBe(true);
      expect(announced).toMatch(new RegExp(`ENGINE ABSENT: skipping ${list.specs.length} specs that need the report-reader engine`));
      // CI refuses every "NOT RUNNING" line, so the engine skip must never use that marker (it would fail every tier in a checkout without the engine).
      expect(announced.split('\n').filter((line) => line.includes('report-reader engine') && line.includes('NOT RUNNING'))).toEqual([]);
      const thisFile = join(BACKEND, 'src/services/report-reader/reader-engine.spec.ts');
      expect(patterns.some((p) => new RegExp(p.replace('<rootDir>', BACKEND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).test(thisFile))).toBe(false);
    });

    it('skips none of them while the engine is present', () => {
      if (missingReaderEngineFiles().length > 0 || !existsSync(helper.FIXTURES_DIR)) return; // a checkout without the engine cannot show the present case
      const { patterns, announced } = configFor(undefined);
      expect(patterns.filter((p) => p.startsWith('<rootDir>/'))).toEqual([]);
      expect(announced).not.toMatch(/report-reader engine/);
    });
  });
});

describe('the start check for a pipeline switched on without the reader engine', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'reader-engine-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('names what is missing', () => {
    const paths = { engineDir: join(scratch, 'engine'), cliPath: join(scratch, 'reader_cli.py') };
    expect(missingReaderEngineFiles(paths)).toEqual([paths.engineDir, paths.cliPath]);
    expect(() => assertReaderEnginePresent(paths)).toThrow(/LAB_REPORT_PIPELINE is enabled but the report-reader engine is not in this checkout \(missing: .*engine, .*reader_cli\.py\)/);
  });

  it('passes when both are there (control)', () => {
    const paths = { engineDir: join(scratch, 'present-engine'), cliPath: join(scratch, 'present_cli.py') };
    mkdirSync(paths.engineDir);
    writeFileSync(paths.cliPath, '');
    expect(missingReaderEngineFiles(paths)).toEqual([]);
    expect(() => assertReaderEnginePresent(paths)).not.toThrow();
  });

  it('reports only the one that is gone', () => {
    const paths = { engineDir: join(scratch, 'half-engine'), cliPath: join(scratch, 'half_cli.py') };
    mkdirSync(paths.engineDir);
    expect(missingReaderEngineFiles(paths)).toEqual([paths.cliPath]);
  });
});
