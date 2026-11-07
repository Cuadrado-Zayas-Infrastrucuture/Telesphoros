import type React from 'react';
import { DATE_OF_BIRTH_MIN, NAME_MAX_LENGTH, type EthnicityCode, type SexCode } from '@telesphoros/shared-types';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { cn } from '@/lib/utils';
import { ETHNICITY_CODES, ETHNICITY_LABELS, SEX_CODES, SEX_LABELS, type DemographicsDraft, type DraftErrors, type DraftField } from '@/lib/demographicsDraft';

interface Props {
  /** Prefix for every element id, so two copies on one page never collide. */
  idPrefix: string;
  value: DemographicsDraft;
  errors: DraftErrors;
  disabled?: boolean;
  /** The panel is narrow: smaller type and one column. */
  compact?: boolean;
  onChange: (next: DemographicsDraft) => void;
  /** Called on Enter in a text or date field, so a form that holds this one (the Upload step) does not submit itself. */
  onEnter?: () => void;
}

/**
 * Spec 025 D9 / T301: a patient's name, date of birth, sex and ethnicity with coded pickers. Sex is male or female; ethnicity is the 2024 federal list,
 * more than one allowed; either may stay empty, and the patient then shows "Incomplete". Identity fields never autofill and are never spell-checked
 * (a browser's spelling service would see them). The component holds no state: the parent owns the draft and clears it after saving.
 */
export function PatientDemographicsFields({ idPrefix, value, errors, disabled, compact, onChange, onEnter }: Props) {
  const id = (field: DraftField) => `${idPrefix}-${field}`;
  const describedBy = (field: DraftField, help?: boolean) =>
    [help ? `${id(field)}-help` : null, errors[field] ? `${id(field)}-error` : null].filter(Boolean).join(' ') || undefined;
  const set = <K extends DraftField>(field: K, next: DemographicsDraft[K]) => onChange({ ...value, [field]: next });
  const text = compact ? 'text-xs' : 'text-sm';
  const enter = onEnter
    ? (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onEnter();
        }
      }
    : undefined;
  const error = (field: DraftField) =>
    errors[field] ? (
      <p id={`${id(field)}-error`} role="alert" className={cn(text, 'text-destructive')}>
        {errors[field]}
      </p>
    ) : null;
  const identityInput = (field: 'givenName' | 'familyName', label: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id(field)} className={text}>
        {label}
      </Label>
      <Input
        id={id(field)}
        value={value[field]}
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        readOnly={disabled}
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={describedBy(field)}
        onChange={(event) => set(field, event.target.value)}
        onKeyDown={enter}
      />
      {error(field)}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
        {identityInput('givenName', 'Given name')}
        {identityInput('familyName', 'Family name')}
      </div>
      <div className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id('dateOfBirth')} className={text}>
            Date of birth
          </Label>
          <Input
            id={id('dateOfBirth')}
            type="date"
            value={value.dateOfBirth}
            min={DATE_OF_BIRTH_MIN}
            max={new Date().toISOString().slice(0, 10)}
            autoComplete="off"
            readOnly={disabled}
            aria-invalid={errors.dateOfBirth ? true : undefined}
            aria-describedby={describedBy('dateOfBirth')}
            onChange={(event) => set('dateOfBirth', event.target.value)}
            onKeyDown={enter}
          />
          {error('dateOfBirth')}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id('sex')} className={text}>
            Sex
          </Label>
          <NativeSelect
            id={id('sex')}
            value={value.sex}
            disabled={disabled}
            aria-invalid={errors.sex ? true : undefined}
            aria-describedby={describedBy('sex')}
            onChange={(event) => set('sex', event.target.value as SexCode | '')}
          >
            <option value="">Not recorded</option>
            {SEX_CODES.map((code) => (
              <option key={code} value={code}>
                {SEX_LABELS[code]}
              </option>
            ))}
          </NativeSelect>
          {error('sex')}
        </div>
      </div>
      <fieldset className="flex flex-col gap-2" aria-describedby={describedBy('ethnicity', true)} disabled={disabled}>
        <legend className={cn(text, 'mb-1 font-medium text-foreground')}>Ethnicity</legend>
        <p id={`${id('ethnicity')}-help`} className={cn(text, 'text-muted-foreground')}>
          Choose all that apply, or leave empty if not recorded.
        </p>
        <div className={cn('grid gap-1', !compact && 'sm:grid-cols-2')}>
          {ETHNICITY_CODES.map((code) => {
            const checkboxId = `${id('ethnicity')}-${code}`;
            const checked = value.ethnicity.includes(code);
            return (
              <div key={code} className="flex min-h-control items-center gap-2">
                <Checkbox
                  id={checkboxId}
                  checked={checked}
                  onChange={() => set('ethnicity', checked ? value.ethnicity.filter((c) => c !== code) : ([...value.ethnicity, code] as EthnicityCode[]))}
                />
                <Label htmlFor={checkboxId} className={cn(text, 'font-normal')}>
                  {ETHNICITY_LABELS[code]}
                </Label>
              </div>
            );
          })}
        </div>
        {error('ethnicity')}
      </fieldset>
    </div>
  );
}
