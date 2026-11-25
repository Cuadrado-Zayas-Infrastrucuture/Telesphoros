import { useEffect, useId, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { Check, CircleHelp, Globe, Info, LogOut, Palette, Settings } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { AccountMenuDisclosure } from '@/components/layout/AccountMenuDisclosure';
import { AccountMenuLink } from '@/components/layout/AccountMenuLink';
import { useStorageConsent } from '@/components/privacy/StorageConsentProvider';
import { ACCOUNT_MENU_ICON as ICON, ACCOUNT_MENU_ROW as ITEM, type AccountMenuKeyHandler as KeyHandler } from '@/lib/accountMenu';
import { useAppLanguage } from '@/lib/appLanguage';
import { HELP_LINKS, POLICY_LINKS } from '@/lib/helpLinks';
import { languagePreviewEnabled } from '@/lib/languagePreview';
import { THEME_PREFERENCES, type ThemePreference } from '@/lib/theme';
import type { Words } from '@/lib/words/defineWords';
import { ACCOUNT_MENU_WORDS } from '@/lib/words/shell';
import { useWords } from '@/lib/words/screens';
import { cn } from '@/lib/utils';
import { useTheme } from '@/theme/ThemeProvider';

type MenuWords = Words<(typeof ACCOUNT_MENU_WORDS)['en']>;
const themeOptions = (words: MenuWords): Record<ThemePreference, { label: string; name: string }> => ({
  system: { label: words.themeAuto, name: words.themeAutoName },
  light: { label: words.themeLight, name: words.themeLight },
  dark: { label: words.themeDark, name: words.themeDark },
});
/** The stops for ↑ and ↓: each link and button outside a closed section, and the theme choice as one stop (its checked radio; ← and → change it). */
const STOPS = 'a[href], button, input[type=radio]:checked';

/** Whether no ancestor up to the document is `hidden` (a closed Language or Learn more list). */
function shown(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) if (node.hidden) return false;
  return true;
}
const visibleStops = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>(STOPS) ?? [])].filter(shown);

/**
 * The account menu (specs/034 D9-D11): who is signed in; Settings, Language, Help (help, feedback, bug reports), the theme on one line, and
 * Learn more (changelog, policies, cookie settings); Sign out. Language, Help and Learn more open in place, so the closed menu stays short.
 * Everything that is a setting is also on the Settings page. Opening the menu moves focus to its first item; ↑ and ↓ move between items.
 */
export function SidebarAccountMenu({ open, name, onClose, onKeyDown }: { open: boolean; name: string; onClose: () => void; onKeyDown: KeyHandler }) {
  const { email, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const { openPreferences, reopenLabel } = useStorageConsent();
  const words = useWords(ACCOUNT_MENU_WORDS);
  const { language, setLanguage } = useAppLanguage();
  const options = themeOptions(words);
  const menu = useRef<HTMLDivElement>(null);
  const themeLabel = useId();
  useEffect(() => {
    if (open) visibleStops(menu.current)[0]?.focus();
  }, [open]);
  // ↑ and ↓ move focus between the menu's own controls; each control keeps its own role and click behavior.
  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const move = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const visible = visibleStops(element);
      const at = visible.findIndex((stop) => stop === document.activeElement);
      event.preventDefault(); // on a radio, ↑ and ↓ would otherwise change the theme
      visible[(at + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length]?.focus();
    };
    element.addEventListener('keydown', move);
    return () => element.removeEventListener('keydown', move);
  }, []);
  return (
    <div ref={menu} className="flex flex-col">
      <div className="px-3 py-1.5">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        {email && (
          <p className="truncate text-xs text-muted-foreground" title={email}>
            {email}
          </p>
        )}
      </div>
      <ul className="flex flex-col border-t border-divider py-1">
        <li>
          <NavLink to="/settings" onKeyDown={onKeyDown} onClick={onClose} className={ITEM}>
            <Settings aria-hidden="true" className={ICON} />
            {words.settings}
          </NavLink>
        </li>
        <AccountMenuDisclosure icon={Globe} label={words.language} value={words.english} onKeyDown={onKeyDown}>
          {/* The signed-in app is written in English only; the public landing alone has Spanish. Nothing here pretends otherwise. */}
          <li className="account-menu-row flex items-center justify-between gap-3 px-3 text-sm">
            {words.english}
            <Check aria-label={words.currentLanguage} className="size-4 shrink-0 text-primary" />
          </li>
          <li lang="es" className="account-menu-row flex items-center px-3 text-sm text-muted-foreground">
            Español: aún no disponible
          </li>
          {/* Spec 050 LS2-D1: the founders' preview, only in a development, test or e2e build. Not translated: it is not part of the app. */}
          {languagePreviewEnabled() && (
            <li className="account-menu-row flex items-center gap-2 px-3 text-xs text-muted-foreground">
              <span>Preview:</span>
              <button type="button" lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')} className="underline underline-offset-2">
                English
              </button>
              <button type="button" lang="es" aria-pressed={language === 'es'} onClick={() => setLanguage('es')} className="underline underline-offset-2">
                Español
              </button>
            </li>
          )}
        </AccountMenuDisclosure>
        <AccountMenuDisclosure icon={CircleHelp} label={words.help} onKeyDown={onKeyDown}>
          <li>
            <AccountMenuLink href={HELP_LINKS.help} onKeyDown={onKeyDown}>
              {words.getHelp}
            </AccountMenuLink>
          </li>
          <li>
            <AccountMenuLink href={HELP_LINKS.feedback} onKeyDown={onKeyDown}>
              {words.sendFeedback}
            </AccountMenuLink>
          </li>
          <li>
            <AccountMenuLink href={HELP_LINKS.bug} onKeyDown={onKeyDown}>
              {words.reportBug}
            </AccountMenuLink>
          </li>
        </AccountMenuDisclosure>
        <li className="account-menu-row flex items-center justify-between gap-2 px-3">
          <span id={themeLabel} className="flex items-center gap-3 text-sm">
            <Palette aria-hidden="true" className={ICON} />
            {words.theme}
          </span>
          {/* Native radios, visually hidden but focusable, as on the Settings page: ← and → move between them. */}
          <div role="radiogroup" aria-labelledby={themeLabel} className="flex rounded-md bg-muted p-0.5">
            {THEME_PREFERENCES.map((option) => {
              const { label, name: optionName } = options[option];
              const checked = preference === option;
              return (
                <label key={option} htmlFor={`account-theme-${option}`} title={optionName} className="cursor-pointer">
                  <input
                    id={`account-theme-${option}`}
                    type="radio"
                    name="account-theme"
                    value={option}
                    checked={checked}
                    aria-label={optionName}
                    onChange={() => setPreference(option)}
                    onKeyDown={onKeyDown}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      'account-menu-segment flex items-center rounded-sm px-2 text-xs font-medium peer-focus-visible:outline-2 peer-focus-visible:outline-ring',
                      checked ? 'bg-panel text-foreground shadow-panel' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </span>
                </label>
              );
            })}
          </div>
        </li>
        <AccountMenuDisclosure icon={Info} label={words.learnMore} onKeyDown={onKeyDown}>
          <li>
            <AccountMenuLink href={HELP_LINKS.changelog} onKeyDown={onKeyDown}>
              {words.changelog}
            </AccountMenuLink>
          </li>
          {POLICY_LINKS.map(({ word, href }) => (
            <li key={href}>
              <AccountMenuLink href={href} onKeyDown={onKeyDown}>
                {words[word]}
              </AccountMenuLink>
            </li>
          ))}
          <li>
            <button
              type="button"
              aria-haspopup="dialog"
              onKeyDown={onKeyDown}
              className={ITEM}
              onClick={() => {
                onClose();
                openPreferences();
              }}
            >
              {reopenLabel}
            </button>
          </li>
        </AccountMenuDisclosure>
      </ul>
      <ul className="border-t border-divider pt-1">
        <li>
          <button type="button" onKeyDown={onKeyDown} className={ITEM} onClick={() => void signOut()}>
            <LogOut aria-hidden="true" className={ICON} />
            {words.signOut}
          </button>
        </li>
      </ul>
    </div>
  );
}
