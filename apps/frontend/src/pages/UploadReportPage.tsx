import { Link } from 'react-router-dom';
import { ownedStorageMode } from '@/lib/storageMode';
import { cancelOwnedUpload, restoreProgress, retireOwnedUpload } from '@/lib/ownedStorageApi';
import { clearRecovery, readRecovery, RECOVERY_LIFETIME_MS, type RecoveryEntry } from '@/lib/uploadRecovery';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Paginated, PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { QuestionnaireProgress } from '@/components/ui/QuestionnaireProgress';
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
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useAddPatient } from '@/hooks/useAddPatient';
import { INCOMPLETE_PROMPT } from '@/components/patients/IncompleteWord';
import { PatientDemographicsFields } from '@/components/patients/PatientDemographicsFields';
import { incompleteness } from '@/lib/demographicsDraft';
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

const GUIDE_STEPS = ['Choose patient', 'Choose file', 'Review upload'] as const;
const STEP_FIELDS = [['patientId'], ['reportType', 'file'], ['syntheticConfirmed']] as const;

export default function UploadReportPage() {
  usePageTitle('Upload report');
  const { apiFetch, recoverySession } = useAuth();
  // After a reload the browser may still hold an interrupted upload of this tab (see lib/uploadRecovery.ts): offer to finish or cancel it.
  const [interrupted, setInterrupted] = useState<RecoveryEntry | undefined>(() => readRecovery(recoverySession));
  const [startingProgress] = useState<UploadProgress>(() => (interrupted && recoverySession ? restoreProgress(interrupted, recoverySession) : {}));
  useEffect(() => {
    if (!interrupted) return;
    const refresh = () => setInterrupted(readRecovery(recoverySession));
    const timer = setTimeout(refresh, Math.max(0, Date.parse(interrupted.savedAt) + RECOVERY_LIFETIME_MS - Date.now()));
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [interrupted, recoverySession]);
  const progress = useRef<UploadProgress>(startingProgress);
  const transfer = useRef<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [canStartOver, setCanStartOver] = useState(true);
  const owned = ownedStorageMode();
  useEffect(
    () => () => {
      retireOwnedUpload(progress.current);
      transfer.current?.abort();
    },
    [],
  );
  const [patients, setPatients] = useState<Paginated<PatientDto> | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<PatientDto | null>(null);
  const [patientRequest, setPatientRequest] = useState({ page: 1, attempt: 0 });
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [patientError, setPatientError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listPatients(apiFetch, patientRequest.page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setPatients(result);
          setPatientsLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && !(error instanceof SessionEndedError)) {
          setPatientError('Patients could not be loaded. Please retry.');
          setPatientsLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, patientRequest]);
  function loadPatients(page: number) {
    setPatientError(null);
    setPatientsLoading(true);
    setPatientRequest((current) => ({ page, attempt: current.attempt + 1 }));
  }

  const [serverError, setServerError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Changing the key remounts the file input, the only way to clear a native file control.
  const [formKey, setFormKey] = useState(0);

  const [guided, setGuided] = useState(false);
  const form = useForm<ProductUploadValues>({
    resolver: zodResolver(productUploadSchema),
    defaultValues: emptyValues,
    // In the guide, clear an error on change so blur cannot move Next during a pointer click.
    mode: guided ? 'onChange' : 'onTouched',
  });
  const { isSubmitting } = form.formState;

  // Adding a synthetic patient from this page. The panel opens by itself when the roster is empty, so nobody is left without a way forward.
  const [addOpen, setAddOpen] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  // Spec 025 T301: the label and the demographics, in two requests that each replay their first request id on a retry (`useAddPatient`).
  const addForm = useAddPatient((created) => {
    setSelectedPatient(created);
    form.setValue('patientId', created.id, { shouldValidate: true, shouldTouch: true });
  });
  const focusPatientAfterLoad = useRef(false);
  const rosterEmpty = !patientsLoading && patients?.meta.total === 0;
  const addVisible = addOpen || rosterEmpty || addForm.pending !== null;
  useEffect(() => {
    if (patientsLoading || !focusPatientAfterLoad.current) return;
    focusPatientAfterLoad.current = false;
    form.setFocus('patientId');
  }, [patientsLoading, form]);
  // The list row of the chosen patient carries `demographicsComplete`; a just-created patient gets it once the page reloads.
  const chosenPatientId = useWatch({ control: form.control, name: 'patientId' });
  const chosenRow = patients?.data.find((patient) => patient.id === chosenPatientId);

  async function addPatient() {
    setAdded(null);
    const outcome = await addForm.submit();
    if (!outcome) return;
    setAddOpen(false);
    setAdded(`Added ${outcome.patient.label} and selected it.`);
    focusPatientAfterLoad.current = true;
    loadPatients(patients?.meta.page ?? 1);
  }

  const [step, setStep] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const pendingField = useRef<keyof ProductUploadValues | null>(null);
  const values = useWatch({ control: form.control });
  useEffect(() => {
    if (!guided) return;
    if (pendingField.current) {
      form.setFocus(pendingField.current);
      pendingField.current = null;
    } else stepHeading.current?.focus();
  }, [guided, step, form]);

  async function nextStep() {
    if (await form.trigger([...STEP_FIELDS[step]], { shouldFocus: true })) setStep((current) => (current === step ? Math.min(step + 1, 2) : current));
  }
  function showInvalidStep(errors: FieldErrors<ProductUploadValues>) {
    if (!guided) return;
    const firstInvalid = STEP_FIELDS.findIndex((fields) => fields.some((field) => errors[field]));
    if (firstInvalid >= 0 && firstInvalid !== step) {
      pendingField.current = STEP_FIELDS[firstInvalid].find((field) => errors[field]) ?? null;
      setStep(firstInvalid);
    }
  }

  async function onSubmit(values: ProductUploadValues) {
    setServerError(null);
    transfer.current = new AbortController();
    try {
      const result = await submitReport(values, apiFetch, progress.current, transfer.current.signal, recoverySession ?? undefined);
      setReference(result.reference);
    } catch (error) {
      // Values stay in the form so the user can retry without retyping.
      if (error instanceof SessionEndedError) return;
      setServerError(error instanceof SubmitError ? error.message : 'The upload was interrupted. Your entries are kept; please retry.');
    } finally {
      transfer.current = null;
      if (progress.current.cancelRequested) await cancelUpload();
      setCanStartOver(!progress.current.declaration || ['cancelled', 'cleaned', 'committed'].includes(progress.current.attempt?.state ?? ''));
      setInterrupted(readRecovery(recoverySession));
    }
  }

  async function cancelUpload() {
    setCancelling(true);
    try {
      await cancelOwnedUpload(apiFetch, progress.current);
      setServerError('Upload cancelled. Start a new upload when ready.');
      setInterrupted(readRecovery(recoverySession));
    } catch (error) {
      setServerError(error instanceof SubmitError ? error.message : 'Cancellation could not be confirmed. Retry cancellation before starting over.');
    } finally {
      setCancelling(false);
      setCanStartOver(!progress.current.declaration || ['cancelled', 'cleaned', 'committed'].includes(progress.current.attempt?.state ?? ''));
    }
  }

  function requestCancel() {
    progress.current.cancelRequested = true;
    if (transfer.current) {
      setCancelling(true);
      transfer.current.abort();
    } else void cancelUpload();
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
      if (!(error instanceof SessionEndedError))
        setServerError(error instanceof SubmitError ? error.message : 'Cancellation could not be confirmed. Retry cancellation before starting over.');
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
    setStep(0);
    form.reset(emptyValues);
    setReference(null);
    setServerError(null);
    setFormKey((key) => key + 1);
  }

  // The form, and the Submit button that had focus, are replaced by the result: say where the person is now.
  const receivedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (reference) receivedHeading.current?.focus();
  }, [reference]);

  if (reference) {
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <h1 ref={receivedHeading} tabIndex={-1} className="text-3xl leading-tight font-bold focus:outline-none">
          Report received
        </h1>
        <Alert variant="success">
          <AlertTitle>Upload complete</AlertTitle>
          <AlertDescription>
            Reference <strong>{reference}</strong>. The server verified the stored file. This does not indicate clinical review or processing.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={isSubmitting || cancelling} onClick={startOver}>
            Upload another report
          </Button>
          {/* Every build has /reports (b9b5307d), and every uploader holds a role that may read it. */}
          <Button asChild variant="outline">
            <Link to="/reports">View reports</Link>
          </Button>
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
          {notice && (
            <Alert>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          {interrupted && !serverError && !isSubmitting && (
            <Alert>
              <AlertTitle>An upload was interrupted</AlertTitle>
              <AlertDescription>
                <p>
                  <strong>The file you chose earlier</strong> ({describeSize(interrupted.file.sizeBytes)}) was not finished. Choose the same patient and the same file again and
                  press Upload report to finish it, or cancel it.
                </p>
                <Button type="button" variant="outline" className="mt-2" disabled={cancelling} onClick={() => void cancelInterrupted()}>
                  {cancelling ? 'Cancelling…' : 'Cancel the interrupted upload'}
                </Button>
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Report details</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={guided}
                  disabled={isSubmitting || cancelling}
                  onClick={() => {
                    setGuided((current) => !current);
                    setStep(0);
                  }}
                >
                  {guided ? 'Show full form' : 'Guide me step by step'}
                </Button>
              </div>
              <CardDescription>The file is checked in your browser before anything is submitted.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form
                  key={formKey}
                  onSubmit={(event) => {
                    if (guided && step < 2) {
                      event.preventDefault();
                      void nextStep();
                    } else void form.handleSubmit(onSubmit, showInvalidStep)(event);
                  }}
                  noValidate
                  className="flex flex-col gap-6"
                >
                  {guided && (
                    <>
                      <QuestionnaireProgress steps={GUIDE_STEPS} active={step} />
                      <h2 ref={stepHeading} tabIndex={-1} className="text-xl">
                        {GUIDE_STEPS[step]}
                      </h2>
                    </>
                  )}
                  <fieldset disabled={isSubmitting || cancelling} className="flex min-w-0 flex-col gap-6">
                    <legend className="sr-only">Report details</legend>

                    <div hidden={guided && step !== 0} className={guided && step !== 0 ? 'hidden' : 'flex flex-col gap-2'}>
                      <FormField
                        control={form.control}
                        name="patientId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Synthetic patient (required)</FormLabel>
                            <FormControl>
                              <NativeSelect
                                {...field}
                                disabled={patientsLoading || isSubmitting}
                                onChange={(event) => {
                                  field.onChange(event);
                                  setSelectedPatient(patients?.data.find((patient) => patient.id === event.target.value) ?? null);
                                }}
                              >
                                <option value="">Choose an existing patient…</option>
                                {selectedPatient && !patients?.data.some((patient) => patient.id === selectedPatient.id) && (
                                  <option value={selectedPatient.id}>{selectedPatient.label}</option>
                                )}
                                {patients?.data.map((patient) => (
                                  <option key={patient.id} value={patient.id}>
                                    {patient.label}
                                  </option>
                                ))}
                              </NativeSelect>
                            </FormControl>
                            <FormDescription>Select a synthetic patient, or add a new one.</FormDescription>
                            {chosenRow && incompleteness(chosenRow) === 'incomplete' && (
                              <p className="text-sm text-warning">
                                {INCOMPLETE_PROMPT}{' '}
                                <Link to={`/patients/${chosenRow.id}`} className="underline underline-offset-2">
                                  Open {chosenRow.label}
                                </Link>
                              </p>
                            )}
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <p role="status" className="text-sm text-muted-foreground">
                          {patientsLoading
                            ? 'Loading patients…'
                            : patients?.meta.total === 0
                              ? 'No patients yet. Add a synthetic patient to continue.'
                              : patients
                                ? `Patient page ${patients.meta.page} of ${patients.meta.totalPages}`
                                : 'Patients unavailable.'}
                        </p>
                        <div className="-ml-3 flex flex-wrap gap-1 sm:ml-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={patientsLoading || isSubmitting}
                            onClick={() => loadPatients(patientError ? patientRequest.page : (patients?.meta.page ?? 1))}
                          >
                            <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
                            Refresh patients
                          </Button>
                          {patients && patients.meta.totalPages > 1 && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={patientsLoading || isSubmitting || patients.meta.page <= 1}
                                onClick={() => loadPatients(patients.meta.page - 1)}
                              >
                                Previous patients
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={patientsLoading || isSubmitting || patients.meta.page >= patients.meta.totalPages}
                                onClick={() => loadPatients(patients.meta.page + 1)}
                              >
                                Next patients
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      {patientError && (
                        <p role="alert" className="text-sm text-destructive">
                          {patientError}
                        </p>
                      )}
                      {added && (
                        <p role="status" className="text-sm text-muted-foreground">
                          {added}
                        </p>
                      )}
                      {addVisible ? (
                        <div role="group" aria-labelledby="add-patient-heading" className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-4">
                          <p id="add-patient-heading" className="text-sm font-medium">
                            Add a synthetic patient
                          </p>
                          {addForm.pending ? (
                            <p className="text-sm text-muted-foreground">
                              Patient <span className="font-medium text-foreground">{addForm.pending.label}</span> exists and is selected. Save its demographics, or continue and
                              add them later on the patient's page.
                            </p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              <Label htmlFor="new-patient-label">Synthetic patient label</Label>
                              <Input
                                id="new-patient-label"
                                value={addForm.label}
                                autoComplete="off"
                                spellCheck={false}
                                readOnly={addForm.busy}
                                aria-invalid={addForm.labelError ? true : undefined}
                                aria-describedby={addForm.labelError ? 'new-patient-help new-patient-error' : 'new-patient-help'}
                                onChange={(event) => addForm.setLabel(event.target.value)}
                                onKeyDown={(event) => {
                                  // Enter adds the patient; without this it would submit the whole upload form.
                                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    void addPatient();
                                  }
                                }}
                              />
                              <p id="new-patient-help" className="text-sm text-muted-foreground">
                                Letters, numbers and hyphens only, up to 40 characters, for example SYN-0002. A code, never a name or a real identifier.
                              </p>
                              {addForm.labelError && (
                                <p id="new-patient-error" role="alert" className="text-sm text-destructive">
                                  {addForm.labelError}
                                </p>
                              )}
                            </div>
                          )}
                          <PatientDemographicsFields
                            idPrefix="new-patient"
                            value={addForm.draft}
                            errors={addForm.errors}
                            disabled={addForm.busy}
                            onChange={addForm.setDraft}
                            onEnter={() => void addPatient()}
                          />
                          {addForm.problem && (
                            <p role="alert" className="text-sm text-destructive">
                              {addForm.problem}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" size="sm" disabled={addForm.busy || isSubmitting} onClick={() => void addPatient()}>
                              {addForm.busy ? 'Saving…' : addForm.pending ? 'Save demographics' : 'Add patient'}
                            <Button type="button" size="sm" pending={adding} pendingLabel="Adding…" disabled={isSubmitting} onClick={() => void addPatient()}>
                              Add patient
                            </Button>
                            {!rosterEmpty && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={addForm.busy}
                                onClick={() => {
                                  setAddOpen(false);
                                  addForm.reset();
                                }}
                              >
                                Cancel
                              </Button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="-ml-3">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={patientsLoading || isSubmitting}
                            onClick={() => {
                              setAddOpen(true);
                              setAdded(null);
                            }}
                          >
                            <Plus aria-hidden="true" className="size-4 shrink-0" />
                            Add a synthetic patient
                          </Button>
                        </div>
                      )}
                    </div>

                    <div hidden={guided && step !== 1} className={guided && step !== 1 ? 'hidden' : 'flex flex-col gap-6'}>
                      <FormField
                        control={form.control}
                        name="reportType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Report type (required)</FormLabel>
                            <FormControl>
                              <NativeSelect {...field}>
                                <option value="">Choose a type…</option>
                                {(owned ? ([...REPORT_TYPES, 'lab-pdf'] as const) : REPORT_TYPES).map((type) => (
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
                                accept={owned ? '.json,.pdf' : '.json'}
                                name={name}
                                ref={ref}
                                onBlur={onBlur}
                                onChange={(event) => onChange(event.target.files?.[0])}
                              />
                            </FormControl>
                            <FormDescription>{owned ? '.pdf or .json, up to 10 MiB.' : '.json, up to 10 MB.'}</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div hidden={guided && step !== 2} className={guided && step !== 2 ? 'hidden' : 'flex flex-col gap-6'}>
                      {guided && (
                        <section aria-label="Upload summary" className="rounded-lg border border-divider bg-background p-4">
                          <h3 className="text-lg">Check your entries</h3>
                          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                            <div>
                              <dt className="text-muted-foreground">Synthetic patient</dt>
                              <dd className="wrap-anywhere font-medium">{selectedPatient?.label ?? 'Not selected'}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Report type</dt>
                              <dd>{values.reportType ? REPORT_TYPE_LABELS[values.reportType] : 'Not selected'}</dd>
                            </div>
                            <div className="min-w-0 sm:col-span-2">
                              <dt className="text-muted-foreground">Report file</dt>
                              <dd className="wrap-anywhere">
                                {values.file?.name ?? 'Not selected'}
                                {values.file && ` (${describeSize(values.file.size)})`}
                              </dd>
                            </div>
                          </dl>
                          <p className="mt-3 text-sm text-muted-foreground">
                            Nothing has been submitted yet. Storage verification happens after upload and is not clinical review.
                          </p>
                        </section>
                      )}
                      <FormField
                        control={form.control}
                        name="syntheticConfirmed"
                        render={({ field: { value, onChange, onBlur, name, ref } }) => (
                          <FormItem>
                            <div className="flex items-center gap-3">
                              <FormControl>
                                <Checkbox name={name} ref={ref} checked={value} onBlur={onBlur} onChange={(event) => onChange(event.target.checked)} />
                              </FormControl>
                              <FormLabel className="flex min-h-control items-center leading-normal">I confirm this file contains synthetic data only (required)</FormLabel>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {guided && step > 0 && (
                        <Button variant="outline" onClick={() => setStep((current) => current - 1)}>
                          Previous step
                        </Button>
                      )}
                      {guided && step < 2 && <Button onClick={() => void nextStep()}>Next step</Button>}
                      <Button
                        hidden={guided && step < 2}
                        type="submit"
                        pending={isSubmitting}
                        pendingLabel="Uploading…"
                        size="lg"
                        disabled={isSubmitting || cancelling}
                        className={guided && step < 2 ? 'hidden' : 'w-full sm:w-auto'}
                      >
                        Upload report
                      </Button>
                      {serverError && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={isSubmitting || cancelling || !canStartOver}
                          onClick={startOver}
                          className="mt-2 w-full sm:ml-2 sm:mt-0 sm:w-auto"
                        >
                          Start a new upload
                        </Button>
                      )}
                    </div>
                  </fieldset>
                  {(isSubmitting || serverError) && (
                    <Button type="button" variant="outline" disabled={cancelling} onClick={requestCancel}>
                      {cancelling ? 'Cancelling…' : 'Cancel upload'}
                    </Button>
                  )}
                </form>
              </Form>
            </CardContent>
          </Card>
        </div>
        <aside aria-labelledby="upload-guide-heading" className="rounded-lg border border-divider bg-panel p-5 shadow-panel">
          <h2 id="upload-guide-heading" className="text-lg">
            Before you upload
          </h2>
          <ul className="mt-3 flex list-disc flex-col gap-3 pl-5 text-sm">
            <li>Use synthetic records only. Real patient information must not be uploaded.</li>
            <li>The server verifies the stored file. Verification confirms storage; it is not clinical review.</li>
            <li>
              Afterwards, find the report on the{' '}
              <Link className="inline-flex min-h-control items-center underline" to="/reports">
                Reports page
              </Link>
              .
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
