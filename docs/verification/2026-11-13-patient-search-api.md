# Patient search on the server, the API (spec 040, slice A), 2026-11-13

Branch `docs/spec-040-patient-search`, from public main `a4de0bee`. Every check below ran in sealed, offline sandbox jobs (the
`telesphoros` job image), never on the host, except gitleaks. All data is synthetic. Nothing was pushed when this was written.

## What changed

- `packages/shared-types`: `patientLabelSearchSchema` (1 to 40 of `A-Z a-z 0-9 -`, not trimmed; messages name the rule, never the
  text) and `labelContains` on `patientListQuerySchema`, which stays strict.
- `storage/patients.repository.ts`: the contract's `list` takes `labelContains`; the in-memory store filters the tenant's rows with
  a lower-cased `includes` before paging, so the total counts matches.
- `storage/postgres/patients.repository.ts`: with a search, one fixed fragment, `AND strpos(lower(<alias>.label), lower($n)) > 0`, on
  the page, its total and the past-the-end count; the text is always a bound parameter. Without a search the statements are unchanged.
- `patients.service.ts`: passes the parameter through. The controller is unchanged.
- `docs/lab-report-reader.md`: the `GET /patients` reads sentence names the parameter.

Not changed: every migration and index; the unfiltered list's statement; patient creation, replacement, deletion, merging,
demographics, reports, the ledger, every clinical output; the front end.

## Order of work

| Commit | Step |
| --- | --- |
| `be1d7186` | Spec and plan, draft |
| `0a01bb9b` | Plan approved by the founder, D1 to D5 as recommended; `tasks.md` |
| `88adbf52` | Slice A: tests, code, route sentence; amended before any push for a gitleaks false positive, one lint error and Prettier |

The tests were written and run against the unchanged code before any code was written; see `tasks.md` A1 and A2 for what each showed.

## T0: an older API refuses the parameter

Against `a4de0bee` on the in-memory and PostgreSQL tiers, every `GET /patients?labelContains=…` answered 400 `VALIDATION_ERROR`, refused
as an unknown key (field `(request)`). The existing case that refuses `sort=label` (`patients.e2e-spec.ts:215`) passed. An API before this
change cannot answer a search with an unfiltered page.

## New tests

| Test | Where | Before the code | After |
| --- | --- | --- | --- |
| T1 | `shared-types.test.ts` | 4 failed (no schema) | 4 passed |
| T2 to T5 | `patients.e2e-spec.ts` | 4 failed, 400 where 200 was expected | passed, both tiers |
| T6 | `patients.e2e-spec.ts` (7 cases) | failed, field `(request)` not `labelContains` | passed, both tiers |
| T7 | `patient-merge.e2e-spec.ts` | failed, 400 | passed (PostgreSQL only) |
| T8 | `src/storage/patients.repository.spec.ts`, `test/db/patient-search.pg-spec.ts` | failed, the search ignored | passed |
| T9 | `query-plans.pg-spec.ts` | failed, 1,502 where 12 was expected | passed |
| T10 | `api-log-privacy.e2e-spec.ts` | passes by design (the log already drops the URL) | passed |

## Query plans (T9)

At 1,502 patients in one tenant: the unfiltered `patients-list` statement has SQL hash `c6b9f3de0a9bcc461ffbf53c92f8e11811b94dcc5623ed6f79c1f9dfbff385e9`
before and after the change. `patients-search` (`syn-15`), `patients-search-one` (`SYN-1500`) and `patients-search-none` (`XYZ`) are one
statement each; the text is bound as parameter 5, a string. The search ran in about 1 ms with 68 shared buffer hits, the same as the
unfiltered list. The planner reads the tenant's rows through `patients_creation_request_uq` (which leads with `tenant_id`) for the list
and the search alike, not the `(tenant_id, seq)` index the first draft of the spec named; the spec now says so.

## Deliberate breakages

Fourteen single changes, each turned its named test red, after control runs that passed; the tree was clean afterwards. Listed in
`tasks.md` A5. The planned survivor stayed green: with `tenant_id = $1` removed from the page statement, row-level security still hid
the other tenant on PostgreSQL. In memory, where the tenant filter is the only layer, removing it turned T4 red.

## Full loop on `88adbf52`

Sealed jobs, never the host:

| Check | Result |
| --- | --- |
| `pnpm build`, `pnpm typecheck` | exit 0 |
| `pnpm lint` (ESLint and `format:check`) | exit 0, after one unused parameter and one Prettier line were fixed in the commit |
| `pnpm test`, without services (CI's verify tier) | exit 0. Backend 170 suites and 2,305 tests passed, 32 suites skipped without PostgreSQL and S3 (announced `NOT RUNNING`), 5 specs `ENGINE ABSENT`; frontend 88 files; shared types 9 files; every other package passed |
| `check:chunks`, `knowledge:verify --production --allow-empty` | exit 0 |
| `pnpm test:infra` | 470 of 470 |
| `pnpm test:ci-config` | 238 of 238 |
| `pnpm check:workflows` | 5 of 5 |
| Backend, PostgreSQL plus S3 (`TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3`), six shards, three at a time | 317 suites (1 skipped) and 4,469 tests (2 skipped). Passed except three tests in two files this change does not touch: |
| `lab-reports-capture.e2e-spec.ts`, "while the CPUs are busy" (shard 3/6) | Failed in its shard, and again run alone: 1 of 35. Run alone on unchanged main `a4de0bee` at the same time, it fails the same way (1 of 35, about 70 s). Not this change |
| `readiness.pg-spec.ts` (shard 6/6) | Two 5-second timeouts under three shards; run alone, 11 of 11 |
| gitleaks 8.30.1, the branch's commits | No leaks. A first run flagged a test line (a variable named for a token, beside a query string) as a generic API key; the variable was renamed in the commit, before any push |

The six new or changed backend specs each ran in a shard and passed: `patients.e2e-spec.ts` and `query-plans.pg-spec.ts` (3/6),
`patient-merge.e2e-spec.ts` and `patient-search.pg-spec.ts` (5/6), `api-log-privacy.e2e-spec.ts` (2/6),
`patients.repository.spec.ts` (6/6). A first attempt ran three shards beside the verify job on a saturated host; it hit 5-second timeouts
in files this change does not touch and was stopped before it finished; its results are not counted.

## Not run

- The browser tier: the job image has no Chromium. No screen changed in this slice.
- `test:ig` (needs Java and a network). Hosted CI.
- The in-memory-with-services and PostgreSQL-only backend tiers as separate runs: the PostgreSQL plus S3 tier ran in three shards and
  the default tier ran without services; the new PostgreSQL tests also ran on their own (A2, A4).
