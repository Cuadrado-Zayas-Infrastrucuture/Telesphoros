// Prints the index of status fragments in docs/status/, newest first.
//   pnpm status:index                 print the index
//   pnpm status:index --dir <folder>  read another folder (the guard's controls use this)
// The index is printed, never committed: a committed index would be one more file every pull
// request edits, which is the conflict the fragments exist to remove.
//
// A fragment is docs/status/YYYY-MM-DD-slug.md. Line 1 is `# Title`; the first non-blank line after
// it is `Date: YYYY-MM-DD`, the same date as the filename. Slugs are unique across the folder.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FRAGMENT_DIR = fileURLToPath(new URL('../docs/status/', import.meta.url));
const FILENAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const DATE_LINE = /^Date: (\d{4}-\d{2}-\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD ("2026-02-30" is not one). */
export function isCalendarDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Every file in the folder, parsed. `problems` lists what is wrong with that file; empty means valid. */
export function readFragments(dir = FRAGMENT_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) => {
      const file = entry.name;
      if (!entry.isFile()) return { file, problems: ['not a file: the folder holds fragments only'] };
      const problems = [];
      const named = FILENAME.exec(file);
      if (!named) {
        problems.push('file name is not YYYY-MM-DD-slug.md (lower-case letters, digits and single hyphens in the slug)');
      } else if (!isCalendarDate(named[1])) {
        problems.push(`file name date ${named[1]} is not a real calendar date`);
      }
      const lines = readFileSync(join(dir, file), 'utf8').split('\n');
      const heading = /^# (\S.*)$/.exec(lines[0] ?? '');
      if (!heading) problems.push('line 1 is not a "# Title" heading');
      const dateLine = lines.slice(1).find((line) => line.trim() !== '');
      const dated = DATE_LINE.exec(dateLine ?? '');
      if (!dated) {
        problems.push('the first non-blank line after the heading is not "Date: YYYY-MM-DD"');
      } else if (!isCalendarDate(dated[1])) {
        problems.push(`Date ${dated[1]} is not a real calendar date`);
      } else if (named && dated[1] !== named[1]) {
        problems.push(`Date ${dated[1]} does not match the file name date ${named[1]}`);
      }
      return { file, slug: named?.[2], date: dated?.[1], title: heading?.[1].trim(), problems };
    });
}

/** Problem strings for the whole folder: each file's own, plus any slug used by more than one file. */
export function fragmentProblems(dir = FRAGMENT_DIR) {
  const fragments = readFragments(dir);
  const out = fragments.flatMap((f) => f.problems.map((p) => `${f.file}: ${p}`));
  const bySlug = new Map();
  for (const f of fragments) if (f.slug) bySlug.set(f.slug, [...(bySlug.get(f.slug) ?? []), f.file]);
  for (const [slug, files] of bySlug) if (files.length > 1) out.push(`slug "${slug}" is used by ${files.join(', ')}`);
  return out;
}

/** The index text, newest first (ties by slug). Only valid fragments appear. */
export function renderIndex(fragments) {
  const valid = fragments.filter((f) => f.problems.length === 0);
  valid.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : a.date < b.date ? 1 : -1));
  return valid.map((f) => `${f.date}  ${f.title}  (docs/status/${f.file})`).join('\n');
}

function main(argv) {
  const at = argv.indexOf('--dir');
  const dir = at >= 0 ? argv[at + 1] : FRAGMENT_DIR;
  if (at >= 0 && !dir) {
    process.stderr.write('--dir needs a folder\n');
    return 2;
  }
  const problems = fragmentProblems(dir);
  if (problems.length > 0) {
    process.stderr.write(`status fragments are not valid:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    return 1;
  }
  const index = renderIndex(readFragments(dir));
  process.stdout.write(index ? `${index}\n` : '(no fragments yet)\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
