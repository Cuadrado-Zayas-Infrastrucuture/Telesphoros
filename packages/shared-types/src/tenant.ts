import { z } from 'zod';

/**
 * A tenant is an organization: the unit whose members share records. Its id is lower-case letters,
 * digits and dashes, so it is safe in a group name, a log line and a storage key prefix.
 */
export const tenantIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lower-case letters, digits and dashes (1 to 63 characters).');
export type TenantId = z.infer<typeof tenantIdSchema>;

/**
 * The identity provider carries tenant membership as a group named "tenant:<id>". Every user must
 * be in exactly one tenant group; none, several or a malformed one is refused (fail closed).
 */
export const TENANT_GROUP_PREFIX = 'tenant:';

export type TenantGroupResult = { ok: true; tenantId: string } | { ok: false };

/** Picks the single tenant out of a user's groups. Anything but exactly one valid tenant group is `{ok: false}`. */
export function tenantFromGroups(groups: readonly string[]): TenantGroupResult {
  const tenantGroups = groups.filter((group) => group.startsWith(TENANT_GROUP_PREFIX));
  if (tenantGroups.length !== 1) return { ok: false };
  const parsed = tenantIdSchema.safeParse(tenantGroups[0]!.slice(TENANT_GROUP_PREFIX.length));
  return parsed.success ? { ok: true, tenantId: parsed.data } : { ok: false };
}
