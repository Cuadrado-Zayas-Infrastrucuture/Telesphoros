# Plan: agent identity (spec 030)

Decisions D1 to D5 are the founder's. Each has a recommendation; none is applied until the founder says so. Line references cite `main` `ce5a04a5`.

## D1: what kind of identity

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **A. GitHub App (recommended)** | An app owned by the organization, installed on this repository only. A session uses a one-hour installation token. | No seat. Tokens expire in one hour and are narrowed to this repository and the permissions in D2 at the moment they are minted (verified). Appears in the audit log as its own actor. Can be uninstalled in one click (FR-005). | Needs a private key that must live somewhere (D4). A token must be minted for each session. Whether its pull requests trigger the workflows is not yet shown (spec, "Not established" 1). |
| B. Machine account | A second GitHub login, invited to the organization with write access. | Simple: one token, works with plain `gh`. Terms of Service allow it (one free machine account, set up and answered for by a person). | Expected to take one of the organization's 3 seats (read billing first). A personal access token is long-lived and as strong as the account's role. Easy to over-grant. |
| C. Keep the founder's login | Today. | Nothing to build. | Everything in the spec's table stays. |

Recommendation **A**, conditional on SC-001: if an app's pull requests do not run the six checks, the fallback is B and this plan is revised, not worked around.

## D2: permissions (App option; the least that US1 and US2 need)

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | read | required by GitHub for every app |
| Contents | write | push branches and commits (the ruleset still refuses `main`: no bypass actors) |
| Pull requests | write | open, update and comment on pull requests |
| Checks | read | read the six checks of a pull request |
| Actions | read | read a run's result and logs |
| Issues | none | no workflow in this repository is allowed to write issues (`supply-chain.test.mjs`); an agent has no need to |
| Workflows | **not granted** | a push that changes `.github/workflows/` is refused by GitHub; the founder pushes those (US2, 3) |
| Administration, Secrets, Variables, Webhooks, Environments, Pages | **not granted** | rulesets, settings and secrets stay the founder's |
| Organization permissions | none | installed on this repository only |

Consequence the founder should know before choosing: **a pull request that adds or edits a workflow file (the nightly `e2e:storage` job is one) cannot be pushed by the agent.**
The agent writes the change in a worktree and the founder pushes the branch. This is the intended control, not a defect.

## D3: reviews on `main` (needs a founder-run `gh api` change; the agent is refused ruleset writes)

| Option | Rule | Effect |
| --- | --- | --- |
| **A. Require 1 approval (recommended, after the app is proven)** | `required_approving_review_count: 1`, and `require_last_push_approval: true` so an approval does not survive a later push | The founder's approval of an agent-authored change is a real review. The founder's own pull requests would need an approver too, and there is no second member: the founder could not merge their own. See below. |
| B. Leave at 0 | Today | The founder's click on Merge is the only human step. |

The catch in A: with one member, a pull request the founder authors themself has no possible approver. Two ways out: the founder authors no pull requests (the agent identity authors all of them, the founder approves and merges), or the count stays 0 and "review" stays the founder's click. **Recommend A with the first way out**, accepted only after SC-004 shows it works on a throwaway pull request, because a wrong count locks `main` for everyone and the repair is a ruleset write by the founder.

## D4: where the private key lives (the long-lived secret, FR-003)

| Option | How | For | Against |
| --- | --- | --- | --- |
| **A. macOS Keychain + a mint script (recommended)** | The key is imported into the login keychain once. `scripts/agent/mint-token.sh` signs a short-lived JWT, asks GitHub for a one-hour installation token narrowed to this repository, and prints it. A session sets `GH_TOKEN` for a command from it. | The key never sits in a file an agent can read; the sandbox does not read the keychain. | The script and the signing step need a rehearsal under the real session (a path the sandbox can run). |
| B. Password manager's CLI | Same script, key fetched from the vault. | Backed up with the vault. | Which tool, and whether it is reachable from a session, was not read. |
| C. A file under `~/telesphoros-private` | Key as a file. | Simple. | A file a session could be told to read; weaker than A. Not recommended. |

The mint script is built in step 2 and tested with a positive control (it mints) and a negative one (a wrong key is refused by GitHub), and gitleaks must find nothing.

## D5: commit and author identity

Recommend: pull request author and commit committer are the app (`<name>[bot]`), the existing `Co-Authored-By` trailer stays, and the founder remains the person who merges. Alternative: keep `Jan Zayas` as commit author and let only the pull request author be the app. The first makes `git blame` and the audit log agree; the second keeps old tooling's idea of who wrote a commit. Recommend the first.

## Rollout (each is one step, in order; the founder's actions are marked)

| Step | Who | What | Done when |
| --- | --- | --- | --- |
| 1 | Founder | Register the app in the organization with exactly D2's permissions; install it on this repository only; note the app id; download the key (import to the keychain, delete the download) | The app is listed as installed; the key is in the keychain and nowhere else |
| 2 | Agent | `scripts/agent/mint-token.sh` and a short ops page; a guard that the script reads no file from the repository and prints no key | A token is minted; a wrong key is refused; gitleaks clean |
| 3 | Agent, founder watching | A throwaway branch and pull request as the app: SC-001, then every SC-002 refusal with its positive control; close it and delete the branch | Every row of the spec's acceptance has GitHub's own response kept |
| 4 | Founder | If D3 is A: apply the ruleset change (the agent drafts the JSON diff and the command) and prove SC-004 on a throwaway pull request | A pull request by the app does not merge without approval; a rollback command is written first |
| 5 | Agent | Update [agent-policy.md](../../docs/ops/agent-policy.md), the ops page and CODEOWNERS notes; add the guard that keeps the app's permission list in this plan equal to a committed copy | `pnpm test:ci-config` green |

Rollback at any step: uninstall the app. Nothing else depends on it until step 4, and step 4 carries its own rollback.

## What I will not decide

- Whether to turn on the review requirement (D3): it changes how every merge works.
- Whether a seat is worth paying for (D1 option B), or whether the fallback is acceptable if SC-001 fails.
