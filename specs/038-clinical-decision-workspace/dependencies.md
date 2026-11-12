# Dependencies: what the workspace cannot do until something else exists

Each entry is something specs/038 stopped short of because no contract supports it. Nothing here is built, and nothing in the front end
pretends it is. Order is the order to build in. A new route or field needs its own plan and the founder's approval first.

## 1. Patient search on the server (F12)

- **Missing:** a way to find a patient who is not on a loaded page. `GET /patients` takes `page`, `pageSize`, `includeMerged`, `order`
  (`patientListQuerySchema`); the roster filters loaded labels only (spec D17).
- **Owner:** API `patients` module and `packages/shared-types` (`patient-merge.ts`); then `PatientRoster` and `PatientPicker`.
- **Minimum data:** a `label` prefix parameter on the existing list (case-insensitive, 1 to 64 characters of the label alphabet),
  answering the same paginated `PatientDto` list. Search by label only: names and dates of birth are encrypted per patient and are not
  searchable by design.
- **Authorization and version:** the roles that read the list today (reader, clinician, reviewer), tenant-scoped by row-level security
  as the list is. A new optional parameter; an API without it must answer 400 for it, not ignore it, so an older API cannot return an
  unfiltered page that reads as a search result.
- **Failure states:** 400 for a malformed prefix; the list's existing 401, 403 and 5xx. The front end keeps the loaded-pages filter and
  its scope sentence when the answer is anything but 200.
- **Acceptance:** two tenants with the same label prefix see only their own; a prefix matching 0, 1 and more than one page of patients
  pages correctly; the SQL is parameterized; the roster's scope sentence changes to say the whole list was searched only on a 200.

## 2. What each conflicting source reports (F11)

- **Missing:** the findings of each conflicting source. The saved history carries, per source, its ids, revision, status, saved time
  and finding ids (`structured-records.ts`, `history`), not the reported values (spec D16).
- **Owner:** API structured-records and review modules, `packages/shared-types` (`structured-records.ts`, `structured-review.ts`); then
  `SourceComparison`.
- **Minimum data:** for each id in `conflict.revisionIds`, the fields a reviewed finding already has for the current source: finding id,
  gene, coverage, analytical state, interpretation state; plus the source's report date and any stated assay limitation, each nullable
  and never filled in when the source does not state it.
- **Authorization and version:** the roles that read the record today; the independent-review rule unchanged (the reviewer is not the
  uploader). A new field on a strict schema breaks an already-released front end, so it is a new read or a versioned response
  (specs/037 D3 took the same route).
- **Failure states:** a source whose file can no longer be read answers "not available" for its findings, per source, without failing
  the whole comparison.
- **Acceptance:** two sources that differ in one finding show that finding differing and the rest equal; a source with an unreadable
  file shows as not available; no source is marked preferred; the source decision's request is unchanged.

## 3. A work list across patients (home)

- **Missing:** one read that lists what needs a person: results on hold, results whose guidelines have since changed, and due
  follow-ups. Follow-ups have an inbox read; results are read per patient or per report only.
- **Owner:** API `lab-reports` (evaluations) and `patient-followups`; then the home screen.
- **Minimum data:** per item: kind, patient id and label, report id, result id and drug where there is one, the reason in the existing
  vocabulary, and the time it arose. No score and no ranking beyond time: an item being old is not a clinical warning.
- **Authorization and version:** clinical read roles, tenant-scoped; `current=true` semantics as the evaluations list already defines
  them.
- **Failure states:** each kind fails on its own; the home shows the kinds it could read and says which it could not.
- **Acceptance:** an item disappears when its cause does (a hold resolved, a result superseded) without a client-side guess; a tenant
  never sees another's; an empty list is said to be empty, not shown as loading.

## 4. Who resolves a hold, and by when (F07)

- **Missing:** an owner, a due date or a completion for a hold. A hold carries its fixed message and reviewer action only (spec D13).
- **Owner:** a product and clinical decision first (whether holds are assigned at all); then the API and a migration.
- **Minimum data:** not designed. Follow-ups already have an assignee and a due date; reusing that record for a hold is one option.
- **Acceptance:** the page shows an owner only when the API names one, and "completed" only when a person recorded it. Opening a result
  never counts as resolving it.

## 5. Where an explicit acknowledgement sits (F13)

- **Missing:** a decision on placing the "Reviewed" control of specs/019 in the result view. The control and its API exist; the result
  view adopts render capture only (spec D18).
- **Owner:** the founder as pharmacist; then `StoredResult`.
- **Acceptance:** displayed, acknowledged, decided and followed up stay four separate records, and the screen never implies one from
  another.

## 6. A language other than English in the clinical screens (F14)

- **Missing:** a localisation layer outside the landing page, and reviewed Spanish clinical wording. Guideline wording is shown as the
  source wrote it and is not translated by the product.
- **Owner:** front end for the layer; a qualified reviewer for every clinical sentence.
- **Acceptance:** no Spanish clinical sentence ships without a named reviewer; `lang` is set on any passage whose language differs from
  the page's.

## 7. An identity bar that stays in view (spec D12)

- **Missing:** a patient identity line that stays visible while a long result list scrolls. It needs a browser to judge: what it
  covers, whether it hides the focused control, and how it behaves at 200% text size.
- **Owner:** front end, with the Playwright suites.
- **Acceptance:** at 1280×800 and at 375 wide, with 20 results, the focused control is never under the bar, and the bar adds no
  horizontal scroll at 200% text size.
