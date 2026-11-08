# The backend README says where a change goes

Date: 2026-11-07

A read-only onboarding audit of main `859e964a` found that `apps/backend` has overlapping folder names (`auth`, `members` and `membership`; `storage`, `object-storage` and `db`; a generic `services`) and no task-to-code map, so a first change could land at the wrong layer or update the in-memory store and miss PostgreSQL. Documentation only; no code, test or migration changed.

`apps/backend/README.md` now has, before the endpoint table: where the entry points are, what each look-alike folder is, the direction of dependencies (with the places that break the simple rule, found by search: SQL also runs in the ledger, session admission and `src/db`, and six more files read `STORAGE_DRIVER`), one traced path from the UI through the shared contract, controller, service and repository to PostgreSQL with its tests (create a patient), and a table for five kinds of change: add a patient field, change upload validation, change a clinical gate, add a job and change who may do what.

One audit example was changed: "change clinical hold". `PGX_CLINICAL_HOLD_LIFTED` is named only in documentation; no code under `apps/` or `packages/` reads it, so the row covers the gates that exist in code (`LAB_REPORT_PIPELINE`, `SYNTHETIC_ASSESSMENT`) and says so.
