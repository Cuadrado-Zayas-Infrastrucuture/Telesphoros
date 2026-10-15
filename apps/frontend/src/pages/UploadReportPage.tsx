import { Link } from 'react-router-dom';
import { ownedStorageMode } from '@/lib/storageMode';
import { cancelOwnedUpload, restoreProgress } from '@/lib/ownedStorageApi';
import { clearRecovery, readRecovery, type RecoveryEntry } from '@/lib/uploadRecovery';
import { zodResolver } from '@hookform/resolvers/zod';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Paginated, PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
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
import { listPatients, SubmitError, submitReport, type UploadProgress } from '@/lib/api';
import { productUploadSchema, type ProductUploadValues } from '@/lib/productUploadSchema';
import { REPORT_TYPE_LABELS, REPORT_TYPES } from '@/types/report';

function describeSize(bytes: number) {
  return bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// The file starts unset; the schema reports "Choose a report file." until one is picked.
const emptyValues = {
  patientId: '',
  reportType: '',
  file: undefined,
  syntheticConfirmed: false,
} as unknown as ProductUploadValues;

export default function UploadReportPage() {
  usePageTitle('Upload report');
  const { apiFetch } = useAuth();
  // After a reload the browser may still hold an interrupted upload of this tab (see lib/uploadRecovery.ts): offer to finish or cancel it.
  const [interrupted, setInterrupted] = useState<RecoveryEntry | undefined>(() => readRecovery());
  const [startingProgress] = useState<UploadProgress>(() => (interrupted ? restoreProgress(interrupted) : {}));
  const progress = useRef<UploadProgress>(startingProgress);
  const transfer = useRef<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [canStartOver, setCanStartOver] = useState(true);
  const owned = ownedStorageMode();
  useEffect(() => () => { transfer.current?.abort(); }, []);
  const [patients, setPatients] = useState<Paginated<PatientDto> | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<PatientDto | null>(null);
  const [patientRequest, setPatientRequest] = useState({ page: 1, attempt: 0 });
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [patientError, setPatientError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listPatients(apiFetch, patientRequest.page, controller.signal).then(result => {
      if (!controller.signal.aborted) { setPatients(result); setPatientsLoading(false); }
    }).catch(error => {
      if (!controller.signal.aborted && !(error instanceof SessionEndedError)) {
        setPatientError('Patients could not be loaded. Please retry.'); setPatientsLoading(false);
      }
    });
    return () => controller.abort();
  }, [apiFetch, patientRequest]);
  function loadPatients(page: number) {
    setPatientError(null); setPatientsLoading(true);
    setPatientRequest(current => ({ page, attempt: current.attempt + 1 }));
  }

  const [serverError, setServerError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Changing the key remounts the file input, the only way to clear a native file control.
  const [formKey, setFormKey] = useState(0);

  const form = useForm<ProductUploadValues>({
    resolver: zodResolver(productUploadSchema),
    defaultValues: emptyValues,
    mode: 'onTouched',
  });
  const { isSubmitting } = form.formState;

  async function onSubmit(values: ProductUploadValues) {
    setServerError(null);
    transfer.current = new AbortController();
    try {
      const result = await submitReport(values, apiFetch, progress.current, transfer.current.signal);
      setReference(result.reference);
    } catch (error) {
      // Values stay in the form so the user can retry without retyping.
      if (error instanceof SessionEndedError) return;
      setServerError(error instanceof SubmitError ? error.message : 'The upload was interrupted. Your entries are kept; please retry.');
    } finally {
      transfer.current = null;
      if (progress.current.cancelRequested) await cancelUpload();
      setCanStartOver(!progress.current.declaration || ['cancelled', 'cleaned', 'committed'].includes(progress.current.attempt?.state ?? ''));
      setInterrupted(readRecovery());
    }
  }

  async function cancelUpload() {
    setCancelling(true);
    try {
      await cancelOwnedUpload(apiFetch, progress.current);
      setServerError('Upload cancelled. Start a new upload when ready.');
      setInterrupted(readRecovery());
    } catch (error) {
      setServerError(error instanceof SubmitError ? error.message : 'Cancellation could not be confirmed. Retry cancellation before starting over.');
    } finally {
      setCancelling(false);
      setCanStartOver(!progress.current.declaration || ['cancelled', 'cleaned', 'committed'].includes(progress.current.attempt?.state ?? ''));
    }
  }

  function requestCancel() {
    progress.current.cancelRequested = true;
    if (transfer.current) { setCancelling(true); transfer.current.abort(); }
    else void cancelUpload();
  }

  /** Cancels the upload that a reload interrupted; the server must acknowledge it before the page lets go of it. */
  async function cancelInterrupted() {
    setCancelling(true);
    setServerError(null);
    try {
      await cancelOwnedUpload(apiFetch, progress.current);
      progress.current = {};
      setInterrupted(undefined);
      setNotice('The interrupted upload was cancelled. You can start a new one.');
    } catch (error) {
      if (!(error instanceof SessionEndedError)) setServerError(error instanceof SubmitError ? error.message : 'Cancellation could not be confirmed. Retry cancellation before starting over.');
    } finally {
      setCancelling(false);
    }
  }

  function startOver() {
    clearRecovery();
    setInterrupted(undefined);
    setNotice(null);
    progress.current = {};
    setCanStartOver(true);
    setSelectedPatient(null);
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
          <AlertTitle>Upload complete</AlertTitle>
          <AlertDescription>
            Reference <strong>{reference}</strong>. The server verified the stored file. This does not indicate clinical review or processing.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={isSubmitting || cancelling} onClick={startOver}>Upload another report</Button>
          {owned && <Button asChild variant="outline"><Link to="/reports">View reports</Link></Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl leading-tight font-bold">Upload report</h1>
        <p className="text-muted-foreground">Synthetic test reports only. Fields marked required must be completed.</p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}

      {interrupted && !serverError && !isSubmitting && (
        <Alert>
          <AlertTitle>An upload was interrupted</AlertTitle>
          <AlertDescription>
            <p>
              <strong>{interrupted.file.name}</strong> ({describeSize(interrupted.file.sizeBytes)}) was not finished. Choose the same patient and the same file again and press Upload report to finish it, or cancel it.
            </p>
            <Button type="button" variant="outline" className="mt-2" disabled={cancelling} onClick={() => void cancelInterrupted()}>{cancelling ? 'Cancelling…' : 'Cancel the interrupted upload'}</Button>
          </AlertDescription>
        </Alert>
      )}

      {serverError && (
        <Alert variant="destructive">
          <AlertTitle>Upload failed</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <Card className="bg-panel shadow-panel">
        <CardHeader>
          <CardTitle>Report details</CardTitle>
          <CardDescription>The file is checked in your browser before anything is submitted.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form key={formKey} onSubmit={event => void form.handleSubmit(onSubmit)(event)} noValidate className="flex flex-col gap-6">
              <fieldset disabled={isSubmitting || cancelling} className="flex min-w-0 flex-col gap-6">
                <legend className="sr-only">Report details</legend>

                <div className="flex flex-col gap-2">
                <FormField
                  control={form.control}
                  name="patientId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Synthetic patient (required)</FormLabel>
                      <FormControl>
                        <NativeSelect {...field} disabled={patientsLoading || isSubmitting} onChange={event => {
                          field.onChange(event);
                          setSelectedPatient(patients?.data.find(patient => patient.id === event.target.value) ?? null);
                        }}>
                          <option value="">Choose an existing patient…</option>
                          {selectedPatient && !patients?.data.some(patient => patient.id === selectedPatient.id) && (
                            <option value={selectedPatient.id}>{selectedPatient.label}</option>
                          )}
                          {patients?.data.map(patient => <option key={patient.id} value={patient.id}>{patient.label}</option>)}
                        </NativeSelect>
                      </FormControl>
                      <FormDescription>Select an existing synthetic patient. This upload does not create a patient.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <p role="status" className="text-sm text-muted-foreground">{patientsLoading ? 'Loading patients…' : patients?.meta.total === 0 ? 'No patients available. Ask a clinician to add a synthetic patient, then refresh the list.' : patients ? `Patient page ${patients.meta.page} of ${patients.meta.totalPages}` : 'Patients unavailable.'}</p>
                  <div className="-ml-3 flex flex-wrap gap-1 sm:ml-0">
                    <Button type="button" variant="ghost" size="sm" disabled={patientsLoading || isSubmitting} onClick={() => loadPatients(patientError ? patientRequest.page : patients?.meta.page ?? 1)}><RefreshCw aria-hidden="true" className="size-4 shrink-0" />Refresh patients</Button>
                    {patients && patients.meta.totalPages > 1 && <>
                      <Button type="button" variant="ghost" size="sm" disabled={patientsLoading || isSubmitting || patients.meta.page <= 1} onClick={() => loadPatients(patients.meta.page - 1)}>Previous patients</Button>
                      <Button type="button" variant="ghost" size="sm" disabled={patientsLoading || isSubmitting || patients.meta.page >= patients.meta.totalPages} onClick={() => loadPatients(patients.meta.page + 1)}>Next patients</Button>
                    </>}
                  </div>
                </div>
                {patientError && <p role="alert" className="text-sm text-destructive">{patientError}</p>}
                </div>

                <FormField
                  control={form.control}
                  name="reportType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Report type (required)</FormLabel>
                      <FormControl>
                        <NativeSelect {...field}>
                          <option value="">Choose a type…</option>
                          {(owned ? [...REPORT_TYPES, 'lab-pdf'] as const : REPORT_TYPES).map((type) => (
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
                          accept={owned ? ".vcf,.json,.pdf" : ".vcf,.json"}
                          name={name}
                          ref={ref}
                          onBlur={onBlur}
                          onChange={(event) => onChange(event.target.files?.[0])}
                        />
                      </FormControl>
                      <FormDescription>{owned ? ".pdf, .vcf or .json, up to 10 MiB." : ".vcf or .json, up to 10 MB."}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="syntheticConfirmed"
                  render={({ field: { value, onChange, onBlur, name, ref } }) => (
                    <FormItem>
                      <div className="flex items-center gap-3">
                        <FormControl>
                          <Checkbox
                            name={name}
                            ref={ref}
                            checked={value}
                            onBlur={onBlur}
                            onChange={(event) => onChange(event.target.checked)}
                          />
                        </FormControl>
                        <FormLabel className="flex min-h-control items-center leading-normal">
                          I confirm this file contains synthetic data only (required)
                        </FormLabel>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div>
                  <Button type="submit" size="lg" disabled={isSubmitting || cancelling} className="w-full sm:w-auto">
                    {isSubmitting ? (
                      <>
                        <Spinner /> Uploading…
                      </>
                    ) : (
                      'Upload report'
                    )}
                  </Button>
                  {serverError && <Button type="button" variant="outline" disabled={isSubmitting || cancelling || !canStartOver} onClick={startOver} className="mt-2 w-full sm:ml-2 sm:mt-0 sm:w-auto">Start a new upload</Button>}
                </div>
              </fieldset>
              {(isSubmitting || serverError) && <Button type="button" variant="outline" disabled={cancelling} onClick={requestCancel}>{cancelling ? 'Cancelling…' : 'Cancel upload'}</Button>}
            </form>
          </Form>
        </CardContent>
      </Card>
      </div>
      <aside aria-labelledby="upload-guide-heading" className="rounded-lg border border-divider bg-panel p-5 shadow-panel">
        <h2 id="upload-guide-heading" className="text-lg">Before you upload</h2>
        <ul className="mt-3 flex list-disc flex-col gap-3 pl-5 text-sm">
          <li>Use synthetic records only. Real patient information must not be uploaded.</li>
          <li>The server verifies the stored file. Verification confirms storage; it is not clinical review.</li>
          {owned && <li>Afterwards, find the report on the <Link className="underline" to="/reports">Reports page</Link>.</li>}
        </ul>
      </aside>
      </div>
    </div>
  );
}
