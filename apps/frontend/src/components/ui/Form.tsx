import { Slot } from '@radix-ui/react-slot';
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { createContext, useContext, useId, type ComponentProps, type HTMLAttributes } from 'react';
import { Label } from '@/components/ui/Label';
import { cn } from '@/lib/utils';

/** Provides react-hook-form context to every field below it. */
export const Form = FormProvider;

type FormFieldContextValue = { name: string };
const FormFieldContext = createContext<FormFieldContextValue | null>(null);
const FormItemContext = createContext<{ id: string } | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

function useFormField() {
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

export function FormItem({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const id = useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div className={cn('flex flex-col gap-2', className)} {...props} />
    </FormItemContext.Provider>
  );
}

export function FormLabel({ className, ...props }: ComponentProps<typeof Label>) {
  const { inputId, error } = useFormField();
  return <Label htmlFor={inputId} className={cn(error && 'text-destructive', className)} {...props} />;
}

/** Wires id / aria-invalid / aria-describedby onto the single control it wraps. */
export function FormControl(props: ComponentProps<typeof Slot>) {
  const { inputId, error, descriptionId, messageId } = useFormField();
  return (
    <Slot
      id={inputId}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${descriptionId} ${messageId}` : descriptionId}
      {...props}
    />
  );
}

export function FormDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const { descriptionId } = useFormField();
  return <p id={descriptionId} className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

/** Field-level error text. Renders nothing (and keeps the DOM quiet) while the field is valid. */
export function FormMessage({ className, children, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const { error, messageId } = useFormField();
  const body = error ? String(error.message ?? '') : children;
  if (!body) return null;
  return (
    <p id={messageId} className={cn('text-sm font-medium text-destructive', className)} {...props}>
      {body}
    </p>
  );
}
