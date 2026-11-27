import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_ROLES } from '@telesphoros/help-content';
import { ROLES } from '@telesphoros/shared-types';

// Spec 053 slice C2a: Help's search, its patient-question rule and its answer live in packages/help-content (src/engine/), where their tests
// are. These two checks need the frontend's side, so they stay here.
const SRC = resolve(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
const ENGINE = /\b(function|const)\s+(isPatientQuestion|searchHelp|answerFor|articlesFor|helpScreenOf)\b/;

describe("Help's engine, shared with the server (spec 053 C2a)", () => {
  it('knows the same roles as the product', () => {
    expect([...HELP_ROLES].sort()).toEqual([...ROLES].sort());
  });

  it('is defined only in packages/help-content: the frontend re-exports it and never keeps its own copy', () => {
    const copies = files(SRC).filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) && ENGINE.test(readFileSync(path, 'utf8')));
    expect(copies).toEqual([]);
  });
});
