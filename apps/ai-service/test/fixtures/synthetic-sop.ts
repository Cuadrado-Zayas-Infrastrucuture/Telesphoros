import type { Candidate, Context, Source } from '../../src/contracts';

// Hand-written fictitious policies and independent literal SHA-256 vectors.
export const texts = { en: 'Record the ticket reference and assign the support owner.', es: 'Registre la referencia del ticket y asigne el responsable de soporte.' };
export const sourceDigest = {
  en: 'sha256:1a874a9e4cfeba51a11a160334fba5c537ca7d0881a8e82061afc78506ac98dc',
  es: 'sha256:16a23438aefb4f1b48ee4abf4a5c67c026293574e5dcd2dc651fe6b04a8a900d',
};
export function fixture(locale: 'en' | 'es' = 'en', tenant = 'tenant-a') {
  const body = texts[locale];
  const source: Source = { id: `sop-${locale}`, tenantId: tenant, version: 'v1', body, digest: sourceDigest[locale] };
  const context: Context = {
    tenantId: tenant,
    requesterRef: 'staff-a',
    authorityGeneration: 1,
    purpose: 'business-assistance',
    sources: [{ id: source.id, version: 'v1', digest: source.digest }],
  };
  const request = {
    schemaVersion: 'agentic.request.v1',
    taskKey: 'business.sop-draft.v1',
    locale,
    question: locale === 'en' ? 'How do I route a routine support request?' : '¿Cómo asigno una solicitud de soporte?',
    idempotencyKey: 'fixture-1',
  };
  const candidate: Candidate = {
    text: body,
    digest: source.digest,
    claims: [{ id: 'claim-1', text: body, sourceId: source.id, startByte: 0, endByte: locale === 'en' ? 57 : 69 }],
  };
  return { source, context, request, candidate };
}
