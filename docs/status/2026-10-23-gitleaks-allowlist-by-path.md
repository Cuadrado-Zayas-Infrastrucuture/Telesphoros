# Fix: secret-scan allowlist by path and shape, not by commit hash (local)

Date: 2026-10-23

The first CI run on the new public repository failed `secret-scan` with one finding: a row in `apps/backend/test/migration-history.spec.ts` (`['0016', 'security_access_audit', '<sha-256>']`) that the `generic-api-key` rule reads as a key because the migration name contains "access". The hash is the checksum the migrator stores for that migration file, not a credential. The repository already knew this false positive, but suppressed it in `.gitleaksignore` by a commit-hash fingerprint, and the public history is a rewrite of the private one, so every commit hash changed and the fingerprint matched nothing.

Now `.gitleaks.toml` allows exactly that row shape in exactly that file for exactly that rule (`^\s*\['\d{4}', '[a-z_0-9]+', '[0-9a-f]{64}'\],?\s*$`), and `.gitleaksignore` is removed (both its fingerprints named commits that no longer exist; the Moto container name is already covered by the existing path-and-pattern allowlist). Nothing in this setup depends on a commit hash any more.

Verified with gitleaks 8.30.1 over the whole history: the old configuration finds 1 leak (the CI failure, reproduced locally); the new one finds none. Two controls show the allowlist stays narrow: a key-shaped value added to the same spec file in a different line shape, and the same row shape in a different file, are each still flagged (2 findings, nothing else).

Not changed: the default gitleaks rules, the other allowlists, the CI job.

Local until the founder says push. The first run's failure is why `main` shows a red required check until this merges.
