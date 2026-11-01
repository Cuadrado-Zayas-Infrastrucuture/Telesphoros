# Tasks: agent identity (spec 030)

Blocked on the founder's decisions D1 to D5 in [plan.md](plan.md). Nothing here is started.

- [ ] **T001** (founder) Decide D1 to D5. Read the organization's billing page first if D1 is the machine account.
- [ ] **T002** (founder) Register and install the app with D2's permissions only; keep the key out of the repository and out of chat (plan, step 1).
- [ ] **T003** `scripts/agent/mint-token.sh`: sign a JWT with the key, request a one-hour installation token narrowed to this repository and to D2's permissions, print it. Refuses a missing key, an expired JWT and a repository other than this one.
- [ ] **T004** A guard test: the script reads no file in the repository, prints no key, and the permission list it requests equals the list in plan D2.
- [ ] **T005** SC-001: a throwaway pull request as the app, and whether the six required checks run for it. If they do not, stop and revise D1.
- [ ] **T006** SC-002: each refusal (ruleset write, repository setting, secret, webhook, push to `main`, force-push, workflow-file push) with GitHub's response kept and a positive control in the same run.
- [ ] **T007** SC-003: gitleaks over the branch and history, and a listing of where the key lives.
- [ ] **T008** (founder, if D3 is A) the ruleset change, with the rollback command written before it runs; SC-004 on a throwaway pull request.
- [ ] **T009** Update `docs/ops/agent-policy.md` and the ops page; run `pnpm test:ci-config`.
- [ ] **T010** Close out: remove the throwaway branches and pull requests, record the result in `docs/status/`.
