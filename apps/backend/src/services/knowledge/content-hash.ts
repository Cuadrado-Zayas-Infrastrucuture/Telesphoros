import { createHash } from 'node:crypto';
import type { KnowledgeFile } from '@telesphoros/cpic-schema';

/** JSON with object keys sorted at every level, so the same content always serialises the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The hash a reviewer signs: the whole file EXCEPT its `review` block (a signature cannot contain
 * its own hash). Formatting, key order and whitespace in the file do not change it; any change to
 * content does.
 */
export function contentSha256(file: KnowledgeFile): string {
  const { review: _review, ...content } = file;
  void _review;
  return sha256(canonicalJson(content));
}

/** Hash of the whole file including its review block, used to identify a knowledge set. */
export function fullSha256(file: KnowledgeFile): string {
  return sha256(canonicalJson(file));
}

/** Identifies a set of files: the same files with the same content and sign-offs always give the same id. */
export function knowledgeSetId(entries: readonly { path: string; fullSha256: string }[]): string {
  const lines = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((entry) => `${entry.path}\0${entry.fullSha256}\n`);
  return sha256(lines.join(''));
}
