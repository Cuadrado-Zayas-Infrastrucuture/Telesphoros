# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses semantic versions from 1.0.0 onward; before that, versions describe milestones.

## [Unreleased]

## [0.1.0] - [DRAFT: date set when tagged]

First public baseline. Status: synthetic data only, nothing deployed, not approved for clinical use.

### Added
- Clinician interface for report upload and the report list (local-storage build), with sign-in and role-based access.
- API with tenant isolation, roles, patient records and an append-only audit ledger.
- Background worker and job queue (code complete; not accepted in a hosted environment).
- Community files: Code of Conduct, issue forms, Support, Maintainers, and an agent instructions file.

### Changed
- CI runs less work when the change does not need it: documentation-only changes, draft pull requests, and a merged tree that was already verified. Pull requests run two backend profiles, and the third runs in a nightly job. Dependency caches are keyed by their dependency files.

### Known limitations
- No clinical guideline content is loaded.
- The infrastructure is written and tested with mocks. It has never been applied to AWS.
- The lab-report pipeline is synthetic and disabled in production.
