import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import Ajv from "ajv";
const rawSchema = zlib.gunzipSync(fs.readFileSync(new URL("./fhir.schema.json.gz", import.meta.url)));
if (crypto.createHash("sha256").update(rawSchema).digest("hex") !== "2230406893b4cf002a4ee1e5e2bbeca22ac5d2d4931b3e9ef7b9594bbc376a01") throw new Error("FHIR schema digest mismatch");
const schema = JSON.parse(rawSchema);
// HL7's draft-06 schema uses `id`, discriminator metadata and no format assertions.
// Explicitly selected draft-06 meta-schema; don't relax field/required/type checks.
const ajv = new Ajv({ schemaId: "auto", allErrors: false });
ajv.addMetaSchema(JSON.parse(fs.readFileSync(new URL("../../node_modules/ajv/lib/refs/json-schema-draft-06.json", import.meta.url))));
ajv.addSchema(schema, "fhir-r4");
export const validateSchema = ajv.compile({ $ref: "fhir-r4#/definitions/Bundle" });
// R4 JSON schema omits required primitive cardinalities (extension-only values are legal).
// This preview supplies actual values, so check those independently as well.
export const validate = bundle => validateSchema(bundle) && bundle.type === "collection" &&
  bundle.entry.every(({ resource: r }) => {
    const required = { DiagnosticReport: "status", Observation: "status", DocumentReference: "status", Provenance: "recorded" }[r.resourceType];
    return !required || (typeof r[required] === "string" && r[required].length > 0);
  });
