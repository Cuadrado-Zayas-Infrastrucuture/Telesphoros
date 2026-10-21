## Summary

<!-- What changes and why, in a few sentences. -->

## What this does NOT touch

<!-- Anything a reviewer might assume is included but is not. -->

## How it was verified

<!-- Commands run and results: typecheck, lint, tests (which tiers), browser tests, mutation checks, etc. -->

## Safety invariants

- [ ] **Synthetic data only.** No real patient data, in code, tests, fixtures, logs, or screenshots.
- [ ] **No PHI and no secrets** in this diff or in the PR description.
- [ ] **BAA status unchanged:** the AWS BAA is not executed, so nothing real is stored and nothing is applied in AWS. (If this PR changes that, say so here.)
- [ ] **Clinical hold unchanged:** nothing in this PR lifts or weakens a clinical hold. (If it does, it must name the sign-off.)
- [ ] Clinical logic changes carry tests and a validation note in `docs/clinical-validation/`.
- [ ] Database changes are a new numbered migration with a down file, and the database tier was run.
- [ ] This PR adds one `docs/status/YYYY-MM-DD-slug.md` fragment (not a section in `docs/STATUS.md`), or changes nothing `docs/STATUS.md` would describe.

## Follow-ups

<!-- Known gaps, decisions waiting on a person, next steps. -->
