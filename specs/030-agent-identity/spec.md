# Feature Specification: the coding agent works as its own identity, with fewer rights than the founder, and the founder is a real reviewer

**Feature Branch**: `docs/spec-030-agent-identity` (spec only; each implementation step gets its own branch off `main`)

**Created**: 2026-10-31

**Status**: Draft, awaiting the founder's decisions D1 to D5 in [plan.md](plan.md). Nothing is created, installed or changed by this spec.

**Input**: the founder's open item "agent identity (bot / GitHub App)", listed since the 2026-10-31 hardening work (agent policy #206). Facts below were read on
2026-10-31 from the repository, the GitHub API and GitHub's own documentation; anything not read is listed under "Not established".

## The problem

Every change an agent makes is pushed, opened and (when asked) merged as the founder's own account.

| # | Fact (read 2026-10-31) | Consequence |
| --- | --- | --- |
| 1 | `gh` acts as the founder's personal login, `jzayas03`, the only member of the organization. Commits are authored `Jan Zayas`. | A change by an agent and a change by the founder look the same in `git log`, in the pull-request list and in GitHub's audit log. |
| 2 | The `main` ruleset (`.github/rulesets/main.json`) requires **0** approving reviews, no code-owner review, and has no bypass actors. | The only gate on a merge is the six checks. The same account authors, and could approve and merge, every change. Nobody else has looked at it. |
| 3 | The agent's GitHub credential is the founder's login. Its scopes were not read (the file is unreadable to the sandbox, by design). | An agent session can do anything the founder can on GitHub, up to the limits of that token. `.claude/settings.json` refuses a few commands ([agent-policy.md](../../docs/ops/agent-policy.md)); it says itself that it is "a guard rail for honest mistakes, not a security boundary". |
| 4 | The repository is **public**; the organization is on the Team plan with 3 seats, 1 filled. | Anything an agent pushes is world-readable. A paid seat is a real cost, and 2 are free. |

This is one gap: **nothing separates the person from the tool they run.** The server-side controls that already hold (no force-push, no direct push to
`main`, six required checks, no cloud credentials in CI, founder-run applies) do not depend on who is acting, so they stay as they are.

## What this does not change

- **The six required checks, their names and the `.github/rulesets/main.json` rules**, until the founder decides D3. Renaming a job still silently un-requires it.
- **No agent gets any cloud access.** Every AWS apply stays founder-run; nothing here puts a credential in a workflow.
- **The founder's own login and its rights.** The founder keeps doing everything they do today. This adds an identity; it removes nothing from the founder.
- **CODEOWNERS paths.** The agent-instructions and guard files stay owned by the founder.
- **The agent policy file** (`.claude/settings.json`) stays a floor under every session, whichever identity the session uses.

## User scenarios

### US1: a change by an agent is recognisable as one (P1)

As the founder, I want to see at a glance in a pull request list, a blame view and the audit log which changes an agent made, so that a review, an incident
or an auditor can tell them apart.

**Acceptance:**
1. A pull request opened by an agent shows the agent identity as its author, not `jzayas03`.
2. Its commits carry the agent identity as committer, and still end with the existing `Co-Authored-By` trailer.
3. GitHub's audit log, filtered by actor, lists the agent's pushes and pull requests separately from the founder's.

### US2: an agent can do less than the founder on GitHub (P1)

As the founder, I want the agent's credential to be unable to change the rules that bind it, so that a mistaken or manipulated session cannot weaken a control.

**Acceptance:**
1. With the agent credential, writing a ruleset, a repository setting, a secret or a webhook is refused by GitHub (not only by `.claude/settings.json`).
2. With it, a push to `main`, a force-push and a branch deletion on `main` are refused.
3. With it, a change to a file under `.github/workflows/` cannot be pushed (the permission that allows it is not granted), so workflow changes are pushed by the founder.
4. The credential expires on its own within hours, and the long-lived secret behind it is not readable by an agent session.
5. A positive control sits beside every refusal in the same run: the agent credential can still open a pull request and read a check run.

### US3: the founder is a real reviewer (P2, needs D3)

As the founder, I want a merge to need my approval of a change I did not author, so that "reviewed" means someone other than the author looked at it.

**Acceptance:**
1. With the agent as author, the founder's approval satisfies a required review; the agent cannot approve its own pull request.
2. A pull request authored by the founder's own login still merges under the rules in force at that moment (D3 says whether the count changes for it).

## Requirements

- **FR-001** The agent identity is not the founder's login and is not a member with write access to the organization's settings.
- **FR-002** Its permissions are the least that US1 and US2 need, listed in [plan.md](plan.md) D2. Any permission beyond that list is a new decision.
- **FR-003** The long-lived secret (the app's private key, or a machine account's password or token) never enters the repository, a workflow, a chat, a log or a path the sandbox can read.
- **FR-004** Everything the agent opens still passes the six required checks. If a pull request from the agent identity does not trigger the workflows, this spec fails (see "Not established" 1).
- **FR-005** Turning the identity off (uninstalling the app, or removing the account) returns the repository to today's behaviour with no other change.

## Success criteria

- **SC-001** A throwaway pull request opened as the agent identity shows that identity as author and runs all six required checks.
- **SC-002** Each US2 refusal is shown by GitHub's own response (status and message kept), next to its positive control.
- **SC-003** A search of the repository, its history and the sandbox-readable paths finds no key or token (gitleaks over the whole branch, plus a listing of where the key lives).
- **SC-004** After D3 is applied (if accepted), a pull request by the agent identity cannot merge without the founder's approval, shown on a throwaway pull request.

## Not established

1. **Whether workflows run for a pull request opened with an installation token.** GitHub's pages read for this spec do not say. It is widely understood that
   a `GITHUB_TOKEN` does not trigger them and an app token does, but that was not confirmed here. SC-001 is the test; D1 does not stand until it passes.
2. **The scopes of the founder's current token**, and whether an app's `Contents: write` could reach `main` past the ruleset (the ruleset has no bypass
   actors, so it should not; SC-002 shows it).
3. **That an extra organization member would take a paid seat.** Expected on a Team plan; read the billing page before choosing D1 option B.
4. **Which GitHub Apps are already installed** on the organization (the API call for it was refused with the credential used).
5. **How a Claude Code session is given a short-lived token** without the agent reading the key (D4 has the options; none was built).

## Verified facts used

- An installation access token expires after one hour, and its permissions and repositories can be narrowed when it is minted
  ([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).
- GitHub's Terms of Service allow a machine account, set up and answered for by a person, used only for automated tasks, one free machine account in addition to a
  personal one ([Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service), section B.3).
