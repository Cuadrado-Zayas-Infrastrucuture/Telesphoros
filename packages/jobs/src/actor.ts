/**
 * A background job acts as a system actor, never as a person. The name is `system:<job type>`; it is recorded as `created_by` on whatever the job writes.
 *
 * The rule that matters: a system actor is never counted as a person. The independence rules ("someone other than who registered it", "a second person")
 * compare identities, so an identity that no person can hold would trivially satisfy them. The database therefore refuses a `system:` actor on every table that
 * records a human decision or assertion (migration 0023), a membership cannot be named `system:...`, and the authentication layer refuses a token whose subject
 * starts that way.
 */
export const SYSTEM_ACTOR_PREFIX = 'system:';

export function systemActor(jobType: string): string {
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(jobType)) throw new Error('A job type is a short lowercase name.');
  return `${SYSTEM_ACTOR_PREFIX}${jobType}`;
}

export function isSystemActor(actor: string): boolean {
  return actor.startsWith(SYSTEM_ACTOR_PREFIX);
}

/** Throws unless `actor` could be a person (used where a rule asks for one). */
export function assertPerson(actor: string): void {
  if (isSystemActor(actor)) throw new Error('A system actor cannot stand in for a person.');
}
