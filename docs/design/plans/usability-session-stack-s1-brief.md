# S1 brief: `pnpm demo:session` (for a session with the sealed sandbox)

Date: 2026-11-25. For [the plan](usability-session-stack.md), approved by the founder on 2026-11-25 with SD-D1 to SD-D3 as recommended.
The founder chose to build S1 in a session where code can run in the sealed OpenSandbox (`docs/ops/agent-policy.md`): start with
`job_start(runtime="telesphoros")`, `job_upload_repo`, then `tele-services` for PostgreSQL. Never run it on the host.

## Goal

One command, `pnpm demo:session`, that a moderator runs on their own machine before a usability session. It:
- starts a loopback-only stack;
- seeds the data that `docs/design/clinical-workspace-usability-protocol.md` lists under "Before the session";
- prints one ready line with the URL;
- on Ctrl+C, stops everything and drops its database.

Once it exists, task 11 of the protocol is no longer skipped.

## Read first

- `docs/design/plans/usability-session-stack.md`: the plan, its safety section and the decisions.
- `docs/design/clinical-workspace-usability-protocol.md`: the data list and tasks 10 to 12.
- `scripts/local-review/start.cjs`, `database.cjs`, `seed.cjs` and their README: the launcher to model. It covers loopback ports, no
  inherited cloud credentials, the fake identity provider and the demo organizations.
- `scripts/local-storage/` (`start.cjs`, `services.cjs`, `ownership.cjs`, `product-demo-ci.cjs`): how a launcher owns, stops and is
  run once in CI. Its history has several teardown fixes worth learning from.
- `apps/backend/test/patient-decisions-browser.e2e-spec.ts` and `apps/frontend/playwright.decisions.config.ts`: the closest working
  stack. It runs the real patient UI against a PostgreSQL-backed API with decisions and follow-ups.
- `apps/backend/test/genomic-profile.e2e-spec.ts` (the N2 case) and `apps/backend/test/helpers/knowledge.ts`
  (`signedModifierCopy`, `signerKeysJson`): how a synthetic modifier list is signed with throwaway keys and loaded. Hydralazine
  (RxCUI 5470) is listed against `GENEA` there, which is SD-D2's choice.
- `apps/backend/src/config/env.ts`: the API settings. They include `SYNTHETIC_ASSESSMENT`, `SYNTHETIC_KNOWLEDGE_DIR`,
  `MEDICATION_WRITES`, `FOLLOWUP_WRITES`, `GENE_MODIFIERS_DIR` and `KNOWLEDGE_SIGNER_KEYS`, and the rules between them.

## The data, in one file (`scripts/session/data.cjs`)

| What | Used by |
| --- | --- |
| `SYN-204` and `SYN-2041` (labels one character apart); `SYN-204` with a current recommendation, a result held for a missing gene result, a result with no guideline, and one withdrawn result | tasks 1, 3 to 8 |
| One patient with 20 or more results | task 9 |
| Enough patients that the patient list has more than one page | tasks 1 and 9 |
| One follow-up overdue and one due today, assigned to the participant's user; one held result | task 10 |
| `SYN-307` with a `GENEA` result, taking hydralazine (5470), recorded as a medication | task 11 |
| A drug from the bundled list that `SYN-307` does not take | task 12 |

The protocol's "Before the session" should name this file, so the two cannot drift.

Seed through the API's routes as the synthetic users would, never by writing to tables. If an item cannot be made through the routes,
stop and name it in the PR: that is plan slice S2, not a workaround. A withdrawn result and a held result are the likely ones.

## Musts

- **Keys.**
  - Two signing keys are generated in memory at each start. Only their public halves are written, to the run's temporary
    directory; everything there is deleted on stop.
  - The launcher refuses to start if `KNOWLEDGE_SIGNER_KEYS` or `SIGNED_KNOWLEDGE_DIR` is already set, or if `NODE_ENV=production`.
- **The committed fixture stays unsigned and unchanged.** Sign a copy in the run directory. It keeps `synthetic: true` and its
  "SYNTHETIC TEST FIXTURE" source text.
- **Loopback only**, ports overridable as the review tool's are, and no cloud credentials inherited.
- **A fresh database (`synthetic_session`) on each start**, dropped on stop.
- **One frontend build, as staging builds it**: `vite build --mode e2e`, without `VITE_LOCAL_STORAGE_INTAKE`.
- **A CI test**, run once in the browser job the way `product-demo-ci.cjs` runs the investor demo. It starts the stack, then checks:
  - task 11: `GET /patients/:id/genomic-profile` for `SYN-307` has the notice on the `GENEA` card, and `modifierLists.loaded` is
    true;
  - task 12: checking the task 12 drug answers `no-guideline-loaded` and stores nothing;
  - task 10: the home lists the overdue follow-up and the held result.

  It then stops the stack and confirms the run directory and database are gone.
- **Agent policy**: no secrets, no applies, no force pushes. One status fragment and a verification record in the PR.

## Done

A draft PR with:
- `scripts/session/`;
- the `demo:session` command;
- a README;
- the CI test;
- the protocol's "Before the session" pointing to the command;
- task 11 un-skipped, provided its check is green.

Its "How it was verified" quotes the sandbox runs: the stack starting, the seed, the three checks, the teardown, and a second start
on a clean database.
