# Report registration's database tests get their own timeout, and local test loops run one at a time

Date: 2026-11-07

On 2026-11-07, local test loops hit four 5-second Jest timeouts on branches that did not touch the specs that timed out. Nothing failed an assertion, and each spec passed when re-run alone:

- `report-registration.pg-spec.ts` twice;
- `security-audit.pg-spec.ts` once;
- `patient-followups.e2e-spec.ts` once, in its PostgreSQL tier.

The cause is CPU contention on the developer machine, not one PostgreSQL shared between runs:

- **Each session had its own cluster.** Six were active that day.
- **Something else heavy was running during each failure.** One ran under root `pnpm test`, which tests the backend, worker and frontend in parallel. The other three ran while one or two other sessions' full loops were running.
- **Overlap does not always cause a failure.** Other loops that overlapped in the same way passed.

The margin explains which specs failed. These timings come from three runs alone on a dedicated cluster, with a load average of 3 to 5:

| Test | Time per run |
|---|---|
| report-registration: "upgrades legacy rows unchanged and guards populated rollback …" | 2.9–3.2 s |
| report-registration: "fails migration on bounded lock contention …" | 2.7–3.2 s |
| security-audit: "refuses to narrow the CHECK again …" | 1.2–1.3 s |
| patient-followups: "filters assigned reminders before pagination …" | 1.0–1.3 s |

So report-registration fails at 1.6 times slower, and the others at about 4 times slower.

What changed:

- **`report-registration.pg-spec.ts` sets `jest.setTimeout(30_000)`,** as ten other database specs do, and as `migrations.pg-spec.ts` did on 2026-11-06. The budget also covers the file's scratch-database hook.
- **"Running things locally" in `docs/STATUS.md` now says to run one backend test loop per machine at a time.** It also says that a 5-second timeout seen during a parallel loop proves nothing either way.

What did not change:

- **The 5-second default for every other spec.** The backend Jest configuration, and the CI guard that keeps it on that default (`.github/ci/guard.test.mjs`, from 2026-10-11), stay as they are. A raised default would hide a 4-times slowdown in exactly the specs that should report one.
- **`security-audit` and `patient-followups` keep the default.** They have about 4 times headroom.
- **`security-events.pg-spec.ts` keeps the default too.** While this change was being verified, its test "reverts only with the deliberate setting once a rejection is recorded" timed out once in tier 2, while another session's loop was running. Alone, under a load average of 5 to 9, it takes 1.5–1.9 s: about 3 times headroom, and the same class as the others.

CI's 2026-11-06 failure in `migrations.pg-spec.ts` is a different case: each CI job has its own PostgreSQL and nothing runs beside it. That file was fixed on its own.
