// Adapted from Prompt Kit; see README.md and LICENSE.md.
import type { ComponentProps } from 'react';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/utils';
import { usePromptInput } from './promptInputContext';

export function PromptInputTextarea({ className, onKeyDown, rows = 3, ...props }: Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'>) {
  const { value, setValue, isLoading, disabled, onSubmit } = usePromptInput();
  return <Textarea {...props} value={value} onChange={event => setValue(event.target.value)} disabled={disabled} readOnly={isLoading}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault(); onSubmit();
      }
    }} rows={rows} className={cn('resize-y border-0 bg-panel text-sm placeholder:text-muted-foreground', className)} />;
}
