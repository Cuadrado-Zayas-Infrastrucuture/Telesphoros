import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { createStoredPgxReader } from "../src/stored-pgx.js";
import * as client from "../src/client.js";
import { validate, validateSchema } from "./fhir-r4/validate.js";

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-10-11T12:00:00Z";
const clock = () => Date.parse(time);
const clinician = "Practitioner/clinician-a";
const binding = { tenantId: "synthetic-office", patientId: "pat_000000000000000000000001", fhirPatient: "patient-a", issuer: "http://127.0.0.1:8301/fhir" };
let config, selection, records, calls, onRead;
const build = () => createStoredPgxReader(config, clock);
const read = () => build()(selection, clinician, binding);
beforeEach(() => {
  const token = jwt.sign({ sub: "synthetic-reader", iss: "http://127.0.0.1:4010", client_id: "synthetic-client", token_use: "access", exp: clock() / 1000 + 120,
    "cognito:groups": ["tenant:alpha", "clinician"] }, crypto.randomBytes(32));
  config = { mode: "stored-synthetic", apiBaseUrl: "http://127.0.0.1:3010/api/v1", issuer: "http://127.0.0.1:4010", clientId: "synthetic-client",
    readers: [{ ehrIssuer: binding.issuer, clinician, subject: "synthetic-reader", tenantId: "alpha", token }] };
  selection = { patientId: uuid(1), label: "SYN-STORED-1", evaluationId: uuid(3) };
  const decision = { id: uuid(5), captureId: uuid(4), decision: "accepted", textSha256: "b".repeat(64), popplerVersion: "synthetic/1", note: null, createdAt: time };
  records = {
    "/me": { roles: ["clinician"] },
    [`/patients/${uuid(1)}`]: { id: uuid(1), label: selection.label, createdAt: time, updatedAt: time },
    [`/reports/${uuid(2)}`]: { id: uuid(2), patientId: uuid(1), type: "lab-pdf", filename: "source.pdf", sizeBytes: 123, status: "processed", fileUploaded: true, contentType: "application/pdf", sha256: "a".repeat(64), createdAt: time, updatedAt: time },
    [`/captures/${uuid(4)}`]: { id: uuid(4), reportId: uuid(2), pdfSha256: "a".repeat(64), textSha256: "b".repeat(64), textScalars: 50, popplerVersion: "synthetic/1", runner: "fake", createdAt: time, latestDecision: decision },
    [`/evaluations/${uuid(3)}`]: { id: uuid(3), reportId: uuid(2), patientId: uuid(1), captureId: uuid(4), acceptance: { id: uuid(5), decision: "accepted", current: true },
      disposition: "evaluated", holdCode: null, hold: null, knowledgeSetId: "stored-knowledge-digest", engineVersion: "stored-engine-1", scope: "synthetic-test-only/1", clinicalUse: "not-approved", actionable: false, state: "active", supersededBy: null, current: true,
      results: [], geneInputs: [], geneStates: [{ gene: "CYP2C19", state: "canonical", phenotype: "intermediate metabolizer", diplotype: "*1/*2", activityScore: null, reasonCode: null }], corrections: [], advisory: { activeDisputes: 0 }, createdAt: time },
  };
  calls = []; onRead = () => {};
  vi.spyOn(client, "requestJson").mockImplementation(async (url, options) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    calls.push({ path, options }); onRead(path, calls.length);
    if (!records[path]) throw new Error("unavailable");
    return structuredClone(records[path]);
  });
});
afterEach(() => vi.restoreAllMocks());
const evaluation = () => records[`/evaluations/${uuid(3)}`];
const report = () => records[`/reports/${uuid(2)}`];
const capture = () => records[`/captures/${uuid(4)}`];

test("maps authorized stored DTOs through the common R4 builder without fabricated bytes, versions or recommendation text", async () => {
  evaluation().results = [{ drug: "synthetic-drug", genes: ["CYP2C19"], outcome: "shown", reasonCode: null, strength: null, citation: null, recommendationText: "DO NOT EXPORT THIS", implication: null, geneEvidence: null }];
  const result = await read();
  expect(validate(result.bundle), JSON.stringify(validateSchema.errors)).toBe(true);
  expect(result.expires).toBe(clock() + 120000);
  const resources = result.bundle.entry.map(e => e.resource);
  const document = resources.find(r => r.resourceType === "DocumentReference");
  const attachment = document.content[0].attachment;
  expect(attachment).toMatchObject({ contentType: "application/pdf", extension: [{ valueString: "a".repeat(64) }] });
  expect(attachment.data).toBeUndefined(); expect(attachment.url).toBeUndefined(); expect(attachment.hash).toBeUndefined();
  expect(document.extension.some(e => e.url.endsWith("source-version-id"))).toBe(false);
  expect(resources.find(r => r.resourceType === "DiagnosticReport").identifier[0].value).toBe(uuid(3));
  expect(resources.find(r => r.resourceType === "DiagnosticReport").extension.map(e => e.valueString)).toContain(uuid(4));
  expect(JSON.stringify(result)).not.toContain("DO NOT EXPORT THIS");
  expect(JSON.stringify(result)).not.toContain(config.readers[0].token);
  expect(calls).toHaveLength(9);
  expect(calls.every(c => c.options.token === config.readers[0].token && !c.options.form)).toBe(true);
});
test("does not infer a genotype when the stored canonical phenotype has no diplotype", async () => {
  evaluation().geneStates[0].diplotype = null;
  const result = await read();
  expect(validate(result.bundle)).toBe(true);
  expect(result.bundle.entry.filter(e => e.resource.resourceType === "Observation")).toHaveLength(1);
  expect(JSON.stringify(result.bundle)).not.toContain("84413-4");
});
test("multiple genes get unique identifiers and closed references", async () => {
  evaluation().geneStates.push({ ...evaluation().geneStates[0], gene: "CYP2B6", phenotype: "normal metabolizer", diplotype: "*1/*1" });
  const { bundle } = await read();
  expect(validate(bundle)).toBe(true);
  const entries = new Map(bundle.entry.map(e => [e.fullUrl, e.resource]));
  expect(entries.size).toBe(9);
  const ids = bundle.entry.filter(e => e.resource.resourceType === "Observation").map(e => JSON.stringify(e.resource.identifier));
  expect(new Set(ids).size).toBe(4);
  const walk = value => { if (value && typeof value === "object") { if (value.reference) expect(entries.has(value.reference)).toBe(true); Object.values(value).forEach(walk); } };
  walk(bundle);
});
test.each([
  ["wrong principal", () => { config.readers[0].subject = "another-user"; }],
  ["wrong tenant", () => { config.readers[0].tenantId = "beta"; }],
  ["wrong issuer", () => { config.issuer = "http://127.0.0.1:4011"; }],
  ["wrong client", () => { config.clientId = "other"; }],
  ["reader-only role", () => { records["/me"].roles = ["reader"]; }],
  ["patient label mismatch", () => { records[`/patients/${uuid(1)}`].label = "SYN-OTHER"; }],
  ["cross-patient evaluation", () => { evaluation().patientId = uuid(99); }],
  ["non-synthetic scope", () => { evaluation().scope = null; }],
  ["clinical approval", () => { evaluation().clinicalUse = "approved"; }],
  ["actionable", () => { evaluation().actionable = true; }],
  ["held", () => { evaluation().disposition = "held"; }],
  ["retracted", () => { evaluation().state = "retracted"; }],
  ["superseded", () => { evaluation().state = "superseded"; }],
  ["not current", () => { evaluation().current = false; }],
  ["dispute", () => { evaluation().advisory.activeDisputes = 1; }],
  ["stale acceptance", () => { evaluation().acceptance.current = false; }],
  ["rejected acceptance", () => { evaluation().acceptance.decision = "rejected"; }],
  ["capture decision changed", () => { capture().latestDecision.id = uuid(99); }],
  ["wrong report patient", () => { report().patientId = uuid(99); }],
  ["wrong capture report", () => { capture().reportId = uuid(99); }],
  ["wrong source digest", () => { report().sha256 = "c".repeat(64); }],
  ["unverified upload", () => { report().fileUploaded = false; }],
  ["unresolved gene", () => { evaluation().geneStates[0].state = "unresolved"; }],
  ["missing phenotype", () => { evaluation().geneStates[0].phenotype = null; }],
  ["no genes", () => { evaluation().geneStates = []; }],
  ["duplicate gene", () => { evaluation().geneStates.push(evaluation().geneStates[0]); }],
])("withholds %s with a successful control", async (_name, mutate) => {
  expect((await read()).bundle.resourceType).toBe("Bundle"); mutate(); await expect(read()).rejects.toThrow();
});
test.each(["/patients/", "/reports/", "/captures/", "/evaluations/"])("refuses %s changes during assembly", async prefix => {
  await read(); calls.length = 0;
  const seen = new Set();
  onRead = path => { if (!path.startsWith(prefix)) return; if (seen.has(path)) records[path].createdAt = "2026-10-12T00:00:00Z"; seen.add(path); };
  await expect(read()).rejects.toThrow("stored_context_changed");
});
test("refuses a backend credential that expires during closing reads", async () => {
  let now = clock(); const reader = createStoredPgxReader(config, () => now);
  await reader(selection, clinician, binding); calls.length = 0;
  onRead = (_p, count) => { if (count === 9) now += 121000; };
  await expect(reader(selection, clinician, binding)).rejects.toThrow("stored_token_expired");
});
test("unmapped clinician makes no backend request", async () => {
  await expect(build()(selection, "Practitioner/other", binding)).rejects.toThrow("stored_reader_unavailable");
  expect(calls).toHaveLength(0);
});
test("unavailable API never maps a static substitute", async () => {
  await read(); vi.mocked(client.requestJson).mockRejectedValue(new Error("unavailable"));
  await expect(read()).rejects.toThrow("unavailable");
});
test.each(["https://example.com/api/v1", "http://127.0.0.1:3010/other", "http://127.0.0.1:3010/api/v1?override=1"])("rejects unsafe API base %s", url => {
  config.apiBaseUrl = url; expect(build).toThrow(); expect(calls).toHaveLength(0);
});

test("the same clinician identifier from a different EHR cannot use the credential", async () => {
  await expect(build()(selection, clinician, { ...binding, issuer: "http://127.0.0.1:8302/fhir" })).rejects.toThrow("stored_reader_unavailable");
  expect(calls).toHaveLength(0);
});
