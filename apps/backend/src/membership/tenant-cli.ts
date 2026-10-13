import { MembershipAdminError, type TenantAdmin } from './membership';
import { PgInvitationAdmin } from './pg-invitation-admin';

export const TENANT_USAGE = `  tenant create --id ID --name NAME --by NAME
  tenant list
  tenant suspend --id ID --by NAME
  tenant activate --id ID --by NAME
  invite list --tenant ID
  invite fulfil --id INVITATION_ID --email ADDRESS --sub SUB --by NAME
                                the organization registry and invitations (DATABASE_MIGRATOR_URL). A membership can only name a registered
                                organization; a suspended one is refused on every request. An organization administrator records an invitation in
                                the application; the application cannot create an account. You create the person's account in the identity
                                provider, then "invite fulfil" checks the address against the invitation, grants the membership with the roles
                                the administrator asked for, and marks it fulfilled. INVITATION_DIGEST_KEY must be the application's key.
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

/** `tenant ...`: the organization registry. Returns the exit code. */
export async function runTenant(admin: TenantAdmin, args: string[], out: (line: string) => void): Promise<number> {
  const [action, ...rest] = args;
  try {
    const f = parse(rest);
    const need = (name: string) => {
      const v = f.get(name);
      if (v === undefined) throw new MembershipAdminError('invalid', `--${name} is required`);
      return v;
    };
    switch (action) {
      case 'create': {
        const t = await admin.registerTenant({ id: need('id'), displayName: need('name'), by: need('by') });
        out(`registered: id=${t.id} name=${JSON.stringify(t.displayName)} status=${t.status}`);
        return 0;
      }
      case 'suspend':
      case 'activate': {
        const t = await admin.setTenantStatus({ id: need('id'), status: action === 'suspend' ? 'suspended' : 'active', by: need('by') });
        out(`${action === 'suspend' ? 'suspended' : 'activated'}: id=${t.id} status=${t.status}`);
        return 0;
      }
      case 'list':
        for (const t of await admin.listTenants()) out(`id=${t.id} name=${JSON.stringify(t.displayName)} status=${t.status}`);
        return 0;
      default:
        throw new MembershipAdminError('invalid', `Unknown tenant command: ${action ?? '(none)'}`);
    }
  } catch (error) {
    if (error instanceof MembershipAdminError) {
      out(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** `invite ...`: invitations. Returns the exit code. */
export async function runInvite(admin: PgInvitationAdmin, args: string[], out: (line: string) => void): Promise<number> {
  const [action, ...rest] = args;
  try {
    const f = parse(rest);
    const need = (name: string) => {
      const v = f.get(name);
      if (v === undefined) throw new MembershipAdminError('invalid', `--${name} is required`);
      return v;
    };
    switch (action) {
      case 'list':
        for (const i of await admin.list(need('tenant'))) out(`id=${i.id} for=${i.emailHint} roles=${i.roles.join(',') || '(none)'} status=${i.status} expires=${i.expiresAt.toISOString()} by=${i.createdBy}`);
        return 0;
      case 'fulfil': {
        const m = await admin.fulfil({ id: need('id'), email: need('email'), sub: need('sub'), by: need('by') });
        out(`fulfilled: tenant=${m.tenantId} sub=${m.sub} roles=${m.roles.join(',') || '(none)'}`);
        return 0;
      }
      default:
        throw new MembershipAdminError('invalid', `Unknown invite command: ${action ?? '(none)'}`);
    }
  } catch (error) {
    if (error instanceof MembershipAdminError) {
      out(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

