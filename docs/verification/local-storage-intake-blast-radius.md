# L1 verification resource boundary

Approved scope: synthetic local L1 API and library tests only. Clinical processing remains disabled in storage-only apps; existing explicitly enabled regression suites use their own disposable fixtures. L2/L3 implementation, cloud access, spending and agreements remain deferred.

The test PostgreSQL cluster is newly created at `<task workspace>/l1-fixtures/pg16`, listening only on 127.0.0.1:54471 with an owned socket directory. Its test helper creates generated `test_<hex>` databases and drops only those databases on this cluster after closing clients. The test S3 emulator is a newly launched owned Moto 5.2.3 process on 127.0.0.1:5571; generated versioned `synthetic-storage-<UUID>` buckets contain synthetic files only. Other tests create their own generated buckets on this same new emulator.

Existing clinical-review databases, PostgreSQL processes, Moto endpoints and SMART/OpenEMR containers are protected and will not be reset or stopped. Both selected ports were checked for listeners before launch. Busy ports are a refusal, not permission to kill a process.

Cleanup tests may delete only exact versions beneath the tested owned run prefix, or abort multipart IDs whose test journal explicitly owns them. Committed/soft-deleted pins, unknown ownership, unavailable/incomplete inventory, retained objects and unowned sentinel objects must remain. The expected loss is the test's abandoned synthetic bytes; fixtures recreate them. Tests never invoke a broad bucket or database deletion against an existing service.

At verification end, stop only the PID/process launched here and the PostgreSQL server whose data directory and postmaster identity match the path above. Preserve logs and fixture roots for review; no recursive deletion is required. This is the L1 verification harness, not the pending L3 product runner/scheduler/automated teardown.

Existing recovery regressions create only suite-owned temporary PostgreSQL clusters, and stop/remove their generated cluster roots through their existing harness. Browser regressions use their existing fixture launcher on previously checked free ports 5557/3010/4010/4173; that launcher terminates only children it starts. They do not connect to the protected review runner. Staging tests remove only private directories they create and exact test symlinks; no recursive cleanup of another directory is permitted.

To exercise the existing password checks instead of skipping them, only this owned fixture cluster may change its `pg_hba.conf`: loopback postgres admin remains trust for the synthetic harness, other loopback logins use SCRAM. Back up the exact file first; restore it and reload this same data directory if authentication fails. Existing clusters/users/configurations are out of scope. No real credential is read or printed.

Download-refusal controls intentionally replace latest bytes, add a delete marker and remove one exact pinned version in their own generated synthetic bucket. Expected loss is that inert test fixture alone; the test regenerates it. Cleanup preservation controls remain separate and never delete their protected pins.
