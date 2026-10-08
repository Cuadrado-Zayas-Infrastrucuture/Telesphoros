# Backup format v1 fixture (TEST ONLY)

A real encrypted backup written by the original `db:backup` (format version 1: AES-256-CBC with a PBKDF2 passphrase),
generated on 2026-10-08 from a synthetic database (three tenants, 15 rows). It exists so a test can prove that backups
written before format v2 still restore. `passphrase.txt` is a throwaway string for this fixture only, not a secret of
any kind. Never regenerate it with newer code: its value is that the old code wrote it.
