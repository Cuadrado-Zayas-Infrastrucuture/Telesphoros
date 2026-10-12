# PR #80 operational blocker regression

The two review findings at `9498f64` are addressed within the owned synthetic runner. No backend application source, migrations, clinical processing, AWS configuration, production data or existing review services were changed.

## Resulting behavior

- Sweep outcomes are durably recorded inside the admission guard, before enabling the API. Persistence failure closes the listener even after database reconciliation succeeds. Failed writes remove only their own exclusive temporary; a renamed destination survives a directory-sync failure. A retry reopens admission only after a durable success.
- Supervisor health reads use the same exclusive operations lock as restart and teardown. Health defers to live maintenance and rechecks afterward, avoiding stopped-PID and partially updated manifest observations. Lock publication exposes a complete receipt; release/acquire races retry safely.

## Local regression evidence

Verified on 2026-10-12 with Node 22.22.0, PostgreSQL 16.14 and Moto 5.2.3:

| Check | Result |
| --- | --- |
| Operations unit controls | 14 passed, zero skips |
| CI configuration guards | 35 passed |
| Native operational rehearsal | 38 recorded checks; all local controls passed with the existing signed-URL expiry emulator gap |
| Browser assertions on owned stack | 16 passed, mobile and desktop |
| Native status persistence regression | API closed on failed write; no temporary residue; durable retry reopened admission |
| Native supervisor regression | Survived a stopped API under the maintenance lock for two ticks and three ordinary restart CLI commands; normal shutdown exited 0 |

`pnpm test:storage-recovery` runs the targeted native regressions. The full `test:storage-rehearsal` also includes them. Both require actual local dependencies and refuse missing services rather than skipping. Hosted CI executes the 14 operations unit controls as part of the root test command; the native lifecycle rehearsal remains local-only.

Every owned regression fixture was removed using the receipt-based teardown. Moto signed-URL expiry remains unresolved: an expired signed URL still returned HTTP 200. This local scope establishes neither AWS authorization/custody nor production readiness. No merge is authorized.

Hosted CI delivery results are recorded on draft PR #80 and in the external delivery receipt after pushing the final fix commit. This document records local behavior and does not claim a remote check result in advance.
