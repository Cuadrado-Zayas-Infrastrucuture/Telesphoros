import { profileSchema, type Profile } from './contracts';
import { hashBytes } from './evidence';

// A fixed synthetic identity, not an approved or signed production WorkflowPackage.
const profile: Profile = { version: 'synthetic.profile.v1', evidenceKind: 'synthetic-control-flow', taskKey: 'business.sop-draft.v1', locales: ['en', 'es'],
  roles: ['retrieval', 'draft', 'verification'], directorRequired: true, maxDepth: 1, maxRepair: 1, activation: 'disabled',
  profileDigest: hashBytes('synthetic.sop.profile.v1:retrieval,draft,verification,director:120000:4:28160:250000:1:2'),
  budget: { elapsedMs: 120000, slots: 4, tokens: 28160, costUnits: 250000, tenantActive: 1, fleetActive: 2 } };
export const syntheticProfile = (): Profile => profileSchema.parse(profile);
export function validProfile(input: unknown): input is Profile {
  const result = profileSchema.safeParse(input);
  return result.success && JSON.stringify(result.data) === JSON.stringify(profile);
}
export const liveReadiness = () => ({ ready: false as const, reasonCode: 'MODEL_EXECUTION_DISABLED' as const });

/**
 * FR-012: the conditions that must all be recorded before a live model call is allowed. The caller states them (this file reads no
 * environment); only the boolean `true` counts. Nothing wires this into a runtime yet: `liveReadiness()` above stays closed, and the
 * adapter that reads the founder's flag arrives with the Bedrock slice.
 */
export const READINESS_KEYS = ['baaExecuted', 'founderFlagSet', 'thresholdsMet', 'shadowReviewPassed', 'counselViewRecorded', 'monitorLive', 'rollbackRehearsed', 'clinicianDocument'] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];
export function readiness(conditions: Partial<Record<ReadinessKey, boolean>>): { ready: true } | { ready: false; reasonCode: 'NOT_READY'; missing: ReadinessKey[] } {
  const missing = READINESS_KEYS.filter(k => conditions[k] !== true);
  return missing.length === 0 ? { ready: true } : { ready: false, reasonCode: 'NOT_READY', missing };
}
