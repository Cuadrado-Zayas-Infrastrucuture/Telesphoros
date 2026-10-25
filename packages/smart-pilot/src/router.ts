import express from 'express';
import type { StoredPgxReader } from './stored-pgx.js';
import { mapPgxToFhir } from './pgx-fhir.js';
import crypto from 'node:crypto';
import { SCOPES, fail, loopbackUrl, validateRegistration, exchange, readContext } from './client.js';
import type { Registration, Flow, Session, Diagnostic } from './types.js';
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function createPilotRouter({
  origin,
  registrations,
  now = Date.now,
  storedReader,
  onDiagnostic = () => {},
}: {
  origin: string;
  registrations: Record<string, Registration>;
  now?: () => number;
  storedReader?: StoredPgxReader;
  onDiagnostic?: (event: Diagnostic) => void;
}) {
  loopbackUrl(origin);
  for (const registration of Object.values(registrations)) validateRegistration(registration);
  const flows = new Map<string, Flow>();
  const sessions = new Map<string, Session>();
  const router = express.Router();
  function prune(store: Map<string, { expires: number }>) {
    for (const [key, value] of store) if (value.expires <= now()) store.delete(key);
    if (store.size >= 1000) fail('pilot_capacity_reached');
  }
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    });
    if (req.headers.host !== new URL(origin).host) return res.status(400).json({ error: 'invalid_host' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'read_only_pilot' });
    return next();
  });
  router.get('/auth/fhir/pilot/launch/:registration', async (req, res) => {
    try {
      const registration = registrations[String(req.params.registration)];
      if (
        !registration ||
        req.query.iss !== registration.issuer ||
        typeof req.query.launch !== 'string' ||
        !req.query.launch ||
        req.query.launch.length > 2048 ||
        Object.keys(req.query).some((key) => !['iss', 'launch', 'aud'].includes(key))
      )
        fail('invalid_launch');
      prune(flows);
      const state = random();
      const browser = random();
      const flow = {
        registration,
        verifier: random() + random(),
        nonce: random(),
        browser: hash(browser),
        redirectUri: `${origin}/auth/fhir/pilot/callback`,
        expires: now() + 5 * 60 * 1000,
      };
      flows.set(hash(state), flow);
      res.cookie(`smart_flow_${hash(state).slice(0, 16)}`, browser, {
        httpOnly: true,
        sameSite: 'lax',
        secure: origin.startsWith('https:'),
        maxAge: 5 * 60 * 1000,
        path: '/auth/fhir/pilot/callback',
      });
      const authorization = new URL(registration.authorizationEndpoint);
      authorization.search = new URLSearchParams({
        response_type: 'code',
        client_id: registration.clientId,
        redirect_uri: flow.redirectUri,
        scope: SCOPES,
        state,
        nonce: flow.nonce,
        launch: req.query.launch,
        aud: registration.issuer,
        code_challenge_method: 'S256',
        code_challenge: hashChallenge(flow.verifier),
      }).toString();
      return res.redirect(authorization.href);
    } catch {
      return res.status(400).json({ error: 'smart_launch_rejected' });
    }
  });
  router.get('/auth/fhir/pilot/callback', async (req, res) => {
    try {
      if (typeof req.query.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(req.query.state)) fail('invalid_state');
      const stateHash = hash(req.query.state);
      const flow = flows.get(stateHash);
      const cookieName = `smart_flow_${stateHash.slice(0, 16)}`;
      const browser = String(req.headers.cookie || '')
        .split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      if (!flow || flow.expires <= now() || !browser || hash(browser) !== flow.browser) fail('invalid_state');
      // Consume atomically before the first await; duplicate callbacks cannot exchange twice.
      flows.delete(stateHash);
      res.clearCookie(cookieName, { path: '/auth/fhir/pilot/callback' });
      if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) fail('invalid_code');
      const context = await exchange(flow.registration, flow, req.query.code);
      prune(sessions);
      const bearer = random();
      sessions.set(hash(bearer), {
        ...context,
        registration: flow.registration,
      });
      return res.redirect(`/smart/evidence#smart_session=${bearer}`);
    } catch (error) {
      onDiagnostic(diagnostic('callback', error));
      return res.status(400).json({ error: 'smart_authorization_rejected' });
    }
  });
  router.get('/auth/fhir/pilot/evidence', async (req, res) => {
    const bearer = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const session = bearer && sessions.get(hash(bearer));
    if (!session || session.expires <= now()) {
      if (bearer) sessions.delete(hash(bearer));
      return res.status(401).json({ error: 'smart_session_expired' });
    }
    try {
      const readStarted = now();
      const context = await readContext(session.registration, session);
      // Upstream pagination can outlive a session. Never release its data afterward.
      if (session.expires <= now()) {
        if (bearer) sessions.delete(hash(bearer));
        return res.status(401).json({ error: 'smart_session_expired' });
      }
      // Synthetic fixture display only: never invokes or bypasses held clinical generation.
      const fixture = context.mapping;
      let status = !fixture.consent
        ? 'consent_required'
        : !fixture.interpretable
          ? 'genotype_not_interpretable'
          : !fixture.stored && !fixture.profile?.length
            ? 'pgx_unavailable'
            : !context.medications.length
              ? 'medications_unavailable'
              : context.uncertainCount || context.unmappedCount
                ? 'medications_incomplete'
                : 'synthetic_context_ready';
      const binding = {
        tenantId: session.registration.tenantId,
        patientId: fixture.patientId,
        fhirPatient: session.patient,
        issuer: session.registration.issuer,
      };
      const stored = fixture.stored && storedReader && status === 'synthetic_context_ready' ? await storedReader(fixture.stored, session.user, binding) : null;
      const expires = Math.min(session.expires, stored?.expires ?? session.expires);
      if (expires <= now()) return res.status(401).json({ error: 'smart_session_expired' });
      const freshUntil = Math.min(expires, readStarted + 30000);
      if (freshUntil <= now()) fail('evidence_read_stale');
      // Selecting stored mode never falls back to registration fixtures, including on missing configuration.
      const preview = fixture.stored
        ? (stored?.bundle ?? null)
        : mapPgxToFhir(fixture.pgx, {
            ...binding,
            consent: fixture.consent,
            interpretable: fixture.interpretable,
            contextReady: status === 'synthetic_context_ready',
          });
      if (fixture.stored && !preview && status === 'synthetic_context_ready') status = stored?.history ? 'evaluation_withheld' : 'pgx_unavailable';
      return res.json({
        synthetic: true,
        clinicalRecommendationsEnabled: false,
        status,
        patient: session.patient,
        encounter: session.encounter,
        clinician: session.user,
        tenant: session.registration.tenantId,
        expiresAt: new Date(expires).toISOString(),
        freshUntil: new Date(freshUntil).toISOString(),
        correctionHistory: stored?.history ?? null,
        medications: context.medications,
        pagesRead: context.pages,
        uncertainMedicationCount: context.uncertainCount,
        unmappedMedicationCount: context.unmappedCount,
        profile: fixture.stored ? (stored?.profile ?? []) : fixture.consent && fixture.interpretable ? fixture.profile || [] : [],
        evidenceSource: fixture.stored ? 'stored-synthetic' : 'static-synthetic',
        pgxFhirPreview: preview,
        evidence: 'Synthetic integration fixture. No clinical recommendation was generated. Clinical release controls remain unchanged.',
      });
    } catch (error) {
      onDiagnostic(diagnostic('evidence', error));
      return res.status(422).json({
        error: 'clinical_context_unavailable',
        message: 'Patient identity or medication context could not be verified. No risk assessment is available.',
      });
    }
  });
  return router;
}
export function hashChallenge(value: string) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function diagnostic(stage: Diagnostic['stage'], error: unknown): Diagnostic {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return {
    stage,
    code: typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'upstream_validation_failed',
    status: null,
  };
}
