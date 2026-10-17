// A model of this root's policy subset, not AWS IAM simulation. No SDK or cloud calls.
// It excludes SCPs, permission boundaries, grants, root special cases and service validation.
import assert from 'node:assert/strict';

const list = (value) => Array.isArray(value) ? value : [value];
const wildcard = (pattern, value) => new RegExp(`^${pattern.split('*').map(
  (part) => part.split('?').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.'),
).join('.*')}$`).test(value);

function applies(statement, probe) {
  const { action, resource, principal, context } = probe;
  if (!list(statement.Action).some((p) => wildcard(p.toLowerCase(), action.toLowerCase()))) return false;
  if (statement.Resource && !list(statement.Resource).some((p) => wildcard(p, resource))) return false;
  if (statement.NotResource && list(statement.NotResource).some((p) => wildcard(p, resource))) return false;
  if (statement.Principal !== '*' && !list(statement.Principal.AWS).includes(principal)) return false;
  for (const [operator, conditions] of Object.entries(statement.Condition ?? {})) {
    assert.ok(['Bool', 'StringEquals', 'StringNotEquals', 'ArnNotEquals'].includes(operator), `unsupported operator: ${operator}`);
    for (const [name, expected] of Object.entries(conditions)) {
      const equal = list(expected).includes(context[name]);
      if (['Bool', 'StringEquals'].includes(operator) ? !equal : equal) return false;
    }
  }
  return true;
}

export function evaluate(policies, probe) {
  const effects = policies[probe.policy].Statement.filter((s) => applies(s, probe)).map((s) => s.Effect);
  assert.ok(effects.every((e) => ['Allow', 'Deny'].includes(e)), 'unsupported effect');
  return effects.includes('Deny') ? 'Deny' : probe.identity || effects.includes('Allow') ? 'Allow' : 'ImplicitDeny';
}

export function policyCases(key) {
  const owner = 'arn:aws:iam::123456789012:role/terraform-state-owner';
  const bucket = 'arn:aws:s3:::telesphoros-synthetic-state-test';
  const state = `${bucket}/staging/terraform.tfstate`, lock = `${state}.tflock`;
  const algorithmHeader = 's3:x-amz-server-side-encryption';
  const keyHeader = 's3:x-amz-server-side-encryption-aws-kms-key-id';
  const base = { 'aws:SecureTransport': 'true', 'aws:PrincipalArn': owner, [algorithmHeader]: 'aws:kms', [keyHeader]: key };
  const cases = [];
  const add = (name, policy, action, resource, principal, context, identity, expected) => {
    cases.push({ name, policy, action, resource, principal, context, identity, expected });
  };
  for (const identity of [false, true]) {
    const s3 = (name, action, resource, expected, context = base, principal = owner) =>
      add(`${name} broadIAM=${identity}`, 's3', action, resource, principal, context, identity, expected);
    for (const [object, actions] of [[state, ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject']], [lock, ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']]]) {
      for (const action of actions) s3(`native ${object.split('/').at(-1)} ${action}`, action, object, 'Allow');
    }
    for (const [object, action] of [[state, 's3:DeleteObject'], [state, 's3:DeleteObjectVersion'], [lock, 's3:DeleteObjectVersion'], [`${state}/extra`, 's3:GetObject'], [`${state}-other`, 's3:PutObject'], [state.toUpperCase(), 's3:GetObject'], [`${bucket}/other.tfstate`, 's3:DeleteObject']]) {
      s3(`delete/path ${object} ${action}`, action, object, 'Deny');
    }
    for (const object of [state, lock]) {
      for (const action of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']) {
        for (const who of ['arn:aws:iam::123456789012:role/other', 'arn:aws:iam::999999999999:role/terraform-state-owner']) {
          s3(`other principal ${who} ${object} ${action}`, action, object, 'Deny', { ...base, 'aws:PrincipalArn': who }, who);
        }
        s3(`nonTLS ${object} ${action}`, action, object, 'Deny', { ...base, 'aws:SecureTransport': 'false' });
      }
    }
    for (const object of [state, lock]) {
      for (const algorithm of [null, 'AES256', 'aws:kms']) {
        for (const keyValue of [null, 'wrong-key', key]) {
          const context = { ...base };
          for (const [name, value] of [[algorithmHeader, algorithm], [keyHeader, keyValue]]) {
            if (value === null) delete context[name];
            else context[name] = value;
          }
          s3(`encryption ${object} ${algorithm} ${keyValue}`, 's3:PutObject', object,
            algorithm === 'aws:kms' && keyValue === key ? 'Allow' : 'Deny', context);
        }
      }
    }
  }
  for (const action of ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey']) {
    for (const object of [state, lock]) {
      const context = { 'kms:ViaService': 's3.us-east-1.amazonaws.com', 'kms:CallerAccount': '123456789012', 'kms:EncryptionContext:aws:s3:arn': object };
      const kms = (name, principal, ctx, expected) => add(name, 'kms', action, key, principal, ctx, false, expected);
      kms(`KMS normal ${action} ${object}`, owner, context, 'Allow');
      for (const [name, value] of [['kms:ViaService', null], ['kms:ViaService', 's3.us-west-2.amazonaws.com'], ['kms:CallerAccount', '999999999999'], ['kms:EncryptionContext:aws:s3:arn', bucket], ['kms:EncryptionContext:aws:s3:arn', `${object}/extra`]]) {
        const changed = { ...context };
        if (value === null) delete changed[name];
        else changed[name] = value;
        kms(`KMS rejected ${action} ${name} ${value} object=${object}`, owner, changed, 'ImplicitDeny');
      }
      kms(`KMS unrelated owner ${action} ${object}`, 'arn:aws:iam::123456789012:role/other', context, 'ImplicitDeny');
    }
  }
  for (const action of ['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:GetKeyRotationStatus', 'kms:ListResourceTags', 'kms:PutKeyPolicy']) {
    add(`bootstrap import/read ${action}`, 'kms', action, key, owner, {}, false, 'Allow');
  }
  return cases;
}

// Promoted review cases: read/release requests omit write-encryption headers,
// and direct/incomplete KMS requests must not gain the S3-only crypto grant.
export function reviewPolicyCases(key) {
  const owner = 'arn:aws:iam::123456789012:role/terraform-state-owner';
  const bucket = 'arn:aws:s3:::telesphoros-synthetic-state-test';
  const state = `${bucket}/staging/terraform.tfstate`, lock = `${state}.tflock`;
  const transport = { 'aws:SecureTransport': 'true', 'aws:PrincipalArn': owner };
  const cases = [];
  const add = (name, policy, action, resource, context, expected, identity = false, principal = owner) => {
    cases.push({ name, policy, action, resource, context, expected, identity, principal });
  };
  for (const [name, action, object, expected] of [
    ['state read without write-encryption headers', 's3:GetObject', state, 'Allow'],
    ['historical state read for recovery without write headers', 's3:GetObjectVersion', state, 'Allow'],
    ['lock inspection without write headers', 's3:GetObject', lock, 'Allow'],
    ['ordinary lock release without write headers', 's3:DeleteObject', lock, 'Allow'],
    ['state deletion without write headers remains denied', 's3:DeleteObject', state, 'Deny'],
    ['historical lock deletion without write headers remains denied', 's3:DeleteObjectVersion', lock, 'Deny'],
  ]) add(name, 's3', action, object, transport, expected);
  const kmsContext = {
    'kms:ViaService': 's3.us-east-1.amazonaws.com',
    'kms:CallerAccount': '123456789012',
    'kms:EncryptionContext:aws:s3:arn': state,
  };
  for (const action of ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey']) {
    const context = { ...kmsContext };
    delete context['kms:ViaService'];
    add(`direct ${action} cannot use S3-only crypto grant`, 'kms', action, key, context, 'ImplicitDeny');
  }
  for (const missing of ['kms:CallerAccount', 'kms:EncryptionContext:aws:s3:arn']) {
    const context = { ...kmsContext };
    delete context[missing];
    add(`missing ${missing} refuses decryption`, 'kms', 'kms:Decrypt', key, context, 'ImplicitDeny');
  }
  for (const action of ['kms:ScheduleKeyDeletion', 'kms:CreateGrant']) {
    add(`${action} has no direct administration grant`, 'kms', action, key, {}, 'ImplicitDeny');
  }
  for (const action of ['s3:ListBucket', 's3:GetBucketLocation']) {
    add(`bootstrap metadata ${action} needs no encryption headers`, 's3', action, bucket, transport, 'Allow');
  }
  add('anonymous read is denied despite hypothetical broad identity grant', 's3', 's3:GetObject', state,
    { 'aws:SecureTransport': 'true' }, 'Deny', true, 'anonymous');
  return cases;
}

// Each challenge names a specific previously passing probe and its expected changed result.
// Policies are cloned by the caller, so no configuration or original plan is weakened.
const remove = (policy, sid) => { policy.Statement = policy.Statement.filter((s) => s.Sid !== sid); };
const statement = (policy, sid) => policy.Statement.find((s) => s.Sid === sid);
export const mutations = [
  {
    name: 'missing TLS deny',
    weaken: (p) => remove(p.s3, 'DenyInsecureTransport'),
    select: (c) => c.name.startsWith('nonTLS') && c.action === 's3:GetObject' && c.identity,
    changedResult: 'Allow',
  },
  {
    name: 'missing identity deny',
    weaken: (p) => remove(p.s3, 'DenyOtherPrincipals'),
    select: (c) => c.name.startsWith('other principal') && c.action === 's3:GetObject' && c.identity,
    changedResult: 'Allow',
  },
  {
    name: 'missing state deletion deny',
    weaken: (p) => remove(p.s3, 'DenyStateDeletion'),
    select: (c) => c.name.startsWith('delete/path') && c.action === 's3:DeleteObject' && c.identity,
    changedResult: 'Allow',
  },
  {
    name: 'missing history deletion deny',
    weaken: (p) => remove(p.s3, 'DenyVersionDeletion'),
    // State deletion has another overlapping deny; lock history isolates this control.
    select: (c) => c.name.startsWith('delete/path') && c.action === 's3:DeleteObjectVersion' && c.identity && c.resource.endsWith('.tflock'),
    changedResult: 'Allow',
  },
  {
    name: 'missing lock delete grant',
    weaken: (p) => { statement(p.s3, 'AllowLock').Action = statement(p.s3, 'AllowLock').Action.filter((a) => a !== 's3:DeleteObject'); },
    select: (c) => c.name.startsWith('native') && c.action === 's3:DeleteObject' && !c.identity,
    changedResult: 'ImplicitDeny',
  },
  {
    name: 'missing path deny',
    weaken: (p) => remove(p.s3, 'DenyOtherObjects'),
    select: (c) => c.name.startsWith('delete/path') && c.action === 's3:GetObject' && c.identity,
    changedResult: 'Allow',
  },
  {
    name: 'missing algorithm deny',
    weaken: (p) => remove(p.s3, 'DenyWrongEncryption'),
    select: (c) => c.name.startsWith('encryption') && c.identity &&
      c.context['s3:x-amz-server-side-encryption'] === 'AES256' &&
      c.context['s3:x-amz-server-side-encryption-aws-kms-key-id'] !== 'wrong-key' &&
      c.context['s3:x-amz-server-side-encryption-aws-kms-key-id'] !== undefined,
    changedResult: 'Allow',
  },
  {
    name: 'missing key deny',
    weaken: (p) => remove(p.s3, 'DenyWrongKey'),
    select: (c) => c.name.startsWith('encryption') && c.identity &&
      c.context['s3:x-amz-server-side-encryption'] === 'aws:kms' &&
      c.context['s3:x-amz-server-side-encryption-aws-kms-key-id'] === 'wrong-key',
    changedResult: 'Allow',
  },
  {
    name: 'broadened KMS context',
    weaken: (p) => { delete statement(p.kms, 'StateEncryption').Condition.StringEquals['kms:EncryptionContext:aws:s3:arn']; },
    select: (c) => c.name.startsWith('KMS rejected') && c.action === 'kms:Decrypt' &&
      c.context['kms:EncryptionContext:aws:s3:arn'] === 'arn:aws:s3:::telesphoros-synthetic-state-test' &&
      c.context['kms:ViaService'] === 's3.us-east-1.amazonaws.com',
    changedResult: 'Allow',
  },
  {
    name: 'missing bootstrap policy read',
    weaken: (p) => { statement(p.kms, 'KeyAdministration').Action = statement(p.kms, 'KeyAdministration').Action.filter((a) => a !== 'kms:GetKeyPolicy'); },
    select: (c) => c.name.startsWith('bootstrap import/read') && c.action === 'kms:GetKeyPolicy',
    changedResult: 'ImplicitDeny',
  },
];
