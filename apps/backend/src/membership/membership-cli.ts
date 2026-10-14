import type { MembershipAdmin, MembershipRecord } from './membership';
import { MembershipAdminError, normalizeRoles } from './membership';

export const MEMBERSHIP_USAGE = `  membership grant          --tenant ID --sub SUB --roles LIST --by NAME [--reason TEXT]
  membership set-roles      --tenant ID --sub SUB --roles LIST --by NAME [--reason TEXT]
  membership remove         --tenant ID --sub SUB --by NAME [--reason TEXT]
  membership revoke-sessions --tenant ID --sub SUB --by NAME [--reason TEXT]
  membership show           --tenant ID --sub SUB
                                who belongs to which organization and with which roles, as the API sees it (DATABASE_MIGRATOR_URL).
                                LIST is comma separated from reader, clinician, admin, reviewer (empty = no roles; such a person can
                                sign in but is refused every clinical route). "remove" ends access on the person's very next request
                                and keeps the row, so every token issued so far stays refused even if they are granted again.
                                "revoke-sessions" does the same without removing or changing roles. --sub is the identity provider's
                                subject id for the person. There is no API route that does any of this.
`;

function parse(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined) throw new MembershipAdminError('invalid', `Expected "--name value" pairs, got: ${args.slice(i).join(' ')}`);
    values.set(name.slice(2), value);
  }
  return values;
}

const describe = (m: MembershipRecord) => `tenant=${m.tenantId} sub=${m.sub} status=${m.status} roles=${m.roles.join(',') || '(none)'} version=${m.version}`;

/** Runs one membership command. Returns the process exit code; never prints a connection string or token. */
export async function runMembership(admin: MembershipAdmin, args: string[], out: (line: string) => void): Promise<number> {
  const [action, ...rest] = args;
  try {
    const f = parse(rest);
    const need = (name: string) => {
      const v = f.get(name);
      if (v === undefined) throw new MembershipAdminError('invalid', `--${name} is required`);
      return v;
    };
    const target = { tenantId: need('tenant'), sub: need('sub') };
    const change = () => ({ ...target, by: need('by'), reason: f.get('reason') });
    const roles = () => normalizeRoles(need('roles').split(',').map((r) => r.trim()).filter((r) => r.length > 0));
    switch (action) {
      case 'grant':
        out(`granted: ${describe(await admin.grant({ ...change(), roles: roles() }))}`);
        return 0;
      case 'set-roles':
        out(`roles set: ${describe(await admin.setRoles({ ...change(), roles: roles() }))}`);
        return 0;
      case 'remove':
        out(`removed: ${describe(await admin.remove(change()))}`);
        return 0;
      case 'revoke-sessions':
        out(`sessions revoked: ${describe(await admin.revokeSessions(change()))}`);
        return 0;
      case 'show': {
        const row = await admin.show(target.tenantId, target.sub);
        out(row ? describe(row) : 'no membership');
        return 0;
      }
      default:
        throw new MembershipAdminError('invalid', `Unknown membership command: ${action ?? '(none)'}`);
    }
  } catch (error) {
    if (error instanceof MembershipAdminError) {
      out(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
