import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PINNED_READER } from './pinned-reader';
import { SubprocessReportReader } from './subprocess-report-reader';

// CHECKPOINT (slice 5B-3.2b): the intended reader really runs in the CI jobs that run the pipeline tests, with its dependencies.
// This spec FAILS, it never skips, when Python or the imported engine is missing or is not the pinned build. A green run is therefore
// evidence that the pipeline's reader was the pinned one; it does not say the reader is correct (its own spec and the hand-written
// goldens do that) and it is TEST ONLY like everything under knowledge/lab-report-reader.
const REPO_ROOT = resolve(__dirname, '../../../../..');
const d01 = readFileSync(join(REPO_ROOT, 'knowledge/lab-report-reader/v2-handoff/fixtures/captures/D01/report.txt'), 'utf8');

describe('reader checkpoint', () => {
  it('has Python 3 on the PATH (the sidecar needs it)', () => {
    const out = execFileSync('python3', ['--version'], { encoding: 'utf8' });
    expect(out).toMatch(/^Python 3\.\d+/);
  });

  it('reports exactly the pinned engine bindings, with no mismatch', async () => {
    const reader = new SubprocessReportReader({ mode: 'non-production' });
    expect(await reader.bindings()).toEqual(PINNED_READER);
    expect(await reader.verifyPinned()).toEqual([]);
  }, 30_000);

  it('reads D01 and the packet it returns carries those same bindings', async () => {
    const result = await new SubprocessReportReader({ mode: 'non-production' }).read(d01);
    expect(result.packet.schema).toBe('pgx-span-candidates/3-draft');
    const packet = result.packet as typeof result.packet & typeof PINNED_READER;
    expect({
      generatorVersion: packet.generatorVersion,
      generatorCodeHash: packet.generatorCodeHash,
      grammarHash: packet.grammarHash,
      offsetContractHash: packet.offsetContractHash,
      fieldBoundaryPolicyHash: packet.fieldBoundaryPolicyHash,
    }).toEqual(PINNED_READER);
    expect(result.projection.status).toBe('projected');
  }, 30_000);
});
