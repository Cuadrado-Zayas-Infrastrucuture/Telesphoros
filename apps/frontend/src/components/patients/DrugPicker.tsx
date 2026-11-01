import { useEffect, useId, useState } from 'react';
import { BUNDLED_DRUG_LIST, drugPresentation, matchesDrug, type DrugListEntry } from '@telesphoros/shared-types';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

/** Local type-ahead. Typing never selects a code; only an explicit option choice does. */
export function DrugPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  const initial = BUNDLED_DRUG_LIST?.entries.find((entry) => entry.rxcui === value);
  const [query, setQuery] = useState(initial ? drugPresentation(initial).displayName : '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const needle = query.trim().toLowerCase();
  const matches =
    needle.length < 2
      ? []
      : (BUNDLED_DRUG_LIST?.entries.filter((entry) => matchesDrug(entry, needle)) ?? []).sort(
          (a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)) || a.name.localeCompare(b.name),
        );
  const suggestions = matches.slice(0, 6);
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, active, open]);
  const choose = (entry: DrugListEntry) => {
    setQuery(drugPresentation(entry).displayName);
    onChange(entry.rxcui);
    setOpen(false);
    setActive(-1);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-drug`}>Drug</Label>
      <Input
        id={`${id}-drug`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? `${id}-suggestions` : undefined}
        aria-activedescendant={open && active >= 0 && suggestions[active] ? `${id}-option-${active}` : undefined}
        aria-describedby={`${id}-help`}
        value={query}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          setOpen(true);
          setActive(-1);
        }}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          onChange('');
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive((index) => (event.key === 'ArrowDown' ? Math.min(index + 1, suggestions.length - 1) : index <= 0 ? suggestions.length - 1 : index - 1));
          } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            if (suggestions[active]) choose(suggestions[active]);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        Type at least two letters, then choose an ingredient. Search stays on this device.
      </p>
      {open && (
        <>
          <ul id={`${id}-suggestions`} role="listbox" aria-label="Drug suggestions" className="max-h-64 overflow-y-auto rounded-md border border-border bg-panel">
            {suggestions.map((entry, index) => {
              const display = drugPresentation(entry);
              return (
                <li
                  key={entry.rxcui}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-label={display.ariaLabel}
                  aria-selected={active === index}
                  tabIndex={-1}
                  className={`flex min-h-control cursor-pointer items-center px-3 text-sm wrap-anywhere ${active === index ? 'bg-muted' : 'hover:bg-muted'}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(entry)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      choose(entry);
                    }
                  }}
                >
                  {display.displayName}
                </li>
              );
            })}
          </ul>
          <p role="status" className="text-sm text-muted-foreground">
            {needle.length < 2
              ? 'Type two or more letters for suggestions.'
              : matches.length === 0
                ? 'No matching drugs. Try another name.'
                : `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}${matches.length > 6 ? '. Type more letters to narrow the list' : ''}.`}
          </p>
        </>
      )}
      {value && (
        <p role="status" className="sr-only">
          Selected {BUNDLED_DRUG_LIST?.entries.find((entry) => entry.rxcui === value)?.name}.
        </p>
      )}
    </div>
  );
}
