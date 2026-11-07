import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types';

/** Keep source attribution available without expanding every medication row. */
export function DrugListInformation() {
  const list = BUNDLED_DRUG_LIST;
  if (!list) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="min-h-control cursor-pointer py-3 text-sm font-medium text-foreground">Drug list information</summary>
      <div className="flex max-w-prose flex-col gap-2 pb-2">
        <p>{list.attribution}</p>
        <p>{list.currencyNotice}</p>
        <p>
          Ingredient names: RxNorm {list.rxnormRelease}. CPIC drug subset {list.cpicRelease}. Snapshot accessed {list.accessedAt.slice(0, 10)}.
        </p>
      </div>
    </details>
  );
}
