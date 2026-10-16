---
name: telesphoros-verify
description: Verify and test a Telesphoros change using the right unit, PostgreSQL, S3, worker, browser and image evidence. Use when asked to prove acceptance, run checks, validate a fix, or assess whether green tests actually cover the changed behavior.
---

# Verify what the change actually proves

Read the [repository context and command matrix](../../references/telesphoros.md). Inspect the diff and its acceptance contract before choosing tests. Verification does not authorize an unrelated fix, cloud spend or production test.

1. Record the checkout SHA, dirty state, runtime, selected suites and required services. Find the repository's current scripts rather than substituting generic upstream commands. Start focused, then cover the affected integration boundary; distinguish tests intentionally not selected from selected tests that skipped themselves.
2. For database/storage/permission behavior, provision only the documented disposable synthetic services within approval. Run all three backend profiles and affected worker tests. A process exit 0 with `[jest] NOT RUNNING`, an absent required profile or missing recovery evidence cannot pass acceptance. Require real application-role/tenant-isolation checks; a mock or superuser query is insufficient.
3. For recovery, run both existing artifact validators over all three profiles at the tested checkout. For an image, distinguish text guards from an actual build, attestations, blocking vulnerability scan and runtime rehearsal. Local inability to start Docker is a limitation, not container evidence.
4. For UI, use the relevant real browser flow, desktop/mobile and expanded/error/loading/permission states. Use synthetic identities; withhold sensitive console/network content and screenshots. Read the existing frontend branding and token rules. Browser mocks do not prove real service behavior.
5. Preserve full permitted outputs and producer statuses locally, then summarize counts, failures and skips. Keep the tested diff fixed while collecting results. After a repair, rerun the affected check; repeat wider suites only when new changes or unresolved concerns justify it. Report missing tools/services before claiming completion.

**Return:** `acceptance claim | command/source | checkout | passed/failed/skipped/not run | evidence | limit`. Separate local, exact-head CI, hosted and clinical evidence. All six required checks remain mandatory; this skill cannot waive them.

**Self-check:** Did the relevant producer actually run? Are counts complete and exits preserved? Is every claim limited to the environment and role that were tested?
