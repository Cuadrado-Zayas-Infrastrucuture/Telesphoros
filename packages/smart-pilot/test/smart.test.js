import express from "express";
import http from "node:http";
import request from "supertest";
import { createPilotRouter } from "../src/router.js";
import { createSyntheticEhr } from "./synthetic-ehr.js";

const pilotOrigin = "http://127.0.0.1:8765";
let ehrServer;
let fixture;
let agent;
let clock;
async function setup(faults = {}) {
  let handler;
  ehrServer = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => ehrServer.listen(0, "127.0.0.1", resolve));
  fixture = createSyntheticEhr({
    origin: `http://127.0.0.1:${ehrServer.address().port}`,
    pilotOrigin,
    faults,
  });
  handler = fixture.app;
  const app = express();
  clock = Date.now();
  app.use(
    createPilotRouter({
      origin: pilotOrigin,
      registrations: { openemr: fixture.registration },
      now: () => clock,
    }),
  );
  agent = request.agent(app);
}
const get = (path) => agent.get(path).set("Host", "127.0.0.1:8765");
async function begin(patient = "patient-a") {
  const launch = await get(
    `/auth/fhir/pilot/launch/openemr?${new URLSearchParams({ iss: fixture.registration.issuer, launch: patient })}`,
  );
  expect(launch.status).toBe(302);
  const authorization = await fetch(launch.headers.location, {
    redirect: "manual",
  });
  expect(authorization.status).toBe(302);
  const callback = new URL(authorization.headers.get("location"));
  return callback.pathname + callback.search;
}
async function login(patient) {
  const callback = await begin(patient);
  const response = await get(callback);
  expect(response.status).toBe(302);
  return new URLSearchParams(response.headers.location.split("#")[1]).get(
    "smart_session",
  );
}
const evidence = (token) =>
  get("/auth/fhir/pilot/evidence").set("Authorization", `Bearer ${token}`);
afterEach(async () => {
  if (ehrServer) {
    ehrServer.closeAllConnections();
    await new Promise((resolve) => ehrServer.close(resolve));
  }
});

test("real HTTP OAuth, PKCE, signed identity and two-page FHIR context; no EHR writes", async () => {
  await setup();
  const response = await evidence(await login());
  expect(response.status).toBe(200);
  expect(response.body.status).toBe("synthetic_context_ready");
  expect(response.body.pagesRead).toBe(2);
  expect(response.body.medications).toHaveLength(2);
  expect(response.body.clinician).toBe("Practitioner/clinician-a");
  expect(response.body.clinicalRecommendationsEnabled).toBe(false);
  expect(JSON.stringify(response.body)).not.toMatch(
    /access_token|refresh_token|id_token/,
  );
  expect(
    fixture.requests.filter((r) => r.method !== "GET").map((r) => r.path),
  ).toEqual(["/oauth/token"]);
});
test("simultaneous launch sessions retain separate clinician and patient contexts", async () => {
  await setup();
  const [a, b] = await Promise.all([begin("patient-a"), begin("patient-b")]);
  const tokens = [];
  for (const callback of [a, b]) {
    const result = await get(callback);
    expect(result.status).toBe(302);
    tokens.push(
      new URLSearchParams(result.headers.location.split("#")[1]).get(
        "smart_session",
      ),
    );
  }
  const [ra, rb] = await Promise.all(tokens.map(evidence));
  expect(ra.body.patient).toBe("patient-a");
  expect(rb.body.patient).toBe("patient-b");
  expect(ra.body.clinician).toBe("Practitioner/clinician-a");
  expect(rb.body.clinician).toBe("Practitioner/clinician-b");
});
test("callback replay and callback from another browser are rejected", async () => {
  await setup();
  const callback = await begin();
  const outsider = request(
    express().use(
      createPilotRouter({
        origin: pilotOrigin,
        registrations: { openemr: fixture.registration },
      }),
    ),
  );
  expect(
    (await outsider.get(callback).set("Host", "127.0.0.1:8765")).status,
  ).toBe(400);
  expect((await get(callback)).status).toBe(302);
  expect((await get(callback)).status).toBe(400);
});
test.each(["nonce", "audience", "issuer", "expired", "signature", "scope"])(
  "rejects invalid OIDC/scope: %s",
  async (fault) => {
    await setup({
      [fault]:
        fault === "scope" ? "launch openid fhirUser patient/*.write" : true,
    });
    expect((await get(await begin())).status).toBe(400);
  },
);
test.each([
  ["nonSynthetic", true],
  ["crossPatient", true],
  ["next", "https://example.com/steal"],
  ["next", "/fhir/MedicationRequest?patient=another-patient"],
])("rejects unsafe clinical context: %s", async (fault, value) => {
  await setup({ [fault]: value });
  expect((await evidence(await login())).status).toBe(422);
});
test.each([
  ["patient-no-consent", "consent_required"],
  ["patient-invalid", "genotype_not_interpretable"],
  ["patient-no-profile", "pgx_unavailable"],
  ["patient-empty", "medications_unavailable"],
])("shows explicit unavailable state for %s", async (patient, status) => {
  await setup();
  const response = await evidence(await login(patient));
  expect(response.status).toBe(200);
  expect(response.body.status).toBe(status);
  if (["consent_required", "genotype_not_interpretable"].includes(status))
    expect(response.body.profile).toHaveLength(0);
});
test.each(["unknownStatus", "uncoded"])(
  "does not interpret incomplete medications: %s",
  async (fault) => {
    await setup({ [fault]: true });
    const response = await evidence(await login());
    expect(["medications_incomplete", "medications_unavailable"]).toContain(
      response.body.status,
    );
  },
);
test("rejects caller tenant/scope overrides, foreign issuer, host rebinding and writes", async () => {
  await setup();
  const base = `/auth/fhir/pilot/launch/openemr?${new URLSearchParams({ iss: fixture.registration.issuer, launch: "patient-a" })}`;
  for (const suffix of ["&tenant_id=other", "&scope=patient/*.write"])
    expect((await get(base + suffix)).status).toBe(400);
  expect(
    (
      await get(
        "/auth/fhir/pilot/launch/openemr?iss=https://foreign.example&launch=x",
      )
    ).status,
  ).toBe(400);
  expect((await agent.get(base).set("Host", "foreign.example")).status).toBe(
    400,
  );
  expect(
    (
      await agent
        .post("/auth/fhir/pilot/evidence")
        .set("Host", "127.0.0.1:8765")
    ).status,
  ).toBe(405);
});
test("expires sessions and authorization state", async () => {
  await setup();
  const token = await login();
  const callback = await begin();
  clock += 16 * 60 * 1000;
  expect((await evidence(token)).status).toBe(401);
  expect((await get(callback)).status).toBe(400);
});

test("supports an explicitly identified signing key", async () => {
  await setup({ withKid: true });
  expect((await evidence(await login())).status).toBe(200);
});
test.each(["ambiguousKeys", "person"])(
  "rejects ambiguous keys or non-clinician identity: %s",
  async (fault) => {
    await setup({ [fault]: true });
    expect((await get(await begin())).status).toBe(400);
  },
);
test("stops cyclic pagination without repeatedly fetching", async () => {
  await setup({ loop: true });
  expect((await evidence(await login())).status).toBe(422);
  expect(
    fixture.requests.filter((r) => r.path === "/fhir/MedicationRequest"),
  ).toHaveLength(1);
});
test("does not accept a known EHR patient without exact local mapping", async () => {
  await setup();
  fixture.registration.patients = fixture.registration.patients.filter(
    (p) => p.fhirId !== "patient-a",
  );
  expect((await evidence(await login())).status).toBe(422);
});

test.each(["searchset", "collection", "transaction"])(
  "accepts only supported medication bundle shapes: %s",
  async (bundleType) => {
    await setup({ bundleType });
    const response = await evidence(await login());
    expect(response.status).toBe(bundleType === "transaction" ? 422 : 200);
  },
);
