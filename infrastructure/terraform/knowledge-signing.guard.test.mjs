// Guards for the knowledge signing keys (knowledge-signing.tf), audit finding CLIN-01. Imported by guard.test.mjs, so `pnpm test:infra` runs it. Like the
// other guards it reads Terraform TEXT: `knowledgeSigningProblems` returns what is wrong with a copy (empty when nothing is), and the tests run it on the real
// files and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const files = { signing: read('./knowledge-signing.tf'), compute: read('./api-compute.tf') };

const squash = (s) => s.replace(/[ \t]+/g, ' ');
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

export function knowledgeSigningProblems({ signing, compute }) {
  const s = squash(code(signing));
  const problems = [];
  if (!s.includes('customer_master_key_spec = "ECC_NIST_P256"') || !s.includes('key_usage = "SIGN_VERIFY"')) {
    problems.push('each knowledge signer key must be a P-256 signing key (the API accepts P-256 public keys only)');
  }
  if (!/sid = "NobodyElseSigns"\s*effect = "Deny"\s*actions = \["kms:Sign"\][\s\S]*?test = "ArnNotEquals"\s*variable = "aws:PrincipalArn"\s*values = \[each\.value\]/.test(s)) {
    problems.push('the key policy must deny kms:Sign to every principal except that signer');
  }
  if (!/length\(var\.knowledge_signers\) >= 2/.test(s)) problems.push('knowledge_signers must refuse fewer than two signers');
  if (!/length\(distinct\(values\(var\.knowledge_signers\)\)\) == length\(var\.knowledge_signers\)/.test(s)) {
    problems.push('knowledge_signers must refuse one principal holding two signers');
  }
  if (!/KNOWLEDGE_SIGNER_KEYS = jsonencode\(\{ for id, key in data\.aws_kms_public_key\.knowledge_signer : id => key\.public_key_pem \}\)/.test(s)) {
    problems.push('KNOWLEDGE_SIGNER_KEYS must be built from the KMS public keys');
  }
  if (!/local\.synthetic_assessment_environment, local\.knowledge_signer_environment\)/.test(squash(code(compute)))) {
    problems.push('the API task must receive the knowledge signer environment');
  }
  return problems;
}

test('the knowledge signing keys and their wiring hold every rule', () => {
  assert.deepEqual(knowledgeSigningProblems(files), []);
});

test('each rule fails on a copy that breaks it', () => {
  const broken = [
    [{ signing: files.signing.replace('ECC_NIST_P256', 'RSA_2048') }, 'P-256 signing key'],
    [{ signing: files.signing.replace('values   = [each.value]', 'values   = ["*"]') }, 'deny kms:Sign'],
    [{ signing: files.signing.replace('length(var.knowledge_signers) >= 2', 'length(var.knowledge_signers) >= 1') }, 'fewer than two'],
    [{ signing: files.signing.replace('length(distinct(values(var.knowledge_signers))) == length(var.knowledge_signers)', 'true') }, 'one principal'],
    [{ signing: files.signing.replace('id => key.public_key_pem', 'id => "pinned-in-repo"') }, 'built from the KMS public keys'],
    [{ compute: files.compute.replace(', local.knowledge_signer_environment)', ')') }, 'receive the knowledge signer environment'],
  ];
  for (const [change, expected] of broken) {
    const problems = knowledgeSigningProblems({ ...files, ...change });
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `${expected}: ${JSON.stringify(problems)}`,
    );
  }
});
