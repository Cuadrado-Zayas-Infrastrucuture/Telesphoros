import { Slot } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';
import { useFormField } from '@/hooks/useFormField';

export function FormControl(props: ComponentProps<typeof Slot>) {
  const { inputId, error, descriptionId, messageId } = useFormField();
  return <Slot id={inputId} aria-invalid={error ? true : undefined} aria-describedby={error ? `${descriptionId} ${messageId}` : descriptionId} {...props} />;
}
