SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- Removing the caller only stops the removal of expired capabilities again: the rows are kept, as before 0065, until a later sweep. Nothing reads one
-- after its five-minute grace, so nothing else changes.
SET LOCAL ROLE telesphoros_jobs;
DROP FUNCTION capabilities_sweep_run(integer);
RESET ROLE;
