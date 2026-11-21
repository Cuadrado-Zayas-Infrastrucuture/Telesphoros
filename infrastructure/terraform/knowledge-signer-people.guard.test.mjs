// Guards for the knowledge signers' own sign-in (knowledge-signer-people.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it. Like the other
// guards it reads Terraform TEXT: `signerPeopleProblems` returns what is wrong with a copy (empty when nothing is), and the tests run it on the real files
// and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('./', import.meta.url);
const read = (path) => readFileSync(new URL(path, dir), 'utf8');
const files = { people: read('./knowledge-signer-people.tf'), signing: read('./knowledge-signing.tf') };
const everyTf = () => readdirSync(dir).filter((f) => f.endsWith('.tf')).map((f) => read(`./${f}`));

const squash = (s) => s.replace(/[ \t]+/g, ' ');
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The text of the first `statement { ... }` whose sid is `sid`, braces balanced. */
function statement(text, sid) {
  const at = text.indexOf(`sid = "${sid}"`);
  if (at < 0) return '';
  const start = text.lastIndexOf('statement {', at);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

// What a signer's own user may do: look after their own password, MFA device and access keys, and become their own signing role. Nothing else.
export const ALLOWED_USER_ACTIONS = new Set([
  'iam:GetAccountPasswordPolicy',
  'iam:ListVirtualMFADevices',
  'iam:ChangePassword',
  'iam:GetUser',
  'iam:GetLoginProfile',
  'iam:UpdateLoginProfile',
  'iam:CreateAccessKey',
  'iam:DeleteAccessKey',
  'iam:ListAccessKeys',
  'iam:UpdateAccessKey',
  'iam:GetAccessKeyLastUsed',
  'iam:CreateVirtualMFADevice',
  'iam:EnableMFADevice',
  'iam:ResyncMFADevice',
  'iam:ListMFADevices',
  'iam:DeactivateMFADevice',
  'sts:AssumeRole',
]);

export function signerPeopleProblems({ people, signing }, allTf = [people, signing]) {
  const p = squash(code(people));
  const problems = [];

  for (const text of allTf) {
    if (/resource "aws_iam_(access_key|user_login_profile|virtual_mfa_device)"/.test(code(text))) {
      problems.push('Terraform must never create an access key, a console password or an MFA device: each would put a secret in the state');
    }
  }

  const trust = statement(p, 'ThisPersonWithFreshMfa');
  if (!/actions = \["sts:AssumeRole"\]/.test(trust)) problems.push('the signing role trust must allow sts:AssumeRole and nothing else');
  if (!/type = "AWS"\s*identifiers = \[aws_iam_user\.knowledge_signer_person\[each\.key\]\.arn\]/.test(trust)) {
    problems.push('the signing role must trust exactly that person\'s own user');
  }
  if (!/test = "Bool"\s*variable = "aws:MultiFactorAuthPresent"\s*values = \["true"\]/.test(trust)) problems.push('the signing role trust must require MFA');
  if (!/test = "NumericLessThan"\s*variable = "aws:MultiFactorAuthAge"\s*values = \["3600"\]/.test(trust)) {
    problems.push('the signing role trust must require MFA that is at most an hour old');
  }
  if (!/resource "aws_iam_role" "knowledge_signer_person" \{[\s\S]*?max_session_duration = 3600/.test(p)) problems.push('a signing session must last at most an hour');

  for (const text of allTf) {
    if (/resource "aws_iam_(role_policy|role_policy_attachment|policy_attachment)" "[^"]+" \{[^}]*aws_iam_role\.knowledge_signer_person/.test(squash(code(text)))) {
      problems.push('the signing role must carry no policy: the signer key policy alone lets it sign');
    }
  }

  const allows = [...p.matchAll(/statement \{\s*sid = "(Own[A-Za-z]+|AccountPasswordRules)"[\s\S]*?actions = \[([^\]]*)\]/g)];
  if (allows.length === 0) problems.push('the user policy must list what the user may do');
  for (const [, sid, list] of allows) {
    for (const action of [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
      if (!ALLOWED_USER_ACTIONS.has(action)) problems.push(`the user policy grants ${action} (${sid}), which is not on the list`);
    }
  }
  const assume = statement(p, 'OwnSigningRole');
  if (!/resources = \[aws_iam_role\.knowledge_signer_person\[each\.key\]\.arn\]/.test(assume)) problems.push('a user may become only their own signing role');
  const deny = statement(p, 'NothingElseWithoutMfa');
  if (!/effect = "Deny"/.test(deny) || !/not_actions = \[/.test(deny) || !/test = "BoolIfExists"\s*variable = "aws:MultiFactorAuthPresent"\s*values = \["false"\]/.test(deny)) {
    problems.push('the user policy must deny everything else to a session without MFA');
  }

  if (!/condition = var\.environment != "production"/.test(p)) problems.push('signer users are refused in production (Identity Center there)');
  if (!/resource "aws_kms_key" "knowledge_signer" \{[\s\S]*?depends_on = \[aws_iam_role\.knowledge_signer_person\]/.test(squash(code(signing)))) {
    problems.push('the signer keys must wait for the signing roles, so a key policy never names a role that does not exist yet');
  }
  return problems;
}

test('the knowledge signers\' sign-in holds every rule', () => {
  assert.deepEqual(signerPeopleProblems(files, everyTf()), []);
});

test('each rule fails on a copy that breaks it', () => {
  const people = files.people;
  const broken = [
    [{ people: people + '\nresource "aws_iam_access_key" "x" {\n  user = "u"\n}\n' }, 'never create an access key'],
    [{ people: people + '\nresource "aws_iam_user_login_profile" "x" {\n  user = "u"\n}\n' }, 'never create an access key'],
    [{ people: people.replace('actions = ["sts:AssumeRole"]\n    principals', 'actions = ["sts:AssumeRole", "sts:TagSession"]\n    principals') }, 'sts:AssumeRole and nothing else'],
    [{ people: people.replace('identifiers = [aws_iam_user.knowledge_signer_person[each.key].arn]', 'identifiers = ["arn:aws:iam::${local.audit_account_id}:root"]') }, 'exactly that person'],
    [{ people: people.replace('variable = "aws:MultiFactorAuthPresent"\n      values   = ["true"]', 'variable = "aws:MultiFactorAuthPresent"\n      values   = ["false"]') }, 'require MFA'],
    [{ people: people.replace('values   = ["3600"]', 'values   = ["86400"]') }, 'at most an hour old'],
    [{ people: people.replace('max_session_duration = 3600', 'max_session_duration = 43200') }, 'at most an hour'],
    [{ people: people + '\nresource "aws_iam_role_policy_attachment" "x" {\n  role       = aws_iam_role.knowledge_signer_person["jan"].name\n  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"\n}\n' }, 'carry no policy'],
    [{ people: people.replace('"iam:ChangePassword",', '"iam:ChangePassword",\n      "iam:CreateUser",') }, 'iam:CreateUser'],
    [{ people: people.replace('resources = [aws_iam_role.knowledge_signer_person[each.key].arn]', 'resources = ["*"]') }, 'only their own signing role'],
    [{ people: people.replace('values   = ["false"]', 'values   = ["true"]') }, 'deny everything else'],
    [{ people: people.replace('condition     = var.environment != "production"', 'condition     = true') }, 'refused in production'],
    [{ signing: files.signing.replace('depends_on = [aws_iam_role.knowledge_signer_person]', '') }, 'wait for the signing roles'],
  ];
  for (const [change, expected] of broken) {
    const copy = { ...files, ...change };
    assert.notDeepEqual(copy, files, `${expected}: the breakage did not change the text`);
    const problems = signerPeopleProblems(copy);
    assert.ok(problems.some((p) => p.includes(expected)), `${expected}: ${JSON.stringify(problems)}`);
  }
});
