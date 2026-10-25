// Lexical scoring adapted from addyosmani/agent-skills scripts/run-evals.js.
// MIT attribution and pinned revision: ../THIRD_PARTY_NOTICES.md.
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stop = new Set('a an and are as at be before by for from in into is it its me my of on or our the their this to use when with you your telesphoros'.split(' '));
const stem = word => {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
};
const words = text => text.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 2 && !stop.has(x)).map(stem);
const frequency = tokens => tokens.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
const escapes = back => back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back);
const cosine = (a, b) => {
  const norm = v => Math.sqrt([...v.values()].reduce((n, x) => n + x * x, 0));
  const denominator = norm(a) * norm(b);
  return denominator ? [...a].reduce((n, [t, w]) => n + w * (b.get(t) || 0), 0) / denominator : 0;
};

export function readSkill(file) {
  const text = readFileSync(file, 'utf8');
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header) throw new Error(`Missing frontmatter: ${file}`);
  // This pack deliberately uses single-line plain name/description values.
  const field = key => header.match(new RegExp(`^${key}: ([^\\r\\n]+)$`, 'm'))?.[1].trim();
  const name = field('name');
  const description = field('description');
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || !description || description.length > 1024) {
    throw new Error(`Invalid skill metadata: ${file}`);
  }
  if (description.startsWith('[TODO')) throw new Error(`Unfinished skill: ${file}`);
  return { name, description, text, file };
}

export function loadSkills(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter(x => x.isDirectory())
    .map(x => readSkill(resolve(directory, x.name, 'SKILL.md')));
}

export function rank(prompt, skills) {
  const docs = skills.map(s => frequency([...words(s.name), ...words(s.name), ...words(s.description)]));
  const df = new Map();
  for (const doc of docs) for (const term of doc.keys()) df.set(term, (df.get(term) || 0) + 1);
  const vector = tf => new Map([...tf].map(([term, n]) => [term, n * Math.log(1 + skills.length / (1 + (df.get(term) || 0)))]));
  const query = vector(frequency(words(prompt)));
  return skills.map((s, i) => ({ name: s.name, score: cosine(query, vector(docs[i])) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function checkLinks(text, file, root) {
  const errors = [];
  const realRoot = realpathSync(root);
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^https?:\/\//.test(target) || target.startsWith('#')) continue;
    const local = target.split('#')[0];
    const destination = resolve(dirname(file), local);
    const back = relative(root, destination);
    if (isAbsolute(local) || escapes(back) || !existsSync(destination) || !statSync(destination).isFile()) {
      errors.push(`Missing or escaping local file: ${relative(root, file)} -> ${target}`);
    } else {
      const realBack = relative(realRoot, realpathSync(destination));
      if (escapes(realBack)) errors.push(`Escaping symlink: ${target}`);
    }
  }
  return errors;
}

export function evaluate(skills, cases) {
  const results = [];
  const names = new Set(skills.map(s => s.name));
  if (names.size !== skills.length) throw new Error('Duplicate skill names');
  for (const test of cases) {
    if (!names.has(test.name) || test.positive.length < 3 || test.negative.length < 2) throw new Error(`Incomplete cases: ${test.name}`);
    for (const prompt of test.positive) {
      const ranking = rank(prompt, skills);
      results.push({ kind: 'positive', owner: test.name, prompt, actual: ranking[0].name, passed: ranking[0].name === test.name && ranking[0].score > 0 });
    }
    for (const { prompt, owner } of test.negative) {
      if (!names.has(owner) || owner === test.name) throw new Error(`Unknown negative owner: ${owner}`);
      const ranking = rank(prompt, skills);
      const actual = ranking.find(x => x.name === owner);
      const unwanted = ranking.find(x => x.name === test.name);
      results.push({ kind: 'negative', owner, excluded: test.name, prompt, actual: ranking[0].name, passed: actual.score > unwanted.score && actual.score > 0 });
    }
  }
  if (new Set(cases.map(x => x.name)).size !== skills.length || cases.length !== skills.length) throw new Error('Eval coverage differs from skill catalog');
  return { passed: results.filter(x => x.passed).length, total: results.length, positive_rank1: results.filter(x => x.kind === 'positive' && x.passed).length, results };
}

/**
 * The upstream comparison covers only skills adapted from that upstream (cases with `upstream_name`). A skill from another source,
 * such as telesphoros-domain-modeling, has no counterpart there and is left out, with any negative case it owns.
 * Upstream name vocabulary is kept for a fair comparison; only result identities are mapped.
 */
export function baselineInputs(cases, upstream) {
  const derived = cases.filter(c => c.upstream_name);
  const aliases = new Map(derived.map(c => [c.name, c.upstream_name]));
  const skills = derived.map(c => {
    const source = upstream.find(s => s.name === c.upstream_name);
    if (!source) throw new Error(`Missing baseline skill: ${c.upstream_name}`);
    return source;
  });
  const baselineCases = derived.map(c => ({ ...c, name: c.upstream_name,
    negative: c.negative.filter(n => aliases.has(n.owner)).map(n => ({ ...n, owner: aliases.get(n.owner) })) }));
  return { skills, cases: baselineCases };
}

export function checkPack(root) {
  const skills = loadSkills(resolve(root, '.agents/skills'));
  const errors = [];
  const files = [resolve(root, '.agents/references/telesphoros.md'), resolve(root, 'docs/engineering/workflows.md')];
  for (const skill of skills) {
    if (basename(dirname(skill.file)) !== skill.name) errors.push(`Folder/name mismatch: ${skill.name}`);
    files.push(skill.file);
    const metadata = readFileSync(resolve(dirname(skill.file), 'agents/openai.yaml'), 'utf8');
    if (!metadata.includes(`$${skill.name}`)) errors.push(`Missing invocation name: ${skill.name}`);
    if (/allow_implicit_invocation:\s*false/.test(metadata)) errors.push(`Unexpected discovery opt-out: ${skill.name}`);
  }
  for (const file of files) errors.push(...checkLinks(readFileSync(file, 'utf8'), file, root));
  const cases = JSON.parse(readFileSync(resolve(root, '.agents/evals/routing.json'), 'utf8'));
  const evaluation = evaluate(skills, cases);
  for (const result of evaluation.results.filter(x => !x.passed)) errors.push(`Routing: ${result.owner} expected; ${result.actual} first: ${result.prompt}`);
  return { skills, cases, evaluation, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--baseline')) throw new Error('Usage: node .agents/scripts/check-workflows.mjs [--baseline /path/to/pinned-upstream]');
    const report = checkPack(defaultRoot);
    const summary = { skills: report.skills.length, local: report.evaluation, errors: report.errors, limits: ['Lexical routing only; not an LLM behavior or safety guarantee.', 'Local links check file existence and containment, not remote URLs or heading fragments.'] };
    if (args.length) {
      const baseline = baselineInputs(report.cases, loadSkills(resolve(args[1], 'skills')));
      summary.baseline = evaluate(baseline.skills, baseline.cases);
    }
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = report.errors.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
