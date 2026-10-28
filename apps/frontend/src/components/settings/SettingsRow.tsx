import type { ReactNode } from 'react';

/** A label and its value inside a Settings description list. */
export function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-divider py-3 last:border-b-0 sm:flex-row sm:gap-6">
      <dt className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}
