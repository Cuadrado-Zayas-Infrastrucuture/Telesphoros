import { ownedStorageMode } from '@/lib/storageMode';
import companySymbol from '@/assets/company-symbol.svg';

export function SiteFooter() {
  return (
    <footer className="border-t border-divider bg-surface">
      <div className="mx-auto flex max-w-page items-start gap-4 px-4 py-6 sm:items-center sm:px-6">
        <img src={companySymbol} alt="Cuadrado Zayas Infrastructure company symbol" width="48" height="48" loading="lazy" className="shrink-0" />
        <div className="flex min-w-0 flex-col gap-2 text-xs sm:text-sm">
          <p className="font-semibold">Cuadrado Zayas Infrastructure LLC · San Juan, Puerto Rico</p>
          <p className="text-muted-foreground">
            {ownedStorageMode() ? <>File storage and retrieval only. Clinical processing is disabled. Use <strong>synthetic data only</strong>.</> : <>Clinical decision support only. It does not prescribe or replace clinician judgment. This environment is for <strong>synthetic data only</strong>.</>}
          </p>
        </div>
      </div>
    </footer>
  );
}
