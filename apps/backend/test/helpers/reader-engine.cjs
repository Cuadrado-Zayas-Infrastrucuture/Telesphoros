/* eslint-disable @typescript-eslint/no-require-imports -- Jest loads jest.config.js and this file as plain CommonJS; they are not transformed. */
/* global require, module, process, __dirname */
// Is the imported report-reader engine in this checkout? The engine, its development fixtures and the Python sidecar are kept out of the
// public repository (docs/status/2026-10-23-reader-engine-optional.md), so the specs that need them are skipped when they are absent.
// The paths mirror DEFAULT_ENGINE_DIR and DEFAULT_CLI_PATH in src/services/report-reader/subprocess-report-reader.ts; reader-engine.spec.ts
// fails if the two ever differ.
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '../../../..');
const ENGINE_DIR = resolve(REPO_ROOT, 'knowledge/lab-report-reader/v2-handoff/engine');
const FIXTURES_DIR = resolve(REPO_ROOT, 'knowledge/lab-report-reader/v2-handoff/fixtures');
const CLI_PATH = resolve(REPO_ROOT, 'sidecars/report-reader/reader_cli.py');

/** Specs that cannot run without the engine, measured by running the whole suite with those paths removed. Paths are relative to apps/backend. */
const SPECS_NEEDING_ENGINE = require('./reader-engine-specs.json').specs;

/**
 * READER_ENGINE=absent forces "absent" without removing anything (a quick look at what would be skipped). READER_ENGINE=measure skips
 * nothing even when the files are gone, so that scripts/check-without-reader.sh --measure can see which specs really fail.
 */
function readerEnginePresent() {
  if (process.env.READER_ENGINE === 'absent') return false;
  if (process.env.READER_ENGINE === 'measure') return true;
  return [ENGINE_DIR, FIXTURES_DIR, CLI_PATH].every((path) => existsSync(path));
}

module.exports = { ENGINE_DIR, FIXTURES_DIR, CLI_PATH, SPECS_NEEDING_ENGINE, readerEnginePresent };
