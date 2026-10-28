import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { ADMIN_ROLES } from '@/auth/roles';
import { AppearanceChoice } from '@/components/settings/AppearanceChoice';
import { OrganizationValue } from '@/components/settings/OrganizationValue';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { NO_ROLE_DESCRIPTION, ROLE_DESCRIPTIONS } from '@/lib/roleDescriptions';

/** The API's host, for the Environment section: a public build setting, shown so support can tell builds apart. */
function apiHost(): string {
  try {
    return new URL(String(import.meta.env.VITE_API_BASE_URL)).host;
  } catch {
    return 'Not configured';
  }
}

const BUILD_LABELS: Record<string, string> = { production: 'Production', development: 'Development' };

/**
 * Who you are signed in as, what your roles allow, how your session is held, and the way out. Open to every signed-in member, including
 * one with no role: nothing here is clinical. The email comes from the sign-in (in memory only) and is never sent to the API.
 */
export default function SettingsPage() {
  usePageTitle('Settings');
  const { email, roles, apiFetch, signOut } = useAuth();
  const [attempt, setAttempt] = useState(0);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-3xl leading-tight tracking-tight">Settings</h1>

      <SettingsSection id="settings-account" title="Account">
        <dl>
          <SettingsRow label="Signed in as">{email ?? 'Your sign-in provider did not share an email address.'}</SettingsRow>
          <SettingsRow label="Organization">
            <OrganizationValue key={attempt} apiFetch={apiFetch} onRetry={() => setAttempt((n) => n + 1)} />
          </SettingsRow>
        </dl>
      </SettingsSection>

      <SettingsSection id="settings-roles" title="Roles" description="What your roles let you do here. The server checks every request; this list only describes it.">
        {roles.length === 0 ? (
          <p>{NO_ROLE_DESCRIPTION}</p>
        ) : (
          <dl>
            {roles.map((role) => (
              <SettingsRow key={role} label={ROLE_DESCRIPTIONS[role].name}>
                {ROLE_DESCRIPTIONS[role].allows}
              </SettingsRow>
            ))}
          </dl>
        )}
      </SettingsSection>

      {roles.some((role) => ADMIN_ROLES.includes(role)) && (
        <SettingsSection id="settings-administration" title="Administration" description="For administrators of this organization.">
          <Button asChild variant="outline">
            <Link to="/usage">See usage</Link>
          </Button>
        </SettingsSection>
      )}

      <SettingsSection id="settings-appearance" title="Appearance">
        <AppearanceChoice />
      </SettingsSection>

      <SettingsSection id="settings-session" title="Session and privacy">
        <div className="flex flex-col gap-4">
          <p>
            Your sign-in is held in this tab&apos;s memory only, never in browser storage. Reloading the page signs this tab out; signing in again is quick while your sign-in
            provider remembers you.
          </p>
          <p>Signing out ends your sessions in this organization on every device, then signs this browser out of your sign-in provider.</p>
          <div>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="settings-environment" title="Environment">
        <dl>
          <SettingsRow label="Build">{BUILD_LABELS[import.meta.env.MODE] ?? import.meta.env.MODE}</SettingsRow>
          <SettingsRow label="API">{apiHost()}</SettingsRow>
        </dl>
      </SettingsSection>
    </div>
  );
}
