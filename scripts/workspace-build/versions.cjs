// One version range per external dependency across the workspace, so two packages never build against different releases of the
// same library without anyone choosing that. Workspace packages are referenced as "workspace:*", and the root installs tools only.
// versions.test.cjs runs this over the real manifests; `pnpm test` runs that file.
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** The `packages:` patterns of pnpm-workspace.yaml, as written. Comments and other keys are ignored. */
function workspacePatterns(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start === -1) return [];
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break; // the next top-level key or comment ends the list
    const item = /^\s+-\s+["']?([^"'#\s]+)["']?\s*(#.*)?$/.exec(line);
    if (item) patterns.push(item[1]);
  }
  return patterns;
}

/**
 * The root manifest and every manifest a workspace pattern matches. Only the `dir/*` form is read; any other form, or a pattern that
 * matches nothing, is a problem rather than a silent skip, so a manifest cannot drop out of the check unnoticed.
 */
function manifests(root) {
  const problems = [];
  const found = [{ path: 'package.json', json: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) }];
  const patterns = workspacePatterns(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  if (patterns.length === 0) problems.push('pnpm-workspace.yaml: no packages patterns were read');
  for (const pattern of patterns) {
    const form = /^([^*!]+)\/\*$/.exec(pattern);
    if (!form) {
      problems.push(`pnpm-workspace.yaml: pattern "${pattern}" is not of the form dir/*, the only form this check reads`);
      continue;
    }
    const dir = join(root, form[1]);
    const matched = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
          .map((entry) => `${form[1]}/${entry.name}/package.json`)
          .sort()
      : [];
    if (matched.length === 0) problems.push(`pnpm-workspace.yaml: pattern "${pattern}" matches no package`);
    for (const path of matched) found.push({ path, json: JSON.parse(readFileSync(join(root, path), 'utf8')) });
  }
  return { manifests: found, problems };
}

/** Problems in a list of { path, json } manifests, and how many external dependencies more than one manifest declares (`compared`). */
function check(list) {
  const problems = [];
  const internal = new Set(list.map(({ json }) => json.name).filter(Boolean));
  const ranges = new Map(); // dependency name -> Map(range -> ['path (field)', ...])
  for (const { path, json } of list) {
    const rootDependencies = path === 'package.json' ? Object.keys(json.dependencies ?? {}) : [];
    if (rootDependencies.length > 0) {
      problems.push(`package.json: the workspace root has dependencies (${rootDependencies.join(', ')}); the root installs tools only, as devDependencies`);
    }
    for (const field of fields) {
      for (const [name, range] of Object.entries(json[field] ?? {})) {
        if (internal.has(name)) {
          if (range !== 'workspace:*') problems.push(`${path}: ${field} "${name}" is "${range}"; a workspace package is referenced as "workspace:*"`);
          continue;
        }
        if (range.startsWith('workspace:')) {
          problems.push(`${path}: ${field} "${name}" is "${range}", but no workspace package has that name`);
          continue;
        }
        if (!ranges.has(name)) ranges.set(name, new Map());
        const users = ranges.get(name);
        users.set(range, [...(users.get(range) ?? []), `${path} (${field})`]);
      }
    }
  }
  let compared = 0;
  for (const [name, users] of ranges) {
    if ([...users.values()].flat().length > 1) compared += 1;
    if (users.size > 1) {
      problems.push(`"${name}" has ${users.size} ranges: ${[...users].map(([range, where]) => `"${range}" in ${where.join(', ')}`).join('; ')}`);
    }
  }
  return { problems, compared };
}

module.exports = { workspacePatterns, manifests, check };
