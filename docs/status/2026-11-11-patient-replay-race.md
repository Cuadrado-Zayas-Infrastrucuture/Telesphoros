# A patient create retry no longer conflicts with itself

Date: 2026-11-11

Slice 1 of the performance measurement plan (`docs/design/plans/performance-measurement.md`, pull request #368), approved by the founder on
2026-11-11 (decision D1).

`POST /patients` with a `requestId` is meant to answer every repeat of the same request with the patient it created. About 1 run in 9 of
`scripts/readiness/local-load.cjs` (2 of 18 on 2026-11-11), one of 16 simultaneous repeats got `409 "A patient with that label already
exists."` instead, while the database held one row. `PatientsService.create` looked the request id up, then the label: a repeat that read
the request id before the first request committed and the label after it met its own label.

Now, when the label is taken and a request id was given, the service reads the request id once more before answering 409. The label read
saw the other row committed, so the second read sees it too: a repeat of the same request is answered with that patient, and a different
body under the same id, or a label another request took, is still a 409. The request-id lookup moved into one helper used by both reads.
No schema, route or response shape changed.

Proved: a unit test forces the interleaving (the first request-id read misses, as it would in the race). It fails without the change and
passes with it, beside two controls that must stay 409. Then the local rehearsal 30 times in a row with no failure (it had failed 2 in 18).
