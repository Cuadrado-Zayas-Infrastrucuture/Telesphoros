import { useContext } from 'react';
import { useFormContext, useFormState } from 'react-hook-form';
import { FormFieldContext, FormItemContext } from '@/lib/formContexts';

export function useFormField() {
  const field = useContext(FormFieldContext);
  const item = useContext(FormItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: field?.name });
  if (!field || !item) throw new Error('Form field components must be used inside <FormField> and <FormItem>.');
  const state = getFieldState(field.name, formState);
  return {
    name: field.name,
    error: state.error,
    inputId: `${item.id}-input`,
    descriptionId: `${item.id}-description`,
    messageId: `${item.id}-message`,
  };
}
