# Worker shutdown process test synchronization
Date: 2026-11-08

The SIGTERM drain process test no longer assumes the test parent can enqueue another job and send a signal before the worker handles that job. Its worker had spare capacity, and the first job's 1.2-second timer did not establish that ordering. A controlled reproduction let the second job finish before SIGTERM and reproduced the original `succeeded` versus `queued` assertion failure.

The existing disposable PostgreSQL settlement gate now also supports synthetic slow jobs. The test holds a real running job at settlement, waits for the worker's `worker-draining` acknowledgement, enqueues new work, then releases the first job. It retains the clean-exit, completed-first-job and untouched-later-job assertions and also checks that the later job has no attempts. A companion control proves the same worker can complete later work with spare capacity before shutdown while the first job is held.

All coordination stays in the test fixtures. Worker behavior, shutdown/drain deadlines, job definitions, schema and CI settings are unchanged. The fixtures retain original assertion and cleanup failures. Verification counts and mutation results are recorded in the pull request; synthetic data only.
