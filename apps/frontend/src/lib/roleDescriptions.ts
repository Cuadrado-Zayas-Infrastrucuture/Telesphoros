import type { Role } from '@telesphoros/shared-types';

/**
 * What each role allows, in words, for Settings. It describes the API's `@Roles` declarations (apps/backend/src/**.controller.ts); the
 * server checks every request, so this text never grants anything. Keep it in step when a route's roles change.
 */
export const ROLE_DESCRIPTIONS: Record<Role, { name: string; allows: string }> = {
  reader: {
    name: 'Reader',
    allows: 'Read patients, reports and their results. Cannot add or change records, or open report files.',
  },
  clinician: {
    name: 'Clinician',
    allows: 'Everything a reader can, plus add patients, upload reports, open report files, run evaluations and resolve patient matches.',
  },
  reviewer: {
    name: 'Reviewer',
    allows: 'Everything a reader can, plus open report files, review captured results, decide disputes and corrections, and resolve patient matches.',
  },
  admin: {
    name: 'Administrator',
    allows: "Manage this organization's members and invitations, and read its audit ledger. Sees no clinical data unless also given a clinical role.",
  },
};

export const NO_ROLE_DESCRIPTION = 'You are a member of this organization without a role yet: you can sign in, see this page and sign out. Ask an administrator for access.';
