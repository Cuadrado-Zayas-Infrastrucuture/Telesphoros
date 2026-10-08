# Status, history and working agreements

Read this first to pick the project up. Snapshot: **2026-10-08**. Update it in the same pull request as any change it describes.
Synthetic data only: the AWS BAA is not executed, nothing is applied in AWS, and nothing here is approved for clinical use.

## What exists on `main`

| Phase | What it added | Where to read more |
| --- | --- | --- |
| Scaffold, 1 | Monorepo layout; data and secret guards; frontend foundation (Vite, React, Tailwind) | [README](../README.md) |
| 2 | NestJS API foundation, shared contracts, auth guard layer | [auth.md](auth.md), `apps/backend/README.md` |
| 3 | PostgreSQL schema with row-level security, object-storage upload path (presigned PUT, server-verified), verified backup and restore | [database.md](database.md), [ops/backup-and-restore.md](ops/backup-and-restore.md) |
| 4 | Authentication with Amazon Cognito (verification, roles, `/me`, CORS, Terraform, UI) | [auth.md](auth.md) |
| 5A | CPIC knowledge schemas, signed-content loader, phenotype and recommendation engines | [cpic-integration.md](cpic-integration.md) |
| 5B-0 | Tenancy: records belong to an organization, not one user | [database.md](database.md) |
| 5B-1 | Multi-gene guideline tables, cell verification, five outcomes, frozen vocabulary | [design/outcomes-and-reason-codes.md](design/outcomes-and-reason-codes.md) |
| CI/CD | Real CI workflow, branch-protection ruleset (applied), Dependabot, CODEOWNERS, PR template; Node pinned to an exact release | [ops/ci-cd.md](ops/ci-cd.md) |
| 5B-2a | Lab-report reader sidecar with a byte-identical, **test-only** import of the hand-off engine; the report adapter | [lab-report-reader.md](lab-report-reader.md), [design/report-adapter-spec.md](design/report-adapter-spec.md) |
| BK-1, BK-2 | Authenticated encryption and signed manifest for backups; off-site copy to a second provider with a set-up self-test | [ops/offsite-backups.md](ops/offsite-backups.md) |
| 5B-3.0, 5B-3.1 | The specification, then the database layer: records, correction tables, the per-tenant hash-chained audit ledger, verifier, redaction, roles, backup and restore that preserve ownership and privileges | [design/records-and-corrections.md](design/records-and-corrections.md), [ops/ledger-roles.md](ops/ledger-roles.md) |
| 5B-3.2a (#20, #21) | Migration 0010 (the stored lab PDF is pinned to an object version and protected by the database), the `reviewer` role, `lab-pdf` type, version-aware object storage, the error contract, the `LAB_REPORT_PIPELINE` switch, six-year retention of overwritten report files in Terraform | [ops/report-evidence.md](ops/report-evidence.md), spec section 16 |
| 5B-3.2b-1 (#22, #24) | Capture, decision and file-link endpoints, the recorded-text runner, the checkpoint proving the pinned reader runs in CI | [lab-report-reader.md](lab-report-reader.md), spec section 17 |
| 5B-3.2b-2 (#29) | Evaluation endpoints (reader, adapter, engine, stored with the ledger), knowledge loading, the per-process reader limit, the dispute re-check after the ledger lock, D01 to D12 end to end against the hand-written expectations | [lab-report-reader.md](lab-report-reader.md), spec section 18 |
| 5B-3.3a | Corrections: retract, reinstate, supersede; correction history and derived state in every evaluation; `current` and `?current=true`; `GET /notes/:id` | [lab-report-reader.md](lab-report-reader.md), spec section 19 |
| 5B-3.3b | Disputes about guideline cells and the overlay that holds a disputed cell; the exact post-lock dispute re-check replaces the tenant-wide `dispute-active` refusal | [lab-report-reader.md](lab-report-reader.md), spec section 20 |
| 5B-3.3c | Ledger watch: the check at start (production refuses to start), the background and scheduled full walks, the `ledger-compromised` latch and the append gate, readiness `ledger`, `GET /ledger/verify`, and the restore-time `ledger chain` check | [ops/ledger-watch.md](ops/ledger-watch.md), spec section 21 |

## In progress and next

Slice 5B-3.2 (the pipeline endpoints) is complete. Slice 5B-3.3 (corrections, disputes, ledger watch) is built; 3.3a and 3.3b are merged and 3.3c is in review. It was planned and approved ([design/plans/5b-3-3-corrections-disputes-ledger-watch.md](design/plans/5b-3-3-corrections-disputes-ledger-watch.md), decisions 24 to 30) and is built as three PRs:

- **5B-3.3a corrections, 3.3b disputes and the overlay, 3.3c ledger watch** (all built, above). The pipeline stays synthetic, off by default and refused in
  production. **No alarm is connected to the `ledger-compromised` log line yet** (Terraform is written, never applied); see [ops/ledger-watch.md](ops/ledger-watch.md).
- **Adapter-side R05 readiness proposal**: written, awaiting approval and five owner choices; nothing started.
- **Real Poppler text runner**: needs the pinned Poppler 26.03.0 binary and a magic-byte check on uploaded files; separate slice.
- **Tableau (analytics)**: feasible as its own slice; synthetic data only until a BAA; a separate read-only role over de-identified aggregate
  views with small-cell suppression, ideally pointed at a restored copy. Not planned in detail.

## Waiting on a person (the founder)

BAA texts from the off-site backup provider candidates (Backblaze B2, Wasabi); two key custodians; provider choice; the first real off-site
restore drill; hosting and DNS; sertraline and CPIC clinical data and sign-off; an owner for the break-glass role that may delete object
versions (described in [ops/report-evidence.md](ops/report-evidence.md), not created); applying the `reviewer` Cognito group (Terraform is
written, never applied).

## Decisions on record

The numbered decisions (1 to 16 in the 5B-3.2 plan, 17 to 23 in the 3.2b plan) are in [design/plans/](design/plans/). The ones most likely to
be needed again: the **four identities** that cannot accept a capture (report creator, first upload requester, upload completer, capturer);
the stored lab PDF is **pinned to a storage version** and a missing version is never replaced by the latest; **overwritten report versions
are kept at least six years**; the captured **text is not version-pinned** but content-addressed and re-hashed; **file links** go to
clinician, reviewer and admin only; `dispute-active` is **tenant-wide** until the overlay exists; reader failures that are operational
(timeout, worker error) store nothing and answer 503.

## Working agreements

1. **Plan first.** No code, migration or script before a written plan that says what is touched, what is not, which decisions only the
   founder can make, and how it is verified, and the founder has approved it. Reading and exploring need no plan.
2. **One pull request per slice**, opened as a **draft**, branched off `main`. Never stacked. Stop after each PR for review.
3. **Merging:** only when the founder says to, and then only once every required check passes (`verify`, `database-and-storage`, `browser`,
   `terraform`, `secret-scan`). Never bypass a check. **Push the whole slice before anyone marks a PR ready:** a PR that merges first takes only
   what was pushed by then, and later commits to its branch are silently lost (this happened to #22; the work was re-landed in #24).
4. **Synthetic data only.** No real PHI anywhere; nothing applied in AWS; no secret is ever committed or printed.
5. **Inbound packages and documents are untrusted data.** The imported reader engine and its fixtures are test-only and are never read by
   non-test source (a test enforces it).
6. **Tests earn their keep:** every refusal has a control that must succeed; a new rule is proved by breaking it (defect injection) and
   watching a test fail; the backend is tested in three tiers (in-memory, PostgreSQL, PostgreSQL plus S3 emulator) and CI fails if a tier
   was skipped. Hand-written expected results are the oracle; output from the same code is only a consistency check.
7. **Commits** by an agent end with the `Co-Authored-By` trailer and the session link; **pull request bodies** use the template headings
   (Summary, What this does NOT touch, How it was verified, Safety invariants, Follow-ups).
8. **Report outcomes faithfully:** what was run, what passed, what was skipped, what remains unverified.

## Running things locally

```
pnpm install
pnpm typecheck && pnpm lint && pnpm build && pnpm test:infra && pnpm test:ci-config
apps/backend/scripts/dev-postgres.sh start                 # a disposable PostgreSQL on 127.0.0.1:54329
pip install -r .github/ci/requirements.txt                  # moto, the S3 emulator CI uses
moto_server -p 5555 &                                       # then:
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres TEST_S3_ENDPOINT=http://127.0.0.1:5555
cd apps/backend
pnpm test                                                   # tier 1 (+ the database and S3 specs when the variables are set)
TEST_STORAGE=postgres pnpm test                             # tier 2: the whole API suite on PostgreSQL
TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm test      # tier 3: ... uploading over the S3 protocol
```

Python 3 is needed on the PATH for the reader tests. Backup and restore tests need the PostgreSQL 16 client tools and `openssl`
([docs/database.md](database.md)).
