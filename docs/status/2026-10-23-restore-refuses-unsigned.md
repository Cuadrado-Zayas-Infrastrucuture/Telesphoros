# Fix: restore refuses an unsigned (format 1) backup unless the operator allows it (local)

Date: 2026-10-23

Found by the security audit. A format 1 manifest is plain JSON, so `restore` took its dump checksum, its required-role list and its migration list from whoever could write the backup folder; someone who could replace the dump could replace the manifest to match, and `restore` would verify its own copy of the lie. Format 2 is signed and could not be downgraded, but nothing stopped a format 1 backup being handed to `restore`. `restoreAndVerify` now stops after reading the manifest, restoring nothing, unless `allowUnauthenticated` is set; the CLI flag is `--allow-unauthenticated`. The message says why and names the flag. `backup` is unchanged (a backup without `--key-file` is still unencrypted and format 1, for development), and off-site upload and restore are unchanged: they already accept only format 2.

Verified on my own scram PostgreSQL cluster (Node 22): before the test edits the refusal failed 20 restore tests, as expected; the 23 restore calls on unsigned backups now pass the option; a new test shows the default refusal (only `manifest valid` and `manifest signature` run) and, as the control, the same fixture passing once allowed. With the guard disabled, that test fails; restored afterwards. Restore, ledger-backup, ledger-restore-check, evidence-catalogue, off-site restore and discovery specs: 83 of 83.

Whole PostgreSQL tier (tier 2): 3037 passed, 21 skipped, 0 failed; `test:infra` 141 and `test:ci-config` pass. Not covered: the memory tier and the PostgreSQL-plus-S3 tier were not re-run (the change is outside the code they exercise beyond these specs); the real CLI was not run end to end.

Local only until the pull request is opened.
