# Plan: a local stack for the usability sessions, with the protocol's data

Date: 2026-11-25

Status: **plan only, waiting for the founder's decisions (section 4).** No code, script or test changes yet.

## 1. Why

The usability protocol (`docs/design/clinical-workspace-usability-protocol.md`, revised in #490) describes a build and data that no
command prepares today.

- **No launcher serves it.**
  - `pnpm demo:storage` runs with processing disabled, so it shows no genomic profile.
  - `pnpm demo:review` turns on the lab-report pipeline for capture review, but not decisions, follow-ups or a modifier list.
  - The decision browser test (`apps/frontend/playwright.decisions.config.ts`) starts its own API and database inside one backend
    test and stops them when the test ends.
  - Staging refuses follow-up writes, and changing it is an apply (agent policy).
- **The data must be entered by hand.** That means two patients whose labels differ by one character, a patient with 20 results,
  enough patients for a second page, follow-ups overdue and due today, a held result, and, for task 11, a patient with a `GENEA`
  result who takes a medication that a modifier list names against `GENEA`.
- **Task 11 cannot run at all.**
  - The API loads a modifier list only under the production rules, which check two signatures against `KNOWLEDGE_SIGNER_KEYS`
    (spec 045 PN-1, `apps/backend/src/config/env.ts`).
  - The synthetic lists are unsigned.
  - Medications can be recorded only from the bundled RxNorm list (`BUNDLED_DRUG_LIST`), so the listed drug must be a real one
    paired with the invented gene.
  - The backend test does exactly this: it signs a copy with throwaway keys and lists hydralazine against `GENEA`
    (`apps/backend/test/genomic-profile.e2e-spec.ts`, `test/helpers/knowledge.ts`).

## 2. What the slice builds

A launcher, `pnpm demo:session`, modelled on `scripts/local-review/start.cjs`:
- loopback ports only;
- no cloud credentials inherited;
- Ctrl+C stops everything.

It starts:
- **PostgreSQL 16**, with a database of its own (`synthetic_session`), created fresh on each start and dropped on stop, so every session
  starts from the same data.
- **The API**, with:
  - the synthetic assessment and synthetic knowledge;
  - medication writes, decisions and follow-up recording switched on;
  - `GENE_MODIFIERS_DIR` pointing at a copy of `syn-modifiers-a`, edited to list the task 11 medication (SD-D2) against `GENEA`;
  - that copy signed by two keys the launcher generates at start (SD-D3), with `KNOWLEDGE_SIGNER_KEYS` set to their public halves.
- **The fake identity provider**, with its existing synthetic users.
- **The frontend**, built as staging is (`vite build --mode e2e`, without `VITE_LOCAL_STORAGE_INTAKE`).
- **A seed**, through the API's own routes as a signed-in synthetic user would act, never by writing to tables. It creates the
  protocol's data list, named in one file (`scripts/session/data.cjs`) so the protocol and the seed cannot drift.

Also:
- A test, run in CI, that starts the stack, checks it with the protocol's pass conditions where a machine can, then stops it.
  - **Task 11:** the `GENEA` card carries the notice.
  - **Task 12:** checking a drug answers `no-guideline-loaded` and stores nothing.
  - **Task 10:** the home lists the overdue follow-up and the held result.
- The protocol's "Before the session" points to `pnpm demo:session`, and task 11 is no longer skipped once it exists.

Not in the slice:
- staging;
- the founders' signing keys;
- any change to the API's rules, the loader, or the production refusal of unsigned lists;
- real knowledge.

## 3. Safety

- **The keys are throwaway.**
  - They are generated in memory at start; only their public halves are written, to the run's temporary directory.
  - Everything is deleted on stop.
  - The launcher refuses to start if `KNOWLEDGE_SIGNER_KEYS` or `SIGNED_KNOWLEDGE_DIR` is already set in its environment, so it can
    never pick up the founders' keys or real knowledge.
- **The signed list is a copy in the run directory.** The committed fixture stays unsigned and unchanged.
- **The edited list keeps its markers.** It still says `synthetic: true` and `SYNTHETIC TEST FIXTURE - not FDA content`, which the
  evidence panel shows.
- **It is local only.** The launcher binds loopback and refuses `NODE_ENV=production`.

## 4. Decisions for the founder

- **SD-D1. Where the sessions run.**
  - **Recommended:** the new local launcher above, on the moderator's machine.
  - **Alternative:** a `--session` flag on `pnpm demo:review`. This means fewer files, but one launcher would serve two different
    purposes, and the review tool's capture routes would show in the session.
- **SD-D2. The task 11 medication.** It must be a real drug from the bundled list, paired with the invented `GENEA`. A pharmacist
  participant may know the drug and be distracted by an "inhibitor" claim they know is not true of it.
  - **Recommended:** hydralazine, as the backend test uses. The moderator's briefing says before task 1 that every gene and every
    drug–gene pairing in the session is invented.
  - **Alternative:** you or the co-founder choose a drug from the bundled list that participants are less likely to know well.
- **SD-D3. The signing keys.**
  - **Recommended:** two throwaway keys per run, as in section 3.
  - **Alternative:** one fixed pair of test keys committed to the repository. This is simpler, but a committed private key is a
    pattern the secret scan and agent policy would rightly question.

## 5. The slices

1. **S1, the launcher and the seed.** Scripts under `scripts/session/`, the CI test above, the `demo:session` command, a README, and
   the protocol's "Before the session" pointing to it. Plan approval covers it; it gets a status fragment and a verification record.
2. **S2, only if S1's test shows a gap.** For example, a held result the seed cannot create through the routes. Any such gap is
   named in S1's PR and gets its own plan; S1 does not work around it by writing to tables.

## 6. How this was checked

Read from `main` at the time of writing:
- the protocol (as in #490);
- `scripts/local-review/start.cjs` and its README;
- `package.json`;
- `apps/frontend/playwright.decisions.config.ts`;
- `apps/backend/src/config/env.ts` and `apps/backend/src/patient-medications/patient-medications.service.ts`;
- `packages/shared-types/src/drug-list-data.ts`;
- `apps/backend/test/genomic-profile.e2e-spec.ts` and `test/helpers/knowledge.ts`;
- `docs/ops/knowledge-signing.md`.

No code ran. Whether every item of the data list can be created through the routes (in particular a held result) is S1's first
check.
