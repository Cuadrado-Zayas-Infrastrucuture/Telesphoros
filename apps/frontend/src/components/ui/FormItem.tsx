import { useId, type HTMLAttributes } from 'react';
import { FormItemContext } from '@/lib/formContexts';
import { cn } from '@/lib/utils';

export function FormItem({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const id = useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div className={cn('flex flex-col gap-2', className)} {...props} />
    </FormItemContext.Provider>
  );
}
