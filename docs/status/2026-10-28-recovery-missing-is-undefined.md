# Fix: recovery storage answers "not found" for an object the restore does not hold (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (O1).

**The problem.**
- Every `ObjectStorage` returns `undefined` from `inspect` and `getObject` when no such object or version exists, and the callers answer 409 (`source-missing`, `source-changed`).
- `RecoveryObjectStorage` threw `EvidenceError('missing')` instead when a key or logical version was not in its catalogue. No filter maps that error, so the request failed with 500.
- Latent today: only the tests open recovery storage (`AppModule.register(env, recovery)`); nothing in production does.

**The fix** (`apps/backend/src/object-storage/recovery-object-storage.ts`).
- `resolve()` returns `undefined` for a key or logical version the catalogue does not hold. `getObject` and `inspect` pass it on, so the callers' 409s apply.
- `createDownloadUrl` still throws `missing` for it: it never signs a link to an object the restore does not hold.

**Kept as an error, by decision.** A catalogued copy that startup verified and that is gone later still throws `missing` (500). It means the installed copy was deleted under Object Lock: a broken restore that operators must see, not an ordinary missing file. `integrity`, `ambiguous` and `limit` stay errors too, and startup verification (`open()`) is unchanged.

**Not changed.** The callers, the S3 and in-memory stores, the catalogue format, the recovery CLI and `docs/ops/application-recovery.md`.

**The tests.**
- `test/recovery-object-storage.spec.ts`: a key and a pin the restore does not hold are `undefined` from `getObject` and `inspect`, and `createDownloadUrl` still refuses; a catalogued copy deleted after startup still throws `missing` from both reads. Red before the fix (2 of 7).
- `test/helpers/application-recovery.ts` (the F3 PostgreSQL suite): an unheld logical pin is now `undefined`, not a rejection. With the old file restored, `application-recovery.pg-spec.ts` went red.
- Recovery suites on PostgreSQL 16 and Moto: 47 of 47, none skipped. The whole backend suite on both tiers: 249 suites passed, 0 failed, 2 skipped (`local-storage-bounds` and `local-storage-cleanup`, which skip under `TEST_STORAGE=postgres`); 3325 tests passed. Not verified in AWS.
