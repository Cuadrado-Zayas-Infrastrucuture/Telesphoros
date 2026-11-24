# Defect injection for the patient page's unknown identity, a lost test restored and one added

Date: 2026-11-24

The plan in `docs/design/plans/patient-page-identity-outage.md` (built in #454) asks, in section 6, that each rule be broken and a test be
seen to fail. That step had not been done. It is now, in a sealed `opensandbox-pilot` job, and the record is in
`docs/clinical-validation/patient-identity-unknown.md` under "What the tests show".

- Six defects were each applied alone, run and reverted: one `Promise.all` again, a failed identity read set to `none`, the medications
  hold dropped, the warning without the label, the decision link ignoring the hold, and the page telling the genomic profile that nothing
  is held. Each turns at least one test red.
- The fifth did not at first. The unit test for the decision link merged with #454 and was dropped by a merge commit on the branch of #457
  (`6853c826`), so `main` lacked it from `123d3774` on. This change puts it back with its text unchanged. The code it tests was not affected.
- The sixth did not either: no test showed that the patient page passes the hold on to the genomic profile. The founder decided on
  2026-11-24 to add that test, with its control.

Tests and documentation only: no source, backend, route, setting, check or migration change.
