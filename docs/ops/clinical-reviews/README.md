# Clinical reviews of releases

One file per staging release, named by the released commit: the `clinical-review.json` the release's image step accepted (spec 044), copied
here by the release's facts pull request ([staging-release.md](../staging-release.md), step 7).

Each file (schema `clinical-review/1`) names the base (the commit of the image that ran before), the candidate and the clinical files that
changed between them, and holds one of:

- `noClinicalChange: true`: nothing under the clinical paths changed, so no review was needed;
- `review`: Kevin's ECDSA P-256 signature (key id `kevin`) over `telesphoros-clinical-review/1`, the base and the candidate;
- `exception`: on staging only, the founder's one-line reason for releasing without the review.

The clinical paths are the "Clinical content and logic" block of [`.github/CODEOWNERS`](../../../.github/CODEOWNERS). Nothing here is read
by the application.
