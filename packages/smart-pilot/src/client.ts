import crypto from "node:crypto";
import axios from "axios";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  registrationSchema,
  patientSchema,
  medicationSchema,
  bundleSchema,
  tokenSchema,
} from "./types.js";
import type { Registration, Flow, Context, Medication } from "./types.js";
export const SCOPES =
  "launch openid fhirUser patient/Patient.r patient/MedicationRequest.rs";
const ID = /^[A-Za-z0-9.-]{1,64}$/;
export const SYNTHETIC_TAG = "https://telesphoros.app/synthetic-smart-pilot";

export function fail(code: string): never {
  const error = Object.assign(new Error(code), { code });
  throw error;
}

export function loopbackUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  )
    fail("pilot_requires_loopback");
  return url;
}

export function validateRegistration(value: unknown): Registration {
  const registration = registrationSchema.parse(value);
  if (!registration || !registration.tenantId || !registration.clientId)
    fail("invalid_registration");
  const issuer = loopbackUrl(registration.issuer);
  if (issuer.search || issuer.pathname.endsWith("/")) fail("invalid_fhir_base");
  for (const field of [
    "authorizationEndpoint",
    "tokenEndpoint",
    "jwksUri",
    "oidcIssuer",
  ] as const) {
    if (loopbackUrl(registration[field]).origin !== issuer.origin)
      fail("untrusted_oauth_endpoint");
  }
  if (!Array.isArray(registration.patients) || !registration.patients.length)
    fail("missing_patient_mapping");
  const ids = new Set();
  for (const p of registration.patients) {
    if (
      !ID.test(p.fhirId) ||
      !/^pat_[a-f0-9]{24}$/.test(p.patientId) ||
      ids.has(p.fhirId)
    )
      fail("invalid_patient_mapping");
    ids.add(p.fhirId);
  }
  return registration;
}

// No caller-supplied method or redirects: the sole outbound write is OAuth's token exchange.
export async function requestJson(
  url: string,
  { token, form }: { token?: string; form?: URLSearchParams } = {},
): Promise<unknown> {
  loopbackUrl(url);
  const response = await axios({
    url,
    method: form ? "POST" : "GET",
    data: form,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    timeout: 5000,
    maxRedirects: 0,
    maxContentLength: 1024 * 1024,
    proxy: false,
    validateStatus: (status) => status === 200,
  });
  if (!response.data || typeof response.data !== "object")
    fail("invalid_json_response");
  return response.data;
}

export function normalizeClinician(value: unknown, issuer: string) {
  if (typeof value !== "string") fail("missing_clinician");
  const relative = value.startsWith(`${issuer}/`)
    ? value.slice(issuer.length + 1)
    : value;
  if (!/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]{1,64}$/.test(relative))
    fail("invalid_clinician");
  return relative;
}

export async function exchange(
  registration: Registration,
  flow: Flow,
  code: string,
): Promise<Context> {
  const response = tokenSchema.parse(
    await requestJson(registration.tokenEndpoint, {
      form: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registration.clientId,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
      }),
    }),
  );
  const granted = new Set(
    String(response.scope || "")
      .split(/\s+/)
      .filter(Boolean),
  );
  // OpenEMR ScopeRepository adds this non-resource scope when nonce is supplied.
  // It grants no FHIR operation; all requested read scopes are still required.
  const allowedGranted = new Set([...SCOPES.split(" "), "nonce"]);
  if (
    SCOPES.split(" ").some((scope) => !granted.has(scope)) ||
    [...granted].some((scope) => !allowedGranted.has(scope))
  )
    fail("invalid_granted_scope");
  if (
    typeof response.access_token !== "string" ||
    response.access_token.length > 16384 ||
    String(response.token_type).toLowerCase() !== "bearer" ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 0 ||
    !ID.test(response.patient || "") ||
    (response.encounter && !ID.test(response.encounter))
  )
    fail("invalid_token_context");
  const decoded = jwt.decode(response.id_token, { complete: true });
  if (
    !decoded ||
    decoded.header.alg !== "RS256" ||
    (decoded.header.kid !== undefined && typeof decoded.header.kid !== "string")
  )
    fail("invalid_identity_token");
  const jwks = z
    .object({
      keys: z.array(
        z.object({
          kid: z.string().optional(),
          kty: z.string(),
          use: z.string().optional(),
          alg: z.string().optional(),
          n: z.string().optional(),
          e: z.string().optional(),
        }),
      ),
    })
    .parse(await requestJson(registration.jwksUri));
  const keys = (jwks.keys || []).filter(
    (key) =>
      (decoded.header.kid === undefined || key.kid === decoded.header.kid) &&
      key.kty === "RSA" &&
      (!key.use || key.use === "sig") &&
      (!key.alg || key.alg === "RS256"),
  );
  // OpenEMR can omit kid. Accept only one eligible pinned JWKS key in that case,
  // never choose arbitrarily during rotation, and always verify the signature.
  if (keys.length !== 1) fail("invalid_signing_key");
  const key = crypto.createPublicKey({ key: keys[0], format: "jwk" });
  const claims = jwt.verify(response.id_token, key, {
    algorithms: ["RS256"],
    issuer: registration.oidcIssuer,
    audience: registration.clientId,
    clockTolerance: 5,
  });
  if (
    typeof claims === "string" ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    (claims.azp !== undefined && claims.azp !== registration.clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.nonce !== flow.nonce ||
    (Array.isArray(claims.aud) &&
      claims.aud.length > 1 &&
      claims.azp !== registration.clientId)
  )
    fail("invalid_identity_claims");
  return {
    token: response.access_token,
    patient: response.patient,
    encounter: response.encounter || null,
    user: normalizeClinician(claims.fhirUser, registration.issuer),
    expires: Math.min(
      Date.now() + 15 * 60 * 1000,
      Date.now() + response.expires_in * 1000,
      claims.exp! * 1000,
    ),
  };
}

function patientReferenceMatches(
  reference: string,
  issuer: string,
  patientId: string,
) {
  return (
    reference === `Patient/${patientId}` ||
    reference === `${issuer}/Patient/${patientId}`
  );
}

export async function readContext(
  registration: Registration,
  session: Context,
) {
  const mapping = registration.patients.find(
    (patient) => patient.fhirId === session.patient,
  );
  if (!mapping) fail("identity_unavailable");
  const base = registration.issuer;
  const patient = patientSchema.parse(
    await requestJson(`${base}/Patient/${session.patient}`, {
      token: session.token,
    }),
  );
  if (patient.resourceType !== "Patient" || patient.id !== session.patient)
    fail("patient_context_mismatch");
  // Only fixtures explicitly marked in the EHR are accepted. No demographic matching.
  const tagged = patient.meta?.tag?.some(
    (tag) => tag.system === SYNTHETIC_TAG && tag.code === "synthetic",
  );
  const marked =
    /^TSP-SYNTHETIC-[0-9]+$/.test(mapping.syntheticIdentifier || "") &&
    patient.identifier?.some(
      (identifier) =>
        identifier.system === "http://terminology.hl7.org/CodeSystem/v2-0203" &&
        identifier.value === mapping.syntheticIdentifier,
    );
  if (!tagged && !marked) fail("synthetic_patient_required");
  let next: string | undefined =
    `${base}/MedicationRequest?patient=${encodeURIComponent(session.patient)}&_count=50`;
  let currentPage = next;
  const visited = new Set();
  const medications: z.infer<typeof medicationSchema>[] = [];
  while (next) {
    // Relative references are resolved against the page that supplied them.
    const url = new URL(next, currentPage);
    if (
      url.origin !== new URL(base).origin ||
      url.pathname !== `${new URL(base).pathname}/MedicationRequest` ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("patient").length !== 1 ||
      url.searchParams.get("patient") !== session.patient ||
      visited.has(url.href) ||
      visited.size >= 20
    )
      fail("unsafe_fhir_pagination");
    currentPage = url.href;
    visited.add(url.href);
    const bundle = bundleSchema.parse(
      await requestJson(url.href, { token: session.token }),
    );
    if (
      bundle.resourceType !== "Bundle" ||
      !["searchset", "collection"].includes(bundle.type) ||
      !Array.isArray(bundle.entry || [])
    )
      fail("invalid_medication_bundle");
    for (const entry of bundle.entry || []) {
      const resource = entry.resource;
      if (
        !resource ||
        resource.resourceType !== "MedicationRequest" ||
        !patientReferenceMatches(
          resource.subject?.reference,
          base,
          session.patient,
        )
      )
        fail("medication_context_mismatch");
      medications.push(resource);
      if (medications.length > 1000) fail("medication_limit_exceeded");
    }
    const links = (bundle.link || []).filter(
      (link) => link.relation === "next",
    );
    if (links.length > 1 || (links.length && typeof links[0].url !== "string"))
      fail("unsafe_fhir_pagination");
    next = links[0]?.url;
  }
  const active = medications.filter((med) => med.status === "active");
  const uncertain = medications.filter(
    (med) =>
      ![
        "active",
        "cancelled",
        "completed",
        "stopped",
        "entered-in-error",
      ].includes(med.status || ""),
  );
  // Display-only adapter. It does not construct or invoke a clinical evaluation request.
  const extracted: Medication[] = active.map((med) => {
    const coding = med.medicationCodeableConcept?.coding || [];
    const rxnorm = coding.find(
      (code) => code.system === "http://www.nlm.nih.gov/research/umls/rxnorm",
    );
    return {
      requestId: med.id || null,
      drug:
        med.medicationCodeableConcept?.text ||
        rxnorm?.display ||
        coding.find((code) => code.display)?.display ||
        null,
      rxcui: rxnorm?.code || null,
    };
  });
  return {
    mapping,
    medications: extracted,
    uncertainCount: uncertain.length,
    unmappedCount: active.filter(
      (med) =>
        !med.medicationCodeableConcept?.coding?.some(
          (code) =>
            code.system === "http://www.nlm.nih.gov/research/umls/rxnorm" &&
            code.code,
        ),
    ).length,
    pages: visited.size,
  };
}
