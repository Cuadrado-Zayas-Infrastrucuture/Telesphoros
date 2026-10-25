// A protocol test double, not OpenEMR. It exercises real HTTP, PKCE and signed OIDC.
import express from 'express';
import fs from 'node:fs';
const pgxTemplate = JSON.parse(fs.readFileSync(new URL('../src/pgx-fixture.json', import.meta.url), 'utf8'));
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { SCOPES, SYNTHETIC_TAG } from '../src/client.js';
import { hashChallenge } from '../src/router.js';

export function createSyntheticEhr({ origin, pilotOrigin, faults = {} }) {
  const app = express();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicJwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'synthetic-key',
    use: 'sig',
    alg: 'RS256',
  };
  const codes = new Map();
  const tokens = new Map();
  const requests = [];
  const issuer = `${origin}/fhir`;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    // Deliberately record only method/path: no codes, query strings or tokens.
    requests.push({ method: req.method, path: req.path });
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.path !== '/oauth/token') return res.status(405).end();
    return next();
  });
  app.get('/oauth/authorize', (req, res) => {
    const q = req.query;
    if (
      q.client_id !== 'synthetic-client' ||
      q.redirect_uri !== `${pilotOrigin}/auth/fhir/pilot/callback` ||
      q.aud !== issuer ||
      q.response_type !== 'code' ||
      q.code_challenge_method !== 'S256' ||
      q.scope !== SCOPES ||
      !['patient-a', 'patient-b', 'patient-no-consent', 'patient-invalid', 'patient-no-profile', 'patient-empty'].includes(q.launch)
    )
      return res.status(400).end();
    const code = crypto.randomBytes(32).toString('base64url');
    codes.set(code, { ...q, expires: Date.now() + 60000 });
    return res.redirect(`${q.redirect_uri}?${new URLSearchParams({ code, state: q.state })}`);
  });
  app.post('/oauth/token', (req, res) => {
    const q = codes.get(req.body.code);
    codes.delete(req.body.code);
    if (
      !q ||
      q.expires < Date.now() ||
      req.body.grant_type !== 'authorization_code' ||
      req.body.client_id !== q.client_id ||
      req.body.redirect_uri !== q.redirect_uri ||
      hashChallenge(req.body.code_verifier || '') !== q.code_challenge
    )
      return res.status(400).json({ error: 'invalid_grant' });
    const access = crypto.randomBytes(32).toString('base64url');
    tokens.set(access, q.launch);
    const idToken = jwt.sign(
      {
        sub: faults.subject ?? `synthetic-${q.launch}`,
        ...(faults.azp ? { azp: faults.azp } : {}),
        nonce: faults.nonce ? 'wrong' : q.nonce,
        fhirUser: `${issuer}/${faults.person ? 'Person' : 'Practitioner'}/${q.launch === 'patient-b' ? 'clinician-b' : 'clinician-a'}`,
      },
      privateKey,
      {
        algorithm: 'RS256',
        ...(faults.withKid ? { keyid: 'synthetic-key' } : {}),
        issuer: faults.issuer || `${origin}/oauth`,
        audience: faults.audience || q.client_id,
        expiresIn: faults.expired ? -10 : 300,
      },
    );
    return res.json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 300,
      scope: faults.scope || `${SCOPES} nonce`,
      patient: q.launch,
      encounter: `encounter-${q.launch}`,
      id_token: faults.signature ? `${idToken.slice(0, -8)}aaaaaaaa` : idToken,
    });
  });
  app.get('/oauth/jwks', (_req, res) =>
    res.json({
      keys: faults.ambiguousKeys ? [publicJwk, { ...publicJwk, kid: 'second-key' }] : [publicJwk],
    }),
  );
  app.use('/fhir', (req, res, next) => {
    const patient = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!patient) return res.status(401).end();
    req.syntheticPatient = patient;
    return next();
  });
  app.get('/fhir/Patient/:id', (req, res) => {
    if (req.params.id !== req.syntheticPatient) return res.status(403).end();
    return res.json({
      resourceType: 'Patient',
      id: req.params.id,
      meta: {
        tag: faults.nonSynthetic ? [] : [{ system: SYNTHETIC_TAG, code: 'synthetic' }],
      },
    });
  });
  app.get('/fhir/MedicationRequest', (req, res) => {
    if (req.query.patient !== req.syntheticPatient) return res.status(403).end();
    faults.onMedicationRead?.();
    const second = req.query.page === '2';
    const medication = {
      resourceType: 'MedicationRequest',
      id: second ? 'synthetic-med-b' : 'synthetic-med-a',
      status: faults.unknownStatus ? 'unknown' : 'active',
      intent: 'order',
      subject: {
        reference: `Patient/${faults.crossPatient ? 'wrong-patient' : req.syntheticPatient}`,
      },
      medicationCodeableConcept: {
        text: second ? 'Synthetic fixture medication B' : 'Synthetic fixture medication A',
        coding: faults.uncoded
          ? []
          : [
              {
                system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
                code: second ? 'synthetic-b' : 'synthetic-a',
              },
            ],
      },
    };
    return res.json({
      resourceType: 'Bundle',
      type: faults.bundleType || 'collection',
      entry: req.syntheticPatient === 'patient-empty' ? [] : [{ resource: medication }],
      link: second
        ? []
        : [
            {
              relation: 'next',
              url:
                (faults.loop ? `${issuer}/MedicationRequest?patient=${req.syntheticPatient}&_count=50` : faults.next) ||
                `${issuer}/MedicationRequest?patient=${req.syntheticPatient}&page=2`,
            },
          ],
    });
  });
  return {
    app,
    requests,
    registration: {
      tenantId: 'synthetic-office',
      clientId: 'synthetic-client',
      issuer,
      authorizationEndpoint: `${origin}/oauth/authorize`,
      tokenEndpoint: `${origin}/oauth/token`,
      jwksUri: `${origin}/oauth/jwks`,
      oidcIssuer: `${origin}/oauth`,
      patients: ['patient-a', 'patient-b', 'patient-no-consent', 'patient-invalid', 'patient-no-profile', 'patient-empty'].map((fhirId, index) => ({
        fhirId,
        patientId: `pat_${String(index + 1).padStart(24, '0')}`,
        pgx: {
          ...pgxTemplate,
          versions: pgxTemplate.versions.map((v) => ({
            ...structuredClone(v),
            patientId: `pat_${String(index + 1).padStart(24, '0')}`,
          })),
        },
        consent: fhirId !== 'patient-no-consent',
        interpretable: fhirId !== 'patient-invalid',
        profile:
          fhirId === 'patient-no-profile'
            ? []
            : [
                {
                  gene: 'CYP2C19',
                  result: 'Synthetic fixture; not a clinical interpretation',
                },
              ],
      })),
    },
  };
}
