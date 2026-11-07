# Independently bounded capture-decision races
Date: 2026-11-01

The capture-decision ordering regression now runs its existing 60 reject/accept reviewer races as 60 independently named cases. Each keeps Jest's default five-second deadline, requires both writes to succeed and compares the current decision with the last event in the ledger. Each case still uses a fresh tenant, report and capture; the original workload remains 60 captures and 120 decisions. The ledger oracle must also return a decision.

Controlled real-database seeding latency reproduced the former aggregate timeout and passes with the independent cases. A private lock-removal mutation confirms all 60 cases still detect incorrect ordering. Production ledger code, test deadlines, shared helpers, dependencies and CI configuration are unchanged. [Evidence and limits](../verification/capture-order-test.md).
