# The readiness database-drop test no longer pays for earlier tests' databases

Date: 2026-11-18

`readiness.pg-spec.ts`, "turns NOT ready when the database disappears", ran past its five-second deadline under load (traced since
2026-10-26). PostgreSQL's log shows why: `DROP DATABASE` forces an immediate checkpoint, and because every earlier test's database stayed
alive until the end of the file, that first drop had to write about 12,000 buffers and sync about 6,750 files (3.7 to 8.9 s in sealed
jobs). Each test now releases its application and database when it ends, and a guard fails any test that inherits them; the drop takes
about 120 ms. Assertions and deadlines are unchanged. Test-only: no product, schema or CI change.
[Verification](../verification/readiness-drop-checkpoint.md).
