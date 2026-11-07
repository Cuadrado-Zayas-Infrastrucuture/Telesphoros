// Guard for the Lambda bundles a release plan builds (spec 027 T022). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// scripts/staging/release/lib.sh build_lambdas builds every infrastructure/lambda/<name> before each plan and plan.sh records .build/<name>.zip.
// That covers a function only if its zip is exactly that: an archive_file over ../lambda/<name>/dist into .build/<name>.zip, from a package with a
// build script, and a function that carries the zip's hash (without it, new code is not a change in the plan). Reads Terraform TEXT;
// `bundleProblems` is run on the real files and on broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('./', import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.tf')).map((f) => [f, read(`./${f}`)]));
const lambdaRoot = new URL('../lambda/', import.meta.url);
const packages = Object.fromEntries(readdirSync(lambdaRoot)
  .filter((n) => existsSync(new URL(`${n}/package.json`, lambdaRoot)))
  .map((n) => [n, JSON.parse(readFileSync(new URL(`${n}/package.json`, lambdaRoot), 'utf8'))]));

/** Top-level blocks of a formatted .tf file: each starts at column 0 and runs to the next line that does. */
const blocks = (text) => text.split(/\n(?=\S)/);
const attr = (block, name) => new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(block)?.[1];

/** What is wrong with the Terraform files `tf` (name -> text) given the Lambda packages `pkgs` (name -> package.json), as sentences. */
export function bundleProblems(tf = files, pkgs = packages) {
  const problems = [];
  const archives = new Set();
  let functions = 0;
  for (const [file, text] of Object.entries(tf)) {
    for (const block of blocks(text)) {
      const archive = /^data "archive_file" "([a-z0-9_]+)"/.exec(block)?.[1];
      if (archive) {
        archives.add(archive);
        const name = /^"\$\{path\.module\}\/\.\.\/lambda\/([a-z0-9-]+)\/dist"$/.exec(attr(block, 'source_dir') ?? '')?.[1];
        if (!name) { problems.push(`${file}: archive_file.${archive} must zip "\${path.module}/../lambda/<name>/dist", the folder build_lambdas builds`); continue; }
        if (attr(block, 'output_path') !== `"\${path.module}/.build/${name}.zip"`) problems.push(`${file}: archive_file.${archive} must write "\${path.module}/.build/${name}.zip", the zip plan.sh records`);
        if (!pkgs[name]?.scripts?.build) problems.push(`${file}: archive_file.${archive} zips ${name}, which has no infrastructure/lambda/${name}/package.json with a build script`);
      }
      if (/^resource "aws_lambda_function" /.test(block)) {
        functions++;
        const from = /^data\.archive_file\.([a-z0-9_]+)(\[0\])?\.output_path$/.exec(attr(block, 'filename') ?? '');
        if (!from) { problems.push(`${file}: every aws_lambda_function takes its filename from an archive_file's output_path (a built bundle)`); continue; }
        if (attr(block, 'source_code_hash') !== `data.archive_file.${from[1]}${from[2] ?? ''}.output_base64sha256`) {
          problems.push(`${file}: the function zipped by archive_file.${from[1]} must set source_code_hash from it, or new code is not a change in the plan`);
        }
      }
    }
  }
  // A floor, so a scan that finds nothing (a renamed block, a changed layout) cannot pass: the password-change notifier is one.
  if (archives.size < 1 || functions < 1) problems.push(`the scan must find the Lambda bundles (found ${archives.size} archive_file, ${functions} aws_lambda_function)`);
  return problems;
}

test('every Lambda function is a bundle that build_lambdas builds and plan.sh records', () => {
  assert.deepEqual(bundleProblems(), []);
});

test('the bundle guard fails when a rule is broken', () => {
  const swap = (from, to) => Object.fromEntries(Object.entries(files).map(([f, t]) => [f, t.replace(from, to)]));
  const notifier = 'password-change-notifier';
  const cases = [
    ['a zip of another folder', swap(`lambda/${notifier}/dist"`, `lambda/${notifier}/build"`), /must zip/],
    ['a zip written elsewhere', swap(`.build/${notifier}.zip"`, `${notifier}.zip"`), /must write/],
    ['a function from a fixed file', swap(/filename\s*=\s*data\.archive_file\.password_notifier\.output_path/, 'filename = "notifier.zip"'), /takes its filename from an archive_file/],
    ['a function without the hash', swap(/\n\s*source_code_hash\s*=.*\n/, '\n'), /must set source_code_hash/],
    ['nothing found', { 'main.tf': '' }, /the scan must find/],
  ];
  for (const [what, tf, why] of cases) assert.match(bundleProblems(tf).join('\n'), why, what);
  assert.match(bundleProblems(files, { ...packages, [notifier]: { scripts: {} } }).join('\n'), /no infrastructure\/lambda\/password-change-notifier\/package\.json with a build script/);
});
