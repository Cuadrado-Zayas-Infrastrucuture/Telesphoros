# Status, history and working agreements

Read this first to pick the project up. Snapshot: **2026-10-09**. Update it in the same pull request as any change it describes.
Synthetic data only: the AWS BAA is not executed, nothing is applied in AWS, and nothing here is approved for clinical use.

## Current frontend foundation closure

Phase 0 skeleton accepted by founder on 2026-10-09. Phase 1 closure is on a separate PR branch, locally verified, awaiting CI/review and founder phase acceptance. It adds local-screen field errors/focus, shared token controls, mobile/keyboard checks, separate form-component files and all-page chunk guards. Standard product upload remains a browser-only sample stub; clinical logic and hosting are untouched. Evidence: [Phase 1 closure](verification/phase1-closure.md). No later phase is marked complete by this change.

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

Slice 5B-3.2 (the pipeline endpoints) is complete. Slice 5B-3.3 (corrections, disputes, ledger watch) is complete; 3.3a, 3.3b and 3.3c are all merged. It was planned and approved ([design/plans/5b-3-3-corrections-disputes-ledger-watch.md](design/plans/5b-3-3-corrections-disputes-ledger-watch.md), decisions 24 to 30) and is built as three PRs:

- **5B-3.3a corrections, 3.3b disputes and the overlay, 3.3c ledger watch** (all built, above). The pipeline stays synthetic, off by default and refused in
  production. **No alarm exists in AWS for the `ledger-compromised` log line yet**: it is written as Terraform in F3b (below), never applied; see [ops/ledger-watch.md](ops/ledger-watch.md).
- **Disputed-cell evaluation listing**: implemented in this slice; exact file matches and historical candidates without provable file identity are shown separately. Read-only, paginated, and synthetic-only; see [verification and limits](clinical-validation/cell-usage-listing.md).
- **Hosting H1**: company site on Vercel, product on AWS, both domains in Jan's Cloudflare account. Optional private S3/CloudFront frontend configuration is written, disabled by default and never applied; see [hosting and DNS checklist](ops/domains-and-hosting.md). API host, WAF, deployment roles/state and live validation remain separate prerequisites (the CloudTrail audit trail is the next item).
- **Audit trail (F1)**: CloudTrail with S3 data events on the reports bucket, a locked log bucket with its own key, and six email alarms are written as Terraform and guard-tested, **never applied**; see [ops/audit-trail.md](ops/audit-trail.md). It satisfies the audit condition for the break-glass role once applied and tested; the role is still not created.
- **API rate limiting (F2)**: per-address (before sign-in) and per-person-by-route-class token buckets returning 429 `RATE_LIMITED`; per process; production requires `TRUST_PROXY_HOPS`; see [ops/rate-limiting.md](ops/rate-limiting.md). The frontend does not yet show a friendly 429 message.
- **API hosting, edge (F3a)**: ACM certificate, HTTPS-only load balancer, firewall and exact security groups for the API are written as Terraform and guard-tested, **off by default and never applied**; staging front end on Vercel, staging API on AWS in production mode. The compute (F3b) and the deployment pipeline (F4) are next; see [ops/api-hosting.md](ops/api-hosting.md) and [the plan](design/plans/f3-api-hosting.md).
- **API hosting, compute (F3b)**: ECS Fargate cluster and service, task and one-off migration task definitions, roles, secret containers (no values), a log group with its own key, and four alarms (including `ledger-compromised`) are written as Terraform and guard-tested, **off by default and never applied**; the task environment is checked against the application's own configuration loader. **Open before anything can run:** the image and pipeline (F4), the three database logins (no tool creates them yet), a VPC with a NAT route; see [ops/api-hosting.md](ops/api-hosting.md).
- **Shared ledger containment (FD-2, from the 2026-10-09 peer review)**: a walk that finds damage records an incident in the database (migration 0011); `ledger_append` refuses that tenant's writes in every task, other tenants carry on, `/ready` says `contained`, and only an operator can reopen it, after a full walk that began later has passed. A global hold stops everyone. Proved against real PostgreSQL (two sessions, a restart, a restore, the in-flight order) and by 20 injected defects; **not** proved in AWS. Two-person authorisation of a clearance waits for the second reviewer. See [ops/ledger-watch.md](ops/ledger-watch.md), [the plan](design/plans/fd2-ledger-containment.md), spec section 23. This also corrects the F3b wording that a damaged task "leaves rotation at once": the load balancer fails open, and the database is what contains the tenant.
- **Database logins command (FD-4a, from the 2026-10-09 peer review)**: `db provision-logins` (run as a one-off task) creates the application, ledger-verifier and migrator logins with generated passwords sent to the database only as SCRAM verifiers (the RDS parameter group logs DDL), writes the connection strings into the three Secrets Manager containers, is safe to run twice, `--rotate` replaces every password, and reads the result back from the catalog (each login a member of exactly its group; the verifier cannot append; the application cannot touch incidents; neither writes a ledger table). Terraform adds the task and two roles (the task role cannot read the administrator secret). Proved on PostgreSQL 16 by automated tests (and, once by hand, a non-superuser administrator on a pristine cluster, after which the migrator, which is not `CREATEROLE`, applied all 11 migrations; FD-4b automates that), the Secrets Manager calls on an emulator, and 24 injected defects; **not** proved on RDS, IAM, or Fargate (FD-7). The image and the CI rehearsal of the first deployment are FD-4b. See [api-hosting.md](ops/api-hosting.md#the-database-logins-db-provision-logins) and [the plan](design/plans/fd4-provisioning-image.md).
- **Synthetic Terraform profile (FD-3, from the 2026-10-09 peer review)**: `deployment_profile` (default `production`) lets the same root plan as a one-Region, small, destroyable rehearsal (`synthetic`: allowed only with `environment = "staging"`, creates its own VPC with public subnets and no NAT, refuses COMPLIANCE locks); production values are untouched and every relaxation is listed in one guard. CI now runs `terraform test` (an offline, mocked plan per profile, 13 runs including the refusals), which also found and fixed a latent bug: with the default variables the root could not be *planned* (two IAM policy documents indexed secrets that exist only with hosting on). Proved offline by `terraform test`, the text guards and injected defects; **not** proved in AWS (limits, the free plan, destroying locked buckets: the FD-7 rehearsal). See [the Terraform README](../infrastructure/terraform/README.md#deployment-profiles-fd-3) and [the plan](design/plans/fd3-synthetic-profile.md).
- **Database TLS contract (FD-1, from the 2026-10-09 peer review)**: connection URLs may not carry TLS parameters (refused at start-up and in the connection builder); `DATABASE_SSL` is the only TLS setting and `require` verifies certificate and host name at TLS 1.2+; the command-line tools use `verify-full`; the migration task now sets `DATABASE_SSL=require`; a static guard keeps every connection on the one builder. See [database.md](database.md#database-tls). The F3b wording that a damaged task "leaves rotation at once" is corrected by FD-2 (below).
- **API image and first-deployment rehearsal (FD-4b)**: a digest-pinned Node 22.22.0 image, owner-confirmed RDS trust bundle, compiled production dependencies with a frozen-resolution comparison, numeric non-root runtime, and a synthetic TLS PostgreSQL/Moto rehearsal. The new `image` CI check builds with retained OCI SBOM/provenance, blocks fixed HIGH/CRITICAL vulnerabilities, and exercises provisioning, pristine-startup refusal, migrations, health/readiness and cross-process tenant containment. Local verification and remaining limits are recorded in [the image runbook](../infrastructure/docker/README.md). This is configuration and local/CI evidence only: nothing applied, published, clinically released, or approved for production; live branch protection still requires the founder to import the ruleset.
- **Adapter-side R05 offline prototype (#28)**: implemented and verified with synthetic development tests; see [offline verification](clinical-validation/report-lookup-offline-v1.md). Production record-store/API integration requires its own approved plan; the evaluation API still uses the existing report adapter. Real clinical content, independent validation and clinical/training release remain pending.
- **Local synthetic review workflow**: development-only upload, PDF comparison and operations pages with a portable launcher; see [runbook](../scripts/local-review/README.md) and [verification](verification/local-review.md). The optional pinned Poppler26.03.0 adapter accepts only D01; general production Poppler integration remains a separate slice.
- **Tableau (analytics)**: feasible as its own slice; synthetic data only until a BAA; a separate read-only role over de-identified aggregate
  views with small-cell suppression, ideally pointed at a restored copy. Not planned in detail.

## Waiting on a person (the founder)

BAA texts from the off-site backup provider candidates (Backblaze B2, Wasabi); two key custodians; provider choice; the first real off-site
restore drill; deployment approval and the company Vercel source/project; sertraline and CPIC clinical data and sign-off; the break-glass role that may delete object versions is **assigned to the founder** and described in
[ops/break-glass.md](ops/break-glass.md), but must **not be created** until the audit trail ([ops/audit-trail.md](ops/audit-trail.md)) has been applied and tested; applying the `reviewer` Cognito group (Terraform is
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
