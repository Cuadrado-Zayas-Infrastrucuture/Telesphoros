# Team access: what a new engineer can do, and what only the founder holds

Date: 2026-11-04; the release-script rows were reconciled on 2026-11-07 against main `859e964a`. One maintainer ([MAINTAINERS.md](../../MAINTAINERS.md)). Synthetic data only. This page names kinds of access and where they
are documented. Account ids, role ARNs, addresses and every other real value stay out of it, and out of the repository.

## Day one, with the repository alone

Everything below needs only a clone. It was checked on 2026-11-04 from a fresh clone of `main` on macOS, Node 22.22.0 and pnpm 10.28.0.

- Install, run every required check and the local storage demo: [start-here.md](../start-here.md), then [CONTRIBUTING.md](../../CONTRIBUTING.md).
- The database and S3 test tiers, which a plain `pnpm test` skips and announces: [database.md](../database.md).
- Where each part lives: [README.md](../../README.md) (folder table), the [documentation map](../README.md), [architecture.md](../architecture.md) and the
  [glossary](../glossary.md). The newest dated entries: `pnpm status:index`.
- Open pull requests. CI runs the required checks; `main` takes a pull request with every required check green ([ci-cd.md](ci-cd.md)).

Not possible from the repository alone: anything in AWS, a staging release, the five report-reader engine specs (the engine comes from a
private source, [lab-report-reader.md](../lab-report-reader.md)), and real data of any kind.

## Held only by the founder today

| Access | Used for | Documented in | Before someone else may hold it |
| --- | --- | --- | --- |
| The staging AWS account, through the founder's MFA-protected profile | `staging-status.sh`, every plan and apply, image pushes | [environments.md](environments.md), [staging-release.md](staging-release.md) | A role per person, with MFA, scoped to the release steps, recorded in `environments.md` |
| The private folder `~/telesphoros-private` (`staging/stack.env`, the hashed `current.tfvars`, `releases/`, the release claim) | Every release step | The header of `scripts/staging/release/lib.sh`, [staging-release.md](staging-release.md) | A copy procedure through an approved private channel; never git, chat or email |
| A first full release run with the ported scripts: `image.sh`, `migrate.sh`, `verify.sh`, `frontend.sh` and `state-backup.sh` are now in `scripts/staging/release/` with tests (spec 027 PR 3a and 3b), but `staging-release.md` records that no release has run the verification, frontend and state-backup scripts yet | The image, migrate, verification, frontend and state-backup steps of a release | [staging-release.md](staging-release.md) | One real release run end to end with them, its outputs kept in the private folder and the result recorded in `staging-release.md` |
| The report-reader engine source | Five engine specs and the local review demo | [lab-report-reader.md](../lab-report-reader.md) | A written decision on who may receive it |
| DNS for `telesphoros.app` | Staging and company addresses, mail records | [domains-and-hosting.md](domains-and-hosting.md) | A second administrator on the DNS account |
| Staging sign-in invitations, SES-verified recipients, the alarm email | Testers, the second reviewer of a walkthrough, alerts | [membership.md](membership.md), [foundations-readiness.md](foundations-readiness.md), [environments.md](environments.md) | Each tester's address verified in SES; the tester roster kept private |
| GitHub: organization owner, the `main` ruleset, the `image-release` environment | Required checks, merges, the dormant CI release job | [ci-cd.md](ci-cd.md) | "When a second maintainer joins" in `ci-cd.md`: one approval and code-owner review |
| The approver role for deleting a stored report file version | Break-glass deletion (the role is not created) | [break-glass.md](break-glass.md) ("Hand-over rule") | A second maintainer or a designated compliance owner |

## Before a second person releases to staging

1. The release scripts are in the repository and tested (spec 027), so a release needs no copy of anyone's laptop. Their first full run is still to come (see the row above).
2. That person has their own role with MFA; nobody shares the founder's profile.
3. They receive the private folder's contents through the approved channel. `claim.sh` keeps one releaser at a time.
4. The ruleset change for a second maintainer is made.
5. They have signed the agreements the company requires. The code is proprietary ([LICENSE](../../LICENSE)) and the contributor agreement is still a
   draft waiting on counsel ([CONTRIBUTING.md](../../CONTRIBUTING.md#contributor-licence)). That is a legal step, not something this page settles.

### New-hire checklist

Each access is granted by one person and is done only when its evidence exists. Nothing waits on a credential before the first row.

| Access | Purpose | Granted by | Scope | Done when |
| --- | --- | --- | --- | --- |
| The repository clone | Everything under "Day one" | Nobody: a clone is enough | Synthetic data only | The default checks and the service tiers have run, and the skip notices were read ([verification matrix](../database.md#verification-matrix)) |
| A personal staging AWS role | Plans, applies, image pushes, `staging-status.sh` | The founder | The release steps only, with MFA | The role is recorded in [environments.md](environments.md) and `staging-status.sh` runs under it |
| The private release folder | Every release step | The founder | One releaser at a time (`claim.sh`) | Handed over through the approved channel, never git, chat or email |
| An SES-verified address and a staging sign-in invitation | Testing the staging sign-in | The founder | One tester | The address is verified in SES and the roster stays private |
| GitHub maintainer rights | Approvals and merges | The organization owner | The ruleset change in [ci-cd.md](ci-cd.md) ("When a second maintainer joins") | `MAINTAINERS.md` and `.github/CODEOWNERS` name the second maintainer, and the ruleset requires one approval and code-owner review. Declared ruleset files alone are not evidence of live protection |
| The signed company agreements | Contributing code | Counsel | See [CONTRIBUTING.md](../../CONTRIBUTING.md#contributor-licence) | Signed; a legal step this page does not settle |

## Before production

Production is not an access question alone. The gates are in [deployment.md](deployment.md) ("Decisions that must come first"), the first-apply
gates in the [Terraform README](../../infrastructure/terraform/README.md), and the "What production adds or changes" column of
[environments.md](environments.md). No real patient data before the AWS BAA is executed.
