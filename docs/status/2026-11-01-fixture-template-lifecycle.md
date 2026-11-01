# Fixture template lifecycle recovery
Date: 2026-11-01

The independently recovered fixture repair retargets stale lifecycle fault controls to migrated-template construction and copying. The helper reclaims unfinished template databases immediately after construction failure, cancellation or publication failure. The five-second test deadlines and real PostgreSQL cleanup assertions remain. See [verification](../verification/fixture-template-lifecycle.md). MD-a remains a separate slice; no push or deployment is included.
