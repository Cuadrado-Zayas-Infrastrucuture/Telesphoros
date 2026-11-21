# The genomic profile read route (spec 044, slice A)

Date: 2026-11-21

`GET /patients/:id/genomic-profile` answers, for the clinical read roles and behind the same gate as the evaluation reads (the pipeline or
the synthetic assessment), with the patient's genes from their current, verified evaluations and each current, active medication checked
against the stored results by RxNorm id: `review`, `held`, `no-recommendation` or `no-guideline-loaded`, with `knowledgeChanged` and
`conflict` beside it and every matching result listed. `?rxcui=` checks one more drug. It reads the medications and the current evaluations
through their services, runs no engine and writes nothing. A new module, `apps/backend/src/genomic-profile/`, is the only place that reads
both (the MD-6 boundary test now says so); `LabReportsModule` exports the evaluations service and its read guard, and
`PatientMedicationsModule` exports its service. The evaluation DTO is unchanged: the stored RxCUI reaches the profile beside the DTO, so an
older frontend never meets an unknown field, and founder decision B-D3 keeps it off the DTO for good. The route is pinned in
`test/route-set.json` and listed among what the synthetic assessment switch opens. The code was written without running it here (founder
decision P2); CI is its first run. Validation note: `docs/clinical-validation/genomic-profile-read.md`.
