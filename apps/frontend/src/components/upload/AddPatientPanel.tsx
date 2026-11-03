import { Plus } from 'lucide-react';
import { PatientDemographicsFields } from '@/components/patients/PatientDemographicsFields';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import type { useAddPatient } from '@/hooks/useAddPatient';

/** The "Add a synthetic patient" panel of the upload page: the opener button while closed, the label and demographics form while open. */
export function AddPatientPanel({
  addForm,
  visible,
  rosterEmpty,
  rosterLoading,
  submitting,
  onAdd,
  onOpen,
  onCancel,
}: {
  addForm: ReturnType<typeof useAddPatient>;
  visible: boolean;
  rosterEmpty: boolean;
  rosterLoading: boolean;
  submitting: boolean;
  onAdd: () => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  if (!visible) {
    return (
      <div className="-ml-3">
        <Button type="button" variant="ghost" size="sm" disabled={rosterLoading || submitting} onClick={onOpen}>
          <Plus aria-hidden="true" className="size-4 shrink-0" />
          Add a synthetic patient
        </Button>
      </div>
    );
  }
  return (
    <div role="group" aria-labelledby="add-patient-heading" className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-4">
      <p id="add-patient-heading" className="text-sm font-medium">
        Add a synthetic patient
      </p>
      {addForm.pending ? (
        <p className="text-sm text-muted-foreground">
          Patient <span className="font-medium text-foreground">{addForm.pending.label}</span> exists and is selected. Save its demographics, or continue and add them later on the
          patient's page.
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
                onAdd();
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
      <PatientDemographicsFields idPrefix="new-patient" value={addForm.draft} errors={addForm.errors} disabled={addForm.busy} onChange={addForm.setDraft} onEnter={onAdd} />
      {addForm.problem && (
        <p role="alert" className="text-sm text-destructive">
          {addForm.problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" pending={addForm.busy} pendingLabel="Saving…" disabled={submitting} onClick={onAdd}>
          {addForm.pending ? 'Save demographics' : 'Add patient'}
        </Button>
        {!rosterEmpty && (
          <Button type="button" variant="ghost" size="sm" disabled={addForm.busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
