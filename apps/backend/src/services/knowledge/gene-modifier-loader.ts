import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GENE_MODIFIER_LIST_KIND, geneModifierListFileSchema, type GeneModifierListFile } from '@telesphoros/cpic-schema';
import { type GeneModifier, type GeneModifierFileInfo, GeneModifierSet } from '../../gene-modifiers/gene-modifier-set';
import { contentSha256, fullSha256, knowledgeSetId } from './content-hash';
import { KnowledgeLoadError, type KnowledgeMode } from './knowledge-loader';
import { checkSignatures, type SignerKeys } from './signatures';

export interface LoadGeneModifiersOptions {
  /** The gene modifier directory (GENE_MODIFIERS_DIR): its own folder, never a CPIC knowledge directory. */
  directory: string;
  /** Required, with no default, as for `loadKnowledge`. The API always passes "production" (spec 045 PN-1); only tests pass "non-production". */
  mode: KnowledgeMode;
  /** The public keys of the signers whose signatures count (KNOWLEDGE_SIGNER_KEYS). Checked under the production rules only. */
  signerKeys?: SignerKeys;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 50;
const IGNORED_FILES = new Set(['.gitkeep', 'README.md']);

interface Candidate {
  path: string;
  file: GeneModifierListFile;
}

/**
 * Reads, validates and cross-checks the gene modifier lists (spec 045 D2). Like `loadKnowledge` it fails closed and reports every problem
 * together: a list that did not load would read as "no listed modifier", which the notice must never be allowed to mean by accident.
 */
export async function loadGeneModifiers(options: LoadGeneModifiersOptions): Promise<GeneModifierSet> {
  // Fail closed: anything other than an explicit "non-production" gets the production rules.
  const strict = options.mode !== 'non-production';
  const problems: string[] = [];
  const candidates = await readLists(options.directory, problems);
  if (candidates.length === 0 && problems.length === 0) problems.push('The gene modifier directory holds no list.');

  const ids = new Set<string>();
  const infos: GeneModifierFileInfo[] = [];
  const modifiers: GeneModifier[] = [];
  const listedIn = new Map<string, string>();
  const ingredientOf = new Map<string, { ingredient: string; path: string }>();
  const hgncOf = new Map<string, { hgncId: string; path: string }>();
  const geneOf = new Map<string, { gene: string; path: string }>();

  for (const { path, file } of candidates) {
    if (ids.has(file.id)) problems.push(`${path}: id "${file.id}" is used by another file.`);
    ids.add(file.id);

    const hash = contentSha256(file);
    if (file.review.status === 'reviewed' && file.review.contentSha256 !== hash) {
      problems.push(`${path}: the content changed after it was reviewed (hash mismatch). It must be reviewed again.`);
    }
    if (strict) {
      if (file.synthetic) problems.push(`${path}: synthetic test content is not allowed in production.`);
      if (file.review.status !== 'reviewed') problems.push(`${path}: unreviewed content is not allowed in production.`);
    }
    // Two signers stand behind every real reviewed list, as behind every other knowledge file (audit CLIN-01).
    let signedBy: string[] | undefined;
    if (strict && !file.synthetic && file.review.status === 'reviewed') {
      const checked = checkSignatures(path, file, hash, options.signerKeys ?? new Map());
      problems.push(...checked.problems);
      signedBy = checked.signedBy;
    }

    // Within a file the schema already refuses these; across files the loader does, naming both files and the ingredient, never an id.
    for (const entry of file.entries) {
      const pair = `${entry.rxcui}\0${entry.gene}`;
      const first = listedIn.get(pair);
      if (first === undefined) listedIn.set(pair, path);
      else if (first !== path) problems.push(`${first} and ${path} both list ${entry.ingredient} for ${entry.gene}.`);
      const named = ingredientOf.get(entry.rxcui);
      if (named === undefined) ingredientOf.set(entry.rxcui, { ingredient: entry.ingredient, path });
      else if (named.ingredient !== entry.ingredient) problems.push(`${named.path} and ${path} state the same RxNorm id for two ingredients.`);
      const hgnc = hgncOf.get(entry.gene);
      if (hgnc === undefined) hgncOf.set(entry.gene, { hgncId: entry.hgncId, path });
      else if (hgnc.hgncId !== entry.hgncId) problems.push(`${hgnc.path} and ${path} state different HGNC ids for ${entry.gene}.`);
      const gene = geneOf.get(entry.hgncId);
      if (gene === undefined) geneOf.set(entry.hgncId, { gene: entry.gene, path });
      else if (gene.gene !== entry.gene) problems.push(`${gene.path} and ${path} state the same HGNC id for two genes.`);
      modifiers.push({
        ...entry,
        listId: file.id,
        source: file.provenance.source,
        sourceUrl: file.provenance.sourceUrl,
        sourceVersion: file.provenance.sourceVersion,
      });
    }

    infos.push({
      path,
      id: file.id,
      synthetic: file.synthetic,
      reviewStatus: file.review.status,
      contentSha256: hash,
      ...(signedBy ? { signedBy } : {}),
    });
  }

  if (problems.length > 0) throw new KnowledgeLoadError(problems);
  const id = knowledgeSetId(candidates.map(({ path, file }) => ({ path, fullSha256: fullSha256(file) })));
  return new GeneModifierSet(id, strict ? 'production' : 'non-production', infos, modifiers);
}

/** The directory is flat: gene modifier lists as plain .json files, and nothing else but a README or .gitkeep. */
async function readLists(directory: string, problems: string[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // intentional: the message below is the report; the system error text adds nothing the operator can act on
    problems.push(`The gene modifier directory cannot be read: ${directory}`);
    return candidates;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isFile() && IGNORED_FILES.has(entry.name)) continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      problems.push(`${entry.name}: only plain .json files are allowed here (no folders, links or other file types).`);
      continue;
    }
    if (candidates.length >= MAX_FILES) {
      problems.push(`More than ${MAX_FILES} gene modifier lists.`);
      return candidates;
    }
    const file = await readOne(join(directory, entry.name), entry.name, problems);
    if (file) candidates.push({ path: entry.name, file });
  }
  return candidates;
}

async function readOne(fullPath: string, path: string, problems: string[]): Promise<GeneModifierListFile | undefined> {
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
  // A CPIC file here is refused by name, so nobody reads the schema errors of the wrong kind and fixes the wrong thing.
  if (json === null || typeof json !== 'object' || (json as { kind?: unknown }).kind !== GENE_MODIFIER_LIST_KIND) {
    problems.push(`${path}: only gene modifier lists belong in this directory.`);
    return undefined;
  }
  const parsed = geneModifierListFileSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${path}: ${issue.path.join('.') || '(file)'}: ${issue.message}`);
    return undefined;
  }
  const file = parsed.data;
  if (path !== `${file.id}.json`) problems.push(`${path}: the file name must match its id (expected ${file.id}.json).`);
  if (file.synthetic && file.review.status === 'reviewed') problems.push(`${path}: synthetic content can never be marked reviewed.`);
  return file;
}
