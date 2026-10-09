import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/Alert';
import { AlertDescription } from '@/components/ui/AlertDescription';
import { AlertTitle } from '@/components/ui/AlertTitle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CardContent } from '@/components/ui/CardContent';
import { CardDescription } from '@/components/ui/CardDescription';
import { CardHeader } from '@/components/ui/CardHeader';
import { CardTitle } from '@/components/ui/CardTitle';
import { Checkbox } from '@/components/ui/Checkbox';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { Spinner } from '@/components/ui/Spinner';
import { usePageTitle } from '@/hooks/usePageTitle';
import { submitReport, type UploadProgress } from '@/lib/localReportApi';
import { uploadReportSchema, type UploadReportValues } from '@/lib/uploadReportSchema';
import { REPORT_TYPE_LABELS, REPORT_TYPES } from '@/types/report';

// The file starts unset; the schema reports "Choose a report file." until one is picked.
const emptyValues = {
  patientLabel: '',
  reportType: '',
  file: undefined,
  syntheticConfirmed: false,
} as unknown as UploadReportValues;

export default function UploadReportPage() {
  const { apiFetch } = useAuth();
  const progress = useRef<UploadProgress>({});
  usePageTitle('Upload report');
  const [serverError, setServerError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  // Changing the key remounts the file input, the only way to clear a native file control.
  const [formKey, setFormKey] = useState(0);

  const form = useForm<UploadReportValues>({
    resolver: zodResolver(uploadReportSchema),
    defaultValues: emptyValues,
    mode: 'onTouched',
  });
  const { isSubmitting } = form.formState;

  async function onSubmit(values: UploadReportValues) {
    setServerError(null);
    try {
      const result = await submitReport(values, apiFetch, progress.current);
      setReference(result.reference);
    } catch (error) {
      // Values stay in the form so the user can retry without retyping.
      setServerError(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    }
  }

  function startOver() {
    progress.current = {};
    form.reset(emptyValues);
    setReference(null);
    setServerError(null);
    setFormKey((key) => key + 1);
  }

  if (reference) {
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <h1 className="text-3xl leading-tight font-bold">Report received</h1>
        <Alert variant="success">
          <AlertTitle>File upload verified locally</AlertTitle>
          <AlertDescription>
            Reference <strong>{reference}</strong>. The local server verified the file. No clinical evaluation was run.
          </AlertDescription>
        </Alert>
        <div>
          <Button onClick={startOver}>Upload another report</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-prose flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl leading-tight font-bold">Upload report</h1>
        <p className="text-muted-foreground">Synthetic test reports only. Fields marked required must be completed.</p>
      </div>

      {serverError && (
        <Alert variant="destructive">
          <AlertTitle>Upload failed</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Report details</CardTitle>
          <CardDescription>The file is checked in your browser before anything is submitted.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form key={formKey} onSubmit={(event) => void form.handleSubmit(onSubmit)(event)} noValidate className="flex flex-col gap-6">
              <fieldset disabled={isSubmitting} className="flex min-w-0 flex-col gap-6">
                <legend className="sr-only">Report details</legend>

                <FormField
                  control={form.control}
                  name="patientLabel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Synthetic patient label (required)</FormLabel>
                      <FormControl>
                        <Input autoComplete="off" {...field} />
                      </FormControl>
                      <FormDescription>Example: SYN-0001. Never a real name or identifier.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="reportType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Report type (required)</FormLabel>
                      <FormControl>
                        <NativeSelect {...field}>
                          <option value="">Choose a type…</option>
                          {REPORT_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {REPORT_TYPE_LABELS[type]}
                            </option>
                          ))}
                        </NativeSelect>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="file"
                  render={({ field: { onChange, onBlur, name, ref } }) => (
                    <FormItem>
                      <FormLabel>Report file (required)</FormLabel>
                      <FormControl>
                        <Input
                          type="file"
                          accept=".vcf,.json"
                          name={name}
                          ref={ref}
                          onBlur={onBlur}
                          onChange={(event) => onChange(event.target.files?.[0])}
                        />
                      </FormControl>
                      <FormDescription>.vcf or .json, up to 10 MB.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="syntheticConfirmed"
                  render={({ field: { value, onChange, onBlur, name, ref } }) => (
                    <FormItem>
                      <div className="flex items-start gap-3">
                        <FormControl>
                          <Checkbox
                            name={name}
                            ref={ref}
                            checked={value}
                            onBlur={onBlur}
                            onChange={(event) => onChange(event.target.checked)}
                          />
                        </FormControl>
                        <FormLabel className="leading-normal">
                          I confirm this file contains synthetic data only (required)
                        </FormLabel>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div>
                  <Button type="submit" size="lg" disabled={isSubmitting} className="w-full sm:w-auto">
                    {isSubmitting ? (
                      <>
                        <Spinner /> Uploading…
                      </>
                    ) : (
                      'Upload report'
                    )}
                  </Button>
                </div>
              </fieldset>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
