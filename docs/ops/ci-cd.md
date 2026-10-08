# CI and branch protection

What runs on every pull request, what `main` requires before a merge, and the exact steps to turn that protection on.
Synthetic data only: no CI job has cloud credentials, and nothing is deployed from CI (see [deployment.md](deployment.md)).

## The jobs (`.github/workflows/ci.yml`)

Runs on every pull request and on every push to `main`. A newer push to the same pull request cancels the older run;
runs on `main` are never cancelled. The workflow has read-only repository permissions and no job uses a secret.

| Job | Required | What a green result proves |
| --- | --- | --- |
| `verify` | yes | Typecheck and lint pass; the unit and API suites pass on the in-memory store; everything builds; the frontend stays inside its chunk budget; the real `knowledge/cpic` directory loads under **production** rules (nothing synthetic or unreviewed); the Terraform security tripwire (`pnpm test:infra`) and the CI-configuration tripwire (`pnpm test:ci-config`) pass |
| `database-and-storage` | yes | On a real PostgreSQL 16 and an S3 emulator (moto): schema, row-level security, backup/restore and readiness; then the **whole API suite on PostgreSQL**; then the same suite **uploading over the S3 protocol**. Each run fails if Jest prints `NOT RUNNING`, so a skipped tier cannot pass quietly |
| `browser` | yes | The login flow and pages, driven by Chromium at 375 px and 1280 px against the fake identity provider (test only), the built API and the built frontend. On failure, traces and screenshots are kept 7 days |
| `terraform` | yes | `terraform fmt -check`, `init -backend=false`, `validate`. No credentials; nothing is planned or applied |
| `secret-scan` | yes | gitleaks over the **full git history** (rules and the one named allowlist entry in `.gitleaks.toml`) |
| `terraform-lint` | no (advisory) | tflint with the AWS ruleset. Promote it once it has run clean on `main` (below) |

A green run is evidence about the code at that commit. It is not evidence about AWS: Terraform has never been applied.

### Choices worth knowing

- **Every GitHub Action is pinned to a full commit SHA**, with the version in a trailing comment. Tags can be moved; SHAs cannot.
  Dependabot opens the update PRs and changes both. `pnpm test:ci-config` fails on an unpinned action.
- **Permissions are `contents: read` and nothing else.** Checks are reported by the runner itself and need no write scope.
- **gitleaks is built from source** (`go install`, verified by the Go checksum database) rather than using the maintainers'
  GitHub Action, which requires a paid licence for organization repositories.
- **Playwright's browser is cached** (key: lockfile hash); the pnpm store and pip downloads are cached by the setup actions.
- **The Terraform provider lock file is not committed**, so `init` resolves the newest `5.x` AWS provider each run. Commit
  `.terraform.lock.hcl` once someone with registry access has generated it (follow-up).
- **Native GitHub secret scanning / code scanning** are not configured here. On a private repository they need GitHub
  Advanced Security. If the plan includes it, turn secret scanning on (Settings → Code security) as a second layer.

## Branch protection (`.github/rulesets/main.json`)

The file is a GitHub **ruleset** for the default branch. It is not active until someone with admin rights imports it.

| Rule | Setting | Why |
| --- | --- | --- |
| Require a pull request | on; **0 required approvals**; conversations must be resolved | Every PR is opened under the sole maintainer's account, so a required approval would be a permanent self-approval deadlock |
| Required status checks | `verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, each bound to the GitHub Actions app | Another app cannot report a check by the same name |
| Block force pushes | on | History on `main` is never rewritten |
| Block deletion | on | |
| "Require branch to be up to date" | **off** | Safer, but forces a re-run after each merge; revisit when `main` becomes contested |
| Code-owner review | **off** | `.github/CODEOWNERS` still requests review automatically. A required code-owner approval cannot be given by the author, so enabling it now would block every PR |
| Bypass | repository admins, **only through a pull request** | Break-glass if Actions is down or out of minutes. Without it, nothing could merge. Use it rarely, and say so in the PR |

**When a second maintainer joins:** change `required_approving_review_count` to `1`, set `require_code_owner_review` to
`true`, and add the second person to `CODEOWNERS` for the sensitive paths. Update this table in the same PR.

### Turning it on

1. Merge the PR that adds these files, and let CI run on `main` once. A check name can only be required after it has reported.
2. GitHub → repository **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, and choose `.github/rulesets/main.json`.
3. Review the page it shows (target: default branch; the five checks; bypass: Admin, pull request only) and **Create**.
4. Check it: open a throwaway PR and confirm it cannot merge until all five checks are green, and that
   `git push --force origin main` is refused.
5. Settings → Actions → General: confirm Actions is allowed, and that **Workflow permissions** is "Read repository contents".
   (The workflow also states its own permissions, so a permissive default would not widen it.)

Renaming a job in `ci.yml` silently stops requiring it, which is why `pnpm test:ci-config` fails if the job names and the
ruleset's required checks disagree.

### Promoting `terraform-lint`

When the advisory job has been green on `main` for a few merges: remove `continue-on-error: true` from it, drop it from
`ADVISORY` in `.github/ci/guard.test.mjs`, and add `{ "context": "terraform-lint", "integration_id": 15368 }` to the ruleset
file (then re-import or edit the ruleset in the UI).

## Other automation

- **Dependabot** (`.github/dependabot.yml`): weekly; npm, GitHub Actions and Terraform minor/patch updates are grouped,
  major updates arrive one at a time; also the CI emulator pin and the local compose file.
- **CODEOWNERS** (`.github/CODEOWNERS`): requests review for migrations, auth and tenancy, clinical content and logic,
  infrastructure, and CI itself.
- **Pull request template** (`.github/pull_request_template.md`): carries the safety invariants onto every PR
  (synthetic data only, no PHI or secrets, BAA status, clinical hold).

## Running the same checks locally

```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:infra && pnpm test:ci-config
# The database and S3 tiers: docs/database.md. The browser tests: pnpm --filter @telesphoros/frontend e2e
```
