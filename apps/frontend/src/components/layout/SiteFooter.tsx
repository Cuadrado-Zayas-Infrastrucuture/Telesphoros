import { ownedStorageMode } from '@/lib/storageMode';

export function SiteFooter() {
  return (
    <footer className="border-t border-divider bg-surface">
      <p className="mx-auto max-w-page px-4 py-4 text-sm text-muted-foreground sm:px-6">
        {ownedStorageMode() ? <>File storage and retrieval only. Clinical processing is disabled. Use <strong>synthetic data only</strong>.</> : <>Clinical decision support only. It does not prescribe or replace clinician judgment. This environment is for <strong>synthetic data only</strong>.</>}
      </p>
    </footer>
  );
}
