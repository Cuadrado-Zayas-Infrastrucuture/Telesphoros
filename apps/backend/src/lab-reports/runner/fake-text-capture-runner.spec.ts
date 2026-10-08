import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES as DEFAULT_FIXTURES_DIR } from '../../../test/helpers/lab-pipeline';
import { FakeTextCaptureRunner } from './fake-text-capture-runner';
import { RunnerMisconfiguredError, UnsupportedSourceError } from './text-capture-runner';

const ids = Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`);
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function copyOfFixtures(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fixtures-'));
  dirs.push(dir);
  await cp(DEFAULT_FIXTURES_DIR, dir, { recursive: true });
  return dir;
}
const fixturePdf = (id: string, dir = DEFAULT_FIXTURES_DIR) => readFile(join(dir, id, 'source.pdf'));
const fixtureText = (id: string, dir = DEFAULT_FIXTURES_DIR) => readFile(join(dir, id, 'report.txt'), 'utf8');
const misconfigured = async (work: Promise<unknown>) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(RunnerMisconfiguredError);
  return (error as RunnerMisconfiguredError).code;
};

describe('FakeTextCaptureRunner', () => {
  it.each(ids)('%s: the bytes of the recorded PDF return the recorded text and the pinned Poppler version', async (id) => {
    const runner = await FakeTextCaptureRunner.open(DEFAULT_FIXTURES_DIR);
    expect(await runner.capture(await fixturePdf(id))).toEqual({ text: await fixtureText(id), popplerVersion: '26.03.0' });
    expect(runner.name).toBe('fake');
  });

  it('refuses a file it has no recording for (a fact about the file), including a recorded PDF with one byte changed', async () => {
    const runner = await FakeTextCaptureRunner.open(DEFAULT_FIXTURES_DIR);
    await expect(runner.capture(Buffer.from('%PDF-1.4 something else'))).rejects.toBeInstanceOf(UnsupportedSourceError);
    const changed = Buffer.from(await fixturePdf('D01'));
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
    await expect(runner.capture(changed)).rejects.toBeInstanceOf(UnsupportedSourceError);
    await expect(runner.capture(Buffer.alloc(0))).rejects.toBeInstanceOf(UnsupportedSourceError);
  });

  it('hashes the bytes it is given: there is no way to ask for a recording by claiming a hash', async () => {
    const runner = await FakeTextCaptureRunner.open(DEFAULT_FIXTURES_DIR);
    expect(runner.capture.length).toBe(1); // one parameter: the bytes
  });

  it('has a manifest hash that identifies the recorded set and changes when the set changes', async () => {
    const a = await FakeTextCaptureRunner.open(DEFAULT_FIXTURES_DIR);
    const b = await FakeTextCaptureRunner.open(DEFAULT_FIXTURES_DIR);
    expect(a.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.manifestSha256).toBe(b.manifestSha256);
    const dir = await copyOfFixtures();
    await rm(join(dir, 'D12'), { recursive: true });
    expect((await FakeTextCaptureRunner.open(dir)).manifestSha256).not.toBe(a.manifestSha256);
  });

  describe('an installation fault is a different failure from an unknown file', () => {
    it('a directory that does not exist, and one that is empty', async () => {
      expect(await misconfigured(FakeTextCaptureRunner.open(join(tmpdir(), 'no-such-fixtures-dir')))).toBe('fixtures-unreadable');
      const empty = await mkdtemp(join(tmpdir(), 'empty-'));
      dirs.push(empty);
      expect(await misconfigured(FakeTextCaptureRunner.open(empty))).toBe('fixtures-empty');
    });

    it.each([
      ['an entry whose manifest is not JSON', async (dir: string) => writeFile(join(dir, 'D03', 'capture.json'), 'not json'), 'fixture-manifest'],
      ['an entry whose PDF is not the file its manifest names', async (dir: string) => writeFile(join(dir, 'D03', 'source.pdf'), 'tampered'), 'fixture-pdf-hash'],
      ['an entry whose recorded text was altered', async (dir: string) => writeFile(join(dir, 'D03', 'report.txt'), 'altered text'), 'fixture-text-hash'],
      ['an entry with no recorded text', async (dir: string) => rm(join(dir, 'D03', 'report.txt')), 'fixture-unreadable'],
      ['an entry with no PDF', async (dir: string) => rm(join(dir, 'D03', 'source.pdf')), 'fixture-unreadable'],
    ])('at startup: %s', async (_name, damage, code) => {
      const dir = await copyOfFixtures();
      await damage(dir);
      expect(await misconfigured(FakeTextCaptureRunner.open(dir))).toBe(code);
    });

    it('at request time: a fixture that was fine at startup and is then damaged', async () => {
      const dir = await copyOfFixtures();
      const runner = await FakeTextCaptureRunner.open(dir);
      const pdf = await fixturePdf('D02', dir);
      expect((await runner.capture(pdf)).text).toBe(await fixtureText('D02', dir));
      await writeFile(join(dir, 'D02', 'report.txt'), 'altered after startup');
      expect(await misconfigured(runner.capture(pdf))).toBe('fixture-text-hash');
      await rm(join(dir, 'D02', 'report.txt'));
      expect(await misconfigured(runner.capture(pdf))).toBe('fixture-unreadable');
      // The other recordings are unaffected: the fault is about that entry.
      expect((await runner.capture(await fixturePdf('D01', dir))).text).toBe(await fixtureText('D01', dir));
    });

    it('a manifest that names a Poppler version other than the pinned one', async () => {
      const dir = await copyOfFixtures();
      const path = join(dir, 'D04', 'capture.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.extractor.version = 'pdftotext version 24.01.0';
      await writeFile(path, JSON.stringify(manifest));
      expect(await misconfigured(FakeTextCaptureRunner.open(dir))).toBe('fixture-poppler-version');
    });

    it('two entries for the same PDF', async () => {
      const dir = await copyOfFixtures();
      await cp(join(dir, 'D01'), join(dir, 'D13'), { recursive: true });
      expect(await misconfigured(FakeTextCaptureRunner.open(dir))).toBe('fixture-duplicate');
    });

    it('never puts a path or text in the error it raises', async () => {
      const dir = await copyOfFixtures();
      await rm(join(dir, 'D03', 'report.txt'));
      const error = (await FakeTextCaptureRunner.open(dir).catch((e: unknown) => e)) as Error;
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(dir);
    });
  });
});
