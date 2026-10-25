import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type GeneMapFile, type GuidelineFile, knowledgeFileSchema, type KnowledgeFile } from '@telesphoros/cpic-schema';
import { contentSha256, fullSha256, knowledgeSetId } from './content-hash';
import { genesKey, type KnowledgeFileInfo, KnowledgeSet } from './knowledge-set';

export type KnowledgeMode = 'production' | 'non-production';

export interface LoadKnowledgeOptions {
  /** The knowledge directory, e.g. <repo>/knowledge/cpic. */
  directory: string;
  /**
   * Required, with no default, so nobody gets the relaxed rules by forgetting to say.
   * "production" refuses unreviewed and synthetic content; the caller derives it from NODE_ENV.
   */
  mode: KnowledgeMode;
}

/** Thrown when the knowledge directory is not safe to use. `problems` lists EVERY problem found, not only the first. */
export class KnowledgeLoadError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Knowledge could not be loaded (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n- ${problems.join('\n- ')}`);
    this.name = 'KnowledgeLoadError';
  }
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 500;
/** Subdirectory → the one kind of file allowed in it. `gene-drug-pairs` is reserved and must stay empty. */
const SUBDIRECTORIES: Readonly<Record<string, KnowledgeFile['kind'] | null>> = {
  phenotypes: 'gene-phenotype-map',
  guidelines: 'guideline',
  'gene-drug-pairs': null,
};
const IGNORED_FILES = new Set(['.gitkeep', 'README.md']);

interface Candidate {
  path: string;
  file: KnowledgeFile;
}

/**
 * Reads, validates and cross-checks the knowledge directory.
 *
 * It fails CLOSED. Anything it does not recognise (a stray file, a typo'd folder, a symlink, a
 * file for the wrong folder) is an error, never silently skipped, because skipped knowledge looks
 * exactly like "no guideline for this drug". All problems are collected and reported together.
 */
export async function loadKnowledge(options: LoadKnowledgeOptions): Promise<KnowledgeSet> {
  // Fail closed: anything other than an explicit "non-production" gets the production rules, even if a
  // caller outside TypeScript passes nothing or a misspelling.
  const strict = options.mode !== 'non-production';
  const problems: string[] = [];
  const candidates = await readCandidates(options.directory, problems);

  const geneMaps = new Map<string, GeneMapFile>();
  const guidelines: GuidelineFile[] = [];
  const guidelineKeys = new Set<string>();
  const ids = new Set<string>();
  const infos: KnowledgeFileInfo[] = [];

  for (const { path, file } of candidates) {
    if (ids.has(file.id)) problems.push(`${path}: id "${file.id}" is used by another file.`);
    ids.add(file.id);

    // A signature binds a reviewer to specific content. Edited since? Then it is not reviewed.
    const hash = contentSha256(file);
    if (file.review.status === 'reviewed' && file.review.contentSha256 !== hash) {
      problems.push(`${path}: the content changed after it was reviewed (hash mismatch). It must be reviewed again.`);
    }

    if (strict) {
      if (file.synthetic) problems.push(`${path}: synthetic test content is not allowed in production.`);
      if (file.review.status !== 'reviewed') problems.push(`${path}: unreviewed content is not allowed in production.`);
    }

    if (file.kind === 'gene-phenotype-map') {
      if (geneMaps.has(file.gene)) problems.push(`${path}: gene ${file.gene} already has a phenotype map.`);
      geneMaps.set(file.gene, file);
    } else {
      const key = `${file.drug}\0${genesKey(file)}`;
      if (guidelineKeys.has(key)) problems.push(`${path}: there is already a guideline for ${file.drug} and ${file.genes.join(' + ')}.`);
      guidelineKeys.add(key);
      guidelines.push(file);
    }

    infos.push({
      path,
      kind: file.kind,
      id: file.id,
      synthetic: file.synthetic,
      reviewStatus: file.review.status,
      contentSha256: hash,
    });
  }

  const guidelineById = new Map(guidelines.map((guideline) => [guideline.id, guideline]));
  const supersededBy = new Map<string, string>();
  for (const { path, file } of candidates) {
    if (file.kind !== 'guideline') continue;
    for (const gene of file.genes) {
      const map = geneMaps.get(gene);
      if (!map) {
        problems.push(`${path}: no phenotype map exists for gene ${gene}.`);
        continue;
      }
      for (const row of file.recommendations) {
        const phenotype = row.when[gene];
        if (phenotype !== undefined && !map.phenotypes.includes(phenotype)) {
          problems.push(`${path}: phenotype "${phenotype}" is not one of the phenotypes defined for ${gene}.`);
        }
      }
    }
    checkSupersession(path, file, guidelineById, supersededBy, problems);
  }

  if (problems.length > 0) throw new KnowledgeLoadError(problems);

  const id = knowledgeSetId(candidates.map(({ path, file }) => ({ path, fullSha256: fullSha256(file) })));
  return new KnowledgeSet(id, strict ? 'production' : 'non-production', [...geneMaps.values()], guidelines, infos);
}

/**
 * A combined table may replace narrower single-gene tables for the same drug. The replaced tables
 * are then never shown on their own, so a mistake here would hide a guideline or allow a fallback.
 */
function checkSupersession(path: string, file: GuidelineFile, byId: ReadonlyMap<string, GuidelineFile>, supersededBy: Map<string, string>, problems: string[]): void {
  for (const id of file.supersedes) {
    const target = byId.get(id);
    if (!target) {
      problems.push(`${path}: supersedes "${id}", which is not a loaded guideline.`);
      continue;
    }
    if (target.drug !== file.drug) problems.push(`${path}: supersedes "${id}", which is for a different drug.`);
    const covered = target.genes.every((gene) => file.genes.includes(gene)) && target.genes.length < file.genes.length;
    if (!covered) problems.push(`${path}: supersedes "${id}", whose genes are not a smaller subset of this guideline's genes.`);
    if (target.supersedes.length > 0) problems.push(`${path}: supersedes "${id}", which itself supersedes others (chains are not allowed).`);
    const other = supersededBy.get(id);
    if (other !== undefined && other !== file.id) problems.push(`${path}: "${id}" is already superseded by "${other}".`);
    supersededBy.set(id, file.id);
  }
}

async function readCandidates(directory: string, problems: string[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let top;
  try {
    top = await readdir(directory, { withFileTypes: true });
  } catch {
    // intentional: the message below is the report; the system error text adds nothing the operator can act on
    problems.push(`The knowledge directory cannot be read: ${directory}`);
    return candidates;
  }

  for (const entry of top.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isFile() && IGNORED_FILES.has(entry.name)) continue;
    if (!entry.isDirectory() || !(entry.name in SUBDIRECTORIES)) {
      problems.push(`${entry.name}: unexpected entry in the knowledge directory (allowed folders: ${Object.keys(SUBDIRECTORIES).join(', ')}).`);
      continue;
    }
    const expectedKind = SUBDIRECTORIES[entry.name];
    const files = (await readdir(join(directory, entry.name), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const item of files) {
      const path = `${entry.name}/${item.name}`;
      if (item.isFile() && IGNORED_FILES.has(item.name)) continue;
      if (!item.isFile() || !item.name.endsWith('.json')) {
        problems.push(`${path}: only plain .json files are allowed here (no folders, links or other file types).`);
        continue;
      }
      if (expectedKind === null) {
        problems.push(`${path}: the ${entry.name} folder is reserved and must stay empty.`);
        continue;
      }
      if (candidates.length >= MAX_FILES) {
        problems.push(`More than ${MAX_FILES} knowledge files.`);
        return candidates;
      }
      const file = await readOne(join(directory, entry.name, item.name), path, expectedKind, problems);
      if (file) candidates.push({ path, file });
    }
  }
  return candidates;
}

async function readOne(fullPath: string, path: string, expectedKind: KnowledgeFile['kind'], problems: string[]): Promise<KnowledgeFile | undefined> {
  const { size } = await stat(fullPath);
  if (size > MAX_FILE_BYTES) {
    problems.push(`${path}: larger than ${MAX_FILE_BYTES} bytes.`);
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(fullPath, 'utf8'));
  } catch {
    // intentional: JSON.parse messages can quote file content; the path is what matters
    problems.push(`${path}: not valid JSON.`);
    return undefined;
  }
  const parsed = knowledgeFileSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${path}: ${issue.path.join('.') || '(file)'}: ${issue.message}`);
    return undefined;
  }
  const file = parsed.data;
  if (file.kind !== expectedKind) problems.push(`${path}: a ${file.kind} file does not belong in this folder.`);
  const expectedName = `${file.id}.json`;
  if (path.split('/')[1] !== expectedName) problems.push(`${path}: the file name must match its id (expected ${expectedName}).`);
  if (file.synthetic && file.review.status === 'reviewed') problems.push(`${path}: synthetic content can never be marked reviewed.`);
  return file;
}
