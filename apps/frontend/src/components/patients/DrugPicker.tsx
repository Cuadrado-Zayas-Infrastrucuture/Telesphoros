import { useEffect, useId, useState } from 'react';
import { drugPresentation, rankDrugs, type DrugListEntry, type DrugSuggestion } from '@telesphoros/shared-types';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

const SHOWN = 6;
/** A brand match shows the brand beside the ingredient it finds; the ingredient is what gets recorded. */
function suggestionPresentation({ entry, brand }: DrugSuggestion): { displayName: string; ariaLabel: string } {
  const display = drugPresentation(entry);
  return brand ? { displayName: `${brand} (${display.displayName})`, ariaLabel: `${brand} (${display.ariaLabel})` } : display;
}

/** Local type-ahead over ingredient and brand names. Typing never selects a code; only an explicit option choice does. */
export function DrugPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  const initial = BUNDLED_DRUG_LIST?.entries.find((entry) => entry.rxcui === value);
  const [query, setQuery] = useState(initial ? drugPresentation(initial).displayName : '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const needle = query.trim().toLowerCase();
  // One more than shown, only to know whether to ask for more letters.
  const matches = rankDrugs(BUNDLED_DRUG_LIST?.entries ?? [], needle, SHOWN + 1);
  const suggestions = matches.slice(0, SHOWN);
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
            if (suggestions[active]) choose(suggestions[active].entry);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        Type at least two letters of an ingredient or brand name, then choose. The ingredient is recorded. Search stays on this device.
      </p>
      {open && (
        <>
          <ul id={`${id}-suggestions`} role="listbox" aria-label="Drug suggestions" className="max-h-64 overflow-y-auto rounded-md border border-border bg-panel">
            {suggestions.map((suggestion, index) => {
              const { entry } = suggestion;
              const display = suggestionPresentation(suggestion);
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
                : `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}${matches.length > SHOWN ? '. Type more letters to narrow the list' : ''}.`}
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
