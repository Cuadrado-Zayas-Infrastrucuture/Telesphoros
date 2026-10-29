import type { Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';

// Full class names, so Tailwind finds them. The colors are fixed copies of each theme's tokens (tokens.css, guarded).
const SKIN: Record<Theme, { background: string; panel: string; divider: string; ink: string; primary: string }> = {
  light: {
    background: 'bg-preview-light-background',
    panel: 'bg-preview-light-panel',
    divider: 'border-preview-light-divider',
    ink: 'bg-preview-light-foreground',
    primary: 'bg-preview-light-primary',
  },
  dark: {
    background: 'bg-preview-dark-background',
    panel: 'bg-preview-dark-panel',
    divider: 'border-preview-dark-divider',
    ink: 'bg-preview-dark-foreground',
    primary: 'bg-preview-dark-primary',
  },
};

/** A small drawing of the app (sidebar, two lines of text, a button) in one theme's colors, for the Appearance cards. */
export function ThemeMiniScreen({ theme, className }: { theme: Theme; className?: string }) {
  const skin = SKIN[theme];
  return (
    <span className={cn('absolute inset-0 flex', skin.background, className)}>
      <span className={cn('w-1/4 border-r', skin.panel, skin.divider)} />
      <span className="flex flex-1 flex-col gap-1.5 p-2.5">
        <span className={cn('h-1.5 w-3/4 rounded-sm opacity-80', skin.ink)} />
        <span className={cn('h-1.5 w-1/2 rounded-sm opacity-40', skin.ink)} />
        <span className={cn('mt-auto h-3 w-2/5 rounded-sm', skin.primary)} />
      </span>
    </span>
  );
}
