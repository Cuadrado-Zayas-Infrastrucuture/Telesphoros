import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PINNED_POPPLER_VERSION } from '../../services/report-reader/pinned-reader';
import { RunnerMisconfiguredError, type TextCapture, TextCaptureRunner, UnsupportedSourceError } from './text-capture-runner';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.looseObject({
  source_pdf_sha256: hex64,
  stored_text_sha256: hex64,
  extractor: z.looseObject({ version: z.string() }),
});

interface Entry {
  dir: string;
  pdfSha256: string;
  textSha256: string;
  popplerVersion: string;
}

/**
 * A recorded-text SUBSTITUTE, not a PDF reader. If the SHA-256 of the bytes it is given equals a fixture's `source_pdf_sha256`, it returns
 * that fixture's stored text (after checking the text against the fixture's own `stored_text_sha256`). It validates the integration from
 * extraction text onward and says NOTHING about real PDF extraction (that needs the pinned Poppler binary and is not part of this slice).
 * TEST ONLY, like the fixtures. The directory is always given by configuration; no source file here names where the recordings live.
 *
 * Two different failures, on purpose: a file it does not know is a fact about that file (UnsupportedSourceError); a fixture directory or
 * entry that is missing, unreadable or inconsistent is an installation fault (RunnerMisconfiguredError, with a code and no path).
 */
export class FakeTextCaptureRunner extends TextCaptureRunner {
  readonly name = 'fake' as const;

  private constructor(
    private readonly entries: ReadonlyMap<string, Entry>,
    /** Identifies the set of recorded files the substitute can answer for. Recorded inside every evaluation (plan 12.6). */
    readonly manifestSha256: string,
  ) {
    super();
  }

  /** Reads and checks the whole fixture directory. Throws RunnerMisconfiguredError if anything about it is wrong. */
  static async open(directory: string): Promise<FakeTextCaptureRunner> {
    let names: string[];
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      throw new RunnerMisconfiguredError('fixtures-unreadable');
    }
    if (names.length === 0) throw new RunnerMisconfiguredError('fixtures-empty');

    const entries = new Map<string, Entry>();
    for (const name of names) {
      const dir = join(directory, name);
      const entry = await FakeTextCaptureRunner.readEntry(dir);
      if (entries.has(entry.pdfSha256)) throw new RunnerMisconfiguredError('fixture-duplicate');
      // The PDF on disk must be the file the manifest names.
      let pdf: Buffer;
      try {
        pdf = await readFile(join(dir, 'source.pdf'));
      } catch {
        throw new RunnerMisconfiguredError('fixture-unreadable');
      }
      if (sha256(pdf) !== entry.pdfSha256) throw new RunnerMisconfiguredError('fixture-pdf-hash');
      await FakeTextCaptureRunner.readText(entry); // fails now if the text is missing or not the recorded one
      entries.set(entry.pdfSha256, entry);
    }
    const manifest = [...entries.values()]
      .map((e) => `${e.pdfSha256}:${e.textSha256}:${e.popplerVersion}`)
      .sort()
      .join('\n');
    return new FakeTextCaptureRunner(entries, sha256(manifest));
  }

  private static async readEntry(dir: string): Promise<Entry> {
    let parsed: z.infer<typeof manifestSchema>;
    try {
      parsed = manifestSchema.parse(JSON.parse(await readFile(join(dir, 'capture.json'), 'utf8')));
    } catch {
      throw new RunnerMisconfiguredError('fixture-manifest');
    }
    const popplerVersion = /(\d+(?:\.\d+){1,3})$/.exec(parsed.extractor.version)?.[1];
    if (popplerVersion !== PINNED_POPPLER_VERSION) throw new RunnerMisconfiguredError('fixture-poppler-version');
    return { dir, pdfSha256: parsed.source_pdf_sha256, textSha256: parsed.stored_text_sha256, popplerVersion };
  }

  private static async readText(entry: Entry): Promise<string> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(entry.dir, 'report.txt'));
    } catch {
      throw new RunnerMisconfiguredError('fixture-unreadable');
    }
    if (sha256(bytes) !== entry.textSha256) throw new RunnerMisconfiguredError('fixture-text-hash');
    return bytes.toString('utf8');
  }

  async capture(pdf: Buffer): Promise<TextCapture> {
    const entry = this.entries.get(sha256(pdf)); // the hash of the bytes we were given, never a hash someone told us
    if (!entry) throw new UnsupportedSourceError();
    return { text: await FakeTextCaptureRunner.readText(entry), popplerVersion: entry.popplerVersion };
  }
}
