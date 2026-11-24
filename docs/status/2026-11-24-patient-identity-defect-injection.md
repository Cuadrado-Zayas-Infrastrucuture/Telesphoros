# Defect injection for the patient page's unknown identity, and a lost test restored

Date: 2026-11-24

The plan in `docs/design/plans/patient-page-identity-outage.md` (built in #454) asks, in section 6, that each rule be broken and a test be
seen to fail. That step had not been done. It is now, in a sealed `opensandbox-pilot` job, and the record is in
`docs/clinical-validation/patient-identity-unknown.md` under "What the tests show".

- Five defects were each applied alone, run and reverted: one `Promise.all` again, a failed identity read set to `none`, the medications
  hold dropped, the warning without the label, and the decision link ignoring the hold. Each turns at least one test red.
- The fifth did not at first. The unit test for the decision link merged with #454 and was dropped by a merge commit on the branch of #457
  (`6853c826`), so `main` lacked it from `123d3774` on. This change puts it back with its text unchanged. The code it tests was not affected.
- One gap is recorded and not closed: no test checks that the patient page passes the hold on to the genomic profile. Whether to add one is
  the founder's decision.

A test and documentation only: no source, backend, route, setting, check or migration change.
