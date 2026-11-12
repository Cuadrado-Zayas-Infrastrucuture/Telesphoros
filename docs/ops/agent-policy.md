# Agent policy: what every agent session in this repository is refused

`.claude/settings.json` is committed, so it reaches every Claude Code session opened in a clone of this repository, a
teammate's included. It holds deny rules only. A deny rule beats an allow from any scope (user, project, local, command
line), so this file is the floor; nobody's own settings can lower it. Per-person approvals go in
`.claude/settings.local.json`, which `.gitignore` keeps out of version control because approved commands can hold credentials.

| Refused | Why |
|---|---|
| Reading `.env`, `.env.local`, `.env.*.local`, `.env.development`, `.env.staging`, `.env.production` at any depth, with the Read tool or with `cat`/`head`/`sed`-style commands | Secrets. `.env.example` and `apps/frontend/.env.e2e` stay readable: they hold no secrets |
| `terraform`/`tofu` `apply` and `destroy`, with or without `-chdir=…` | An apply is a human decision on a reviewed plan ([environments.md](environments.md) says what is applied) |
| `git push --force`/`-f` in any position, a `+refspec`, and a push naming `main` or `HEAD:main` | The ruleset already refuses these on GitHub; this stops them before they leave the machine |
| `gh api` with `PUT`, `POST`, `PATCH` or `DELETE` on a rulesets URL | The merge rules change only by a founder decision ([ci-cd.md](ci-cd.md)) |

`.github/ci/guard.test.mjs` (`pnpm test:ci-config`) refuses a change that drops one of these rules or adds an allow,
ask, hook or env entry to the shared file.

## What it does not stop

A rule matches the command as written. The same program invoked another way passes: `git -C dir push --force`, a script
or `node`/`python` process that reads a file or runs the command itself, `grep -r` over a directory that holds a `.env`.
It is a guard rail for honest mistakes, not a security boundary. The controls that hold regardless are server-side:
the ruleset (no force-push, no direct push to `main`), the cloud account's own permissions, and the operating-system sandbox.
There are no hooks in the shared file on purpose: a repository hook runs outside the sandbox on every teammate's machine.

## Re-checking that Claude Code enforces it

A text check cannot show enforcement. Re-run this after changing the file or upgrading Claude Code, in a throwaway
directory holding a copy of `.claude/settings.json`, a dummy `.env`, and stand-in `terraform`, `tofu`, `gh` and
`git push` scripts first on `PATH` that only print what they were given:

```bash
claude -p --setting-sources project --allowedTools "Bash" "Read" --output-format json "$(cat prompt.txt)"
```

Every Bash and Read call is allowed there, so a refusal can only come from a deny rule. The JSON's `permission_denials`
must list each refused command, and the stand-ins must still run for the controls (`terraform version`, a `-chdir` plan,
an ordinary `git push`, a rulesets `GET`, `cat` of a plain file, Read of `.env.example`).

Last run 2026-10-30, Claude Code 2.1.310: 10 of 10 refused, by the permission system; 6 of 6 controls ran.

## Code runs only in the sealed sandbox

Founder decision, 2026-11-11: every Claude Code session on this repository runs code (tests, builds, type checks,
linters, scripts) only inside a job of the local OpenSandbox pilot, the MCP server `opensandbox-pilot`, and never on
the host. The pilot's own README, `~/opensandbox-pilot/README.md`, holds the details and the seal test that proves them.

- **What a job is.** It has no network at all and runs as an unprivileged user. Only `/work` is writable, and `/tmp` is a
  link into it. A job lives at most 15 minutes and is destroyed afterwards. Each job gets its own key, which the agent
  never sees.
- **How to use it.** Start with `job_start(runtime="telesphoros")`. That image has this repository's locked dependencies,
  PostgreSQL 16 and moto installed; run `tele-services` inside the job to start the database and S3 emulator. Then use
  `job_upload_repo` (tracked files only) and `job_exec`. Use `job_get_patch` to bring a change back for review before it
  touches a host checkout. Always end with `job_end`, including after a failure.
- **Proven in a job, 2026-11-11.** On a commit that CI last passed, these all ran green: `verify` (all steps except
  `smart-pilot test:ig`), Tier 1, Postgres+S3 and the worker tests. One job holds one tier. Postgres+S3 needs about
  14.5 of the 15 minutes.
- **Not in a job.** Some steps need the network, Docker or AWS: the FHIR IG check, the browser tier, terraform and
  tflint, gitleaks, image builds and staging releases. Those, and git and `gh`, stay on the host under the rest of
  this policy. If anything else will not run in a job, stop and ask the founder. Do not fall back to the host.
- **When the lockfile changes.** `job_upload_repo` then reports `lockfile: MISMATCH`, and the installed dependencies no
  longer match. Rebuild the image (`~/opensandbox-pilot/images/telesphoros/build.sh <clone> <ref>`) before trusting a
  result.

`.claude/settings.json` backs it with deny rules for the ordinary ways to run code on the host: `pnpm` `test`,
`typecheck`, `lint`, `build`, `install`, `exec` and `dlx` (tests and builds also through `--filter` or `-F`), `npx`,
`npm` `test`, `run`, `ci` and `install`, `jest`, `vitest` and `node --test`. Like the rules above, they match the
command as written, so `bash -c`, a script or `node path/to/file.js` still pass (see "What it does not stop"): a
guard rail, not a boundary. They do not reach commands a script runs, such as the `pnpm` calls inside
`scripts/staging/release/frontend.sh`, and they do not apply to commands the founder types in a terminal.
Re-checked 2026-11-12 with the procedure above (Claude Code 2.1.310, stand-ins for `pnpm`, `npx`, `npm`, `jest`,
`vitest` and `node`): 19 of 19 refused by the permission system; `pnpm --version`, `node --version` and `cat` of a plain
file ran, and the stand-ins' own log shows the refused commands never started.
