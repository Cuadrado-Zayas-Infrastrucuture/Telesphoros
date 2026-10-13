// Adapted from Prompt Kit; see README.md and LICENSE.md.
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PromptInputContext } from './promptInputContext';

export function PromptInput({ value, onValueChange, onSubmit, isLoading = false, disabled = false, children, className }: {
  value?: string; onValueChange?: (value: string) => void; onSubmit: () => void;
  isLoading?: boolean; disabled?: boolean; children: ReactNode; className?: string;
}) {
  const [internalValue, setInternalValue] = useState('');
  const currentValue = value ?? internalValue;
  const submit = () => { if (!disabled && !isLoading && currentValue.trim()) onSubmit(); };
  return <PromptInputContext.Provider value={{ value: currentValue, setValue: onValueChange ?? setInternalValue, isLoading, disabled, onSubmit: submit }}>
    <form aria-label="Synthetic explanation prompt" onSubmit={event => { event.preventDefault(); submit(); }} className={cn('rounded-lg border border-border bg-panel p-3', className)}>{children}</form>
  </PromptInputContext.Provider>;
}
