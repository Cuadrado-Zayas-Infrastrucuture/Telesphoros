import { Check } from 'lucide-react';
import { THEME_PREFERENCES, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useTheme } from '@/theme/ThemeProvider';
import { ThemeMiniScreen } from './ThemeMiniScreen';

const LABELS: Record<ThemePreference, { name: string; detail: string }> = {
  system: { name: 'Match this device', detail: "Follows your device's light or dark setting." },
  light: { name: 'Light', detail: 'Always light.' },
  dark: { name: 'Dark', detail: 'Always dark.' },
};

/**
 * Light, dark or the device's setting, as three picture cards. They are native radios, visually hidden but still focusable:
 * arrow keys move between them, and the whole card is the click target.
 */
export function AppearanceChoice() {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-3 text-sm text-muted-foreground">Theme for this browser. The public home page always stays light.</legend>
      <div className="grid max-w-xl grid-cols-3 gap-3">
        {THEME_PREFERENCES.map((option) => {
          const checked = preference === option;
          return (
            <label key={option} htmlFor={`theme-${option}`} className="flex min-w-0 cursor-pointer flex-col gap-2">
              <input id={`theme-${option}`} type="radio" name="theme" value={option} checked={checked} onChange={() => setPreference(option)} className="peer sr-only" />
              <span
                aria-hidden="true"
                className={cn(
                  'relative block aspect-theme-card overflow-hidden rounded-lg border-2 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
                  checked ? 'border-primary' : 'border-divider hover:border-border',
                )}
              >
                {option === 'system' ? (
                  <>
                    <ThemeMiniScreen theme="light" />
                    {/* The device's choice: light on the left, dark on the right. */}
                    <ThemeMiniScreen theme="dark" className="theme-card-split" />
                  </>
                ) : (
                  <ThemeMiniScreen theme={option} />
                )}
              </span>
              <span className={cn('flex items-center gap-1.5 text-sm font-medium', checked ? 'text-primary' : 'text-foreground')}>
                {checked && <Check aria-hidden="true" className="size-4 shrink-0" />}
                {LABELS[option].name}
              </span>
              <span className="text-xs text-muted-foreground">{LABELS[option].detail}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
