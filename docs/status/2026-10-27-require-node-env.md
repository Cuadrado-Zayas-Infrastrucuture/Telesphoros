# Fix: the API refuses to start without NODE_ENV, and the reader keeps its production rule (local)

Date: 2026-10-27

Found by the 2026-10-27 audit (A1).

**The problem.** Two production protections could be skipped without anyone noticing.
- `NODE_ENV` defaulted to `development`. Every production refusal in `loadEnv` is keyed on it: Cognito required, PostgreSQL with SSL, S3, the rate limit, and the lab-report pipeline refused.
- So an API started without the setting skipped all of them silently. The Dockerfile and Terraform set it, which is why production was safe.
- `lab-reports.module.ts` also hard-coded `mode: 'non-production'` for the knowledge loader and the report reader. The reader's own production refusal therefore could never fire.

**The fix.**
- `NODE_ENV` has no default. `loadEnv` names it and refuses to start, as the issuer already did.
- The knowledge loader and reader factories take their mode from `NODE_ENV`, so in production the reader refuses and the loader refuses synthetic content.
- The reader is now constructed before the engine-presence check, so its production refusal is not masked by "engine absent".
- The factories are exported so the wiring itself is tested.
- Every launch path already sets `NODE_ENV`: Dockerfile, Terraform, the local-review and local-storage scripts, and Playwright. `apps/backend/README.md` says the setting is required.

**The tests.**
- `env.spec.ts`: a new test that a missing `NODE_ENV` is refused, with a control.
- `lab-reports.module.spec.ts`: new tests for both production refusals, plus the pipeline-off and non-production controls.
- Red on the old behaviour, after the factories were extracted unchanged. Green after.
- `env.spec.ts` and `auth.module.spec.ts` now state `NODE_ENV` in their literal settings.
