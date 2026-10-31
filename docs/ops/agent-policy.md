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
