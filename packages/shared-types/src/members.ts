import { z } from 'zod';
import { roleSchema } from './roles';

/** A person's subject id from the identity provider, as it appears in a path. No control characters, at most 128. */
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
export const memberSubSchema = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f/?#%\\]+$/, 'Not a valid member id.');
export const memberParamSchema = z.strictObject({ sub: memberSubSchema });
export type MemberParam = z.infer<typeof memberParamSchema>;

/** PUT body: the roles the member should hold from now on (a full replacement; empty means no roles). */
export const memberRolesInputSchema = z.strictObject({ roles: z.array(roleSchema).max(4) });
export type MemberRolesInput = z.infer<typeof memberRolesInputSchema>;

/** An active member of the caller's own organization. Never an e-mail address or a name: the opaque subject id and the roles. */
export const memberDtoSchema = z.strictObject({
  sub: z.string(),
  roles: z.array(roleSchema),
  changedAt: z.iso.datetime(),
});
export type MemberDto = z.infer<typeof memberDtoSchema>;

/** POST body. The address is turned into a keyed digest on arrival; only a masked hint is ever shown back. */
export const invitationCreateSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  roles: z.array(roleSchema).max(4),
});
export type InvitationCreate = z.infer<typeof invitationCreateSchema>;

export const invitationDtoSchema = z.strictObject({
  id: z.uuid(),
  emailHint: z.string(),
  roles: z.array(roleSchema),
  status: z.enum(['pending', 'fulfilled', 'cancelled', 'expired']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type InvitationDto = z.infer<typeof invitationDtoSchema>;
