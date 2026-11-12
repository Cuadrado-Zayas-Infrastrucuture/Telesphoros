import type { ReactNode } from 'react';

/** One headed part of a result's evidence panel. The heading is the question the part answers. */
export function EvidenceBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h5 className="text-sm font-medium">{title}</h5>
      <div className="flex flex-col gap-1 text-sm">{children}</div>
    </section>
  );
}
