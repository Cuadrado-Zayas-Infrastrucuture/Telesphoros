import { THEME_PREFERENCES, type ThemePreference } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeProvider';

const LABELS: Record<ThemePreference, { name: string; detail: string }> = {
  system: { name: 'Match this device', detail: "Follows your device's light or dark setting." },
  light: { name: 'Light', detail: 'Always light.' },
  dark: { name: 'Dark', detail: 'Always dark.' },
};

/** Light, dark or the device's setting. Native radios: arrow keys move between them, and each row is a 44px target. */
export function AppearanceChoice() {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-2 text-sm text-muted-foreground">Theme for this browser. The public home page always stays light.</legend>
      {THEME_PREFERENCES.map((option) => (
        <label key={option} htmlFor={`theme-${option}`} className="flex min-h-control cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted">
          <input
            id={`theme-${option}`}
            type="radio"
            name="theme"
            value={option}
            checked={preference === option}
            onChange={() => setPreference(option)}
            className="size-6 shrink-0 accent-primary"
          />
          <span className="flex flex-col">
            {LABELS[option].name}
            <span className="text-sm text-muted-foreground">{LABELS[option].detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
