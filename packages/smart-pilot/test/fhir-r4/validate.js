import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import Ajv from 'ajv';
const rawSchema = zlib.gunzipSync(fs.readFileSync(new URL('./fhir.schema.json.gz', import.meta.url)));
if (crypto.createHash('sha256').update(rawSchema).digest('hex') !== '2230406893b4cf002a4ee1e5e2bbeca22ac5d2d4931b3e9ef7b9594bbc376a01')
  throw new Error('FHIR schema digest mismatch');
// Ajv 8 refuses the draft-04 `id` keyword ("use $id"). The only schema-level `id` is HL7's top-level identifier, and every
// `$ref` is a local "#/definitions/..." pointer, so it is dropped after the digest above has vouched for the file.
const schema = JSON.parse(rawSchema);
delete schema.id;
// HL7's draft-06 schema uses `id`, discriminator metadata and no format assertions.
// Ajv 8 defaults to draft-07 and rejects unknown keywords, so: `strict: false` ignores HL7's `id` and `discriminator` annotations
// (Ajv 6 ignored them too; every field/required/type/enum check is still enforced), and the draft-06 meta-schema is added explicitly.
// The meta-schema is not validated against itself (its own `$schema` is the one being added).
const ajv = new Ajv({ strict: false, allErrors: false });
ajv.addMetaSchema(JSON.parse(fs.readFileSync(new URL('../../node_modules/ajv/dist/refs/json-schema-draft-06.json', import.meta.url))), undefined, false);
ajv.addSchema(schema, 'fhir-r4');
export const validateSchema = ajv.compile({ $ref: 'fhir-r4#/definitions/Bundle' });
// R4 JSON schema omits required primitive cardinalities (extension-only values are legal).
// This preview supplies actual values, so check those independently as well.
export const validate = (bundle) =>
  validateSchema(bundle) &&
  bundle.type === 'collection' &&
  bundle.entry.every(({ resource: r }) => {
    const required = { DiagnosticReport: 'status', Observation: 'status', DocumentReference: 'status', Provenance: 'recorded' }[r.resourceType];
    return !required || (typeof r[required] === 'string' && r[required].length > 0);
  });
