# The patient-switch control test waits for the read it releases

Date: 2026-11-19

`PatientPage.test.tsx`, "control: the held first-patient reads do show on that patient once they answer", failed once in CI on a loaded
runner (1 of 1,208 frontend tests; the re-run passed). The test holds the first patient's results read and frees it with `release()`,
which frees only the reads already held. It released as soon as the chart's heading rendered, and when the page sent the read after
that, the read was held for good, so no longer timeout would help. The test now waits until the read has been sent before releasing it,
and the results late-answer test waits for the same read before it switches patients, so the late answer it guards against is really
sent. Reproduced by delaying the read 50 ms before it reaches the mock: the control test fails before the change and passes after it.
`release()`, timeouts and assertions are unchanged. Test-only: no product, schema or CI change.
