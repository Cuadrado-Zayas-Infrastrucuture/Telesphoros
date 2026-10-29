// Adapted from Prompt Kit; see README.md and LICENSE.md.
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PromptInputContext } from './promptInputContext';

export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  isLoading = false,
  disabled = false,
  children,
  className,
  label = 'Synthetic explanation prompt',
  allowEmpty = false,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  onSubmit: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  /** The form's accessible name. */
  label?: string;
  /** Submit with no text, e.g. when a file is attached (specs/021); the caller still validates. */
  allowEmpty?: boolean;
}) {
  const [internalValue, setInternalValue] = useState('');
  const currentValue = value ?? internalValue;
  const submit = () => {
    if (!disabled && !isLoading && (allowEmpty || currentValue.trim())) onSubmit();
  };
  return (
    <PromptInputContext.Provider value={{ value: currentValue, setValue: onValueChange ?? setInternalValue, isLoading, disabled, onSubmit: submit }}>
      <form
        aria-label={label}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className={cn('rounded-lg border border-border bg-panel p-3', className)}
      >
        {children}
      </form>
    </PromptInputContext.Provider>
  );
}
